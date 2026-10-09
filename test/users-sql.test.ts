import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { usersSql } from '../scripts/users-sql'
import app from '../src/index'

const login = (email: string, password: string) =>
  app.request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }, env)

it('creates users who can log in and must change their password', async () => {
  const { statements, generated } = await usersSql([
    { name: "Gita O'Brien", email: 'gita@example.com', password: 's3cret!' },
    { name: 'Hadi', email: 'hadi@example.com' },
  ])
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)))

  const gita = await login('gita@example.com', 's3cret!')
  expect(gita.status).toBe(200)
  expect(((await gita.json()) as any).user).toMatchObject({ name: "Gita O'Brien", mustChangePassword: true })

  expect(Object.keys(generated)).toEqual(['hadi@example.com'])
  expect((await login('hadi@example.com', generated['hadi@example.com'])).status).toBe(200)
})

it('refuses a user without a name or email', async () => {
  await expect(usersSql([{ name: 'x', email: 'nope' }])).rejects.toThrow('name and an email')
})
