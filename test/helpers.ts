import { env } from 'cloudflare:workers'
import app from '../src/index'

export async function login(email = 'mira@arcbyte.dev') {
  const res = await app.request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'password' }) }, env)
  return ((await res.json()) as { token: string }).token
}

/** A request as [token]'s user. */
export const api = (token: string, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } }, env)
