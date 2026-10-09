import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, login } from './helpers'

let mira: string
beforeEach(async () => {
  mira = await login()
})

const send = (method: string, path: string, body: unknown, token = mira) => api(token, path, { method, body: JSON.stringify(body) })
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>

describe('create', () => {
  it('in private: a personal task', async () => {
    const res = await send('POST', '/tabs/private/0/tasks', { name: ' Call mum ', priority: 3, dueDate: '2026-10-10T09:30:00.000Z' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      name: 'Call mum', priority: 3, status: 'todo', personal: true, code: null, dueDate: '2026-10-10T09:30:00Z',
    })
    expect((await env.DB.prepare("select user_id from personal_tasks where title = 'Call mum'").first())!.user_id).toBe(1)
  })

  it('in a division: a team task with the division code and no project', async () => {
    const task = await json(send('POST', '/tabs/division/1/tasks', { name: 'Rotate keys', priority: 2, assigneeId: 3 }))
    expect(task).toMatchObject({ code: 'TECH-0002', status: 'waiting', assigneeId: 3, personal: false })
    const row = await env.DB.prepare('select division_id, project_id, creator_id from tasks where id = ?').bind(task.id).first()
    expect(row).toEqual({ division_id: 1, project_id: null, creator_id: 1 })
  })

  it('in a project: the division comes from the project', async () => {
    const task = await json(send('POST', '/tabs/project/1/tasks', { name: 'Ship beta', priority: 4, description: 'TestFlight first' }))
    expect(task).toMatchObject({ code: 'TECH-0002', description: 'TestFlight first', assigneeId: null })
    const row = await env.DB.prepare('select division_id, project_id from tasks where id = ?').bind(task.id).first()
    expect(row).toEqual({ division_id: 1, project_id: 1 })
  })

  it('numbers codes per division without collisions, even in parallel', async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) => json(send('POST', '/tabs/project/2/tasks', { name: `t${i}`, priority: 2 }))),
    )
    expect(created.map((t) => t.code).sort()).toEqual(['TECH-0002', 'TECH-0003', 'TECH-0004', 'TECH-0005', 'TECH-0006'])
    await env.DB.prepare("insert into divisions (id, prefix, name, slug) values (2, 'OPS', 'ops', 'ops')").run()
    await env.DB.prepare("insert into division_members (user_id, division_id, role_type) values (1, 2, 'member')").run()
    expect((await json(send('POST', '/tabs/division/2/tasks', { name: 'x', priority: 2 }))).code).toBe('OPS-0001')
  })

  it('reads a prefix literally: `_` is not a wildcard and case counts', async () => {
    await env.DB.batch([
      env.DB.prepare("insert into divisions (id, prefix, name, slug) values (2, 'T_', 't', 't')"),
      env.DB.prepare("insert into division_members (user_id, division_id, role_type) values (1, 2, 'member')"),
      env.DB.prepare("insert into divisions (id, prefix, name, slug) values (3, 'tech', 'lower', 'lower')"),
      env.DB.prepare("insert into division_members (user_id, division_id, role_type) values (1, 3, 'member')"),
    ])
    expect((await json(send('POST', '/tabs/division/2/tasks', { name: 'x', priority: 2 }))).code).toBe('T_-0001')
    expect((await json(send('POST', '/tabs/division/3/tasks', { name: 'x', priority: 2 }))).code).toBe('tech-0001')
  })

  it('rejects an assignee from outside the tab', async () => {
    await env.DB.prepare("insert into users (id, name, email, password) values (8, 'Gita', 'gita@arcbyte.dev', '!')").run()
    expect((await send('POST', '/tabs/project/1/tasks', { name: 'x', priority: 2, assigneeId: 8 })).status).toBe(422)
    expect((await send('POST', '/tabs/private/0/tasks', { name: 'x', priority: 2, assigneeId: 1 })).status).toBe(422)
  })

  it('rejects a bad body, and a tab the viewer is not in', async () => {
    expect((await send('POST', '/tabs/project/1/tasks', { priority: 2 })).status).toBe(400)
    expect((await send('POST', '/tabs/project/1/tasks', { name: 'x', priority: 5 })).status).toBe(400)
    expect((await send('POST', '/tabs/project/1/tasks', { name: 'x', priority: 2, dueDate: 'soon' })).status).toBe(400)
    for (const dueDate of ['March 5', '2026-02-30', '2026-13-01', '1']) {
      expect((await send('POST', '/tabs/project/1/tasks', { name: 'x', priority: 2, dueDate })).status, dueDate).toBe(400)
    }
    expect((await send('POST', '/tabs/project/1/tasks', { name: 'x', priority: 2, dueDate: '2026-02-28' })).status).toBe(201)
    for (const body of [null, 'x', 5, []]) {
      expect((await send('POST', '/tabs/project/1/tasks', body)).status, JSON.stringify(body)).toBe(400)
      expect((await send('PATCH', '/tasks/2', body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await send('POST', '/tabs/private/5/tasks', { name: 'x', priority: 2 })).status, 'private is only 0').toBe(404)
    await env.DB.prepare('delete from project_members where project_id = 1 and user_id = 1').run()
    expect((await send('POST', '/tabs/project/1/tasks', { name: 'x', priority: 2 })).status).toBe(403)
  })
})

describe('update', () => {
  it('changes only the fields sent', async () => {
    const task = await json(send('PATCH', '/tasks/2', { name: 'Port the tokens', priority: 1, dueDate: null, assigneeId: 3 }))
    expect(task).toMatchObject({ id: 2, name: 'Port the tokens', priority: 1, dueDate: null, assigneeId: 3, status: 'waiting', code: 'TA-0012' })
  })

  it('a personal task maps name and description to title and note', async () => {
    const task = await json(send('PATCH', '/personal-tasks/2', { name: 'Renew ID', description: 'bring photos' }))
    expect(task).toMatchObject({ name: 'Renew ID', description: 'bring photos', personal: true })
    expect(await env.DB.prepare('select title, note from personal_tasks where id = 2').first()).toEqual({ title: 'Renew ID', note: 'bring photos' })
  })

  it('does not touch status, and checks the assignee and the viewer', async () => {
    await send('PATCH', '/tasks/2', { status: 'done' })
    expect((await env.DB.prepare('select status from tasks where id = 2').first())!.status).toBe('waiting')
    expect((await send('PATCH', '/tasks/2', { assigneeId: 99 })).status).toBe(422)
    expect((await send('PATCH', '/personal-tasks/2', { name: 'x' }, await login('ana@arcbyte.dev'))).status).toBe(404)
  })
})

describe('sub-tasks', () => {
  it('a team sub-task stays in the parent’s tab, with the parent’s assignee', async () => {
    const res = await send('POST', '/tasks/7/subtasks', { name: 'Check CI' })
    expect(res.status).toBe(201)
    const sub = (await res.json()) as any
    expect(sub).toMatchObject({ parentId: 7, assigneeId: 3, status: 'waiting', code: 'TECH-0002' })
    expect(await env.DB.prepare('select division_id, project_id from tasks where id = ?').bind(sub.id).first()).toEqual({ division_id: 1, project_id: 2 })
  })

  it('a team sub-task starts unassigned if the parent’s assignee has left the tab', async () => {
    await env.DB.prepare('delete from project_members where project_id = 2 and user_id = 3').run()
    expect(await json(send('POST', '/tasks/7/subtasks', { name: 'Check CI' }))).toMatchObject({ parentId: 7, assigneeId: null })
  })

  it('a personal sub-task belongs to the owner', async () => {
    expect(await json(send('POST', '/personal-tasks/1/subtasks', { name: 'Pick a TLD' }))).toMatchObject({ parentId: 1, personal: true, status: 'todo' })
    expect((await send('POST', '/personal-tasks/1/subtasks', { name: 'x' }, await login('ana@arcbyte.dev'))).status).toBe(404)
  })
})
