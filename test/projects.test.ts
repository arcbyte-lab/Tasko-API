import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { api, login } from './helpers'

let ana: string // admin of tech (division 1); Mira is a plain member there
beforeEach(async () => {
  ana = await login('ana@arcbyte.dev')
})

const create = (token: string, body: unknown) => api(token, '/projects', { method: 'POST', body: JSON.stringify(body) })

it('a division admin creates a project, owns it, and sees it as a tab (0010)', async () => {
  const res = await create(ana, { divisionId: 1, name: '  Launch  ', description: 'go', dueDate: '2026-12-31T00:00:00+07:00' })
  expect(res.status).toBe(201)
  const tab = (await res.json()) as any
  expect(tab).toEqual({ kind: 'project', id: expect.any(Number), name: 'Launch', role: 'owner' })

  const row = await env.DB.prepare('select status, creator_id, division_id, due_date, description from projects where id = ?').bind(tab.id).first()
  expect(row).toEqual({ status: 'planning', creator_id: 2, division_id: 1, due_date: '2026-12-31', description: 'go' })
  const { results } = await env.DB.prepare('select user_id, role, invited_by from project_members where project_id = ?').bind(tab.id).all()
  expect(results).toEqual([{ user_id: 2, role: 'owner', invited_by: null }])

  const tabs = (await (await api(ana, '/tabs')).json()) as any[]
  expect(tabs.some((t) => t.kind === 'project' && t.id === tab.id)).toBe(true)
})

it('a supervisor can create one too', async () => {
  await env.DB.prepare("update division_members set role_type = 'supervisor' where user_id = 2 and division_id = 1").run()
  expect((await create(ana, { divisionId: 1, name: 'x' })).status).toBe(201)
})

it('a plain member, an outsider or a deleted division gets 403', async () => {
  expect((await create(await login(), { divisionId: 1, name: 'x' })).status).toBe(403)
  expect((await create(ana, { divisionId: 999, name: 'x' })).status).toBe(403)
  await env.DB.prepare("update divisions set deleted_at = datetime('now') where id = 1").run()
  expect((await create(ana, { divisionId: 1, name: 'x' })).status).toBe(403)
  expect((await env.DB.prepare('select count(*) n from projects where name = ?').bind('x').first('n'))).toBe(0)
})

it('refuses a bad body', async () => {
  for (const body of [{ divisionId: 1, name: '  ' }, { divisionId: 1 }, { name: 'x' }, { divisionId: '1', name: 'x' }, { divisionId: 1, name: 'x', dueDate: 'soon' }, [1]]) {
    expect((await create(ana, body)).status).toBe(400)
  }
})
