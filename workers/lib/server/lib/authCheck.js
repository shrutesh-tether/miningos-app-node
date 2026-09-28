'use strict'

const { extractIps, getAuthTokenFromHeaders } = require('../../utils')
const { AUTH_CACHE_TTL } = require('../../constants')

async function authCheck (ctx, req, rep, tokenFromQuery = null) {
  req._info = req._info || {}

  if (ctx.noAuth) return

  const token = tokenFromQuery || getAuthTokenFromHeaders(req.headers)
  if (!token) {
    return rep.status(401).send({
      statusCode: 401,
      error: 'Missing or invalid Authorization header',
      message: 'ERR_AUTH_FAIL'
    })
  }

  const ips = extractIps(req)

  // JSON-encode rather than join with a plain delimiter: token and ip values are
  // attacker-controlled (Authorization header, X-Forwarded-For) and unvalidated, so a
  // naive `${token}:${ips.join(',')}` lets two different (token, ips) pairs collide on
  // the same string (e.g. token `a:b`, ips `[c]` vs token `a`, ips `[b:c]`), letting a
  // crafted request hit another session's cached user.
  const cacheKey = JSON.stringify([token, ips])

  const cached = ctx.lru_1m?.get(cacheKey)
  if (cached && (ctx.conf.ttl * 1000) > AUTH_CACHE_TTL) {
    req._info.user = cached
    req._info.authToken = token
    return
  }

  try {
    const user = await ctx.authLib?.resolveToken(token, ips)

    if (!user) {
      return rep.status(401).send({
        statusCode: 401,
        error: 'Authentication failed',
        message: 'ERR_AUTH_FAIL'
      })
    }

    ctx.lru_1m?.set(cacheKey, user)

    req._info.user = user
    req._info.authToken = token
  } catch (err) {
    console.error('[authCheck] ❌ Final error:', err)
    throw new Error('ERR_AUTH_FAIL')
  }
}

module.exports = { authCheck }
