import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, login } from './helpers'

let mira: string
beforeEach(async () => {
  mira = await login()
})

const tick = (path: string, status: string, token = mira) =>
  api(token, `${path}/status`, { method: 'PATCH', body: JSON.stringify({ status }) })
const row = (sql: string) => env.DB.prepare(sql).first<any>()

describe('personal tasks', () => {
  it('open → done sets completed_at', async () => {
    const res = await tick('/personal-tasks/1', 'done')
    expect(res.status).toBe(200)
    const task = (await res.json()) as any
    expect(task).toMatchObject({ id: 1, personal: true, status: 'done' })
    expect(task.completedAt).toMatch(/Z$/)
  })

  it('done → todo clears completed_at', async () => {
    const task = (await (await tick('/personal-tasks/6', 'todo')).json()) as any
    expect(task).toMatchObject({ status: 'todo', completedAt: null })
  })

  it('anything else is 422', async () => {
    expect((await tick('/personal-tasks/1', 'inProgress')).status).toBe(422)
    expect((await tick('/personal-tasks/1', 'review')).status).toBe(422)
    expect((await tick('/personal-tasks/6', 'done')).status).toBe(422)
  })

  it('never reaches anyone but its owner', async () => {
    expect((await tick('/personal-tasks/1', 'done', await login('ana@arcbyte.dev'))).status).toBe(404)
  })
})

describe('team tasks', () => {
  it('open → done when no proof is required, setting completed_date', async () => {
    const task = (await (await tick('/tasks/1', 'done')).json()) as any
    expect(task).toMatchObject({ id: 1, personal: false, status: 'done' })
    expect(task.completedAt).toMatch(/Z$/)
  })

  it('open → review when a proof is required, setting review_date', async () => {
    const res = await tick('/tasks/5', 'review')
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).status).toBe('review')
    expect((await row('select review_date from tasks where id = 5')).review_date).not.toBeNull()
  })

  it('done → waiting clears completed_date and review_date', async () => {
    await env.DB.prepare("update tasks set review_date = datetime('now') where id = 4").run()
    const task = (await (await tick('/tasks/4', 'waiting')).json()) as any
    expect(task).toMatchObject({ status: 'waiting', completedAt: null })
    expect((await row('select review_date from tasks where id = 4')).review_date).toBeNull()
  })

  it('anything else is 422', async () => {
    expect((await tick('/tasks/5', 'done')).status, 'proof required').toBe(422)
    expect((await tick('/tasks/2', 'review')).status, 'no proof required').toBe(422)
    expect((await tick('/tasks/12', 'done')).status, 'out of review').toBe(422)
    expect((await tick('/tasks/12', 'inProgress')).status, 'out of review').toBe(422)
    expect((await tick('/tasks/2', 'inProgress')).status, 'the checkbox never sets in progress (0004)').toBe(422)
    expect((await tick('/tasks/1', 'waiting')).status, 'in progress → waiting').toBe(422)
    expect((await tick('/tasks/2', 'todo')).status, 'personal-only status').toBe(422)
  })

  it('only the assignee can tick an assigned task', async () => {
    expect((await tick('/tasks/7', 'done')).status).toBe(403)
    expect((await tick('/tasks/2', 'done', await login('ana@arcbyte.dev'))).status).toBe(403)
  })

  it('anyone in the tab can tick an unassigned task, and no one else', async () => {
    await env.DB.prepare('update tasks set assignee_id = null where id in (2, 3)').run()
    expect((await tick('/tasks/2', 'done', await login('ana@arcbyte.dev'))).status).toBe(200)
    await env.DB.prepare('delete from project_members where project_id = 1 and user_id = 1').run()
    expect((await tick('/tasks/3', 'done')).status).toBe(403)
  })

  it('not even the assignee, once removed from the tab or once it is archived', async () => {
    await env.DB.prepare('delete from project_members where project_id = 1 and user_id = 1').run()
    expect((await tick('/tasks/2', 'done')).status, 'removed').toBe(403)
    await env.DB.prepare("update projects set status = 'archived' where id = 2").run()
    expect((await tick('/tasks/5', 'review')).status, 'archived').toBe(403)
  })
})

it('rejects an unknown status and an unknown task', async () => {
  expect((await tick('/tasks/1', 'in_progress')).status).toBe(400)
  expect((await tick('/tasks/999', 'done')).status).toBe(404)
  expect((await tick('/tasks/1', 'constructor')).status, 'inherited key').toBe(400)
  const nullBody = await api(mira, '/tasks/1/status', { method: 'PATCH', body: 'null' })
  expect(nullBody.status, 'null body').toBe(400)
})
