'use strict'

// generate-price-backfill-timestamps.js
//
// Drop this single file into the root of an app-node checkout and run it from
// there (`node generate-price-backfill-timestamps.js ...`). It has no
// dependencies beyond what app-node itself already has installed.
//
// Reads the real Ocean/f2pool payouts and rebates for a date range and writes
// the exact 5-minute buckets that need a historical BTC price — the file that
// miningos-wrk-ext-mempool's scripts/backfill-5m-prices.js takes as
// --timestamps-file. This is what makes that script's targeted mode "targeted":
// its cost becomes proportional to actual payout count instead of calendar time
// (288 buckets/day densely filled).
//
// A pure-HTTP alternative was tried first: app-node's existing API already
// exposes exact per-rebate timestamps (GET /auth/global/data?type=poolRebates),
// but every finance endpoint sums transactions into one row per day before the
// response is built — no endpoint returns an individual payout's own
// timestamp. The best that API-only approach could do for payouts was flag
// whole days as incomplete and densely fill all 288 buckets in each, which
// overshoots badly when a day's actual payouts are sparse. This script trades
// that simplicity back for precision by reading the real payout/rebate data
// the same way the finance API itself does — via the live P2P RPC layer for
// payouts, and this site's own store for rebates — instead of only through
// day-aggregated HTTP responses.
//
// Usage:
//   node generate-price-backfill-timestamps.js [--start <when>] [--end <when>] [--out <file>]
//     [--env production] [--skip-cached]
//
//   --start/--end    date range to scan, same formats as the backfill script
//                    accepts (ISO date or epoch, seconds or ms). Default: the
//                    last DEFAULT_LOOKBACK_MS (see below) up to now — enough
//                    for a routine "catch up on recent gaps" run. Pass these
//                    explicitly for a one-off historical backfill further back.
//   --out            where to write the timestamps file. Default:
//                    DEFAULT_OUT_FILE (see below) in the current directory.
//   --env            which config/*.json to load (default: production, i.e.
//                    the real deployed config — this reads live data)
//   --skip-cached    also query the mempool worker for buckets it already has
//                    a price for, and omit them from the output (default: on;
//                    pass --skip-cached=false to get every bucket regardless)
//   --root           repo root to load config/store from (default: this
//                    file's own directory). Override only for a multi-site
//                    deployment where this checkout isn't the target site.
//
// It is read-only end to end: it opens its store in read-only mode and never
// calls anything that writes global data, so it is always safe to run
// alongside the live production worker.
//
// --- Why this needs a real (if minimal) worker boot ---
//
// Payouts only exist behind the live P2P RPC layer (they are never persisted
// in this app), and a destination ork's firewall allowlists specific caller
// public keys — so a script with its own freshly generated identity would
// simply be rejected. WrkPriceBackfillSource below instead points its store at
// the exact same corestore directory WrkServerHttp uses (`store/http`), opened
// read-only: it derives the same seeds, therefore the same RPC identity,
// therefore the same already-allowlisted key, and it can never contend with
// that worker's write lock or block on it. It only ever dials out
// (`net_r0.startRpc()`, not `startRpcServer()`), so it needs no firewall of
// its own.

const fs = require('fs')
const path = require('path')
const async = require('async')
const WrkBase = require('@bitfinex/bfx-wrk-base')

const GlobalDataLib = require('./workers/lib/globalData')
const { createDataProxy } = require('./workers/lib/data.proxy')
const {
  RPC_METHODS,
  WORKER_TYPES,
  MINERPOOL_EXT_DATA_KEYS,
  GLOBAL_DATA_TYPES
} = require('./workers/lib/constants')
const { processTransactions, priceBucket, fetchBucketPrices } = require('./workers/lib/server/handlers/finance.utils')

const REPO_ROOT = __dirname
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_OUT_FILE = 'price-backfill-timestamps.txt'

/**
 * A read-only client that pulls the payout/rebate data a real HTTP worker
 * sees, without running one. See the file header for why it can do this
 * without its own allowlisted P2P identity.
 */
class WrkPriceBackfillSource extends WrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)
    this.storeDir = 'http'
    this.isRpcMode = ctx.isRpcMode !== false
    this.dataProxy = createDataProxy(this)
  }

  init () {
    super.init()
    this.loadConf('common')

    this.setInitFacs([
      ['fac', '@tetherto/hp-svc-facs-store', 's0', 's0', {
        // Absolute, not the bare relative string WrkServerHttp uses — that
        // form resolves against process.cwd(), which real workers get right
        // only because they're always launched from the repo root. This
        // script may be invoked from an arbitrary cwd, and would otherwise
        // silently open (or create) the wrong directory and read back
        // nothing, with no error.
        storeDir: path.join(this.ctx.root, 'store', this.storeDir),
        storeOpts: { readOnly: true }
      }, 0],
      ['fac', '@tetherto/hp-svc-facs-net', 'r0', 'r0', () => ({ fac_store: this.store_s0 }), 1]
    ])
  }

  _start (cb) {
    async.series([
      next => { super._start(next) },
      async () => {
        // Client only: never listens, so it needs no firewall/allowlist of
        // its own callers — it only ever dials out.
        await this.net_r0.startRpc()

        this.globalDataBee = await this.store_s0.getBee(
          { name: 'global-data' },
          { keyEncoding: 'utf-8', valueEncoding: 'json' }
        )
        await this.globalDataBee.ready()
        this.globalDataLib = new GlobalDataLib(this.globalDataBee, this.conf.site)
      }
    ], cb)
  }
}

function parseArgs (argv) {
  const now = Date.now()
  const args = {
    env: 'production',
    skipCached: true,
    root: REPO_ROOT,
    start: now - DEFAULT_LOOKBACK_MS,
    end: now,
    out: DEFAULT_OUT_FILE
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--start') args.start = argv[++i]
    else if (a === '--end') args.end = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--env') args.env = argv[++i]
    else if (a === '--root') args.root = path.resolve(argv[++i])
    else if (a === '--skip-cached') args.skipCached = argv[i + 1] === 'false' ? (++i, false) : true
    else if (a === '-h' || a === '--help') args.help = true
    else throw new Error(`unknown arg: ${a}`)
  }
  return args
}

function usage () {
  console.log('Usage: node generate-price-backfill-timestamps.js [--start <when>] [--end <when>] [--out <file>]')
  console.log('       [--env production] [--root <path>] [--skip-cached=false]')
  console.log(`Defaults: --start ${DEFAULT_LOOKBACK_MS / 86400000} days ago, --end now, --out ./${DEFAULT_OUT_FILE}`)
}

function parseTs (value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`cannot parse timestamp: ${value}`)
  return parsed
}

function pStart (wrk) { return new Promise((resolve, reject) => wrk.start(err => err ? reject(err) : resolve())) }
function pStop (wrk) { return new Promise((resolve, reject) => wrk.stop(err => err ? reject(err) : resolve())) }

async function fetchTransactionTimestamps (ctx, start, end) {
  const results = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type: WORKER_TYPES.MINERPOOL,
    query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
  })

  const { txEntries } = processTransactions(results, null, 'UTC')
  return txEntries.map((t) => t.ts)
}

async function fetchRebateTimestamps (ctx, start, end) {
  const rebates = await ctx.globalDataLib.getGlobalData({
    type: GLOBAL_DATA_TYPES.POOL_REBATES,
    range: { gte: start, lte: end }
  })

  // A rebate already priced at receipt (see global.handlers.js) needs no
  // backfill at all — only the ones written before that existed, or where the
  // price lookup failed at write time, are missing a price.
  return (Array.isArray(rebates) ? rebates : [])
    .filter((r) => Number.isFinite(r?.ts) && !Number.isFinite(r?.priceUSD))
    .map((r) => r.ts)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { usage(); return }

  const start = parseTs(args.start)
  const end = parseTs(args.end)
  if (start >= end) throw new Error('--start must be before --end')

  console.log(`[generate-price-backfill-timestamps] range ${new Date(start).toISOString()} .. ${new Date(end).toISOString()}`)

  const ctx = { root: args.root, env: args.env, wtype: 'price-backfill-source' }
  const wrk = new WrkPriceBackfillSource({}, ctx)
  wrk.init()
  await pStart(wrk)

  let buckets
  try {
    const [txTimestamps, rebateTimestamps] = await Promise.all([
      fetchTransactionTimestamps(wrk, start, end),
      fetchRebateTimestamps(wrk, start, end)
    ])

    buckets = [...new Set([...txTimestamps, ...rebateTimestamps].map(priceBucket))].sort((a, b) => a - b)
    console.log(`[generate-price-backfill-timestamps] payouts=${txTimestamps.length} unpriced-rebates=${rebateTimestamps.length} distinct-buckets=${buckets.length}`)

    if (args.skipCached && buckets.length) {
      const cached = await fetchBucketPrices(wrk, buckets)
      const before = buckets.length
      buckets = buckets.filter((b) => !cached[b])
      console.log(`[generate-price-backfill-timestamps] ${before - buckets.length} bucket(s) already priced, ${buckets.length} remaining`)
    }
  } finally {
    await pStop(wrk)
  }

  fs.writeFileSync(path.resolve(args.out), buckets.map(String).join('\n') + (buckets.length ? '\n' : ''))
  console.log(`[generate-price-backfill-timestamps] wrote ${buckets.length} timestamp(s) to ${args.out}`)
}

main().catch((err) => { console.error('[generate-price-backfill-timestamps] FAILED:', err.message); process.exit(1) })
