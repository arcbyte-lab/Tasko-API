import { Hono } from 'hono'
import type { AppEnv } from './auth'
import { iso, VISIBLE_DIVISION, VISIBLE_PROJECT } from './tabs'
import { teamTask } from './tasks'

/**
 * The Discussion list (arcbyte H13): one row per task with a comment, in the
 * viewer's tabs, newest comment first. A discussion is the task's comment
 * thread; the thread itself is `GET /tasks/:id/detail` and sending is
 * `POST /tasks/:id/comments`.
 */
export const discussions = new Hono<AppEnv>()

type Row = {
  id: number
  code: string | null
  name: string
  tab_kind: 'division' | 'project'
  tab_id: number
  tab_name: string
  author_id: number
  author_name: string
  body: string
  created_at: string
  unread: number
}

discussions.get('/discussions', async (c) => {
  const me = c.get('user').id
  const q = (c.req.query('q') ?? '').trim().replace(/[!%_]/g, '!$&')
  const { results } = await c.env.DB.prepare(
    `select t.id, t.code, t.name,
       case when t.project_id is null then 'division' else 'project' end tab_kind,
       coalesce(t.project_id, t.division_id) tab_id,
       coalesce((select p.name from projects p where p.id = t.project_id), (select d.name from divisions d where d.id = t.division_id)) tab_name,
       u.id author_id, u.name author_name, coalesce(c.comment, '') body, c.created_at,
       (select count(*) from comments x
         where x.task_id = t.id and x.deleted_at is null and x.user_id != ?1
           and x.created_at > coalesce((select r.last_read_at from discussion_reads r where r.user_id = ?1 and r.task_id = t.id), '')) unread
     from tasks t
     join comments c on c.id = (select max(y.id) from comments y where y.task_id = t.id and y.deleted_at is null)
     join users u on u.id = c.user_id
     where t.cancelled_date is null
       and ((t.project_id is not null and exists (select 1 from projects p where p.id = t.project_id and ${VISIBLE_PROJECT}))
         or (t.project_id is null and exists (select 1 from divisions d where d.id = t.division_id and ${VISIBLE_DIVISION})))
       and (t.name like ?2 escape '!' or t.code like ?2 escape '!')
     order by c.id desc limit 100`,
  )
    .bind(me, `%${q}%`)
    .all<Row>()
  const list = results.map((r) => ({
    taskId: r.id,
    code: r.code,
    name: r.name,
    tab: { kind: r.tab_kind, id: r.tab_id, name: r.tab_name },
    last: { author: { id: r.author_id, name: r.author_name }, body: r.body, createdAt: iso(r.created_at) },
    unread: r.unread,
  }))
  // The rails badge counts chats with something unread, not messages.
  return c.json({ unread: list.filter((d) => d.unread > 0).length, discussions: list })
})

/** Opening a conversation: everything in it up to now is read. */
discussions.post('/discussions/:id{[0-9]+}/read', async (c) => {
  const task = await teamTask(c)
  await c.env.DB.prepare(
    `insert into discussion_reads (user_id, task_id, last_read_at) values (?, ?, datetime('now'))
     on conflict (user_id, task_id) do update set last_read_at = excluded.last_read_at`,
  )
    .bind(c.get('user').id, task.id)
    .run()
  return c.body(null, 204)
})
