import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './auth'
import { assertMember, iso, PERSONAL_TASK_COLUMNS, STATUS, type TaskRow, TEAM_TASK_COLUMNS, toTask } from './tabs'

/** The app sends the Dart enum name; the database holds the snake_case value. */
const DB_STATUS: Record<string, string> = Object.fromEntries(Object.entries(STATUS).map(([db, app]) => [app, db]))

/**
 * The checkbox rules (arcbyte decisions 0004 and 0005): what else to set for
 * `from → to`, or null when the move is not allowed.
 */
function teamMove(from: string, to: string, needsReview: boolean): string | null {
  const open = from === 'waiting' || from === 'in_progress'
  if (open && to === 'done' && !needsReview) return "completed_date = datetime('now')"
  if (open && to === 'review' && needsReview) return "review_date = datetime('now')"
  if (from === 'done' && to === 'waiting') return 'completed_date = null, review_date = null'
  return null
}

function personalMove(from: string, to: string): string | null {
  if ((from === 'todo' || from === 'in_progress') && to === 'done') return "completed_at = datetime('now')"
  if (from === 'done' && to === 'todo') return 'completed_at = null'
  return null
}

const bad = (message: string) => new HTTPException(400, { message })

/** The JSON body as an object; null, an array, a bare value or bad JSON is a 400. */
async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('The body must be a JSON object')
  return body as Record<string, unknown>
}

async function newStatus(c: Context<AppEnv>) {
  const { status } = await readBody(c)
  const to = typeof status === 'string' && Object.hasOwn(DB_STATUS, status) ? DB_STATUS[status] : undefined
  if (!to) throw new HTTPException(400, { message: 'status must be one of ' + Object.keys(DB_STATUS).join(', ') })
  return to
}

const notAllowed = (from: string, to: string) => new HTTPException(422, { message: `Cannot move a task from ${from} to ${to}` })
const changedMeanwhile = () => new HTTPException(409, { message: 'The task changed meanwhile; reload it' })
const noAssignee = () => new HTTPException(422, { message: 'A personal task has no assignee' })

type Fields = { name?: string; description?: string | null; priority?: number; dueDate?: string | null; assigneeId?: number | null }

/** A strict ISO 8601 date or date-time, or null; `new Date` alone takes 'March 5' and rolls Feb 30 into March. */
function parseDue(s: unknown) {
  const m = typeof s === 'string' && /^(\d{4})-(\d\d)-(\d\d)(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?$/.exec(s)
  if (!m) return null
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (day.getUTCMonth() !== +m[2] - 1 || day.getUTCDate() !== +m[3]) return null
  const due = new Date(s as string)
  return isNaN(due.getTime()) ? null : due
}

/** The editable fields present in the body; [required] ones must be there. */
async function readFields(c: Context<AppEnv>, required: (keyof Fields)[]): Promise<Fields> {
  const body = await readBody(c)
  for (const key of required) if (!(key in body)) throw bad(`${key} is required`)
  const f: Fields = {}
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw bad('name must be a non-empty string')
    f.name = body.name.trim()
  }
  if ('description' in body) {
    if (body.description !== null && typeof body.description !== 'string') throw bad('description must be a string or null')
    f.description = body.description
  }
  if ('priority' in body) {
    const p = body.priority
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 4) throw bad('priority must be 1 to 4')
    f.priority = p
  }
  if ('dueDate' in body) {
    const due = parseDue(body.dueDate)
    if (body.dueDate !== null && !due) throw bad('dueDate must be an ISO 8601 date or null')
    f.dueDate = due && due.toISOString().slice(0, 19).replace('T', ' ') // D1's UTC datetime format
  }
  if ('assigneeId' in body) {
    if (body.assigneeId !== null && !Number.isInteger(body.assigneeId)) throw bad('assigneeId must be a user id or null')
    f.assigneeId = body.assigneeId as number | null
  }
  return f
}

/** Whether [userId] is an active member of the tab, as its members list (A2) counts them. */
async function isAssignable(db: D1Database, kind: 'division' | 'project', tabId: number, userId: number) {
  const members = kind === 'division' ? 'division_members m where m.division_id' : 'project_members m where m.project_id'
  const sql = `select 1 from ${members} = ?1 and m.user_id = ?2 and exists (select 1 from users u where u.id = m.user_id and u.is_active = 1)`
  return !!(await db.prepare(sql).bind(tabId, userId).first())
}

/** 422 unless [assigneeId] is null or assignable in the tab. */
async function assertAssignable(db: D1Database, kind: 'division' | 'project', tabId: number, assigneeId: number | null | undefined) {
  if (assigneeId != null && !(await isAssignable(db, kind, tabId, assigneeId))) {
    throw new HTTPException(422, { message: 'The assignee is not a member of this tab' })
  }
}

type TeamTask = { division_id: number; project_id: number | null; assignee_id: number | null }
const tabOf = (t: TeamTask) =>
  t.project_id ? { kind: 'project' as const, id: t.project_id } : { kind: 'division' as const, id: t.division_id }

/** A team task in one of the viewer's tabs: 404 if missing, 403 if outside them. */
async function teamTask(c: Context<AppEnv>) {
  const task = await c.env.DB.prepare('select division_id, project_id, assignee_id, creator_id, status, required_proof_type from tasks where id = ?')
    .bind(c.req.param('id'))
    .first<TeamTask & { creator_id: number; status: string; required_proof_type: string | null }>()
  if (!task) throw new HTTPException(404, { message: 'No such task' })
  const tab = tabOf(task)
  await assertMember(c.env.DB, tab.kind, tab.id, c.get('user').id)
  return task
}

/** Someone else's personal task does not exist, as far as the viewer can tell. */
async function ownPersonalTask(c: Context<AppEnv>) {
  const task = await c.env.DB.prepare('select status from personal_tasks where id = ? and user_id = ?')
    .bind(c.req.param('id'), c.get('user').id)
    .first<{ status: string }>()
  if (!task) throw new HTTPException(404, { message: 'No such task' })
  return task
}

/**
 * `code` is the division's prefix and the next number in that division, worked
 * out inside the insert so two inserts can never take the same one.
 */
function insertTeamTask(db: D1Database, t: TeamTask & { parent_id: number | null; creator_id: number }, f: Fields) {
  return db
    .prepare(
      `insert into tasks (code, division_id, project_id, parent_id, creator_id, assignee_id, name, description, priority_level, due_date, created_at, updated_at)
       select d.prefix || '-' || printf('%04d', 1 + coalesce(
           (select max(cast(substr(x.code, length(d.prefix) + 2) as integer)) from tasks x where substr(x.code, 1, length(d.prefix) + 1) = d.prefix || '-'), 0)),
         d.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now')
       from divisions d where d.id = ?1
       returning ${TEAM_TASK_COLUMNS}`,
    )
    .bind(t.division_id, t.project_id, t.parent_id, t.creator_id, t.assignee_id, f.name, f.description ?? null, f.priority ?? 2, f.dueDate ?? null)
    .first<TaskRow>()
}

function insertPersonalTask(db: D1Database, userId: number, parentId: number | null, f: Fields) {
  return db
    .prepare(
      `insert into personal_tasks (user_id, parent_id, title, note, priority_level, due_date, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')) returning ${PERSONAL_TASK_COLUMNS}`,
    )
    .bind(userId, parentId, f.name, f.description ?? null, f.priority ?? 2, f.dueDate ?? null)
    .first<TaskRow>()
}

/** The `set` clause and its values for the fields present in [f]. */
function setClause(f: Fields, personal: boolean) {
  const column = {
    name: personal ? 'title' : 'name',
    description: personal ? 'note' : 'description',
    priority: 'priority_level',
    dueDate: 'due_date',
    assigneeId: 'assignee_id',
  }
  const keys = Object.keys(f) as (keyof Fields)[]
  return { sql: [...keys.map((k) => `${column[k]} = ?`), "updated_at = datetime('now')"].join(', '), values: keys.map((k) => f[k]) }
}

/** A guarded update matched nothing: 404 if the task was deleted meanwhile, else 409. */
async function goneOrChanged(db: D1Database, table: 'tasks' | 'personal_tasks', id: string) {
  const gone = !(await db.prepare(`select 1 from ${table} where id = ?`).bind(id).first())
  return gone ? new HTTPException(404, { message: 'No such task' }) : changedMeanwhile()
}

export const tasks = new Hono<AppEnv>()

tasks.post('/tabs/:kind{private|division|project}/:id{[0-9]+}/tasks', async (c) => {
  const kind = c.req.param('kind') as 'private' | 'division' | 'project'
  const id = Number(c.req.param('id'))
  const me = c.get('user').id
  await assertMember(c.env.DB, kind, id, me)
  const f = await readFields(c, ['name', 'priority'])
  if (kind === 'private') {
    if (f.assigneeId != null) throw noAssignee()
    return c.json(toTask((await insertPersonalTask(c.env.DB, me, null, f))!), 201)
  }
  await assertAssignable(c.env.DB, kind, id, f.assigneeId)
  const division_id =
    kind === 'division' ? id : (await c.env.DB.prepare('select division_id from projects where id = ?').bind(id).first<number>('division_id'))!
  const project_id = kind === 'project' ? id : null
  const row = await insertTeamTask(c.env.DB, { division_id, project_id, parent_id: null, creator_id: me, assignee_id: f.assigneeId ?? null }, f)
  return c.json(toTask(row!), 201)
})

tasks.patch('/tasks/:id{[0-9]+}', async (c) => {
  const task = await teamTask(c)
  const f = await readFields(c, [])
  const tab = tabOf(task)
  await assertAssignable(c.env.DB, tab.kind, tab.id, f.assigneeId)
  const set = setClause(f, false)
  const row = await c.env.DB.prepare(`update tasks set ${set.sql} where id = ? returning ${TEAM_TASK_COLUMNS}`)
    .bind(...set.values, c.req.param('id'))
    .first<TaskRow>()
  return c.json(toTask(row!))
})

tasks.patch('/personal-tasks/:id{[0-9]+}', async (c) => {
  await ownPersonalTask(c)
  const f = await readFields(c, [])
  if (f.assigneeId != null) throw noAssignee()
  delete f.assigneeId
  const set = setClause(f, true)
  const row = await c.env.DB.prepare(`update personal_tasks set ${set.sql} where id = ? returning ${PERSONAL_TASK_COLUMNS}`)
    .bind(...set.values, c.req.param('id'))
    .first<TaskRow>()
  return c.json(toTask(row!))
})

/** A sub-task stays in its parent's tab and starts with the parent's assignee, if they can still be assigned there. */
/** Sub-tasks are one level deep: a sub-task can't have its own. */
async function assertTopLevel(db: D1Database, table: 'tasks' | 'personal_tasks', id: string) {
  if ((await db.prepare(`select parent_id from ${table} where id = ?`).bind(id).first('parent_id')) !== null) {
    throw new HTTPException(422, { message: 'A sub-task cannot have sub-tasks' })
  }
}

tasks.post('/tasks/:id{[0-9]+}/subtasks', async (c) => {
  const parent = await teamTask(c)
  await assertTopLevel(c.env.DB, 'tasks', c.req.param('id'))
  const { name } = await readFields(c, ['name'])
  const tab = tabOf(parent)
  const keep = parent.assignee_id !== null && (await isAssignable(c.env.DB, tab.kind, tab.id, parent.assignee_id))
  const row = await insertTeamTask(
    c.env.DB,
    {
      division_id: parent.division_id,
      project_id: parent.project_id,
      assignee_id: keep ? parent.assignee_id : null,
      parent_id: Number(c.req.param('id')),
      creator_id: c.get('user').id,
    },
    { name },
  )
  return c.json(toTask(row!), 201)
})

tasks.post('/personal-tasks/:id{[0-9]+}/subtasks', async (c) => {
  await ownPersonalTask(c)
  await assertTopLevel(c.env.DB, 'personal_tasks', c.req.param('id'))
  const { name } = await readFields(c, ['name'])
  return c.json(toTask((await insertPersonalTask(c.env.DB, c.get('user').id, Number(c.req.param('id')), { name }))!), 201)
})

tasks.patch('/tasks/:id{[0-9]+}/status', async (c) => {
  const me = c.get('user').id
  const to = await newStatus(c)
  // Only in a tab the viewer can see; then the assignee ticks it, or anyone if it's unassigned.
  const task = await teamTask(c)
  if (task.assignee_id !== null && task.assignee_id !== me) {
    throw new HTTPException(403, { message: 'Only the assignee can change this task' })
  }

  const also = teamMove(task.status, to, task.required_proof_type !== null)
  if (also === null) throw notAllowed(task.status, to)
  const row = await c.env.DB.prepare(
    `update tasks set status = ?1, ${also ? also + ', ' : ''}updated_at = datetime('now')
     where id = ?2 and status = ?3 returning ${TEAM_TASK_COLUMNS}`,
  )
    .bind(to, c.req.param('id'), task.status)
    .first<TaskRow>()
  if (!row) throw await goneOrChanged(c.env.DB, 'tasks', c.req.param('id'))
  return c.json(toTask(row))
})

tasks.patch('/personal-tasks/:id{[0-9]+}/status', async (c) => {
  const to = await newStatus(c)
  const task = await ownPersonalTask(c)

  const also = personalMove(task.status, to)
  if (also === null) throw notAllowed(task.status, to)
  const row = await c.env.DB.prepare(
    `update personal_tasks set status = ?1, ${also}, updated_at = datetime('now')
     where id = ?2 and status = ?3 returning ${PERSONAL_TASK_COLUMNS}`,
  )
    .bind(to, c.req.param('id'), task.status)
    .first<TaskRow>()
  if (!row) throw await goneOrChanged(c.env.DB, 'personal_tasks', c.req.param('id'))
  return c.json(toTask(row))
})

/**
 * Who reviews a task (arcbyte decision 0004): in a project, its
 * person-in-charge or its author; in a division only, its admin or supervisor.
 * A reviewer may review their own task.
 */
export async function isReviewer(db: D1Database, task: TeamTask, userId: number) {
  const tab = tabOf(task)
  const sql =
    tab.kind === 'project'
      ? `select 1 from projects p where p.id = ?1 and (p.creator_id = ?2 or exists (select 1 from project_members m
           where m.project_id = p.id and m.user_id = ?2 and m.role = 'person-in-charge'))`
      : `select 1 from division_members where division_id = ?1 and user_id = ?2 and role_type in ('admin', 'supervisor')`
  return !!(await db.prepare(sql).bind(tab.id, userId).first())
}

tasks.get('/tasks/:id{[0-9]+}/detail', async (c) => {
  const me = c.get('user').id
  const task = await teamTask(c)
  const tab = tabOf(task)
  const [tabRow, subtasks, comments, assignee, reviewer] = await Promise.all([
    c.env.DB.prepare(`select name from ${tab.kind === 'project' ? 'projects' : 'divisions'} where id = ?`).bind(tab.id).first<string>('name'),
    c.env.DB.prepare(`select ${TEAM_TASK_COLUMNS} from tasks where parent_id = ? order by created_at, id`).bind(c.req.param('id')).all<TaskRow>(),
    c.env.DB.prepare(
      `select u.id, u.name, c.comment body, c.created_at from comments c join users u on u.id = c.user_id
       where c.task_id = ? and c.deleted_at is null order by c.created_at, c.id`,
    )
      .bind(c.req.param('id'))
      .all<{ id: number; name: string; body: string; created_at: string }>(),
    task.assignee_id === null ? null : c.env.DB.prepare('select id, name from users where id = ?').bind(task.assignee_id).first(),
    isReviewer(c.env.DB, task, me),
  ])
  return c.json({
    tab: { kind: tab.kind, id: tab.id, name: tabRow },
    subtasks: subtasks.results.map(toTask),
    comments: comments.results.map((r) => ({ author: { id: r.id, name: r.name }, body: r.body, createdAt: iso(r.created_at) })),
    assignee,
    canReview: task.status === 'review' && reviewer,
    canArchive: task.creator_id === me,
    canRequestExtension: task.assignee_id === me && !reviewer,
  })
})

tasks.get('/personal-tasks/:id{[0-9]+}/detail', async (c) => {
  await assertOwnPersonalTask(c)
  const { results } = await c.env.DB.prepare(`select ${PERSONAL_TASK_COLUMNS} from personal_tasks where parent_id = ? order by created_at, id`)
    .bind(c.req.param('id'))
    .all<TaskRow>()
  return c.json({
    tab: { kind: 'private', id: 0, name: 'private' },
    subtasks: results.map(toTask),
    comments: [],
    assignee: null,
    canReview: false,
    canArchive: false,
    canRequestExtension: false,
  })
})

tasks.post('/tasks/:id{[0-9]+}/comments', async (c) => {
  await teamTask(c)
  const { body } = await c.req.json<{ body?: unknown }>().catch(() => ({}) as { body?: unknown })
  if (typeof body !== 'string' || !body.trim()) throw bad('body must be a non-empty string')
  const user = c.get('user')
  const createdAt = await c.env.DB.prepare(
    `insert into comments (task_id, user_id, comment, created_at, updated_at) values (?, ?, ?, datetime('now'), datetime('now')) returning created_at`,
  )
    .bind(c.req.param('id'), user.id, body.trim())
    .first<string>('created_at')
  return c.json({ author: { id: user.id, name: user.name }, body: body.trim(), createdAt: iso(createdAt!) }, 201)
})
