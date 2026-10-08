import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, login } from './helpers'

let mira: string
beforeEach(async () => {
  mira = await login()
})

const post = (path: string, body: unknown, token = mira) => api(token, path, { method: 'POST', body: JSON.stringify(body) })
const reviews = async () => (await env.DB.prepare('select task_id, reviewer_id, decision, reason from task_reviews').all()).results

describe('reviews', () => {
  // Task 12 "QA checkout flow" is in review on tasko-web, where Mira is the author.
  it('approve: done, completed_date set, one approved row', async () => {
    const res = await post('/tasks/12/reviews', { approve: true })
    expect(res.status).toBe(200)
    const task = (await res.json()) as any
    expect(task).toMatchObject({ id: 12, status: 'done' })
    expect(task.completedAt).toMatch(/Z$/)
    expect(await reviews()).toEqual([{ task_id: 12, reviewer_id: 1, decision: 'approved', reason: null }])
  })

  it('decline: back to in progress, with the reason', async () => {
    const task = (await (await post('/tasks/12/reviews', { approve: false, reason: 'Missing the mobile pass' })).json()) as any
    expect(task).toMatchObject({ status: 'inProgress', completedAt: null })
    expect(await reviews()).toEqual([{ task_id: 12, reviewer_id: 1, decision: 'declined', reason: 'Missing the mobile pass' }])
  })

  it('the first decision wins: a second reviewer gets 409 and writes no row', async () => {
    const ana = await login('ana@arcbyte.dev')
    expect((await post('/tasks/12/reviews', { approve: true })).status).toBe(200)
    expect((await post('/tasks/12/reviews', { approve: true }, ana)).status).toBe(409)
    expect(await reviews()).toHaveLength(1)
  })

  it('two reviewers at the same moment: exactly one wins', async () => {
    const ana = await login('ana@arcbyte.dev')
    const codes = (await Promise.all([post('/tasks/12/reviews', { approve: true }), post('/tasks/12/reviews', { approve: false }, ana)])).map((r) => r.status)
    expect(codes.sort()).toEqual([200, 409])
    expect(await reviews()).toHaveLength(1)
  })

  it('a non-reviewer gets 403', async () => {
    await env.DB.prepare("update tasks set status = 'review' where id = 2").run() // tasko-app, Mira is a member
    expect((await post('/tasks/2/reviews', { approve: true })).status).toBe(403)
    expect((await post('/tasks/12/reviews', { approve: true }, await login('budi@arcbyte.dev'))).status).toBe(403)
    expect(await reviews()).toEqual([])
  })

  it('a task not in review is 409, and a bad body 400', async () => {
    expect((await post('/tasks/5/reviews', { approve: true })).status).toBe(409)
    expect((await post('/tasks/12/reviews', { approve: 'yes' })).status).toBe(400)
  })
})

describe('deadline requests', () => {
  it('the assignee asks for more time: a pending row with the current due date', async () => {
    const res = await post('/tasks/1/deadline-requests', { newDue: '2026-12-01T10:00:00Z', reason: 'Waiting on runners' })
    expect(res.status).toBe(204)
    const row = await env.DB.prepare('select r.*, t.due_date from task_deadline_requests r join tasks t on t.id = r.task_id').first<any>()
    expect(row).toMatchObject({
      task_id: 1, requester_id: 1, requested_due_date: '2026-12-01 10:00:00', reason: 'Waiting on runners', status: 'pending',
    })
    expect(row.current_due_date).toBe(row.due_date)
  })

  it('is 403 for a reviewer or someone who is not the assignee', async () => {
    expect((await post('/tasks/5/deadline-requests', { newDue: '2026-12-01T10:00:00Z', reason: 'x' })).status, 'reviewer').toBe(403)
    expect((await post('/tasks/1/deadline-requests', { newDue: '2026-12-01T10:00:00Z', reason: 'x' }, await login('budi@arcbyte.dev'))).status).toBe(403)
  })

  it('needs a date and a reason', async () => {
    expect((await post('/tasks/1/deadline-requests', { newDue: 'later', reason: 'x' })).status).toBe(400)
    expect((await post('/tasks/1/deadline-requests', { newDue: '2026-12-01T10:00:00Z' })).status).toBe(400)
  })
})
