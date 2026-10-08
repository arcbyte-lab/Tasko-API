import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, login } from './helpers'

let mira: string
beforeEach(async () => {
  mira = await login()
})

const send = (method: string, path: string, body: unknown, token = mira) => api(token, path, { method, body: JSON.stringify(body) })
const bell = async (token: string) => (await api(token, '/notifications')).json() as Promise<any[]>
const rows = async () =>
  (await env.DB.prepare('select type, notifiable_type, notifiable_id, data from notifications order by rowid').all<any>()).results.map((r) => ({
    ...r,
    data: JSON.parse(r.data),
  }))

describe('producers', () => {
  it('assigning a new task to someone else notifies them; assigning yourself does not', async () => {
    const task = (await (await send('POST', '/tabs/project/1/tasks', { name: 'Ship beta', priority: 2, assigneeId: 3 })).json()) as any
    await send('POST', '/tabs/project/1/tasks', { name: 'Mine', priority: 2, assigneeId: 1 })
    expect(await rows()).toEqual([
      { type: 'task_assigned', notifiable_type: 'user', notifiable_id: 3, data: { taskId: task.id, taskName: 'Ship beta', actorId: 1 } },
    ])
    const [n] = await bell(await login('budi@arcbyte.dev'))
    expect(n).toMatchObject({ text: 'Mira assigned you Ship beta', actor: { id: 1, name: 'Mira' }, readAt: null })
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('re-assigning on edit notifies the new assignee once', async () => {
    await send('PATCH', '/tasks/2', { assigneeId: 4 })
    await send('PATCH', '/tasks/2', { assigneeId: 4, name: 'Port theme tokens again' })
    expect((await rows()).map((r) => [r.type, r.notifiable_id])).toEqual([['task_assigned', 4]])
  })

  it('sending a task to review notifies every reviewer but the actor', async () => {
    await send('PATCH', '/tasks/5/status', { status: 'review' }) // tasko-web: reviewers are Mira (author) and Ana (person-in-charge)
    expect((await rows()).map((r) => [r.type, r.notifiable_id, r.data.taskId])).toEqual([['task_review_requested', 2, 5]])
    expect((await bell(await login('ana@arcbyte.dev')))[0].text).toBe('Mira sent Fix login redirect for review')

    await env.DB.prepare("update tasks set required_proof_type = 'file' where id = 23").run() // division-only: Ana is admin
    await env.DB.prepare("update division_members set role_type = 'supervisor' where user_id = 4").run()
    await send('PATCH', '/tasks/23/status', { status: 'review' })
    expect((await rows()).slice(1).map((r) => r.notifiable_id).sort()).toEqual([2, 4])
  })

  it('a review decision notifies the assignee', async () => {
    const ana = await login('ana@arcbyte.dev')
    await send('POST', '/tasks/7/reviews', { approve: false, reason: 'Needs tests' }, ana) // assigned to Budi
    expect(await rows()).toEqual([
      { type: 'task_reviewed', notifiable_type: 'user', notifiable_id: 3, data: { taskId: 7, taskName: 'Review PR #42', actorId: 2, approved: false } },
    ])
    expect((await bell(await login('budi@arcbyte.dev')))[0].text).toBe('Ana declined Review PR #42')
    await send('POST', '/tasks/12/reviews', { approve: true }) // Mira reviews her own task: nobody to tell
    expect(await rows()).toHaveLength(1)
  })

  it('a 409 review writes nothing', async () => {
    await send('POST', '/tasks/7/reviews', { approve: true })
    await send('POST', '/tasks/7/reviews', { approve: true }, await login('ana@arcbyte.dev'))
    expect(await rows()).toHaveLength(1)
  })
})

describe('the bell', () => {
  beforeEach(async () => {
    const ana = await login('ana@arcbyte.dev')
    await send('POST', '/tabs/project/1/tasks', { name: 'First', priority: 2, assigneeId: 1 }, ana)
    await env.DB.prepare("update notifications set created_at = datetime('now', '-1 hour')").run()
    await send('POST', '/tabs/project/1/tasks', { name: 'Second', priority: 2, assigneeId: 1 }, ana)
    await send('POST', '/tabs/project/1/tasks', { name: 'For Budi', priority: 2, assigneeId: 3 }, ana)
  })

  it('shows only the viewer’s notifications, newest first', async () => {
    expect((await bell(mira)).map((n) => n.text)).toEqual(['Ana assigned you Second', 'Ana assigned you First'])
  })

  it('marks one read, and refuses someone else’s', async () => {
    const [newest, older] = await bell(mira)
    expect((await api(mira, `/notifications/${newest.id}/read`, { method: 'POST' })).status).toBe(204)
    const after = await bell(mira)
    expect(after[0].readAt).toMatch(/Z$/)
    expect(after[1].readAt).toBeNull()
    const [budis] = await bell(await login('budi@arcbyte.dev'))
    expect((await api(mira, `/notifications/${budis.id}/read`, { method: 'POST' })).status).toBe(404)
    expect(older.id).not.toBe(budis.id)
  })

  it('marks all of the viewer’s read, and nobody else’s', async () => {
    expect((await api(mira, '/notifications/read-all', { method: 'POST' })).status).toBe(204)
    expect((await bell(mira)).every((n) => n.readAt)).toBe(true)
    expect((await bell(await login('budi@arcbyte.dev')))[0].readAt).toBeNull()
  })
})
