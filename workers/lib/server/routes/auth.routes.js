'use strict'
const {
  ENDPOINTS,
  HTTP_METHODS,
  AUTH_PERMISSIONS
} = require('../../constants')

const {
  getUserInfo,
  newAuthToken,
  getUserPermissions,
  extDataRoute,
  redactExtData
} = require('../handlers/auth.handlers')
const { createAuthRoute, createAuthOnRequest, AUTH_ONLY } = require('../lib/routeHelpers')
const { cachedRoute } = require('../lib/cachedRoute')
const { send200 } = require('../lib/send200')

// The payout ledger is revenue data; every other ext-data read is shown to all roles, with pool balances
// stripped for callers without revenue (see redactExtData).
const extDataPerms = (req) => {
  try {
    return JSON.parse(req.query.query).key === 'transactions' ? [AUTH_PERMISSIONS.REVENUE] : AUTH_ONLY
  } catch {
    return AUTH_ONLY
  }
}

// Time-ranged queries embed caller-supplied ms timestamps, so their cache
// keys are unique per request and would only pile up dead LRU entries;
// bypass the cache for them (invalid JSON falls through to the handler,
// which rejects it with a proper error).
function extDataCacheKey (req) {
  if (req.query.query) {
    try {
      const query = JSON.parse(req.query.query)
      if (query.start != null || query.end != null) return null
    } catch (err) {}
  }
  return ['ext-data', req.query.type, req.query.query]
}

// Every failure reads the same so the callback cannot be used to probe which addresses are provisioned.
async function oauthCallbackRedirect (ctx, provider, req, uiUri) {
  try {
    const token = await ctx.auth_a0.authCallbackHandler(provider, req)
    return uiUri + '?' + new URLSearchParams({ authToken: token })
  } catch (err) {
    console.error(new Date().toISOString(), `ERR_OAUTH_CALLBACK_${provider.toUpperCase()}`, err.message)
    return uiUri + '?' + new URLSearchParams({ error: 'ERR_AUTH_FAIL' })
  }
}

module.exports = (ctx) => [
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.OAUTH_GOOGLE_CALLBACK,
    handler: async (req, rep) => {
      return rep.redirect(await oauthCallbackRedirect(ctx, 'google', req, ctx.httpdOauth2_h0.callbackUriUI()))
    }
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.OAUTH_MICROSOFT_CALLBACK,
    handler: async (req, rep) => {
      return rep.redirect(await oauthCallbackRedirect(ctx, 'microsoft', req, ctx.httpdOauth2_h1?.callbackUriUI?.()))
    }
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.USERINFO,
    ...createAuthRoute(ctx, getUserInfo, AUTH_ONLY)
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.TOKEN,
    ...createAuthRoute(ctx, async (ctx, req) => ({ token: await newAuthToken(ctx, req) }), AUTH_ONLY)
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.PERMISSIONS,
    ...createAuthRoute(ctx, async (ctx, req) => ({ permissions: await getUserPermissions(ctx, req) }), AUTH_ONLY)
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.EXT_DATA,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          query: { type: 'string' },
          overwriteCache: { type: 'boolean' }
        },
        required: ['type']
      }
    },
    onRequest: createAuthOnRequest(ctx, extDataPerms),
    // The cache holds full pool stats; balance fields are dropped per caller after it.
    handler: async (req, rep) => {
      const key = extDataCacheKey(req)
      const load = () => extDataRoute(ctx, req, rep)
      const results = key
        ? await cachedRoute(ctx, key, ENDPOINTS.EXT_DATA, load, !!req.query.overwriteCache)
        : await load()
      return send200(rep, await redactExtData(ctx, req, results))
    }
  }
]
