'use strict'

const gLibUtilBase = require('@bitfinex/lib-js-util-base')
const { parseJsonQueryParam, getAuthTokenFromHeaders } = require('../../utils')
const { AUTH_PERMISSIONS, POOL_REVENUE_FIELDS } = require('../../constants')

async function getUserInfo (ctx, req) {
  return req._info.user
}

async function newAuthToken (ctx, req) {
  // ips are left out so the new token keeps the old one's binding rather than one the caller picks
  const opts = gLibUtilBase.pick(req.body, ['ttl', 'pfx', 'scope', 'roles'])
  opts.oldToken = getAuthTokenFromHeaders(req.headers)
  if (!opts.ttl && ctx.conf.ttl) opts.ttl = ctx.conf.ttl
  return ctx.authLib.regenerateToken(opts)
}

async function getUserPermissions (ctx, req) {
  return ctx.authLib.getTokenPerms(req._info.authToken)
}

function getSiteName (ctx) {
  return { site: ctx.conf.site }
}

async function extDataRoute (ctx, req, rep) {
  if (req.query.query) {
    req.query.query = parseJsonQueryParam(req.query.query, 'ERR_QUERY_INVALID_JSON')
  }

  return await ctx.dataProxy.requestDataMap('getWrkExtData', req.query)
}

// Pool balances sit inside otherwise role-neutral stats, so they are dropped per caller on a copy,
// never on the cached entries themselves.
function omitPoolRevenueFields (entry) {
  if (Array.isArray(entry)) return entry.map(omitPoolRevenueFields)
  if (!entry || typeof entry !== 'object') return entry
  const rest = {}
  for (const [key, value] of Object.entries(entry)) {
    if (!POOL_REVENUE_FIELDS.includes(key)) rest[key] = omitPoolRevenueFields(value)
  }
  return rest
}

async function redactExtData (ctx, req, results) {
  if (ctx.noAuth) return results
  const canSeeRevenue = await ctx.authLib.tokenHasPerms(req._info?.authToken, false, [AUTH_PERMISSIONS.REVENUE])
  return canSeeRevenue ? results : omitPoolRevenueFields(results)
}

module.exports = {
  getUserInfo,
  newAuthToken,
  getUserPermissions,
  getSiteName,
  extDataRoute,
  redactExtData
}
