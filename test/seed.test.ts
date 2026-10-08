import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

it('reads the seeded users', async () => {
  const { results } = await env.DB.prepare('select name from users order by id').all()
  expect(results.map((u) => u.name)).toEqual(['Mira', 'Ana', 'Budi', 'Citra', 'Dimas', 'Eka', 'Fajar'])
})

it('rejects a task status outside the four', async () => {
  await expect(env.DB.prepare("update tasks set status = 'cancelled' where id = 1").run()).rejects.toThrow(/CHECK/)
})

it('gives each test a fresh database', async () => {
  await env.DB.prepare('delete from users where id = 7').run()
  expect((await env.DB.prepare('select count(*) n from users').first())!.n).toBe(6)
})

it('still has every user after the previous test deleted one', async () => {
  expect((await env.DB.prepare('select count(*) n from users').first())!.n).toBe(7)
})
