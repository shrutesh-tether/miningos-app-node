'use strict'

class AuthLib {
  constructor ({ httpc, httpd, userService, auth, microsoftTenant }) {
    this._httpc = httpc
    this._httpd = httpd
    this._userService = userService
    this._auth = auth
    this._microsoftTenant = microsoftTenant
  }

  _permsMatch (perms, perm) {
    const [key, required] = perm.split(':')
    const av = perms.find(p => p.startsWith(`${key}:`))?.split(':')[1] ?? ''
    return [...required].every(c => av.includes(c))
  }

  async start () {
    await this._userService.init()
    this._auth.addHandlers({
      google: this._resolveOAuthGoogle.bind(this),
      microsoft: this._resolveOAuthMicrosoft.bind(this)
    })
  }

  async regenerateToken ({ oldToken, ips, ttl = 300, pfx = 'pub', scope = 'api', roles = [] }) {
    return await this._auth.regenerateToken({
      oldToken,
      ips,
      ttl,
      pfx,
      scope,
      roles
    })
  }

  async resolveToken (token, ips) {
    return await this._auth.resolveToken(token, ips, { updateLastActive: true })
  }

  async getTokenPerms (token) {
    const { superadmin: superAdmin, perms = [] } = this._auth.getTokenPerms(token)
    const write = superAdmin || this._permsMatch(perms, 'actions:w')
    const applicablePerms = superAdmin ? (this._auth.conf.superAdminPerms ?? []) : perms
    const caps = applicablePerms.map(perm => perm.split(':')[0])

    return { write, caps, superAdmin, permissions: applicablePerms }
  }

  async tokenHasPerms (token, write, requestedPerms, matchAll = false) {
    const perms = await this.getTokenPerms(token)
    if (perms.superAdmin) {
      return true
    }

    if (write && !perms.write) {
      return false
    }

    const level = write ? 'rw' : 'r'
    const resolved = requestedPerms.map(perm => {
      const qualified = perm.includes(':') ? perm : `${perm}:${level}`
      return this._permsMatch(perms.permissions, qualified)
    })

    return matchAll
      ? resolved.every(res => res)
      : resolved.some(res => res)
  }

  async cleanupTokens () {
    await this._auth.cleanupTokens()
  }

  async _resolveOAuthGoogle (ctx, req) {
    const oauthRes = await this._httpd.server.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(req)
    const { body: info } = await this._httpc.get(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { authorization: 'Bearer ' + oauthRes.token.access_token },
        encoding: 'json'
      }
    )

    if (!info?.verified_email || !info.id) {
      return null
    }

    await this._userService.bindOAuthSubject(info.email, 'google', info.id)
    return {
      email: info.email
    }
  }

  async _resolveOAuthMicrosoft (ctx, req) {
    let accessToken, idToken
    try {
      const oauthRes = await this._httpd.server.microsoftOAuth2.getAccessTokenFromAuthorizationCodeFlow(req)
      accessToken = oauthRes?.token?.access_token
      idToken = oauthRes?.token?.id_token
    } catch (err) {
      const msg = err?.response?.body?.error_description || err?.message || 'ERR_MICROSOFT_TOKEN_EXCHANGE_FAILED'
      throw new Error(msg)
    }

    if (!accessToken) {
      throw new Error('ERR_MICROSOFT_TOKEN_MISSING')
    }

    // id_token comes straight from the token endpoint over TLS, so its claims need no signature check (OIDC Core 3.1.3.7)
    const { tid, oid } = idToken ? JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url')) : {}
    if (!oid || tid !== this._microsoftTenant) {
      throw new Error('ERR_MICROSOFT_TENANT_INVALID')
    }

    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,otherMails', {
      headers: { authorization: 'Bearer ' + accessToken }
    })

    if (!graphRes.ok) {
      const bodyText = await graphRes.text()
      throw new Error(`ERR_MICROSOFT_GRAPH_${graphRes.status}: ${bodyText}`)
    }

    const profile = await graphRes.json()

    if (!profile) {
      return null
    }

    const isAzureGuestUpn = (value) => typeof value === 'string' && value.includes('#EXT#')
    const { mail, userPrincipalName, otherMails } = profile

    let email = null
    if (mail && !isAzureGuestUpn(mail)) {
      email = mail
    } else if (Array.isArray(otherMails) && otherMails[0]) {
      email = otherMails[0]
    } else if (mail) {
      email = mail
    } else if (userPrincipalName && !isAzureGuestUpn(userPrincipalName)) {
      email = userPrincipalName
    } else {
      email = userPrincipalName || null
    }

    if (!email) {
      return null
    }

    await this._userService.bindOAuthSubject(email.toLowerCase(), 'microsoft', oid)
    return { email: email.toLowerCase() }
  }
}

module.exports = AuthLib
