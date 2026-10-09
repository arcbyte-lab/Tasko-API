import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../src/index'

const post = (path: string, body: unknown, token?: string) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: token ? { Authorization: `Bearer ${token}` } : {} }, env)
const me = (token?: string) => app.request('/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} }, env)

async function login(email = 'mira@arcbyte.dev') {
  const res = await post('/auth/login', { email, password: 'password' })
  return ((await res.json()) as { token: string }).token
}

describe('login', () => {
  it('returns a token and the user, and stores only its hash', async () => {
    const res = await post('/auth/login', { email: 'mira@arcbyte.dev', password: 'password' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; user: unknown }
    expect(body.user).toEqual({ id: 1, name: 'Mira', email: 'mira@arcbyte.dev' })
    const row = await env.DB.prepare('select tokenable_type, tokenable_id, token from personal_access_tokens').first()
    expect(row).toMatchObject({ tokenable_type: 'user', tokenable_id: 1 })
    expect(row!.token).not.toBe(body.token)
    expect(row!.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('answers a wrong password and an unknown email with the same 401', async () => {
    const wrong = await post('/auth/login', { email: 'mira@arcbyte.dev', password: 'nope' })
    const unknown = await post('/auth/login', { email: 'nobody@arcbyte.dev', password: 'password' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(await wrong.text()).toBe(await unknown.text())
  })

  it('matches the email in any case', async () => {
    expect((await post('/auth/login', { email: 'Mira@Arcbyte.dev', password: 'password' })).status).toBe(200)
  })

  it('answers a null body with 400', async () => {
    expect((await post('/auth/login', null)).status).toBe(400)
  })

  it('answers a malformed stored hash with 401, not 500', async () => {
    for (const bad of ['pbkdf2_sha256$100000$AAAA$AAAA', 'pbkdf2_sha256$999999$AAAA$AAAA', 'pbkdf2_sha256$100000']) {
      await env.DB.prepare('update users set password = ? where id = 1').bind(bad).run()
      expect((await post('/auth/login', { email: 'mira@arcbyte.dev', password: 'password' })).status).toBe(401)
    }
  })

  it('rejects an inactive user', async () => {
    await env.DB.prepare('update users set is_active = 0 where id = 1').run()
    expect((await post('/auth/login', { email: 'mira@arcbyte.dev', password: 'password' })).status).toBe(401)
  })
})

describe('GET /me', () => {
  it('returns the viewer and marks the token used', async () => {
    const res = await me(await login())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 1, name: 'Mira', email: 'mira@arcbyte.dev' })
    expect((await env.DB.prepare('select last_used_at from personal_access_tokens').first())!.last_used_at).not.toBeNull()
  })

  it('rejects a missing or unknown token', async () => {
    expect((await me()).status).toBe(401)
    expect((await me('not-a-token')).status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const token = await login()
    await env.DB.prepare("update personal_access_tokens set expires_at = datetime('now', '-1 minute')").run()
    expect((await me(token)).status).toBe(401)
  })

  it('rejects the token of a user made inactive after login', async () => {
    const token = await login()
    await env.DB.prepare('update users set is_active = 0 where id = 1').run()
    expect((await me(token)).status).toBe(401)
  })
})

it('logout deletes the token', async () => {
  const token = await login()
  expect((await post('/auth/logout', {}, token)).status).toBe(204)
  expect((await me(token)).status).toBe(401)
  expect((await env.DB.prepare('select count(*) n from personal_access_tokens').first())!.n).toBe(0)
})
