import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './auth'

type Kind = 'private' | 'division' | 'project'

const STATUS: Record<string, string> = { todo: 'todo', waiting: 'waiting', in_progress: 'inProgress', review: 'review', done: 'done' }
const PRIORITY = ['low', 'medium', 'high', 'urgent']

/** D1 stores UTC as `YYYY-MM-DD HH:MM:SS`; the app wants ISO 8601. */
const iso = (d: string | null) => (d ? `${d.replace(' ', 'T')}Z` : null)

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
  priority: PRIORITY[Math.min(Math.max(r.priority_level, 1), 4) - 1],
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

/** Throws 403 unless the viewer belongs to the division or project. */
async function assertMember(db: D1Database, kind: Kind, id: number, userId: number) {
  if (kind === 'private') return
  const sql =
    kind === 'division'
      ? 'select 1 from division_members where division_id = ?1 and user_id = ?2'
      : `select 1 from projects p where p.id = ?1 and (p.creator_id = ?2
           or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = ?2))`
  if (!(await db.prepare(sql).bind(id, userId).first())) throw new HTTPException(403, { message: 'Not a member' })
}

export const tabs = new Hono<AppEnv>()

tabs.get('/', async (c) => {
  const me = c.get('user').id
  const { results } = await c.env.DB.prepare(
    `select 'division' kind, d.id, d.name from divisions d
       join division_members m on m.division_id = d.id and m.user_id = ?1
       where d.deleted_at is null
     union all
     select 'project', p.id, p.name from projects p
       where p.status != 'archived' and (p.creator_id = ?1
         or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = ?1))
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
  const query = {
    private: [`select ${PERSONAL_TASK_COLUMNS} from personal_tasks where user_id = ? and parent_id is null order by position, id`, me],
    division: [`select ${TEAM_TASK_COLUMNS} from tasks where division_id = ? and project_id is null and parent_id is null order by id`, id],
    project: [`select ${TEAM_TASK_COLUMNS} from tasks where project_id = ? and parent_id is null order by id`, id],
  }[kind]
  const { results } = await c.env.DB.prepare(query[0] as string).bind(query[1]).all<TaskRow>()
  return c.json(results.map(toTask))
})

tabs.get('/:kind{private|division|project}/:id{[0-9]+}/members', async (c) => {
  const kind = c.req.param('kind') as Kind
  const id = Number(c.req.param('id'))
  const me = c.get('user').id
  if (kind === 'private') return c.json([])
  await assertMember(c.env.DB, kind, id, me)
  const sql =
    kind === 'division'
      ? 'select u.id, u.name, m.role_type role from division_members m join users u on u.id = m.user_id where m.division_id = ?1 and u.is_active = 1'
      : 'select u.id, u.name, m.role from project_members m join users u on u.id = m.user_id where m.project_id = ?1 and u.is_active = 1'
  const { results } = await c.env.DB.prepare(`${sql} order by u.id != ?2, u.id`)
    .bind(id, me)
    .all<{ id: number; name: string; role: string }>()
  return c.json(results.map((m) => ({ user: { id: m.id, name: m.name }, role: m.role })))
})
