import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, login } from './helpers'

let mira: string
beforeEach(async () => {
  mira = await login()
})

const detail = async (path: string, token = mira) => (await api(token, `${path}/detail`)).json() as Promise<any>
const flags = async (path: string, token = mira) => {
  const { canReview, canArchive, canRequestExtension } = await detail(path, token)
  return { canReview, canArchive, canRequestExtension }
}
const setStatus = (id: number, status: string) => env.DB.prepare('update tasks set status = ? where id = ?').bind(status, id).run()

describe('team task detail', () => {
  it('has its tab, sub-tasks by creation, live comments and assignee', async () => {
    await env.DB.prepare("insert into comments (task_id, user_id, comment, created_at, deleted_at) values (5, 4, 'gone', datetime('now'), datetime('now'))").run()
    const d = await detail('/tasks/5')
    expect(d.tab).toEqual({ kind: 'project', id: 2, name: 'tasko-web' })
    expect(d.subtasks.map((t: any) => t.name)).toEqual(['Reproduce on Safari', 'Store return URL', 'Add redirect test'])
    expect(d.comments.map((c: any) => [c.author.name, c.body])).toEqual([
      ['Ana', 'Only happens on Safari for me. Chrome is fine.'],
      ['Budi', "Can this ship before Friday's release?"],
    ])
    expect(d.comments[0].createdAt).toMatch(/Z$/)
    expect(d.assignee).toEqual({ id: 1, name: 'Mira' })
  })

  it('on tasko-web, where Mira is the author, she reviews and never asks for an extension', async () => {
    expect(await flags('/tasks/12')).toEqual({ canReview: true, canArchive: false, canRequestExtension: false })
    expect((await flags('/tasks/7')).canReview).toBe(true)
    expect((await flags('/tasks/5')).canReview, 'not in review').toBe(false)
    expect((await flags('/tasks/20')).canArchive, 'she created it').toBe(true)
  })

  it('on tasko-app, where Mira is a member, she only asks for extensions', async () => {
    await setStatus(2, 'review')
    expect(await flags('/tasks/2')).toEqual({ canReview: false, canArchive: false, canRequestExtension: true })
    expect((await flags('/tasks/2', await login('ana@arcbyte.dev'))).canReview, 'person-in-charge').toBe(true)
  })

  it('a division-only task is reviewed by the division’s admin or supervisor', async () => {
    await setStatus(23, 'review')
    expect((await flags('/tasks/23')).canReview).toBe(false)
    expect((await flags('/tasks/23', await login('ana@arcbyte.dev'))).canReview).toBe(true)
    await env.DB.prepare("update division_members set role_type = 'supervisor' where user_id = 1").run()
    expect((await flags('/tasks/23')).canReview).toBe(true)
  })

  it('is 403 outside the viewer’s tabs and 404 when missing', async () => {
    await env.DB.prepare('delete from project_members where project_id = 1 and user_id = 1').run()
    expect((await api(mira, '/tasks/1/detail')).status).toBe(403)
    expect((await api(mira, '/tasks/999/detail')).status).toBe(404)
  })
})

it('personal task detail: private tab, sub-tasks, no comments, all flags false', async () => {
  const d = await detail('/personal-tasks/1')
  expect(d).toMatchObject({
    tab: { kind: 'private', id: 0, name: 'private' }, comments: [], assignee: null,
    canReview: false, canArchive: false, canRequestExtension: false,
  })
  expect(d.subtasks.map((t: any) => t.name)).toEqual(['Compare registrars', 'Set up DNS'])
  expect((await api(await login('ana@arcbyte.dev'), '/personal-tasks/1/detail')).status).toBe(404)
})

describe('comments', () => {
  const comment = (path: string, body: unknown, token = mira) => api(token, `${path}/comments`, { method: 'POST', body: JSON.stringify({ body }) })

  it('adds one as the viewer and shows it in the detail', async () => {
    const res = await comment('/tasks/1', ' On it. ')
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ author: { id: 1, name: 'Mira' }, body: 'On it.' })
    expect((await detail('/tasks/1')).comments.map((c: any) => c.body)).toEqual(['On it.'])
  })

  it('rejects an empty body, a personal task and an outsider', async () => {
    expect((await comment('/tasks/1', '  ')).status).toBe(400)
    expect((await comment('/personal-tasks/1', 'hi')).status).toBe(404)
    await env.DB.prepare('delete from project_members where project_id = 1 and user_id = 1').run()
    expect((await comment('/tasks/1', 'hi')).status).toBe(403)
  })
})
