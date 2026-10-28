'use strict'

const test = require('brittle')
const { getSiteName, extDataRoute, getUserInfo, newAuthToken, getUserPermissions, redactExtData } = require('../../../workers/lib/server/handlers/auth.handlers')
const { createMockCtxWithOrks } = require('../helpers/mockHelpers')

test('getSiteName - returns site from context', (t) => {
  const mockCtx = {
    conf: {
      site: 'test-site'
    }
  }

  const result = getSiteName(mockCtx)
  t.is(result.site, 'test-site', 'should return site from context')
  t.pass()
})

test('extDataRoute - with query param', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }, { rpcPublicKey: 'key2' }],
    async () => ({ data: 'test' })
  )

  const mockReq = {
    query: {
      type: 'test-type',
      query: '{"field":"value"}'
    }
  }

  const result = await extDataRoute(mockCtx, mockReq, {})
  t.ok(Array.isArray(result), 'should return array')
  t.is(result.length, 2, 'should return results for all orks')
  t.pass()
})

test('extDataRoute - without query param', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => ({ data: 'test' })
  )

  const mockReq = {
    query: {
      type: 'test-type'
    }
  }

  const result = await extDataRoute(mockCtx, mockReq, {})
  t.ok(Array.isArray(result), 'should return array')
  t.pass()
})

test('getUserInfo - returns user from req._info', async (t) => {
  const mockCtx = {}
  const mockReq = {
    _info: {
      user: { userId: 'user123', email: 'test@example.com' }
    }
  }

  const result = await getUserInfo(mockCtx, mockReq)
  t.is(result.userId, 'user123', 'should return user from req._info')
  t.is(result.email, 'test@example.com', 'should return user email')
  t.pass()
})

test('newAuthToken - regenerates token via authLib', async (t) => {
  const mockCtx = {
    conf: {
      ttl: 3600
    },
    authLib: {
      regenerateToken: async (opts) => {
        t.is(opts.ttl, 3600, 'should pass ttl from context')
        t.is(opts.oldToken, 'old-token', 'should pass old token')
        t.absent(opts.ips, 'should not let the caller choose the ip binding')
        return 'new-token'
      }
    }
  }

  const mockReq = {
    headers: {
      authorization: 'Bearer old-token'
    },
    body: {
      ips: ['127.0.0.1'],
      scope: 'read',
      roles: ['user']
    }
  }

  const result = await newAuthToken(mockCtx, mockReq)
  t.is(result, 'new-token', 'should return new token')
  t.pass()
})

test('getUserPermissions - returns permissions from authLib', async (t) => {
  const mockCtx = {
    authLib: {
      getTokenPerms: async (token) => {
        t.is(token, 'test-token', 'should pass token')
        return ['read', 'write']
      }
    }
  }

  const mockReq = {
    _info: {
      authToken: 'test-token'
    }
  }

  const result = await getUserPermissions(mockCtx, mockReq)
  t.ok(Array.isArray(result), 'should return array')
  t.is(result.length, 2, 'should return permissions')
  t.ok(result.includes('read'), 'should include read permission')
  t.ok(result.includes('write'), 'should include write permission')
  t.pass()
})

test('redactExtData - strips pool balances for callers without revenue, on a copy', async (t) => {
  const cached = [{
    ts: 1,
    stats: [{ username: 'acct1', hashrate: 5, balance: 1.2, unsettled: 0.3, revenue_24h: 0.1, estimated_today_income: 0.05, yearlyBalances: { '2026-1': 2 } }]
  }]
  const ctxFor = (hasRevenue) => ({
    authLib: {
      tokenHasPerms: async (token, write, perms) => {
        t.alike(perms, ['revenue'], 'should check the revenue permission')
        return hasRevenue
      }
    }
  })
  const req = { _info: { authToken: 'token' } }

  const redacted = await redactExtData(ctxFor(false), req, cached)
  t.alike(redacted, [{ ts: 1, stats: [{ username: 'acct1', hashrate: 5 }] }], 'should drop every pool money field')
  t.is(cached[0].stats[0].balance, 1.2, 'should not mutate the cached entry')

  t.is(await redactExtData(ctxFor(true), req, cached), cached, 'revenue holders get the full response')
  t.is(await redactExtData({ noAuth: true }, req, cached), cached, 'noAuth mode is untouched')
})
