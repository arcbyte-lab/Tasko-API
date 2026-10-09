import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { api, login } from './helpers'

let mira: string
beforeEach(async () => {
  mira = await login()
})

const json = async (path: string, token = mira) => (await api(token, path)).json() as Promise<any>

it('lists private, then divisions, then projects', async () => {
  expect(await json('/tabs')).toEqual([
    { kind: 'private', id: 0, name: 'private' },
    { kind: 'division', id: 1, name: 'tech' },
    { kind: 'project', id: 1, name: 'tasko-app' },
    { kind: 'project', id: 2, name: 'tasko-web' },
  ])
})

it('leaves out archived projects, and one the viewer created but is no longer a member of (0002)', async () => {
  await env.DB.prepare("update projects set status = 'archived' where id = 1").run()
  expect((await json('/tabs')).map((t: any) => t.name)).toEqual(['private', 'tech', 'tasko-web'])
  await env.DB.prepare('delete from project_members where project_id = 2 and user_id = 1').run()
  expect((await json('/tabs')).map((t: any) => t.name)).toEqual(['private', 'tech'])
  expect((await api(mira, '/tabs/project/2/tasks')).status).toBe(403)
})

it('private holds only the viewer’s top-level personal tasks, mapped to the Task shape', async () => {
  const tasks = await json('/tabs/private/0/tasks')
  expect(tasks.map((t: any) => t.name)).toEqual([
    'Buy domain', 'Renew passport', 'Book dentist', 'Pay internet bill', 'Read Flutter release notes', 'Buy groceries',
  ])
  expect(tasks[0]).toMatchObject({ personal: true, status: 'todo', priority: 'medium', code: null, assigneeId: null, parentId: null })
  expect(tasks[0].dueDate).toMatch(/^\d{4}-\d\d-\d\dT17:00:00Z$/) // local (UTC+7) midnight
  expect(await json('/tabs/private/0/tasks', await login('ana@arcbyte.dev'))).toEqual([])
})

it('a division tab holds only tasks with no project', async () => {
  const tasks = await json('/tabs/division/1/tasks')
  expect(tasks.map((t: any) => t.code)).toEqual(['TECH-0001'])
})

it('a project tab holds its top-level tasks', async () => {
  const web = await json('/tabs/project/2/tasks')
  expect(web).toHaveLength(15)
  expect(web.every((t: any) => t.parentId === null && t.personal === false)).toBe(true)
  expect(web[0]).toMatchObject({
    code: 'TW-0041', status: 'inProgress', priority: 'urgent', requiredProofType: 'image', assigneeId: 1,
  })
  expect(web[0].dueDate).toMatch(/T10:00:00Z$/) // 17:00 local
  expect((await json('/tabs/project/1/tasks')).map((t: any) => t.code)).toEqual(['TA-0011', 'TA-0012', 'TA-0013', 'TA-0014'])
})

it('lists members with the viewer first; private has none', async () => {
  const members = await json('/tabs/project/2/members', await login('budi@arcbyte.dev'))
  expect(members[0]).toEqual({ user: { id: 3, name: 'Budi' }, role: 'member' })
  expect(members.map((m: any) => m.user.id)).toEqual([3, 1, 2, 4, 5, 6, 7])
  expect(members[1].role).toBe('owner')
  expect((await json('/tabs/division/1/members'))[1]).toEqual({ user: { id: 2, name: 'Ana' }, role: 'admin' })
  expect(await json('/tabs/private/0/members')).toEqual([])
})

it('returns 403 for a division or project the viewer is not in', async () => {
  await env.DB.batch([
    env.DB.prepare("insert into divisions (id, prefix, name, slug) values (2, 'OPS', 'ops', 'ops')"),
    env.DB.prepare("insert into projects (id, name, creator_id, division_id) values (3, 'secret', 2, 2)"),
  ])
  for (const path of ['/tabs/division/2/tasks', '/tabs/division/2/members', '/tabs/project/3/tasks', '/tabs/project/3/members']) {
    expect((await api(mira, path)).status, path).toBe(403)
  }
})

it('returns 403 for an archived project or a deleted division, and hides the division’s projects', async () => {
  await env.DB.prepare("update projects set status = 'archived' where id = 1").run()
  for (const path of ['/tabs/project/1/tasks', '/tabs/project/1/members']) {
    expect((await api(mira, path)).status, path).toBe(403)
  }
  await env.DB.prepare("update divisions set deleted_at = datetime('now') where id = 1").run()
  expect((await json('/tabs')).map((t: any) => t.kind)).toEqual(['private'])
  for (const path of ['/tabs/division/1/tasks', '/tabs/division/1/members', '/tabs/project/2/tasks']) {
    expect((await api(mira, path)).status, path).toBe(403)
  }
})

it('the private tab is only id 0', async () => {
  expect((await api(mira, '/tabs/private/5/tasks')).status).toBe(404)
  expect((await api(mira, '/tabs/private/5/members')).status).toBe(404)
})

it('sends a date-only due date as midnight UTC', async () => {
  await env.DB.prepare("update personal_tasks set due_date = '2026-10-12' where id = 1").run()
  expect((await json('/tabs/private/0/tasks'))[0].dueDate).toBe('2026-10-12T00:00:00Z')
})

it('needs a token', async () => {
  expect((await api('nope', '/tabs')).status).toBe(401)
})
