import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './auth'

export type Kind = 'private' | 'division' | 'project'

export const STATUS: Record<string, string> = { todo: 'todo', waiting: 'waiting', in_progress: 'inProgress', review: 'review', done: 'done' }

/** D1 stores UTC as `YYYY-MM-DD HH:MM:SS`; the app wants ISO 8601. A bare date is midnight UTC. */
const iso = (d: string | null) => {
  if (!d) return null
  const s = d.replace(' ', 'T')
  if (!s.includes('T')) return `${s}T00:00:00Z`
  return /(Z|[+-]\d\d:\d\d)$/.test(s) ? s : `${s}Z`
}

export type TaskRow = {
  id: number
  name: string
  status: string
  priority_level: number
  due_date: string | null
  description: string | null
  assignee_id: number | null
  required_proof_type: string | null
  personal: number
  code: string | null
  parent_id: number | null
  completed_at: string | null
}

/** One `Task` shape for both tables, named as in the app's models.dart. */
export const toTask = (r: TaskRow) => ({
  id: r.id,
  name: r.name,
  status: STATUS[r.status],
  priority: r.priority_level,
  dueDate: iso(r.due_date),
  description: r.description,
  assigneeId: r.assignee_id,
  requiredProofType: r.required_proof_type,
  personal: r.personal === 1,
  code: r.code,
  parentId: r.parent_id,
  completedAt: iso(r.completed_at),
})

export const TEAM_TASK_COLUMNS = `id, name, status, priority_level, due_date, description, assignee_id, required_proof_type,
  0 personal, code, parent_id, completed_date completed_at`
export const PERSONAL_TASK_COLUMNS = `id, title name, status, priority_level, due_date, note description, null assignee_id,
  null required_proof_type, 1 personal, null code, parent_id, completed_at`

// The tabs the viewer (?1) sees. GET /tabs and assertMember share these, so a hidden tab can't be opened by id.
const VISIBLE_DIVISION = `d.deleted_at is null
  and exists (select 1 from division_members m where m.division_id = d.id and m.user_id = ?1)`
const VISIBLE_PROJECT = `p.status != 'archived'
  and exists (select 1 from divisions d where d.id = p.division_id and d.deleted_at is null)
  and exists (select 1 from project_members m where m.project_id = p.id and m.user_id = ?1)` // membership is the member tables alone (0002)

/** Throws 403 unless the viewer can see the division or project; the private tab is only id 0. */
export async function assertMember(db: D1Database, kind: Kind, id: number, userId: number) {
  if (kind === 'private') {
    if (id !== 0) throw new HTTPException(404, { message: 'The private tab is 0' })
    return
  }
  const sql =
    kind === 'division'
      ? `select 1 from divisions d where d.id = ?2 and ${VISIBLE_DIVISION}`
      : `select 1 from projects p where p.id = ?2 and ${VISIBLE_PROJECT}`
  if (!(await db.prepare(sql).bind(userId, id).first())) throw new HTTPException(403, { message: 'Not a member' })
}

export const tabs = new Hono<AppEnv>()

tabs.get('/', async (c) => {
  const me = c.get('user').id
  const { results } = await c.env.DB.prepare(
    `select 'division' kind, d.id, d.name from divisions d where ${VISIBLE_DIVISION}
     union all
     select 'project', p.id, p.name from projects p where ${VISIBLE_PROJECT}
     order by kind, id`,
  )
    .bind(me)
    .all()
  return c.json([{ kind: 'private', id: 0, name: 'private' }, ...results])
})

tabs.get('/:kind{private|division|project}/:id{[0-9]+}/tasks', async (c) => {
  const kind = c.req.param('kind') as Kind
  const id = Number(c.req.param('id'))
  const me = c.get('user').id
  await assertMember(c.env.DB, kind, id, me)
  const sql = {
    private: `select ${PERSONAL_TASK_COLUMNS} from personal_tasks where user_id = ? and parent_id is null order by position, id`,
    division: `select ${TEAM_TASK_COLUMNS} from tasks where division_id = ? and project_id is null and parent_id is null order by id`,
    project: `select ${TEAM_TASK_COLUMNS} from tasks where project_id = ? and parent_id is null order by id`,
  }[kind]
  const { results } = await c.env.DB.prepare(sql).bind(kind === 'private' ? me : id).all<TaskRow>()
  return c.json(results.map(toTask))
})

/** Who a task in the tab can be assigned to: its active members, [viewer] first. */
export async function membersOf(db: D1Database, kind: 'division' | 'project', id: number, viewer: number) {
  const sql =
    kind === 'division'
      ? 'select u.id, u.name, m.role_type role from division_members m join users u on u.id = m.user_id where m.division_id = ?1 and u.is_active = 1'
      : 'select u.id, u.name, m.role from project_members m join users u on u.id = m.user_id where m.project_id = ?1 and u.is_active = 1'
  const { results } = await db.prepare(`${sql} order by u.id != ?2, u.id`)
    .bind(id, viewer)
    .all<{ id: number; name: string; role: string }>()
  return results.map((m) => ({ user: { id: m.id, name: m.name }, role: m.role }))
}

tabs.get('/:kind{private|division|project}/:id{[0-9]+}/members', async (c) => {
  const kind = c.req.param('kind') as Kind
  const id = Number(c.req.param('id'))
  const me = c.get('user').id
  await assertMember(c.env.DB, kind, id, me)
  if (kind === 'private') return c.json([])
  return c.json(await membersOf(c.env.DB, kind, id, me))
})
