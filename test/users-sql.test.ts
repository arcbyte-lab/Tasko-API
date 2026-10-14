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

it('creates divisions and puts users in them', async () => {
  const { statements } = await usersSql({
    divisions: [{ prefix: 'FIN', name: 'Finance Ops' }],
    users: [
      { name: 'Ika', email: 'ika@example.com', password: 'p', divisions: { FIN: 'admin' } },
      { name: 'Joko', email: 'joko@example.com', password: 'p' },
    ],
  })
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)))

  expect(await env.DB.prepare("select name, slug from divisions where prefix = 'FIN'").first()).toEqual({ name: 'Finance Ops', slug: 'finance-ops' })
  const { results } = await env.DB.prepare(
    "select u.email, m.role_type from division_members m join users u on u.id = m.user_id join divisions d on d.id = m.division_id where d.prefix = 'FIN'",
  ).all()
  expect(results).toEqual([{ email: 'ika@example.com', role_type: 'admin' }])
})

it('refuses an unknown division or role', async () => {
  const user = (divisions: Record<string, string>) => ({ name: 'x', email: 'x@example.com', password: 'p', divisions })
  await expect(usersSql({ divisions: [{ prefix: 'FIN', name: 'Finance' }], users: [user({ NOPE: 'admin' })] })).rejects.toThrow('no division with prefix NOPE')
  await expect(usersSql({ divisions: [{ prefix: 'FIN', name: 'Finance' }], users: [user({ FIN: 'boss' })] })).rejects.toThrow('role must be one of')
})
