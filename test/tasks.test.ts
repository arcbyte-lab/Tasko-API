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
      name: 'Call mum', priority: 3, status: 'todo', personal: true, code: null, creatorId: 1, dueDate: '2026-10-10T09:30:00Z',
    })
    expect((await env.DB.prepare("select user_id from personal_tasks where title = 'Call mum'").first())!.user_id).toBe(1)
  })

  it('in a division: a team task with the division code and no project', async () => {
    const task = await json(send('POST', '/tabs/division/1/tasks', { name: 'Rotate keys', priority: 2, assigneeId: 3 }))
    expect(task).toMatchObject({ code: 'TECH-0002', status: 'waiting', assigneeId: 3, creatorId: 1, personal: false })
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

describe('archive', () => {
  it('the creator archives: the task leaves its tab, gets a date and a log row; a second time is 409', async () => {
    const ana = await login('ana@arcbyte.dev') // task 2's creator
    const before = (await json(api(ana, '/tabs/project/1/tasks'))).length
    expect((await send('POST', '/tasks/2/archive', {}, ana)).status).toBe(204)
    expect((await env.DB.prepare('select cancelled_date c from tasks where id = 2').first())!.c).not.toBeNull()
    expect((await json(api(ana, '/tabs/project/1/tasks'))).length).toBe(before - 1)
    expect(await env.DB.prepare("select count(*) n from activity_logs where action = 'task.archived' and subject_id = 2").first('n')).toBe(1)
    expect((await send('POST', '/tasks/2/archive', {}, ana)).status).toBe(409)
  })

  it('an archived task refuses every change but can still be read', async () => {
    const ana = await login('ana@arcbyte.dev')
    await send('POST', '/tasks/2/archive', {}, ana)
    const refused = async (method: string, path: string, body: unknown, token = mira) => (await send(method, path, body, token)).status
    expect(await refused('PATCH', '/tasks/2', { name: 'x' })).toBe(409)
    expect(await refused('PATCH', '/tasks/2/status', { status: 'inProgress' })).toBe(409)
    expect(await refused('POST', '/tasks/2/subtasks', { name: 'x' })).toBe(409)
    expect(await refused('POST', '/tasks/2/comments', { body: 'x' })).toBe(409)
    expect(await refused('POST', '/tasks/2/reviews', { approve: true }, ana)).toBe(409)
    expect(await refused('POST', '/tasks/2/deadline-requests', { newDue: '2099-12-01T10:00:00Z', reason: 'x' })).toBe(409)
    expect((await api(mira, '/tasks/2')).status, 'a log row can still open it').toBe(200)
    expect((await api(mira, '/tasks/2/detail')).status).toBe(200)
  })

  it('only the creator, and only inside the viewer’s tabs', async () => {
    expect((await send('POST', '/tasks/2/archive', {})).status, 'the assignee').toBe(403)
    expect((await send('POST', '/tasks/2/archive', {}, await login('budi@arcbyte.dev'))).status, 'a member').toBe(403)
    expect((await send('POST', '/tasks/9999/archive', {})).status).toBe(404)
  })
})

describe('update', () => {
  it('changes only the fields sent', async () => {
    const ana = await login('ana@arcbyte.dev') // task 2's creator
    const task = await json(send('PATCH', '/tasks/2', { name: 'Port the tokens', priority: 1, dueDate: null, assigneeId: 3 }, ana))
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
    expect((await send('PATCH', '/tasks/2', { assigneeId: 99 }, await login('ana@arcbyte.dev'))).status).toBe(422)
    expect((await send('PATCH', '/personal-tasks/2', { name: 'x' }, await login('ana@arcbyte.dev'))).status).toBe(404)
  })

  it('an assignee can resend the due date but not change it; the creator can (0018)', async () => {
    await env.DB.prepare("update tasks set due_date = '2099-01-01 10:00:00' where id = 2").run()
    expect((await send('PATCH', '/tasks/2', { dueDate: '2099-01-01T10:00:00Z', name: 'same date' })).status, 'unchanged').toBe(200)
    const res = await send('PATCH', '/tasks/2', { dueDate: '2099-02-01T10:00:00Z' })
    expect(res.status, 'assignee moves it').toBe(403)
    expect((await send('PATCH', '/tasks/2', { dueDate: null })).status, 'assignee clears it').toBe(403)
    expect((await env.DB.prepare('select due_date from tasks where id = 2').first())!.due_date).toBe('2099-01-01 10:00:00')
    expect((await send('PATCH', '/tasks/2', { dueDate: '2099-02-01T10:00:00Z' }, await login('ana@arcbyte.dev'))).status, 'creator').toBe(200)
  })

  it('the assignee edits but can’t reassign; other members can’t edit; the creator and reviewers can do both', async () => {
    // Task 2 on tasko-app: assigned to Mira, created by Ana (also its person-in-charge); Budi is a plain member.
    expect((await send('PATCH', '/tasks/2', { name: 'Port tokens' })).status, 'assignee edits').toBe(200)
    expect((await send('PATCH', '/tasks/2', { assigneeId: 1, priority: 3 })).status, 'same assignee is not a reassign').toBe(200)
    expect((await send('PATCH', '/tasks/2', { assigneeId: 3 })).status, 'assignee reassigns').toBe(403)
    const budi = await login('budi@arcbyte.dev')
    expect((await send('PATCH', '/tasks/2', { name: 'mine now' }, budi)).status, 'member edits').toBe(403)
    expect((await send('PATCH', '/tasks/2', { assigneeId: 3 }, budi)).status, 'member takes it').toBe(403)
    expect((await send('PATCH', '/tasks/2', { assigneeId: 3 }, await login('ana@arcbyte.dev'))).status, 'creator reassigns').toBe(200)
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

  it('is one level deep: a sub-task can’t have its own', async () => {
    const sub = (await json(send('POST', '/tasks/7/subtasks', { name: 'Check CI' }))) as any
    expect((await send('POST', `/tasks/${sub.id}/subtasks`, { name: 'x' })).status).toBe(422)
    expect((await send('POST', '/personal-tasks/7/subtasks', { name: 'x' })).status, 'personal 7 is a sub-task').toBe(422)
  })

  it('a personal sub-task belongs to the owner', async () => {
    expect(await json(send('POST', '/personal-tasks/1/subtasks', { name: 'Pick a TLD' }))).toMatchObject({ parentId: 1, personal: true, status: 'todo' })
    expect((await send('POST', '/personal-tasks/1/subtasks', { name: 'x' }, await login('ana@arcbyte.dev'))).status).toBe(404)
  })
})
