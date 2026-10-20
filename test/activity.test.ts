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

describe('status and reviews', () => {
  it('start, done and reopen, each with the move; acting on your own task has no target', async () => {
    for (const status of ['inProgress', 'done', 'waiting']) await send('PATCH', '/tasks/2/status', { status }, mira)
    expect((await logs()).map((r) => [r.action, r.target_user_id, r.changes.status])).toEqual([
      ['task.started', null, ['waiting', 'in_progress']],
      ['task.completed', null, ['in_progress', 'done']],
      ['task.reopened', null, ['done', 'waiting']],
    ])
  })

  it('sent to review, with the proof link', async () => {
    await env.DB.prepare("update tasks set required_proof_type = 'file' where id = 1").run()
    await send('PATCH', '/tasks/1/status', { status: 'review', proofUrl: 'https://drive.example/ci.png' }, mira)
    expect(await logs()).toMatchObject([{ action: 'task.sent_to_review', changes: { status: ['in_progress', 'review'], proofUrl: 'https://drive.example/ci.png' } }])
  })

  it('a refused move writes nothing', async () => {
    expect((await send('PATCH', '/tasks/4/status', { status: 'inProgress' }, mira)).status).toBe(422)
    expect(await logs()).toEqual([])
  })

  it('approve and reject target the assignee; the losing second decision writes nothing', async () => {
    await send('POST', '/tasks/7/reviews', { approve: false, reason: ' blurry ' }, mira)
    await send('POST', '/tasks/12/reviews', { approve: true })
    expect((await send('POST', '/tasks/12/reviews', { approve: true }, mira)).status).toBe(409)
    expect((await logs()).map((r) => [r.action, r.actor_id, r.target_user_id, r.changes])).toEqual([
      ['task.rejected', 1, 3, { status: ['review', 'in_progress'], reason: 'blurry' }],
      ['task.approved', 2, 1, { status: ['review', 'done'] }],
    ])
  })
})

describe('repeats', () => {
  it('finishing a repeating task logs the next one, on the new task, for its assignee', async () => {
    await send('PATCH', '/tasks/23', { repeat: WEEKLY })
    await send('PATCH', '/tasks/23/status', { status: 'done' }, mira)
    const next = (await env.DB.prepare('select id from tasks where series_id = 23 and id != 23').first<number>('id'))!
    const rows = await logs()
    expect(rows.map((r) => r.action)).toEqual(['repeat.set', 'task.completed', 'repeat.next_created'])
    expect(rows[2]).toMatchObject({ actor_id: 1, subject_id: next, subject_label: 'Renew SSL certificate', target_user_id: null })
    expect(rows[2].changes.fromTaskId).toBe(23)
  })

  it('approved by a lead: the lead is the actor and the assignee the target', async () => {
    await env.DB.prepare("update tasks set required_proof_type = 'file' where id = 23").run()
    await send('PATCH', '/tasks/23', { repeat: WEEKLY })
    await send('PATCH', '/tasks/23/status', { status: 'review', proofUrl: 'https://drive.example/ssl.png' }, mira)
    await send('POST', '/tasks/23/reviews', { approve: true })
    expect((await logs()).at(-1)).toMatchObject({ action: 'repeat.next_created', actor_id: 2, target_user_id: 1 })
  })

  it('deleting a series logs it; a refused delete writes nothing', async () => {
    await send('PATCH', '/tasks/23', { repeat: WEEKLY })
    await send('PATCH', '/tasks/23/status', { status: 'inProgress' }, mira)
    expect((await send('DELETE', '/series/23', null)).status).toBe(409)
    expect((await logs()).map((r) => r.action)).toEqual(['repeat.set', 'task.started'])
    await send('PATCH', '/tasks/23/status', { status: 'done' }, mira)
    expect((await send('DELETE', '/series/23', null)).status).toBe(204)
    expect((await logs()).at(-1)).toMatchObject({ action: 'series.deleted', subject_type: 'series', subject_id: 23, subject_label: 'Renew SSL certificate', division_id: 1 })
  })
})

describe('projects and members', () => {
  it('a new project is the subject and the project of its row', async () => {
    const project = await json(send('POST', '/projects', { divisionId: 1, name: 'Stock Opname Q4', dueDate: '2026-12-20' }))
    expect(await logs()).toEqual([
      {
        actor_id: 2, actor_name: 'Ana', action: 'project.created', subject_type: 'project', subject_id: project.id, subject_label: 'Stock Opname Q4',
        division_id: 1, project_id: project.id, target_user_id: null, changes: { dueDate: '2026-12-20' },
      },
    ])
  })

  it('added, given a role, and a no-op role change writes nothing', async () => {
    await env.DB.prepare("insert into users (id, name, email, password) values (8, 'Gita', 'gita@arcbyte.dev', '!')").run()
    await send('POST', '/projects/2/members', { userId: 8 }, mira)
    expect((await send('POST', '/projects/2/members', { userId: 8 }, mira)).status).toBe(409)
    await send('PATCH', '/projects/2/members/3', { role: 'person-in-charge' }, mira)
    await send('PATCH', '/projects/2/members/3', { role: 'person-in-charge' }, mira)
    expect((await logs()).map((r) => [r.action, r.subject_type, r.subject_label, r.project_id, r.target_user_id, r.changes])).toEqual([
      ['member.added', 'member', 'Gita', 2, 8, { role: 'member' }],
      ['member.role_changed', 'member', 'Budi', 2, 3, { role: ['member', 'person-in-charge'] }],
    ])
  })

  it('removed: the row lists the unassigned tasks, and each task logs its own unassign', async () => {
    const { results } = await env.DB.prepare(
      "select id from tasks where project_id = 1 and assignee_id = 1 and status in ('todo', 'waiting', 'in_progress') order by id",
    ).all<{ id: number }>()
    const ids = results.map((r) => r.id)
    expect(ids.length).toBeGreaterThan(0)
    await send('DELETE', '/projects/1/members/1', null)
    const [member, ...tasks] = await logs()
    expect(member).toMatchObject({ action: 'member.removed', actor_id: 2, target_user_id: 1, changes: { role: 'member', unassignedTaskIds: ids } })
    expect(tasks.map((r) => [r.action, r.subject_id, r.target_user_id])).toEqual(ids.map((id) => ['task.unassigned', id, 1]))
  })

  it('leaving is member.left with no target; a refused leave writes nothing', async () => {
    await send('DELETE', '/projects/1/members/3', null, await login('budi@arcbyte.dev'))
    expect((await logs())[0]).toMatchObject({ action: 'member.left', actor_id: 3, target_user_id: null })
    await env.DB.prepare('delete from activity_logs').run()
    expect((await send('DELETE', '/projects/2/members/1', null, mira)).status).toBe(422)
    expect(await logs()).toEqual([])
  })
})
