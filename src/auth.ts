import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { HTTPException } from 'hono/http-exception'

export type User = { id: number; name: string; email: string }
export type AppEnv = { Bindings: CloudflareBindings; Variables: { user: User; tokenId: number } }

const ITERATIONS = 100_000 // the most PBKDF2 iterations Workers allows

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
}

/** `pbkdf2_sha256$<iterations>$<salt>$<hash>`, salt and hash in base64. */
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2_sha256$${ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITERATIONS))}`
}

async function verifyPassword(password: string, stored: string) {
  const [scheme, iterations, salt, hash] = stored.split('$')
  if (scheme !== 'pbkdf2_sha256') return false
  const actual = await pbkdf2(password, unb64(salt), Number(iterations))
  return crypto.subtle.timingSafeEqual(actual, unb64(hash))
}

// Checked when the email is unknown, so that answer takes as long as a wrong password.
const DUMMY_HASH = `pbkdf2_sha256$${ITERATIONS}$${'A'.repeat(22)}==$${'A'.repeat(43)}=`

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (token: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))

export const auth = new Hono<AppEnv>()

auth.post('/login', async (c) => {
  const { email, password } = await c.req.json<{ email?: unknown; password?: unknown }>().catch(() => ({}) as never)
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new HTTPException(400, { message: 'email and password are required' })
  }
  const row = await c.env.DB.prepare('select id, name, email, password, is_active from users where email = ?')
    .bind(email)
    .first<User & { password: string; is_active: number }>()
  const ok = await verifyPassword(password, row?.password ?? DUMMY_HASH)
  if (!row || !ok || !row.is_active) throw new HTTPException(401, { message: 'Invalid email or password' })

  const token = hex(crypto.getRandomValues(new Uint8Array(32)))
  await c.env.DB.prepare(
    "insert into personal_access_tokens (tokenable_type, tokenable_id, name, token, created_at, updated_at) values ('user', ?, 'app', ?, datetime('now'), datetime('now'))",
  )
    .bind(row.id, await sha256(token))
    .run()
  return c.json({ token, user: { id: row.id, name: row.name, email: row.email } })
})

/** Every route but login: a live token for an active user. */
export const requireUser = bearerAuth<AppEnv>({
  verifyToken: async (token, c) => {
    const row = await c.env.DB.prepare(
      `select t.id token_id, u.id, u.name, u.email from personal_access_tokens t
       join users u on u.id = t.tokenable_id and t.tokenable_type = 'user'
       where t.token = ? and u.is_active = 1 and (t.expires_at is null or t.expires_at > datetime('now'))`,
    )
      .bind(await sha256(token))
      .first<User & { token_id: number }>()
    if (!row) return false
    await c.env.DB.prepare("update personal_access_tokens set last_used_at = datetime('now') where id = ?").bind(row.token_id).run()
    c.set('user', { id: row.id, name: row.name, email: row.email })
    c.set('tokenId', row.token_id)
    return true
  },
})

auth.post('/logout', requireUser, async (c) => {
  await c.env.DB.prepare('delete from personal_access_tokens where id = ?').bind(c.get('tokenId')).run()
  return c.body(null, 204)
})
