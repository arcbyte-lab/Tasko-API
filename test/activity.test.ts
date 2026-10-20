import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { logRow } from '../src/activity'
import { api, login } from './helpers'

// Mira (1) is a member and the assignee of tasks 1 (project 1) and 23 (division 1).
// Ana (2) is the division admin, project 1's person-in-charge, and created both.
let mira: string
let ana: string
beforeEach(async () => {
  mira = await login()
  ana = await login('ana@arcbyte.dev')
})

const send = (method: string, path: string, body: unknown, token = ana) => api(token, path, { method, body: JSON.stringify(body) })
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>
const WEEKLY = { every: 1, unit: 'week', weekdays: [1] }

async function logs() {
  const { results } = await env.DB.prepare(
    'select actor_id, actor_name, action, subject_type, subject_id, subject_label, division_id, project_id, target_user_id, changes from activity_logs order by id',
  ).all<any>()
  return results.map((r) => ({ ...r, changes: r.changes && JSON.parse(r.changes) }))
}

describe('logRow', () => {
  const entry = { actor: { id: 2, name: 'Ana' }, action: 'x', subject: { type: 'task', id: 1, label: 'Set up CI' }, divisionId: 1, projectId: 1 }

  it('a guarded row, and every guarded row after it, follows the statement before', async () => {
    const miss = env.DB.prepare("update tasks set name = 'y' where id = 999")
    const hit = env.DB.prepare("update tasks set name = 'y' where id = 1")
    await env.DB.batch([miss, logRow(env.DB, entry, true), logRow(env.DB, entry, true)])
    expect(await logs()).toHaveLength(0)
    await env.DB.batch([hit, logRow(env.DB, entry, true), logRow(env.DB, entry, true)])
    expect(await logs()).toHaveLength(2)
  })

  it('acting on yourself has no target', async () => {
    await logRow(env.DB, { ...entry, targetUserId: 2 }).run()
    expect((await logs())[0].target_user_id).toBeNull()
  })
})

describe('create', () => {
  it('logs task.created on the new task, with its assignee as the target', async () => {
    const task = await json(send('POST', '/tabs/project/1/tasks', { name: 'Ship beta', priority: 4, assigneeId: 3 }))
    expect(await logs()).toEqual([
      {
        actor_id: 2, actor_name: 'Ana', action: 'task.created', subject_type: 'task', subject_id: task.id, subject_label: 'Ship beta',
        division_id: 1, project_id: 1, target_user_id: 3, changes: { name: 'Ship beta', priority: 4, assigneeId: 3, repeat: null },
      },
    ])
  })

  it('a repeating task: the row still points at the task, not the series update', async () => {
    const task = await json(send('POST', '/tabs/division/1/tasks', { name: 'Backup', priority: 2, dueDate: '2026-11-02', repeat: WEEKLY }))
    const [row] = await logs()
    expect(row).toMatchObject({ subject_id: task.id, project_id: null, target_user_id: null })
    expect(row.changes.repeat).toMatchObject({ every: 1, unit: 'week' })
  })
})

describe('edit', () => {
  it('one row per changed field', async () => {
    await send('PATCH', '/tasks/1', { name: 'Set up CI/CD', priority: 4, description: 'GitHub Actions' })
    const rows = await logs()
    expect(rows.map((r) => [r.action, r.changes])).toEqual([
      ['task.renamed', { name: ['Set up CI', 'Set up CI/CD'] }],
      ['task.description_changed', { description: [null, 'GitHub Actions'] }],
      ['task.priority_changed', { priority: [3, 4] }],
    ])
    expect(rows.every((r) => r.subject_label === 'Set up CI/CD')).toBe(true)
  })

  it('no row when nothing changed', async () => {
    const res = await send('PATCH', '/tasks/1', { name: 'Set up CI', priority: 3, description: null, assigneeId: 1 })
    expect(res.status).toBe(200)
    expect(await logs()).toEqual([])
  })

  it('a due date, as before and after ISO dates', async () => {
    await send('PATCH', '/tasks/23', { dueDate: '2026-12-01T02:00:00Z' })
    const [row] = await logs()
    expect(row.action).toBe('task.due_changed')
    expect(row.changes.dueDate[1]).toBe('2026-12-01T02:00:00Z')
  })

  it('a reassignment logs the old assignee unassigned and the new one assigned', async () => {
    await send('PATCH', '/tasks/1', { assigneeId: 3 })
    expect((await logs()).map((r) => [r.action, r.target_user_id, r.changes])).toEqual([
      ['task.unassigned', 1, { assigneeId: [1, 3], assigneeName: 'Mira' }],
      ['task.assigned', 3, { assigneeId: [1, 3], assigneeName: 'Budi' }],
    ])
  })

  it('a repeat is set, changed and stopped', async () => {
    await send('PATCH', '/tasks/23', { repeat: WEEKLY })
    await send('PATCH', '/tasks/23', { repeat: { ...WEEKLY, weekdays: [1, 4] } })
    await send('PATCH', '/tasks/23', { repeat: { ...WEEKLY, weekdays: [1, 4] } })
    await send('PATCH', '/tasks/23', { repeat: null })
    const rows = await logs()
    expect(rows.map((r) => r.action)).toEqual(['repeat.set', 'repeat.changed', 'repeat.stopped'])
    expect(rows[1].changes.repeat.map((r: any) => r.weekdays)).toEqual([[1], [1, 4]])
  })

  it('a refused edit writes nothing', async () => {
    expect((await send('PATCH', '/tasks/1', { assigneeId: 3 }, mira)).status).toBe(403)
    expect(await logs()).toEqual([])
  })
})

describe('sub-tasks, comments and deadline requests', () => {
  it('a sub-task is logged on its parent', async () => {
    await send('POST', '/tasks/1/subtasks', { name: 'Cache deps' })
    expect(await logs()).toMatchObject([{ action: 'subtask.added', subject_id: 1, subject_label: 'Set up CI', changes: { subtask: 'Cache deps' } }])
  })

  it('a comment targets the assignee, unless they wrote it', async () => {
    await send('POST', '/tasks/1/comments', { body: 'Use the shared runner' })
    await send('POST', '/tasks/1/comments', { body: 'OK' }, mira)
    expect((await logs()).map((r) => [r.actor_id, r.target_user_id, r.changes.body])).toEqual([
      [2, 1, 'Use the shared runner'],
      [1, null, 'OK'],
    ])
  })

  it('a deadline request, once: the refused second one writes nothing', async () => {
    const ask = () => send('POST', '/tasks/1/deadline-requests', { newDue: '2030-01-01', reason: 'runner quota' }, mira)
    expect((await ask()).status).toBe(204)
    expect((await ask()).status).toBe(409)
    const rows = await logs()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'deadline.requested', actor_id: 1, changes: { reason: 'runner quota' } })
    expect(rows[0].changes.dueDate[1]).toBe('2030-01-01T00:00:00Z')
  })
})

it('private tasks write nothing', async () => {
  const task = await json(send('POST', '/tabs/private/0/tasks', { name: 'Call mum', priority: 2 }, mira))
  await send('PATCH', `/personal-tasks/${task.id}`, { name: 'Call mum tonight' }, mira)
  await send('POST', `/personal-tasks/${task.id}/subtasks`, { name: 'Buy flowers' }, mira)
  expect(await logs()).toEqual([])
})
