'use strict'
const { GLOBAL_DATA_TYPES, LOCKED_TIMEZONE_DEFAULT } = require('../../constants')
const { parseJsonQueryParam } = require('../../utils')
const { priceBucket, fetchBucketPrices } = require('./finance.utils')

async function getGlobalData (ctx, req) {
  const type = req.query.type
  const groupBy = req.query.groupBy

  const range = {}
  const opts = {}
  if (req.query.gt) range.gt = req.query.gt
  if (req.query.gte) range.gte = req.query.gte
  if (req.query.lt) range.lt = req.query.lt
  if (req.query.lte) range.lte = req.query.lte
  if (req.query.limit) opts.limit = req.query.limit

  if (req.query.query) {
    req.query.query = parseJsonQueryParam(req.query.query, 'ERR_QUERY_INVALID_JSON')
  }
  if (req.query.sort) {
    req.query.sort = parseJsonQueryParam(req.query.sort, 'ERR_SORT_INVALID_JSON')
  }

  if (req.query.fields) {
    req.query.fields = parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON')
  }

  return await ctx.globalDataLib.getGlobalData({
    type,
    range,
    opts,
    query: req.query.query,
    fields: req.query.fields,
    sort: req.query.sort,
    offset: req.query.offset,
    limit: req.query.limit,
    groupBy,
    model: req.query.model
  })
}

// Captures what the rebate was worth when it was received, so its USD value
// stays fixed instead of being re-derived from a daily price later. A rebate
// entered close to real time is a straight cache hit; a backdated one may have
// no recorded price yet, and must not fail the write for it — the read path
// falls back and the backfill script fills the gap.
async function priceRebateAtReceipt (ctx, data) {
  try {
    const bucketTs = priceBucket(data.ts)
    const prices = await fetchBucketPrices(ctx, [bucketTs])
    if (prices[bucketTs]) return { ...data, priceUSD: prices[bucketTs] }
  } catch (err) {
    console.error('ERR_PRICE_REBATE_AT_RECEIPT', err)
  }
  return data
}

async function setGlobalData (ctx, req) {
  let data = req.body.data
  const type = req.query.type

  if (type === GLOBAL_DATA_TYPES.POOL_REBATES && !data?.remove && Number.isFinite(data?.ts)) {
    data = await priceRebateAtReceipt(ctx, data)
  }

  return await ctx.globalDataLib.setGlobalData(data, type)
}

async function getFeatureConfig (ctx) {
  const featureConfig = ctx.conf.featureConfig || {}
  return {
    ...featureConfig,
    lockedTimezone: featureConfig.lockedTimezone || LOCKED_TIMEZONE_DEFAULT
  }
}

async function getFeatures (ctx) {
  return await ctx.globalDataLib.getGlobalData({ type: GLOBAL_DATA_TYPES.FEATURES })
}

async function setFeatures (ctx, req) {
  const data = req.body.data
  return await ctx.globalDataLib.setGlobalData(data, GLOBAL_DATA_TYPES.FEATURES)
}

async function getGlobalConfig (ctx, req, rep) {
  if (req.query.fields) {
    req.query.fields = parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON')
  }

  return await ctx.dataProxy.requestDataMap('getGlobalConfig', req.query)
}

async function setGlobalConfig (ctx, req, rep) {
  return await ctx.dataProxy.requestDataMap('setGlobalConfig', req.body.data)
}

module.exports = {
  getGlobalData,
  setGlobalData,
  getFeatureConfig,
  getFeatures,
  setFeatures,
  getGlobalConfig,
  setGlobalConfig
}
