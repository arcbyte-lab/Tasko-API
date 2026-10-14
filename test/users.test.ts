import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { api, login } from './helpers'

let mira: string
beforeEach(async () => {
  mira = await login()
})

const search = async (q?: string) => (await api(mira, q === undefined ? '/users' : `/users?q=${encodeURIComponent(q)}`)).json() as Promise<any[]>

it('finds active users by name or email, any case', async () => {
  expect(await search('BUDI')).toEqual([{ id: 3, name: 'Budi', email: 'budi@arcbyte.dev' }])
  expect((await search('@arcbyte.dev')).length).toBeGreaterThan(1)
  expect(await search('nobody')).toEqual([])
})

it('leaves out inactive users', async () => {
  await env.DB.prepare('update users set is_active = 0 where id = 3').run()
  expect(await search('budi')).toEqual([])
})

it('treats % and _ as plain text', async () => {
  expect(await search('%')).toEqual([])
  expect(await search('_')).toEqual([])
})

it('returns at most 20, by name, when q is empty', async () => {
  await env.DB.batch(
    Array.from({ length: 25 }, (_, i) =>
      env.DB.prepare("insert into users (name, email, password) values (?, ?, 'x')").bind(`Zed ${String(i).padStart(2, '0')}`, `zed${i}@example.com`),
    ),
  )
  const all = await search()
  expect(all).toHaveLength(20)
  expect(all.map((u) => u.name)).toEqual([...all.map((u) => u.name)].sort())
  expect(await search('zed')).toHaveLength(20)
})

it('needs a login', async () => {
  expect((await api('nope', '/users')).status).toBe(401)
})
