import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, login } from './helpers'

// Division 1: Ana (2) admin, Citra (4) made supervisor here, everyone else a member.
// Project 1: Ana person-in-charge, Mira (1) and Citra members. Project 2: Mira owner.
// Task 1 is in project 1 and task 23 in the division's own tab; Mira is assigned both.
let mira: string, ana: string, citra: string, budi: string
beforeEach(async () => {
  await env.DB.prepare("update division_members set role_type = 'supervisor' where user_id = 4 and division_id = 1").run()
  ;[mira, ana, citra, budi] = await Promise.all(['mira', 'ana', 'citra', 'budi'].map((n) => login(`${n}@arcbyte.dev`)))
})

const send = (method: string, path: string, body: unknown, token = ana) => api(token, path, { method, body: JSON.stringify(body) })
const get = (path: string, token: string) => api(token, path)
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>
const actions = async (path: string, token: string) => (await json(get(path, token))).items.map((i: any) => `${i.action} ${i.subject.label}`)

/** One row of each kind: a division task, a project task, a sub-task, a project member. */
async function someActivity() {
  await send('PATCH', '/tasks/23', { name: 'Renew SSL' })
  await send('PATCH', '/tasks/1', { name: 'Set up CI/CD' })
  await send('POST', '/tasks/1/subtasks', { name: 'Cache deps' })
  await env.DB.prepare("insert into users (id, name, email, password) values (8, 'Gita', 'gita@arcbyte.dev', '!')").run()
  await send('POST', '/projects/2/members', { userId: 8 }, mira)
}

describe('division log', () => {
  it('its own tasks and its projects’ member rows, not the tasks inside projects', async () => {
    await someActivity()
    expect(await actions('/divisions/1/activity', citra)).toEqual(['member.added Gita', 'task.renamed Renew SSL'])
  })

  it('leads only', async () => {
    expect((await get('/divisions/1/activity', mira)).status).toBe(403)
    expect((await get('/divisions/1/activity', ana)).status).toBe(200)
  })
})

describe('project log', () => {
  it('its tasks, sub-tasks on their parent, and its members', async () => {
    await someActivity()
    expect(await actions('/projects/1/activity', ana)).toEqual(['subtask.added Set up CI/CD', 'task.renamed Set up CI/CD'])
    expect(await actions('/projects/2/activity', mira)).toEqual(['member.added Gita'])
  })

  it('owner or person-in-charge only: a division lead who is a plain member gets 403', async () => {
    expect((await get('/projects/1/activity', citra)).status).toBe(403)
    expect((await get('/projects/1/activity', mira)).status).toBe(403)
    expect((await get('/projects/2/activity', mira)).status).toBe(200)
  })
})

describe('task log', () => {
  it('a project task opens for its project’s managers, a division task for the division’s leads', async () => {
    await someActivity()
    expect(await actions('/tasks/1/activity', ana)).toEqual(['subtask.added Set up CI/CD', 'task.renamed Set up CI/CD'])
    expect((await get('/tasks/1/activity', citra)).status).toBe(403)
    expect(await actions('/tasks/23/activity', citra)).toEqual(['task.renamed Renew SSL'])
    expect((await get('/tasks/23/activity', mira)).status).toBe(403)
    expect((await get('/tasks/999/activity', ana)).status).toBe(404)
  })

  it('Task Detail says whether the viewer can open it', async () => {
    const can = async (task: number, token: string) => (await json(get(`/tasks/${task}/detail`, token))).canViewLog
    expect([await can(1, ana), await can(1, citra), await can(23, citra), await can(23, mira)]).toEqual([true, false, true, false])
  })
})

describe('user log', () => {
  it('what they did and what was done to them, in full for themselves', async () => {
    await send('POST', '/tasks/1/comments', { body: 'Use the shared runner' })
    await send('POST', '/tasks/23/comments', { body: 'Due Friday' })
    await send('PATCH', '/tasks/2/status', { status: 'inProgress' }, mira)
    await send('POST', '/tasks/3/comments', { body: 'On her task' }, budi)
    await send('POST', '/tasks/7/comments', { body: 'Not about her' }, ana)
    expect(await actions('/users/1/activity', mira)).toEqual([
      'comment.added Draft API contract',
      'task.started Port theme tokens',
      'comment.added Renew SSL certificate',
      'comment.added Set up CI',
    ])
  })

  it('a lead sees only rows from logs they open', async () => {
    await send('POST', '/tasks/1/comments', { body: 'Use the shared runner' })
    await send('POST', '/tasks/23/comments', { body: 'Due Friday' })
    expect(await actions('/users/1/activity', citra)).toEqual(['comment.added Renew SSL certificate'])
    expect(await actions('/users/1/activity', ana)).toEqual(['comment.added Renew SSL certificate', 'comment.added Set up CI'])
  })

  it('a member can’t open someone else’s; an unknown user is 404', async () => {
    expect((await get('/users/1/activity', budi)).status).toBe(403)
    expect((await get('/users/999/activity', ana)).status).toBe(404)
  })
})

describe('the response', () => {
  it('a row in full', async () => {
    await send('PATCH', '/tasks/1', { assigneeId: 3 })
    const [assigned] = (await json(get('/tasks/1/activity', ana))).items
    expect(assigned).toMatchObject({
      action: 'task.assigned',
      actor: { id: 2, name: 'Ana' },
      subject: { type: 'task', id: 1, label: 'Set up CI' },
      target: { id: 3, name: 'Budi' },
      tab: { kind: 'project', id: 1, name: 'tasko-app' },
      changes: { assigneeId: [1, 3], assigneeName: 'Budi' },
    })
    expect(assigned.createdAt).toMatch(/Z$/)
  })

  it('pages of 50, newest first, with before', async () => {
    await env.DB.batch(
      Array.from({ length: 120 }, (_, i) =>
        env.DB.prepare(
          "insert into activity_logs (actor_id, actor_name, action, subject_type, subject_id, subject_label, division_id, created_at) values (2, 'Ana', 'task.renamed', 'task', 23, ?, 1, datetime('now'))",
        ).bind(`n${i}`),
      ),
    )
    const first = await json(get('/divisions/1/activity', ana))
    expect([first.items.length, first.items[0].subject.label, first.next]).toEqual([50, 'n119', first.items[49].id])
    const second = await json(get(`/divisions/1/activity?before=${first.next}`, ana))
    expect(second.items[0].subject.label).toBe('n69')
    const third = await json(get(`/divisions/1/activity?before=${second.next}`, ana))
    expect([third.items.length, third.next]).toEqual([20, null])
    expect((await get('/divisions/1/activity?before=x', ana)).status).toBe(400)
  })
})
