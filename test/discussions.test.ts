import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, login } from './helpers'

let mira: string
beforeEach(async () => {
  mira = await login()
})

const list = async (path = '/discussions', token = mira) => (await api(token, path)).json() as Promise<any>
const read = (id: number, token = mira) => api(token, `/discussions/${id}/read`, { method: 'POST' })
const comment = (taskId: number, userId: number, text: string, ago = '-1 minutes') =>
  env.DB.prepare("insert into comments (task_id, user_id, comment, created_at, updated_at) values (?, ?, ?, datetime('now', ?), datetime('now'))")
    .bind(taskId, userId, text, ago)
    .run()

describe('discussions', () => {
  it('lists a task with comments, with its last message and what is unread', async () => {
    const { unread, discussions } = await list()
    expect(discussions).toHaveLength(1)
    expect(discussions[0]).toMatchObject({
      taskId: 5,
      code: 'TW-0041',
      name: 'Fix login redirect',
      tab: { kind: 'project', name: 'tasko-web' },
      last: { author: { id: 3 }, body: 'Can this ship before Friday\'s release?' },
      unread: 2,
    })
    expect(discussions[0].last.createdAt).toMatch(/Z$/)
    expect(unread, 'chats, not messages').toBe(1)
  })

  it('newest conversation first; the viewer’s own message is not unread', async () => {
    await comment(1, 2, 'Ping', '-10 minutes')
    await comment(1, 1, 'On it', '-1 minutes')
    const { discussions } = await list()
    expect(discussions.map((d: any) => d.taskId)).toEqual([1, 5])
    expect(discussions[0]).toMatchObject({ last: { body: 'On it' }, unread: 1 })
  })

  it('opening a conversation reads it, until someone else writes again', async () => {
    expect((await read(5)).status).toBe(204)
    expect((await list()).discussions[0].unread).toBe(0)
    expect((await list()).unread).toBe(0)
    await env.DB.prepare("update discussion_reads set last_read_at = datetime('now', '-10 minutes')").run()
    await comment(5, 2, 'One more thing', '-1 minutes')
    expect((await list()).discussions[0].unread).toBe(1)
  })

  it('searches by task name or code', async () => {
    await comment(1, 2, 'Ping')
    expect((await list('/discussions?q=login')).discussions.map((d: any) => d.taskId)).toEqual([5])
    expect((await list('/discussions?q=ta-0011')).discussions.map((d: any) => d.taskId)).toEqual([1])
    expect((await list('/discussions?q=nothing')).discussions).toEqual([])
  })

  it('leaves out archived tasks, deleted comments and other people’s tabs', async () => {
    await env.DB.prepare("update tasks set cancelled_date = datetime('now') where id = 5").run()
    expect((await list()).discussions).toEqual([])
    await env.DB.prepare("update tasks set cancelled_date = null where id = 5").run()
    await env.DB.prepare("update comments set deleted_at = datetime('now')").run()
    expect((await list()).discussions).toEqual([])
    await env.DB.prepare("update comments set deleted_at = null").run()
    await env.DB.prepare('delete from project_members where user_id = 1 and project_id = 2').run()
    expect((await list()).discussions).toEqual([])
  })

  it('marking read follows the task’s tabs: 403 outside, 404 when missing', async () => {
    await env.DB.prepare('delete from project_members where user_id = 1 and project_id = 2').run()
    expect((await read(5)).status).toBe(403)
    expect((await read(9999)).status).toBe(404)
  })
})
