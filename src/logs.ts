import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { LEADS_DIVISION, MANAGES_PROJECT, opensLog } from './activity'
import type { AppEnv } from './auth'
import { assertMember, iso } from './tabs'
import { tabOf, teamTask } from './tasks'

/**
 * The four activity logs (arcbyte decision 0014): one table, filtered per log,
 * newest first. Only leads open them; a user also opens their own.
 */
const PAGE = 50

type LogRow = {
  id: number
  action: string
  actor_id: number | null
  actor_name: string | null
  subject_type: string
  subject_id: number
  subject_label: string
  division_id: number | null
  project_id: number | null
  target_id: number | null
  target_name: string | null
  tab_name: string | null
  changes: string | null
  created_at: string
}

// A user log shows a lead only the rows a log they open would: a division's own
// rows, its projects' project and member rows, and the projects they manage.
const VISIBLE_ROW = `(((l.project_id is null or l.action like 'project.%' or l.action like 'member.%') and ${LEADS_DIVISION('l.division_id', '?1')})
  or (l.project_id is not null and ${MANAGES_PROJECT('l.project_id', '?1')}))`

/** One page of rows matching [where]: ?1 is the viewer, ?2 the log's id. */
async function page(c: Context<AppEnv>, where: string, id: number) {
  const before = c.req.query('before')
  if (before !== undefined && !/^[0-9]+$/.test(before)) throw new HTTPException(400, { message: 'before must be a log id' })
  const { results } = await c.env.DB.prepare(
    `select l.id, l.action, l.actor_id, l.actor_name, l.subject_type, l.subject_id, l.subject_label, l.division_id, l.project_id,
       l.changes, l.created_at, t.id target_id, t.name target_name,
       case when l.project_id is null then d.name else p.name end tab_name
     from activity_logs l
       left join users t on t.id = l.target_user_id
       left join projects p on p.id = l.project_id
       left join divisions d on d.id = l.division_id
     where ${where} and (?3 is null or l.id < ?3)
     order by l.id desc limit ${PAGE + 1}`,
  )
    .bind(c.get('user').id, id, before === undefined ? null : Number(before))
    .all<LogRow>()
  const items = results.slice(0, PAGE).map((r) => ({
    id: r.id,
    action: r.action,
    actor: { id: r.actor_id, name: r.actor_name },
    subject: { type: r.subject_type, id: r.subject_id, label: r.subject_label },
    target: r.target_id === null ? null : { id: r.target_id, name: r.target_name },
    tab: r.project_id === null ? { kind: 'division', id: r.division_id, name: r.tab_name } : { kind: 'project', id: r.project_id, name: r.tab_name },
    changes: r.changes === null ? null : JSON.parse(r.changes),
    createdAt: iso(r.created_at),
  }))
  return c.json({ items, next: results.length > PAGE ? items[PAGE - 1].id : null })
}

const leadsOnly = () => new HTTPException(403, { message: 'Only a lead can open this log' })

export const logs = new Hono<AppEnv>()

logs.get('/tasks/:id{[0-9]+}/activity', async (c) => {
  const task = await teamTask(c)
  if (!(await opensLog(c.env.DB, tabOf(task), c.get('user').id))) throw leadsOnly()
  return page(c, "l.subject_type = 'task' and l.subject_id = ?2", task.id)
})

logs.get('/projects/:id{[0-9]+}/activity', async (c) => {
  const id = Number(c.req.param('id'))
  await assertMember(c.env.DB, 'project', id, c.get('user').id)
  if (!(await opensLog(c.env.DB, { kind: 'project', id }, c.get('user').id))) throw leadsOnly()
  return page(c, 'l.project_id = ?2', id)
})

/** Its own tab's rows, and its projects' project and member rows; not the tasks inside them. */
logs.get('/divisions/:id{[0-9]+}/activity', async (c) => {
  const id = Number(c.req.param('id'))
  await assertMember(c.env.DB, 'division', id, c.get('user').id)
  if (!(await opensLog(c.env.DB, { kind: 'division', id }, c.get('user').id))) throw leadsOnly()
  return page(c, "l.division_id = ?2 and (l.project_id is null or l.action like 'project.%' or l.action like 'member.%')", id)
})

/** What they did and what was done to them; opened by them, or a lead of one of their divisions. */
logs.get('/users/:id{[0-9]+}/activity', async (c) => {
  const id = Number(c.req.param('id'))
  const me = c.get('user').id
  if (!(await c.env.DB.prepare('select 1 from users where id = ?').bind(id).first())) throw new HTTPException(404, { message: 'No such user' })
  if (id !== me) {
    const leads = await c.env.DB.prepare(
      `select 1 from division_members m where m.user_id = ?2 and ${LEADS_DIVISION('m.division_id', '?1')}`,
    )
      .bind(me, id)
      .first()
    if (!leads) throw new HTTPException(403, { message: 'Only they or a lead of their division can open this log' })
  }
  return page(c, `(l.actor_id = ?2 or l.target_user_id = ?2) and (?1 = ?2 or ${VISIBLE_ROW})`, id)
})
