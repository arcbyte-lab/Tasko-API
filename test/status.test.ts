import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, login } from './helpers'

let mira: string
beforeEach(async () => {
  mira = await login()
})

const tick = (path: string, status: string, token = mira, extra = {}) =>
  api(token, `${path}/status`, { method: 'PATCH', body: JSON.stringify({ status, ...extra }) })
const LINK = { proofUrl: 'https://drive.google.com/file/d/abc/view' }
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

  it('todo → in progress: "start working" (0008)', async () => {
    const task = (await (await tick('/personal-tasks/1', 'inProgress')).json()) as any
    expect(task).toMatchObject({ status: 'inProgress', completedAt: null })
  })

  it('anything else is 422', async () => {
    expect((await tick('/personal-tasks/3', 'inProgress')).status, 'already in progress').toBe(422)
    expect((await tick('/personal-tasks/6', 'inProgress')).status, 'done').toBe(422)
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

  it('open → review when a proof is required, with its link: review_date set, proof stored', async () => {
    const res = await tick('/tasks/5', 'review', mira, { proofUrl: ' https://drive.google.com/file/d/abc/view ' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).status).toBe('review')
    expect((await row('select review_date from tasks where id = 5')).review_date).not.toBeNull()
    expect(await row('select task_id, user_id, file from proofs where task_id = 5')).toEqual({
      task_id: 5, user_id: 1, file: 'https://drive.google.com/file/d/abc/view',
    })
  })

  it('review without an http(s) proof link is a 400 and changes nothing', async () => {
    for (const extra of [{}, { proofUrl: '' }, { proofUrl: 'not a link' }, { proofUrl: 'javascript:alert(1)' }, { proofUrl: 5 }]) {
      expect((await tick('/tasks/5', 'review', mira, extra)).status, JSON.stringify(extra)).toBe(400)
    }
    expect((await row('select status from tasks where id = 5')).status).toBe('in_progress')
    expect(await row('select count(*) n from proofs where task_id = 5')).toEqual({ n: 0 })
  })

  it('a refused move stores no proof', async () => {
    expect((await tick('/tasks/2', 'review', mira, LINK)).status, 'no proof required').toBe(422)
    expect(await row('select count(*) n from proofs where task_id = 2')).toEqual({ n: 0 })
  })

  it('waiting → in progress: "start working" (0008), setting start_date once', async () => {
    const task = (await (await tick('/tasks/2', 'inProgress')).json()) as any
    expect(task).toMatchObject({ id: 2, status: 'inProgress', completedAt: null })
    expect((await row('select start_date from tasks where id = 2')).start_date).not.toBeNull()
    expect((await tick('/tasks/7', 'inProgress')).status, 'only its assignee').toBe(403)
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
    expect((await tick('/tasks/1', 'inProgress')).status, 'already in progress').toBe(422)
    expect((await tick('/tasks/4', 'inProgress')).status, 'done').toBe(422)
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
    expect((await tick('/tasks/5', 'review', mira, LINK)).status, 'archived').toBe(403)
  })
})

it('rejects an unknown status and an unknown task', async () => {
  expect((await tick('/tasks/1', 'in_progress')).status).toBe(400)
  expect((await tick('/tasks/999', 'done')).status).toBe(404)
  expect((await tick('/tasks/1', 'constructor')).status, 'inherited key').toBe(400)
  const nullBody = await api(mira, '/tasks/1/status', { method: 'PATCH', body: 'null' })
  expect(nullBody.status, 'null body').toBe(400)
})
