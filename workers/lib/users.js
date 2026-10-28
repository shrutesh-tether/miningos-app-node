'use strict'
const { SUPER_ADMIN_ID } = require('./constants')

// An unbound login is admitted only within this long of an admin creating or saving the user, or of the user's last activity
const OAUTH_BIND_WINDOW_SEC = 14 * 24 * 60 * 60

class UserService {
  constructor ({ sqlite, auth }) {
    this._auth = auth
    this._sqlite = sqlite
  }

  async init () {
    await this._sqlite.execAsync('CREATE TABLE IF NOT EXISTS oauth_subjects (userId INTEGER NOT NULL, email TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY (userId, email, provider))')
    await this._sqlite.execAsync('CREATE TABLE IF NOT EXISTS oauth_bind_windows (userId INTEGER NOT NULL, email TEXT NOT NULL, openedAt INTEGER NOT NULL, PRIMARY KEY (userId, email))')
  }

  // First login binds the provider's immutable subject; a later login for the same row and email must present it again
  async bindOAuthSubject (email, provider, subject) {
    const user = await this._auth.getUserByEmail(email)
    if (!user) return

    const key = [user.id, email, provider]
    const existing = await this._sqlite.getAsync('SELECT subject FROM oauth_subjects WHERE userId = ? AND email = ? AND provider = ?', key)
    if (!existing && !await this._canBindOAuthSubject(user, email)) {
      throw new Error('ERR_OAUTH_BIND_WINDOW_CLOSED')
    }

    await this._sqlite.runAsync('INSERT OR IGNORE INTO oauth_subjects (userId, email, provider, subject) VALUES (?, ?, ?, ?)', [...key, subject])
    const bound = await this._sqlite.getAsync('SELECT subject FROM oauth_subjects WHERE userId = ? AND email = ? AND provider = ?', key)
    if (bound.subject !== subject) {
      throw new Error('ERR_USER_INVALID')
    }
  }

  // A row nobody has used or touched lately may sit at a lapsed domain, so whoever holds that address now must not claim it
  async _canBindOAuthSubject (user, email) {
    const since = Math.floor(Date.now() / 1000) - OAUTH_BIND_WINDOW_SEC
    if (user.lastActiveAt >= since) return true

    const window = await this._sqlite.getAsync('SELECT openedAt FROM oauth_bind_windows WHERE userId = ? AND email = ?', [user.id, email])
    if (window?.openedAt >= since) return true

    // The super admin is seeded from config and cannot be saved through the API, so its first binding is left open
    if (user.id.toString() === SUPER_ADMIN_ID) {
      const anyBound = await this._sqlite.getAsync('SELECT 1 FROM oauth_subjects WHERE userId = ? AND email = ?', [user.id, email])
      return !anyBound
    }

    return false
  }

  async _openOAuthBindWindow (userId, email) {
    await this._sqlite.runAsync('INSERT OR REPLACE INTO oauth_bind_windows (userId, email, openedAt) VALUES (?, ?, ?)', [userId, email, Math.floor(Date.now() / 1000)])
  }

  parseUserRow (userRow) {
    const { email, roles, name, id, lastActiveAt } = userRow
    const role = JSON.parse(roles)[0]
    return {
      id,
      email,
      name,
      role,
      lastActiveAt
    }
  }

  async createUser ({ email, name, role }) {
    const normalizedEmail = email.toLowerCase()
    await this._auth.createUser({
      email: normalizedEmail,
      name,
      roles: [role]
    })

    const user = await this._auth.getUserByEmail(normalizedEmail)
    await this._openOAuthBindWindow(user.id, normalizedEmail)
    return this.parseUserRow(user)
  }

  async listUsers () {
    const userRows = await this._auth.listUsers()

    return userRows.filter(user => user.id !== 1).map(this.parseUserRow.bind(this))
  }

  async updateUser ({ id, email, name = null, role, callerRoles }) {
    const targetUser = await this._auth.getUserById(id)
    if (!targetUser) {
      throw new Error('ERR_USER_NOT_FOUND')
    }

    const token = await this._auth.genToken({
      ips: ['127.0.0.1'],
      userId: id,
      roles: callerRoles
    })

    await this._auth.updateUser({
      token,
      email: email.toLowerCase(),
      name,
      roles: [role]
    })

    // Saving a user is how an admin re-invites one whose window has lapsed
    await this._openOAuthBindWindow(id, email.toLowerCase())

    const user = await this._auth.getUserById(id)
    return this.parseUserRow(user)
  }

  async deleteUser (id) {
    const result = await this._auth.deleteUser(id)
    await this._sqlite.runAsync('DELETE FROM oauth_subjects WHERE userId = ?', [id])
    await this._sqlite.runAsync('DELETE FROM oauth_bind_windows WHERE userId = ?', [id])
    return result
  }

  getUser (id) {
    return this._auth.getUserById(id)
  }
}

module.exports = {
  UserService
}
