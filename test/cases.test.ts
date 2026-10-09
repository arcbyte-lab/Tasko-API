import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { api, login } from './helpers'

// seed/cases.sql, on top of seed.sql: each check is a claim from its header.
let mira: string
beforeEach(async () => {
  await env.DB.batch(env.TEST_CASES.map((q) => env.DB.prepare(q)))
  mira = await login()
})

const json = async (path: string, token = mira) => (await api(token, path)).json() as Promise<any>
const detail = (id: number, token = mira) => json(`/tasks/${id}/detail`, token)

it('Mira sees ops, ops-site, ops-wiki and contracts, and none of the hidden tabs', async () => {
  expect((await json('/tabs')).map((t: any) => t.name)).toEqual([
    'private', 'tech', 'ops', 'tasko-app', 'tasko-web', 'ops-site', 'ops-wiki', 'contracts',
  ])
  for (const id of [40, 41, 42]) expect((await api(mira, `/tasks/${id}/detail`)).status).toBe(403)
})

it('the special logins', async () => {
  const res = await api('', '/auth/login', { method: 'POST', body: JSON.stringify({ email: 'gita@arcbyte.dev', password: 'password' }) })
  expect(((await res.json()) as any).user.mustChangePassword).toBe(true)
  const hadi = await api('', '/auth/login', { method: 'POST', body: JSON.stringify({ email: 'hadi@arcbyte.dev', password: 'password' }) })
  expect(hadi.status).toBe(401)
  expect(await json('/tabs', await login('indah@arcbyte.dev'))).toEqual([{ kind: 'private', id: 0, name: 'private' }])
  expect((await json('/tabs/project/3/members')).map((m: any) => m.user.name)).not.toContain('Hadi')
})

it('who reviews', async () => {
  expect((await detail(25)).canReview).toBe(true) // ops supervisor
  expect((await detail(29)).canReview).toBe(true) // ops-site person-in-charge
  expect((await detail(35)).canReview).toBe(false) // ops-wiki member
  expect((await detail(35, await login('joko@arcbyte.dev'))).canReview).toBe(true) // its person-in-charge
  expect((await api(await login('kiki@arcbyte.dev'), '/tasks/35/detail')).status).toBe(403) // its author left
})

it('proofs, comments and extensions', async () => {
  const wifi = await detail(29)
  expect(wifi.proof.url).toBe('https://photos.example.com/wifi-second-try.jpg')
  expect(wifi.assignee.name).toBe('Hadi')
  expect((await detail(30)).comments.map((c: any) => c.body)).not.toContain('Deleted, so it never shows.')
  expect((await detail(27)).canRequestExtension).toBe(false) // reviewer of her own task
  expect((await detail(37)).canRequestExtension).toBe(true)
  const again = await api(mira, '/tasks/36/deadline-requests', {
    method: 'POST',
    body: JSON.stringify({ newDue: '2099-01-01', reason: 'again' }),
  })
  expect(again.status).toBe(409)
})

it('the bell has every type, and an actor that no longer exists reads "Someone"', async () => {
  const texts = (await json('/notifications')).map((n: any) => n.text)
  expect(texts).toContain('Hadi sent Install wifi for review')
  expect(texts).toContain('Ana approved Sign vendor contract')
  expect(texts).toContain('Someone assigned you Review NDA template')
})
