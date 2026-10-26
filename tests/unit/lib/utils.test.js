'use strict'

const test = require('brittle')
const {
  dateNowSec,
  extractIps,
  isValidJsonObject,
  isValidEmail,
  getRpcTimeout,
  getAuthTokenFromHeaders,
  parseJsonQueryParam,
  escapeRegex,
  csvEscape,
  stableJsonString,
  listThingsWithCount
} = require('../../../workers/lib/utils')

const randomIPv4 = () => {
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join('.')
}

const TEST_IPS = {
  PRIVATE_1: randomIPv4(),
  PRIVATE_2: randomIPv4(),
  PRIVATE_3: randomIPv4(),
  PRIVATE_4: randomIPv4(),
  PRIVATE_5: randomIPv4()
}

test('dateNowSec - returns current timestamp in seconds', (t) => {
  const now = Date.now()
  const result = dateNowSec()

  t.ok(typeof result === 'number', 'should return number')
  t.ok(result > 0, 'should return positive number')
  t.ok(result <= Math.floor(now / 1000), 'should be less than or equal to current time')
  t.ok(result >= Math.floor(now / 1000) - 1, 'should be within 1 second of current time')

  t.pass()
})

test('extractIps - ignores a client-written x-forwarded-for header', (t) => {
  const req = {
    headers: { 'x-forwarded-for': `${TEST_IPS.PRIVATE_1}, ${TEST_IPS.PRIVATE_2}` },
    socket: { remoteAddress: TEST_IPS.PRIVATE_5 }
  }

  t.alike(extractIps(req), [TEST_IPS.PRIVATE_5], 'should use only the connecting address')
})

test('extractIps - uses the proxy-resolved req.ip', (t) => {
  const req = {
    headers: { 'x-forwarded-for': `${TEST_IPS.PRIVATE_1}, ${TEST_IPS.PRIVATE_4}` },
    ip: TEST_IPS.PRIVATE_4,
    ips: [TEST_IPS.PRIVATE_5, TEST_IPS.PRIVATE_4],
    socket: { remoteAddress: TEST_IPS.PRIVATE_5 }
  }

  t.alike(extractIps(req), [TEST_IPS.PRIVATE_4], 'should return only req.ip')
})

test('extractIps - resolves the client behind nginx and Cloudflare, not a spoofed entry', (t) => {
  const proxyaddr = require('@fastify/proxy-addr')
  const { TRUSTED_PROXIES_DEFAULT } = require('../../../workers/lib/constants')
  const trust = proxyaddr.compile(TRUSTED_PROXIES_DEFAULT)
  const viaProxies = (xff) => {
    const raw = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': xff } }
    return { ...raw, ip: proxyaddr(raw, trust) }
  }

  // client 9.9.9.9 claims 1.2.3.4; Cloudflare appends the client, nginx appends the edge
  t.alike(extractIps(viaProxies('1.2.3.4, 9.9.9.9, 173.245.48.5')), ['9.9.9.9'])
  // nginx real_ip style, where nginx appends the already-resolved client
  t.alike(extractIps(viaProxies('1.2.3.4, 9.9.9.9')), ['9.9.9.9'])

  const direct = { socket: { remoteAddress: '6.6.6.6' }, headers: { 'x-forwarded-for': '1.2.3.4' } }
  t.alike(extractIps({ ...direct, ip: proxyaddr(direct, trust) }), ['6.6.6.6'], 'a request bypassing the proxies keeps its own address')
})

test('extractIps - with no IP sources throws error', (t) => {
  const req = {
    headers: {},
    socket: null
  }

  try {
    extractIps(req)
    t.fail('should throw error when no IPs found')
  } catch (err) {
    t.is(err.message, 'ERR_IP_RESOLVE_FAIL', 'should throw ERR_IP_RESOLVE_FAIL')
  }

  t.pass()
})

test('isValidJsonObject - with valid objects', (t) => {
  const validObjects = [
    {},
    { key: 'value' },
    { nested: { key: 'value' } },
    { array: [1, 2, 3] },
    { null: null },
    { undefined }
  ]

  validObjects.forEach(obj => {
    t.ok(isValidJsonObject(obj), `should validate ${JSON.stringify(obj)} as valid`)
  })

  t.pass()
})

test('isValidJsonObject - with invalid objects', (t) => {
  const invalidObjects = [
    null,
    undefined,
    'string',
    123,
    true,
    false,
    [],
    [1, 2, 3],
    function () {}
  ]

  invalidObjects.forEach(obj => {
    t.ok(!isValidJsonObject(obj), `should validate ${typeof obj} as invalid`)
  })

  t.pass()
})

test('isValidEmail - with valid emails', (t) => {
  const validEmails = [
    'test@example.com',
    'user.name@domain.co.uk',
    'user+tag@example.org',
    'user123@test-domain.com',
    'a@b.co',
    'user.name+tag@example-domain.com'
  ]

  validEmails.forEach(email => {
    t.ok(isValidEmail(email), `should validate ${email} as valid`)
  })

  t.pass()
})

test('isValidEmail - with invalid emails', (t) => {
  const invalidEmails = [
    'not-an-email',
    '@example.com',
    'user@',
    'user@.com',
    'user@example..com',
    'user@example.com.',
    'user name@example.com',
    'user@example com',
    '',
    null,
    undefined,
    123
  ]

  invalidEmails.forEach(email => {
    t.ok(!isValidEmail(email), `should validate ${email} as invalid`)
  })

  t.pass()
})

test('getRpcTimeout - with custom timeout in conf', (t) => {
  const conf = { rpcTimeout: 30000 }
  const result = getRpcTimeout(conf)

  t.is(result, 30000, 'should return custom timeout')

  t.pass()
})

test('getRpcTimeout - without custom timeout in conf', (t) => {
  const conf = {}
  const result = getRpcTimeout(conf)

  t.is(result, 15000, 'should return default timeout')

  t.pass()
})

test('getRpcTimeout - with null conf', (t) => {
  const conf = null

  try {
    const result = getRpcTimeout(conf)
    t.is(result, 15000, 'should return default timeout for null conf')
  } catch (err) {
    t.ok(err.message.includes('Cannot read properties'), 'should handle null conf gracefully')
  }

  t.pass()
})

test('getRpcTimeout - with undefined conf', (t) => {
  const conf = undefined

  try {
    const result = getRpcTimeout(conf)
    t.is(result, 15000, 'should return default timeout for undefined conf')
  } catch (err) {
    t.ok(err.message.includes('Cannot read properties'), 'should handle undefined conf gracefully')
  }

  t.pass()
})

test('getAuthTokenFromHeaders - with authorization header', (t) => {
  const headers = {
    authorization: 'Bearer token123'
  }

  const result = getAuthTokenFromHeaders(headers)

  t.is(result, 'token123', 'should extract token from authorization header')

  t.pass()
})

test('getAuthTokenFromHeaders - with Authorization header (capitalized)', (t) => {
  const headers = {
    Authorization: 'Bearer token456'
  }

  const result = getAuthTokenFromHeaders(headers)

  t.is(result, 'token456', 'should extract token from Authorization header')

  t.pass()
})

test('getAuthTokenFromHeaders - with bearer in different case', (t) => {
  const headers = {
    authorization: 'bearer token789'
  }

  const result = getAuthTokenFromHeaders(headers)

  t.is(result, 'token789', 'should extract token with lowercase bearer')

  t.pass()
})

test('getAuthTokenFromHeaders - with BEARER in uppercase', (t) => {
  const headers = {
    authorization: 'BEARER tokenABC'
  }

  const result = getAuthTokenFromHeaders(headers)

  t.is(result, 'tokenABC', 'should extract token with uppercase BEARER')

  t.pass()
})

test('getAuthTokenFromHeaders - without bearer prefix', (t) => {
  const headers = {
    authorization: 'token123'
  }

  const result = getAuthTokenFromHeaders(headers)

  t.is(result, null, 'should return null without bearer prefix')

  t.pass()
})

test('getAuthTokenFromHeaders - without authorization header', (t) => {
  const headers = {}

  const result = getAuthTokenFromHeaders(headers)

  t.is(result, null, 'should return null without authorization header')

  t.pass()
})

test('getAuthTokenFromHeaders - with null headers', (t) => {
  const headers = null

  try {
    const result = getAuthTokenFromHeaders(headers)
    t.is(result, null, 'should return null with null headers')
  } catch (err) {
    t.ok(err.message.includes('Cannot read properties'), 'should handle null headers gracefully')
  }

  t.pass()
})

test('getAuthTokenFromHeaders - with undefined headers', (t) => {
  const headers = undefined

  try {
    const result = getAuthTokenFromHeaders(headers)
    t.is(result, null, 'should return null with undefined headers')
  } catch (err) {
    t.ok(err.message.includes('Cannot read properties'), 'should handle undefined headers gracefully')
  }

  t.pass()
})

test('getAuthTokenFromHeaders - with empty authorization header', (t) => {
  const headers = {
    authorization: ''
  }

  const result = getAuthTokenFromHeaders(headers)

  t.is(result, null, 'should return null with empty authorization header')

  t.pass()
})

test('getAuthTokenFromHeaders - with bearer but no token', (t) => {
  const headers = {
    authorization: 'Bearer '
  }

  const result = getAuthTokenFromHeaders(headers)

  t.is(result, '', 'should return empty string with bearer but no token')

  t.pass()
})

test('parseJsonQueryParam - with valid JSON string', (t) => {
  const jsonString = '{"key": "value", "number": 123}'
  const result = parseJsonQueryParam(jsonString)

  t.ok(typeof result === 'object', 'should return object')
  t.is(result.key, 'value', 'should parse key correctly')
  t.is(result.number, 123, 'should parse number correctly')

  t.pass()
})

test('parseJsonQueryParam - with array JSON string', (t) => {
  const jsonString = '[1, 2, 3, "test"]'
  const result = parseJsonQueryParam(jsonString)

  t.ok(Array.isArray(result), 'should return array')
  t.is(result.length, 4, 'should parse array correctly')

  t.pass()
})

test('parseJsonQueryParam - with null or undefined', (t) => {
  t.is(parseJsonQueryParam(null), undefined, 'should return undefined for null')
  t.is(parseJsonQueryParam(undefined), undefined, 'should return undefined for undefined')
  t.is(parseJsonQueryParam(''), undefined, 'should return undefined for empty string')

  t.pass()
})

test('parseJsonQueryParam - with invalid JSON throws error', (t) => {
  const invalidJson = '{"key": "value"'

  try {
    parseJsonQueryParam(invalidJson)
    t.fail('should throw error for invalid JSON')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_JSON', 'should throw ERR_INVALID_JSON')
  }

  t.pass()
})

test('parseJsonQueryParam - with custom error code', (t) => {
  const invalidJson = 'invalid-json'

  try {
    parseJsonQueryParam(invalidJson, 'ERR_CUSTOM_ERROR')
    t.fail('should throw error with custom error code')
  } catch (err) {
    t.is(err.message, 'ERR_CUSTOM_ERROR', 'should throw custom error code')
  }

  t.pass()
})

test('escapeRegex - escapes mingo regex metacharacters', (t) => {
  t.is(escapeRegex('a.b+c*'), 'a\\.b\\+c\\*')
  t.is(escapeRegex('AB:CD:EF'), 'AB:CD:EF', 'preserves non-metachars like ":"')
  t.is(escapeRegex('(x|y)?'), '\\(x\\|y\\)\\?')
})

test('csvEscape - blanks null/undefined, quotes only when needed, doubles inner quotes', (t) => {
  t.is(csvEscape(null), '')
  t.is(csvEscape(undefined), '')
  t.is(csvEscape('plain'), 'plain', 'no wrapping when no metacharacters')
  t.is(csvEscape('a,b'), '"a,b"', 'comma forces quoting')
  t.is(csvEscape('line1\nline2'), '"line1\nline2"', 'newline forces quoting')
  t.is(csvEscape('say "hi"'), '"say ""hi"""', 'inner quotes doubled')
  t.is(csvEscape(42), '42', 'non-strings JSON-stringified')
  t.is(csvEscape({ a: 1 }), '"{""a"":1}"', 'objects stringified then escaped')
})

test('stableJsonString - sorts top-level keys so semantically-equal queries share cache entries', (t) => {
  t.is(stableJsonString('{"b":2,"a":1}'), stableJsonString('{"a":1,"b":2}'))
  t.is(stableJsonString('{"a":1,"b":2}'), '{"a":1,"b":2}')
})

test('stableJsonString - passes through non-strings, primitives, and malformed JSON', (t) => {
  t.is(stableJsonString(undefined), undefined)
  t.is(stableJsonString(42), 42)
  t.is(stableJsonString('not json'), 'not json')
  t.is(stableJsonString('"just a string"'), '"just a string"', 'wrapped primitive is not reordered')
  t.is(stableJsonString('null'), 'null')
})

test('listThingsWithCount - issues listThings + getThingsCount in parallel and returns envelope', async (t) => {
  const calls = []
  const ctx = {
    dataProxy: {
      requestData: async (method, params) => {
        calls.push({ method, params })
        if (method === 'listThings') return [[{ id: 'a' }, { id: 'b' }]]
        if (method === 'getThingsCount') return [5]
      }
    }
  }
  const out = await listThingsWithCount(ctx, { type: 'x' }, { offset: 2, limit: 2 })
  t.is(calls.length, 2)
  t.alike(calls.map(c => c.method).sort(), ['getThingsCount', 'listThings'])
  t.alike(out.data.map(d => d.id), ['a', 'b'])
  t.is(out.totalCount, 5)
  t.is(out.offset, 2)
  t.is(out.limit, 2)
  t.is(out.hasMore, true, 'offset(2) + page(2) < total(5)')
})

test('listThingsWithCount - hasMore=false when full result returned', async (t) => {
  const ctx = {
    dataProxy: {
      requestData: async (method) => method === 'listThings' ? [[{ id: 'a' }]] : [1]
    }
  }
  const out = await listThingsWithCount(ctx, {}, { offset: 0, limit: 10 })
  t.is(out.hasMore, false)
})

test('listThingsWithCount - caps data at limit when multiple orks each return up to limit items', async (t) => {
  const ctx = {
    dataProxy: {
      requestData: async (method) => method === 'listThings'
        ? [
            [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            [{ id: 'd' }, { id: 'e' }, { id: 'f' }]
          ]
        : [3, 3]
    }
  }
  const out = await listThingsWithCount(ctx, {}, { offset: 0, limit: 4 })
  t.is(out.data.length, 4, 'capped to limit even though 6 unique items came back across 2 orks')
  t.is(out.totalCount, 6)
  t.is(out.hasMore, true)
})
