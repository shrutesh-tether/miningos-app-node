'use strict'

const test = require('brittle')
const { UserService } = require('../../../workers/lib/users')

test('UserService - constructor', (t) => {
  const mockAuth = {}
  const mockSqlite = {}
  const userService = new UserService({ sqlite: mockSqlite, auth: mockAuth })

  t.ok(userService._auth === mockAuth, 'should store auth')
  t.ok(userService._sqlite === mockSqlite, 'should store sqlite')

  t.pass()
})

test('UserService - parseUserRow', (t) => {
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: {} })
  const userRow = {
    id: 123,
    email: 'test@example.com',
    name: 'Test User',
    roles: '["admin"]'
  }

  const result = userService.parseUserRow(userRow)

  t.is(result.id, 123, 'should parse id')
  t.is(result.email, 'test@example.com', 'should parse email')
  t.is(result.name, 'Test User', 'should parse name')
  t.is(result.role, 'admin', 'should parse role from JSON')

  t.pass()
})

test('UserService - createUser lowercases email', async (t) => {
  let createUserArgs = null
  let lookedUpEmail = null
  const mockAuth = {
    createUser: async (data) => {
      createUserArgs = data
    },
    getUserByEmail: async (email) => {
      lookedUpEmail = email
      return { id: 123, email, name: 'Test User', roles: '["admin"]' }
    }
  }
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: mockAuth })

  const result = await userService.createUser({
    email: 'Test.User@Example.COM',
    name: 'Test User',
    role: 'admin'
  })

  t.is(createUserArgs.email, 'test.user@example.com', 'should store email in lowercase')
  t.is(lookedUpEmail, 'test.user@example.com', 'should look up user by lowercase email')
  t.is(result.email, 'test.user@example.com', 'should return lowercase email')

  t.pass()
})

test('UserService - createUser', async (t) => {
  let createUserCalled = false
  let createUserArgs = null
  const mockAuth = {
    createUser: async (data) => {
      createUserCalled = true
      createUserArgs = data
    },
    getUserByEmail: async (email) => {
      return { id: 123, email, name: 'Test User', roles: '["admin"]' }
    }
  }
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: mockAuth })

  const result = await userService.createUser({
    email: 'test@example.com',
    name: 'Test User',
    role: 'admin'
  })

  t.ok(createUserCalled, 'should call auth.createUser')
  t.is(createUserArgs.email, 'test@example.com', 'should pass email')
  t.is(createUserArgs.name, 'Test User', 'should pass name')
  t.ok(Array.isArray(createUserArgs.roles), 'should pass roles as array')
  t.is(createUserArgs.roles[0], 'admin', 'should pass correct role')
  t.is(result.id, 123, 'should return created user id')
  t.is(result.email, 'test@example.com', 'should return created user email')
  t.is(result.name, 'Test User', 'should return created user name')
  t.is(result.role, 'admin', 'should return parsed role')

  t.pass()
})

test('UserService - listUsers', async (t) => {
  const mockUsers = [
    { id: 1, email: 'admin@example.com', roles: '["*"]' },
    { id: 2, email: 'user1@example.com', roles: '["user"]' },
    { id: 3, email: 'user2@example.com', roles: '["admin"]' }
  ]
  const mockAuth = {
    listUsers: async () => mockUsers
  }
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: mockAuth })

  const result = await userService.listUsers()

  t.ok(Array.isArray(result), 'should return array')
  t.is(result.length, 2, 'should filter out super admin (id=1)')
  t.is(result[0].id, 2, 'should return first user')
  t.is(result[1].id, 3, 'should return second user')

  t.pass()
})

test('UserService - listUsers with only super admin', async (t) => {
  const mockUsers = [
    { id: 1, email: 'admin@example.com', roles: '["*"]' }
  ]
  const mockAuth = {
    listUsers: async () => mockUsers
  }
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: mockAuth })

  const result = await userService.listUsers()

  t.ok(Array.isArray(result), 'should return array')
  t.is(result.length, 0, 'should return empty array when only super admin exists')

  t.pass()
})

test('UserService - updateUser', async (t) => {
  let genTokenCalled = false
  let updateUserCalled = false
  let updateUserArgs = null
  const mockAuth = {
    genToken: async () => {
      genTokenCalled = true
      return 'mock-token'
    },
    updateUser: async (data) => {
      updateUserCalled = true
      updateUserArgs = data
    },
    getUserById: async (id) => {
      return { id, email: 'updated@example.com', name: 'Updated User', roles: '["admin"]' }
    }
  }
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: mockAuth })

  const result = await userService.updateUser({
    id: 123,
    email: 'updated@example.com',
    name: 'Updated User',
    role: 'admin',
    callerRoles: ['admin']
  })

  t.ok(genTokenCalled, 'should call genToken')
  t.ok(updateUserCalled, 'should call updateUser')
  t.is(updateUserArgs.email, 'updated@example.com', 'should pass email')
  t.is(updateUserArgs.name, 'Updated User', 'should pass name')
  t.ok(Array.isArray(updateUserArgs.roles), 'should pass roles as array')
  t.is(updateUserArgs.roles[0], 'admin', 'should pass correct role')
  t.is(result.id, 123, 'should return updated user id')
  t.is(result.email, 'updated@example.com', 'should return updated user email')
  t.is(result.name, 'Updated User', 'should return updated user name')
  t.is(result.role, 'admin', 'should return parsed role')

  t.pass()
})

test('UserService - updateUser lowercases email', async (t) => {
  let updateUserArgs = null
  const mockAuth = {
    genToken: async () => 'mock-token',
    updateUser: async (data) => {
      updateUserArgs = data
    },
    getUserById: async (id) => {
      return { id, email: 'updated@example.com', name: 'Updated User', roles: '["admin"]' }
    }
  }
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: mockAuth })

  await userService.updateUser({
    id: 123,
    email: 'Updated@Example.COM',
    name: 'Updated User',
    role: 'admin',
    callerRoles: ['admin']
  })

  t.is(updateUserArgs.email, 'updated@example.com', 'should pass email in lowercase')

  t.pass()
})

test('UserService - updateUser with null name', async (t) => {
  let updateUserArgs = null
  const mockAuth = {
    genToken: async () => 'mock-token',
    updateUser: async (data) => {
      updateUserArgs = data
    },
    getUserById: async (id) => {
      return { id, email: 'test@example.com', name: null, roles: '["admin"]' }
    }
  }
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: mockAuth })

  const result = await userService.updateUser({
    id: 123,
    email: 'test@example.com',
    name: null,
    role: 'admin',
    callerRoles: ['admin']
  })

  t.is(updateUserArgs.name, null, 'should pass null name')
  t.is(result.name, null, 'should return null name')

  t.pass()
})

test('UserService - deleteUser', async (t) => {
  let deleteUserCalled = false
  let deleteUserId = null
  const mockAuth = {
    deleteUser: async (id) => {
      deleteUserCalled = true
      deleteUserId = id
      return true
    }
  }
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: mockAuth })

  const result = await userService.deleteUser(123)

  t.ok(deleteUserCalled, 'should call auth.deleteUser')
  t.is(deleteUserId, 123, 'should pass correct id')
  t.is(result, true, 'should return result')

  t.pass()
})

test('UserService - getUser', async (t) => {
  let getUserByIdCalled = false
  let getUserByIdId = null
  const mockUser = { id: 123, email: 'test@example.com' }
  const mockAuth = {
    getUserById: async (id) => {
      getUserByIdCalled = true
      getUserByIdId = id
      return mockUser
    }
  }
  const userService = new UserService({ sqlite: { runAsync: async () => {} }, auth: mockAuth })

  const result = await userService.getUser(123)

  t.ok(getUserByIdCalled, 'should call auth.getUserById')
  t.is(getUserByIdId, 123, 'should pass correct id')
  t.ok(result.id, 'should return user')
  t.is(result.email, 'test@example.com', 'should return correct user')

  t.pass()
})

function memorySqlite () {
  const { promisify } = require('util')
  const sqlite3 = require('sqlite3')
  const db = new sqlite3.Database(':memory:')
  return {
    execAsync: promisify(db.exec.bind(db)),
    runAsync: promisify(db.run.bind(db)),
    getAsync: promisify(db.get.bind(db))
  }
}

const nowSec = () => Math.floor(Date.now() / 1000)

test('UserService - bindOAuthSubject binds the first subject and rejects any other', async (t) => {
  const sqlite = memorySqlite()
  const users = { 'bob@acme.com': { id: 7, lastActiveAt: nowSec() } }
  const userService = new UserService({ sqlite, auth: { getUserByEmail: async (email) => users[email] } })
  await userService.init()
  await userService.init()

  await userService.bindOAuthSubject('bob@acme.com', 'google', 'sub-1')
  await userService.bindOAuthSubject('bob@acme.com', 'google', 'sub-1')
  await userService.bindOAuthSubject('bob@acme.com', 'microsoft', 'oid-1')
  await t.exception(userService.bindOAuthSubject('bob@acme.com', 'google', 'sub-2'), /ERR_USER_INVALID/)

  await userService.bindOAuthSubject('nobody@acme.com', 'google', 'sub-3')
  t.is(await sqlite.getAsync('SELECT * FROM oauth_subjects WHERE email = ?', ['nobody@acme.com']), undefined, 'unknown email binds nothing')

  users['bob@acme.com'] = { id: 8, lastActiveAt: nowSec() }
  await userService.bindOAuthSubject('bob@acme.com', 'google', 'sub-2')
  t.pass('recreated user row rebinds')
})

test('UserService - bindOAuthSubject refuses a first binding for a long-idle row', async (t) => {
  const sqlite = memorySqlite()
  const stale = nowSec() - 60 * 24 * 60 * 60
  const users = {
    'bob@lapsed.com': { id: 7, lastActiveAt: stale },
    'never@lapsed.com': { id: 9, lastActiveAt: null },
    'admin@tether.io': { id: 1, lastActiveAt: null }
  }
  const auth = {
    getUserByEmail: async (email) => users[email],
    getUserById: async (id) => Object.entries(users).map(([email, u]) => ({ ...u, email, roles: '["admin"]' })).find(u => u.id === id),
    genToken: async () => 'token',
    updateUser: async () => {},
    deleteUser: async () => {}
  }
  const userService = new UserService({ sqlite, auth })
  await userService.init()

  await t.exception(userService.bindOAuthSubject('bob@lapsed.com', 'google', 'attacker'), /ERR_OAUTH_BIND_WINDOW_CLOSED/)
  await t.exception(userService.bindOAuthSubject('never@lapsed.com', 'google', 'attacker'), /ERR_OAUTH_BIND_WINDOW_CLOSED/)

  await sqlite.runAsync('INSERT INTO oauth_bind_windows (userId, email, openedAt) VALUES (?, ?, ?)', [7, 'bob@lapsed.com', stale])
  await t.exception(userService.bindOAuthSubject('bob@lapsed.com', 'google', 'attacker'), /ERR_OAUTH_BIND_WINDOW_CLOSED/, 'expired window stays closed')

  await userService.updateUser({ id: 7, email: 'Bob@lapsed.com', role: 'admin', callerRoles: ['*'] })
  await userService.bindOAuthSubject('bob@lapsed.com', 'google', 'bob')
  t.pass('admin save reopens the window')

  await userService.bindOAuthSubject('admin@tether.io', 'google', 'admin-sub')
  await t.exception(userService.bindOAuthSubject('admin@tether.io', 'microsoft', 'other'), /ERR_OAUTH_BIND_WINDOW_CLOSED/, 'idle super admin binds only once')

  await userService.deleteUser(7)
  t.is(await sqlite.getAsync('SELECT * FROM oauth_subjects WHERE userId = 7'), undefined, 'delete drops bindings')
  t.is(await sqlite.getAsync('SELECT * FROM oauth_bind_windows WHERE userId = 7'), undefined, 'delete drops windows')
})
