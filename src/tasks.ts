import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { JUST_INSERTED, logRow, opensLog } from './activity'
import type { AppEnv } from './auth'
import { notify } from './notifications'
import { nextDue, readRepeat, type Repeat } from './repeat'
import { assertMember, iso, PERSONAL_TASK_COLUMNS, STATUS, TEAM_TASK_COLUMNS, toTask, type TaskRow } from './tabs'

/** The app sends the Dart enum name; the database holds the snake_case value. */
const DB_STATUS: Record<string, string> = Object.fromEntries(Object.entries(STATUS).map(([db, app]) => [app, db]))

/**
 * The checkbox rules (arcbyte decisions 0004 and 0005): what else to set for
 * `from → to`, or null when the move is not allowed. Task Detail's "start
 * working" moves an untouched task to in progress (decision 0008); the
 * checkbox itself never does.
 */
/** The log action for a move to each status (arcbyte decision 0014); `waiting` is only reached by reopening. */
const MOVED: Record<string, string> = { in_progress: 'task.started', done: 'task.completed', review: 'task.sent_to_review', waiting: 'task.reopened' }

function teamMove(from: string, to: string, needsReview: boolean): string | null {
  const open = from === 'waiting' || from === 'in_progress'
  if (from === 'waiting' && to === 'in_progress') return "start_date = coalesce(start_date, datetime('now'))"
  if (open && to === 'done' && !needsReview) return "completed_date = datetime('now')"
  if (open && to === 'review' && needsReview) return "review_date = datetime('now')"
  if (from === 'done' && to === 'waiting') return 'completed_date = null, review_date = null'
  return null
}

function personalMove(from: string, to: string): string | null {
  if (from === 'todo' && to === 'in_progress') return ''
  if ((from === 'todo' || from === 'in_progress') && to === 'done') return "completed_at = datetime('now')"
  if (from === 'done' && to === 'todo') return 'completed_at = null'
  return null
}

export const bad = (message: string) => new HTTPException(400, { message })

/** The JSON body as an object; null, an array, a bare value or bad JSON is a 400. */
export async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('The body must be a JSON object')
  return body as Record<string, unknown>
}

async function newStatus(c: Context<AppEnv>) {
  const body = await readBody(c)
  const to = typeof body.status === 'string' && Object.hasOwn(DB_STATUS, body.status) ? DB_STATUS[body.status] : undefined
  if (!to) throw new HTTPException(400, { message: 'status must be one of ' + Object.keys(DB_STATUS).join(', ') })
  return { to, body }
}

/**
 * A proof is a link for now (owner's call, 2026-10-09): an http(s) URL. Sending a
 * task to review needs one (decision 0004: the user is asked for it first).
 */
function proofLink(value: unknown) {
  const s = typeof value === 'string' ? value.trim() : ''
  let url: URL | null = null
  try {
    url = new URL(s)
  } catch {}
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || s.length > 2048) {
    throw bad('proofUrl must be an http or https link; a task needs one to go to review')
  }
  return s
}

const notAllowed = (from: string, to: string) => new HTTPException(422, { message: `Cannot move a task from ${from} to ${to}` })
const changedMeanwhile = () => new HTTPException(409, { message: 'The task changed meanwhile; reload it' })
const noAssignee = () => new HTTPException(422, { message: 'A personal task has no assignee' })

/** An ISO 8601 string as D1's UTC datetime, `YYYY-MM-DD HH:MM:SS`. */
function dbDate(value: unknown, field: string) {
  const date = parseDue(value)
  if (!date) throw bad(`${field} must be an ISO 8601 date`)
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

type Fields = { name?: string; description?: string | null; priority?: number; dueDate?: string | null; assigneeId?: number | null; repeat?: string | null }

/** A strict ISO 8601 date or date-time, or null; `new Date` alone takes 'March 5' and rolls Feb 30 into March. */
export function parseDue(s: unknown) {
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
  if ('dueDate' in body) f.dueDate = body.dueDate === null ? null : dbDate(body.dueDate, 'dueDate')
  if ('assigneeId' in body) {
    if (body.assigneeId !== null && !Number.isInteger(body.assigneeId)) throw bad('assigneeId must be a user id or null')
    f.assigneeId = body.assigneeId as number | null
  }
  if ('repeat' in body) f.repeat = readRepeat(body.repeat)
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
export const tabOf = (t: TeamTask) =>
  t.project_id ? { kind: 'project' as const, id: t.project_id } : { kind: 'division' as const, id: t.division_id }

/** A team task in one of the viewer's tabs: 404 if missing, 403 if outside them. */
export async function teamTask(c: Context<AppEnv>) {
  const task = await c.env.DB.prepare(
    'select id, name, description, priority_level, division_id, project_id, parent_id, assignee_id, creator_id, status, required_proof_type, due_date, repeat from tasks where id = ?',
  )
    .bind(c.req.param('id'))
    .first<
      TeamTask & {
        id: number
        name: string
        description: string | null
        priority_level: number
        parent_id: number | null
        creator_id: number
        status: string
        required_proof_type: string | null
        due_date: string | null
        repeat: string | null
      }
    >()
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
function insertTeamTask(
  db: D1Database,
  t: TeamTask & { parent_id: number | null; creator_id: number; required_proof_type?: string | null; series_id?: number | null },
  f: Fields,
  where = '',
) {
  return db
    .prepare(
      `insert into tasks (code, division_id, project_id, parent_id, creator_id, assignee_id, name, description, priority_level, due_date,
         required_proof_type, repeat, series_id, created_at, updated_at)
       select d.prefix || '-' || printf('%04d', 1 + coalesce(
           (select max(cast(substr(x.code, length(d.prefix) + 2) as integer)) from tasks x where substr(x.code, 1, length(d.prefix) + 1) = d.prefix || '-'), 0)),
         d.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now'), datetime('now')
       from divisions d where d.id = ?1${where}
       returning ${TEAM_TASK_COLUMNS}`,
    )
    .bind(
      t.division_id, t.project_id, t.parent_id, t.creator_id, t.assignee_id, f.name, f.description ?? null, f.priority ?? 2, f.dueDate ?? null,
      t.required_proof_type ?? null, f.repeat ?? null, t.series_id ?? null,
    )
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
    repeat: 'repeat',
  }
  const keys = Object.keys(f) as (keyof Fields)[]
  return { sql: [...keys.map((k) => `${column[k]} = ?`), "updated_at = datetime('now')"].join(', '), values: keys.map((k) => f[k]) }
}

/** A guarded update matched nothing: 404 if the task was deleted meanwhile, else 409. */
async function goneOrChanged(db: D1Database, table: 'tasks' | 'personal_tasks', id: string) {
  const gone = !(await db.prepare(`select 1 from ${table} where id = ?`).bind(id).first())
  return gone ? new HTTPException(404, { message: 'No such task' }) : changedMeanwhile()
}

/** Only a division's admins and supervisors set up repeats (arcbyte decision 0012); for a workspace task they are its reviewers. */
export async function assertLead(db: D1Database, divisionId: number, me: number) {
  if (!(await isReviewer(db, { division_id: divisionId, project_id: null, assignee_id: null }, me))) {
    throw new HTTPException(403, { message: 'Only a division admin or supervisor can set up a repeat' })
  }
}

/** Only a workspace's own top-level tasks repeat (arcbyte decision 0009), and only from a due date. */
function assertCanRepeat(kind: 'private' | 'division' | 'project', parentId: number | null, due: string | null | undefined) {
  if (kind !== 'division' || parentId !== null) throw new HTTPException(422, { message: 'Only a workspace task can repeat' })
  if (due == null) throw new HTTPException(422, { message: 'A repeating task needs a due date' })
}

type Actor = { id: number; name: string }

type Finished = TeamTask & {
  name: string
  description: string | null
  priority_level: number
  due_date: string | null
  required_proof_type: string | null
  repeat: string | null
  series_id: number
}

/**
 * Finishing a repeating task creates the next one, due one step later, and the
 * rule moves onto it (Santian's repeat, decision 0009). One step only, even if
 * finished late: no catch-up. Moving the rule is the guard, so unticking and
 * ticking again never makes a second one. Sub-tasks, comments and proofs stay
 * with the finished task. Returns whether a next one was created.
 */
async function createNextOccurrence(db: D1Database, id: number, actor: Actor) {
  const done = await db
    .prepare(
      'select division_id, project_id, assignee_id, name, description, priority_level, due_date, required_proof_type, repeat, coalesce(series_id, id) series_id from tasks where id = ?',
    )
    .bind(id)
    .first<Finished>()
  if (!done?.repeat || !done.due_date) return false
  const rule = JSON.parse(done.repeat) as Repeat
  const due = nextDue(done.due_date, rule)
  if (!due) {
    // Ran out: the repeat ends, and stays listed until a lead deletes it (decision 0013).
    await db.prepare('update tasks set repeat_ended = repeat, repeat = null where id = ? and repeat = ?').bind(id, done.repeat).run()
    return false
  }
  const keep = done.assignee_id !== null && (await isAssignable(db, 'division', done.division_id, done.assignee_id))
  const next = { ...rule, count: rule.count === null ? null : rule.count - 1 }
  const assignee = keep ? done.assignee_id : null
  // One transaction: the new task, and its log row, are written only if this call moved the rule off the finished one.
  const [, inserted] = await db.batch<TaskRow>([
    db.prepare('update tasks set repeat = null where id = ? and repeat = ?').bind(id, done.repeat),
    insertTeamTask(
      db,
      { ...done, parent_id: null, creator_id: actor.id, assignee_id: assignee },
      { name: done.name, description: done.description, priority: done.priority_level, dueDate: due, repeat: JSON.stringify(next) },
      ' and changes() = 1',
    ),
    logRow(
      db,
      {
        actor, action: 'repeat.next_created', subject: { type: 'task', id: JUST_INSERTED, label: done.name },
        divisionId: done.division_id, projectId: null, targetUserId: assignee, changes: { fromTaskId: id, dueDate: iso(due) },
      },
      true,
    ),
  ])
  const row = inserted.results[0]
  if (row?.assignee_id != null) await notify(db, [row.assignee_id], 'task_assigned', { taskId: row.id, taskName: row.name, actorId: actor.id })
  return !!row
}

type Stored = Awaited<ReturnType<typeof teamTask>>

const parseRule = (rule: string | null | undefined) => (rule == null ? null : JSON.parse(rule))

/** The plain fields an edit logs, each as its own row: field, action, stored column. */
const EDITS = [
  ['name', 'task.renamed', 'name'],
  ['description', 'task.description_changed', 'description'],
  ['priority', 'task.priority_changed', 'priority_level'],
  ['dueDate', 'task.due_changed', 'due_date'],
] as const

/**
 * One guarded log row per field [f] changes on [task] (arcbyte decision 0014),
 * to follow the update in its batch. A reassignment logs both people: the old
 * assignee's unassign and the new one's assign.
 */
async function editLogs(db: D1Database, task: Stored, f: Fields, actor: Actor) {
  const row = (action: string, changes: Record<string, unknown>, targetUserId: number | null = null) =>
    logRow(
      db,
      { actor, action, subject: { type: 'task', id: task.id, label: f.name ?? task.name }, divisionId: task.division_id, projectId: task.project_id, targetUserId, changes },
      true,
    )
  const rows = []
  for (const [key, action, column] of EDITS) {
    if (!(key in f) || f[key] === task[column]) continue
    const [before, after] = key === 'dueDate' ? [iso(task.due_date), iso(f.dueDate ?? null)] : [task[column], f[key]]
    rows.push(row(action, { [key]: [before, after] }))
  }
  if ('assigneeId' in f && f.assigneeId !== task.assignee_id) {
    const change = [task.assignee_id, f.assigneeId]
    const nameOf = (id: number) => db.prepare('select name from users where id = ?').bind(id).first<string>('name')
    if (task.assignee_id !== null) rows.push(row('task.unassigned', { assigneeId: change, assigneeName: await nameOf(task.assignee_id) }, task.assignee_id))
    if (f.assigneeId != null) rows.push(row('task.assigned', { assigneeId: change, assigneeName: await nameOf(f.assigneeId) }, f.assigneeId))
  }
  if ('repeat' in f && f.repeat !== task.repeat) {
    const action = task.repeat === null ? 'repeat.set' : f.repeat === null ? 'repeat.stopped' : 'repeat.changed'
    rows.push(row(action, { repeat: [parseRule(task.repeat), parseRule(f.repeat)] }))
  }
  return rows
}

export const tasks = new Hono<AppEnv>()

tasks.post('/tabs/:kind{private|division|project}/:id{[0-9]+}/tasks', async (c) => {
  const kind = c.req.param('kind') as 'private' | 'division' | 'project'
  const id = Number(c.req.param('id'))
  const me = c.get('user').id
  await assertMember(c.env.DB, kind, id, me)
  const f = await readFields(c, ['name', 'priority'])
  if (f.repeat != null) assertCanRepeat(kind, null, f.dueDate)
  if (f.repeat != null) await assertLead(c.env.DB, id, me)
  if (kind === 'private') {
    if (f.assigneeId != null) throw noAssignee()
    return c.json(toTask((await insertPersonalTask(c.env.DB, me, null, f))!), 201)
  }
  await assertAssignable(c.env.DB, kind, id, f.assigneeId)
  const division_id =
    kind === 'division' ? id : (await c.env.DB.prepare('select division_id from projects where id = ?').bind(id).first<number>('division_id'))!
  const project_id = kind === 'project' ? id : null
  const insert = insertTeamTask(c.env.DB, { division_id, project_id, parent_id: null, creator_id: me, assignee_id: f.assigneeId ?? null }, f)
  const log = logRow(
    c.env.DB,
    {
      actor: c.get('user'), action: 'task.created', subject: { type: 'task', id: JUST_INSERTED, label: f.name! },
      divisionId: division_id, projectId: project_id, targetUserId: f.assigneeId, changes: { ...f, repeat: parseRule(f.repeat) },
    },
    true,
  )
  // A repeating task starts its own series; one transaction, so it never exists without one, or without its log row.
  const [inserted] = await c.env.DB.batch<TaskRow>(
    f.repeat ? [insert, c.env.DB.prepare('update tasks set series_id = id where id = last_insert_rowid()'), log] : [insert, log],
  )
  const row: TaskRow = f.repeat ? { ...inserted.results[0], series_id: inserted.results[0].id } : inserted.results[0]
  if (row.assignee_id !== null) await notify(c.env.DB, [row.assignee_id], 'task_assigned', { taskId: row.id, taskName: row.name, actorId: me })
  return c.json(toTask(row), 201)
})

/** The assignee, the creator and the reviewers edit a team task; only the creator and reviewers reassign it. */
tasks.patch('/tasks/:id{[0-9]+}', async (c) => {
  const me = c.get('user').id
  const task = await teamTask(c)
  const lead = task.creator_id === me || (await isReviewer(c.env.DB, task, me))
  if (!lead && task.assignee_id !== me) throw new HTTPException(403, { message: 'Only the assignee, the creator or a reviewer can edit this task' })
  const f = await readFields(c, [])
  if (!lead && 'assigneeId' in f && f.assigneeId !== task.assignee_id) {
    throw new HTTPException(403, { message: 'Only the creator or a reviewer can reassign this task' })
  }
  const tab = tabOf(task)
  await assertAssignable(c.env.DB, tab.kind, tab.id, f.assigneeId)
  if (('repeat' in f ? f.repeat : task.repeat) != null) {
    assertCanRepeat(tab.kind, task.parent_id, 'dueDate' in f ? f.dueDate : task.due_date)
  }
  // The app sends the rule with every edit, so only a change needs a lead.
  if ('repeat' in f && f.repeat !== task.repeat) await assertLead(c.env.DB, task.division_id, me)
  const set = setClause(f, false)
  // Turning a rule on starts a series, or continues the one it was stopped in.
  if (f.repeat != null) set.sql += ', series_id = coalesce(series_id, id), repeat_ended = null'
  // Stopping ends the repeat; its last rule is kept for the repeating view (decision 0013).
  else if ('repeat' in f && task.repeat !== null) set.sql += ', repeat_ended = repeat'
  // A reassignment only applies over the assignee read above, so two at once can't both notify.
  const reassign = 'assigneeId' in f
  const update = c.env.DB.prepare(
    `update tasks set ${set.sql} where id = ?${reassign ? ' and assignee_id is ?' : ''} returning ${TEAM_TASK_COLUMNS}`,
  ).bind(...set.values, c.req.param('id'), ...(reassign ? [task.assignee_id] : []))
  // ponytail: other fields' "before" is the read above, not the row updated; a concurrent edit can make it stale.
  const [updated] = await c.env.DB.batch<TaskRow>([update, ...(await editLogs(c.env.DB, task, f, c.get('user')))])
  const row = updated.results[0]
  if (!row) throw changedMeanwhile()
  if (row.assignee_id !== null && row.assignee_id !== task.assignee_id) {
    await notify(c.env.DB, [row.assignee_id], 'task_assigned', { taskId: row.id, taskName: row.name, actorId: c.get('user').id })
  }
  return c.json(toTask(row))
})

tasks.patch('/personal-tasks/:id{[0-9]+}', async (c) => {
  await ownPersonalTask(c)
  const f = await readFields(c, [])
  if (f.assigneeId != null) throw noAssignee()
  if (f.repeat != null) assertCanRepeat('private', null, f.dueDate)
  delete f.assigneeId
  delete f.repeat
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
  const [inserted] = await c.env.DB.batch<TaskRow>([
    insertTeamTask(
      c.env.DB,
      {
        division_id: parent.division_id,
        project_id: parent.project_id,
        assignee_id: keep ? parent.assignee_id : null,
        parent_id: parent.id,
        creator_id: c.get('user').id,
      },
      { name },
    ),
    // A sub-task's log is its parent's.
    logRow(
      c.env.DB,
      {
        actor: c.get('user'), action: 'subtask.added', subject: { type: 'task', id: parent.id, label: parent.name },
        divisionId: parent.division_id, projectId: parent.project_id, changes: { subtask: name },
      },
      true,
    ),
  ])
  const row = inserted.results[0]
  const me = c.get('user').id
  if (row!.assignee_id !== null) await notify(c.env.DB, [row!.assignee_id], 'task_assigned', { taskId: row!.id, taskName: row!.name, actorId: me })
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
  const { to, body } = await newStatus(c)
  // Only in a tab the viewer can see; then the assignee ticks it, or anyone if it's unassigned.
  const task = await teamTask(c)
  if (task.assignee_id !== null && task.assignee_id !== me) {
    throw new HTTPException(403, { message: 'Only the assignee can change this task' })
  }

  const also = teamMove(task.status, to, task.required_proof_type !== null)
  if (also === null) throw notAllowed(task.status, to)
  const proof = to === 'review' ? proofLink(body.proofUrl) : null
  const log = logRow(
    c.env.DB,
    {
      actor: c.get('user'), action: MOVED[to], subject: { type: 'task', id: task.id, label: task.name },
      divisionId: task.division_id, projectId: task.project_id, targetUserId: task.assignee_id,
      changes: { status: [task.status, to], ...(proof === null ? {} : { proofUrl: proof }) },
    },
    true,
  )
  const update = c.env.DB.prepare(
    `update tasks set status = ?1, ${also ? also + ', ' : ''}updated_at = datetime('now')
     where id = ?2 and status = ?3 returning ${TEAM_TASK_COLUMNS}`,
  ).bind(to, c.req.param('id'), task.status)
  // With a proof, one transaction: the proof row is written only if the status moved, and the log row only if both were.
  const [updated] = await c.env.DB.batch<TaskRow>(
    proof === null
      ? [update, log]
      : [
          update,
          c.env.DB.prepare(
            `insert into proofs (task_id, user_id, file, created_at, updated_at)
             select ?, ?, ?, datetime('now'), datetime('now') where changes() = 1`,
          ).bind(c.req.param('id'), me, proof),
          log,
        ],
  )
  const row = updated.results[0]
  if (!row) throw await goneOrChanged(c.env.DB, 'tasks', c.req.param('id'))
  if (to === 'review') {
    await notify(c.env.DB, await reviewersOf(c.env.DB, task), 'task_review_requested', { taskId: row.id, taskName: row.name, actorId: me })
  }
  if (to === 'done' && (await createNextOccurrence(c.env.DB, row.id, c.get('user')))) row.repeat = null
  return c.json(toTask(row))
})

tasks.patch('/personal-tasks/:id{[0-9]+}/status', async (c) => {
  const { to } = await newStatus(c)
  const task = await ownPersonalTask(c)

  const also = personalMove(task.status, to)
  if (also === null) throw notAllowed(task.status, to)
  const row = await c.env.DB.prepare(
    `update personal_tasks set status = ?1, ${also ? also + ', ' : ''}updated_at = datetime('now')
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
 * The author counts only while still a member (decision 0002). A reviewer may
 * review their own task.
 */
/** The task's reviewers, or with [only], just that user if they are one. */
async function reviewersOf(db: D1Database, task: TeamTask, only: number | null = null) {
  const tab = tabOf(task)
  const sql =
    tab.kind === 'project'
      ? `select m.user_id id from project_members m join projects p on p.id = m.project_id
         where m.project_id = ?1 and (m.role = 'person-in-charge' or m.user_id = p.creator_id)`
      : `select user_id id from division_members where division_id = ?1 and role_type in ('admin', 'supervisor')`
  const { results } = await db.prepare(`select id from (${sql}) where ?2 is null or id = ?2`).bind(tab.id, only).all<{ id: number }>()
  return results.map((r) => r.id)
}

const isReviewer = async (db: D1Database, task: TeamTask, userId: number) => (await reviewersOf(db, task, userId)).length > 0

tasks.get('/tasks/:id{[0-9]+}/detail', async (c) => {
  const me = c.get('user').id
  const task = await teamTask(c)
  const tab = tabOf(task)
  const repeatable = tab.kind === 'division' && task.parent_id === null
  const [tabRow, subtasks, comments, assignee, reviewer, proof, canViewLog] = await Promise.all([
    c.env.DB.prepare(`select name from ${tab.kind === 'project' ? 'projects' : 'divisions'} where id = ?`).bind(tab.id).first<string>('name'),
    c.env.DB.prepare(`select ${TEAM_TASK_COLUMNS} from tasks where parent_id = ? order by created_at, id`).bind(c.req.param('id')).all<TaskRow>(),
    c.env.DB.prepare(
      `select u.id, u.name, coalesce(c.comment, '') body, c.created_at from comments c join users u on u.id = c.user_id
       where c.task_id = ? and c.deleted_at is null order by c.created_at, c.id`,
    )
      .bind(c.req.param('id'))
      .all<{ id: number; name: string; body: string; created_at: string }>(),
    task.assignee_id === null ? null : c.env.DB.prepare('select id, name from users where id = ?').bind(task.assignee_id).first(),
    // Only the review, extension and repeat flags read it, so skip the query when none can be true.
    task.status === 'review' || task.assignee_id === me || repeatable ? isReviewer(c.env.DB, task, me) : false,
    c.env.DB.prepare(
      `select p.file url, u.id, u.name, p.created_at from proofs p join users u on u.id = p.user_id
       where p.task_id = ? order by p.created_at desc, p.id desc limit 1`,
    )
      .bind(c.req.param('id'))
      .first<{ url: string; id: number; name: string; created_at: string }>(),
    opensLog(c.env.DB, tab, me),
  ])
  return c.json({
    tab: { kind: tab.kind, id: tab.id, name: tabRow },
    subtasks: subtasks.results.map(toTask),
    comments: comments.results.map((r) => ({ author: { id: r.id, name: r.name }, body: r.body, createdAt: iso(r.created_at) })),
    assignee,
    // The latest proof; an earlier one stays in the table after a rejection.
    proof: proof && { url: proof.url, author: { id: proof.id, name: proof.name }, createdAt: iso(proof.created_at) },
    canReview: task.status === 'review' && reviewer,
    canArchive: task.creator_id === me,
    // Only open tasks can be overdue (decision 0004).
    canRequestExtension: task.assignee_id === me && !reviewer && (task.status === 'waiting' || task.status === 'in_progress'),
    // A workspace task's reviewers are its division's leads, who set up repeats (decision 0012).
    canRepeat: repeatable && reviewer,
    // Leads only (decision 0014): the division's admins and supervisors, or the project's owners and persons-in-charge.
    canViewLog,
  })
})

tasks.get('/personal-tasks/:id{[0-9]+}/detail', async (c) => {
  await ownPersonalTask(c)
  const { results } = await c.env.DB.prepare(`select ${PERSONAL_TASK_COLUMNS} from personal_tasks where parent_id = ? order by created_at, id`)
    .bind(c.req.param('id'))
    .all<TaskRow>()
  return c.json({
    tab: { kind: 'private', id: 0, name: 'private' },
    subtasks: results.map(toTask),
    comments: [],
    assignee: null,
    proof: null,
    canReview: false,
    canArchive: false,
    canRequestExtension: false,
    canRepeat: false,
  })
})

tasks.post('/tasks/:id{[0-9]+}/comments', async (c) => {
  const task = await teamTask(c)
  const { body } = await readBody(c)
  if (typeof body !== 'string' || !body.trim()) throw bad('body must be a non-empty string')
  const user = c.get('user')
  const [inserted] = await c.env.DB.batch<{ created_at: string }>([
    c.env.DB.prepare(
      `insert into comments (task_id, user_id, comment, created_at, updated_at) values (?, ?, ?, datetime('now'), datetime('now')) returning created_at`,
    ).bind(task.id, user.id, body.trim()),
    logRow(c.env.DB, {
      actor: user, action: 'comment.added', subject: { type: 'task', id: task.id, label: task.name },
      divisionId: task.division_id, projectId: task.project_id, targetUserId: task.assignee_id, changes: { body: body.trim() },
    }),
  ])
  const createdAt = inserted.results[0].created_at
  return c.json({ author: { id: user.id, name: user.name }, body: body.trim(), createdAt: iso(createdAt!) }, 201)
})

/** Approve → done, reject → back to in progress (decision 0004). The first decision wins (decision 0005). */
tasks.post('/tasks/:id{[0-9]+}/reviews', async (c) => {
  const me = c.get('user').id
  const task = await teamTask(c)
  if (!(await isReviewer(c.env.DB, task, me))) throw new HTTPException(403, { message: 'Only a reviewer can decide this task' })
  const { approve, reason } = await readBody(c)
  if (typeof approve !== 'boolean') throw bad('approve must be true or false')
  if (reason != null && typeof reason !== 'string') throw bad('reason must be a string')

  const id = c.req.param('id')
  const also = approve ? "completed_date = datetime('now')" : 'completed_date = null, review_date = null'
  // One transaction: the status moves only out of review, and the review row is
  // written only if it did (changes() is the update's row count).
  const [updated] = await c.env.DB.batch<TaskRow>([
    c.env.DB.prepare(
      `update tasks set status = ?1, ${also}, updated_at = datetime('now') where id = ?2 and status = 'review' returning ${TEAM_TASK_COLUMNS}`,
    ).bind(approve ? 'done' : 'in_progress', id),
    c.env.DB.prepare(
      `insert into task_reviews (task_id, reviewer_id, decision, reason, created_at, updated_at)
       select ?, ?, ?, ?, datetime('now'), datetime('now') where changes() = 1`,
    ).bind(id, me, approve ? 'approved' : 'rejected', reason?.trim() || null),
    logRow(
      c.env.DB,
      {
        actor: c.get('user'), action: approve ? 'task.approved' : 'task.rejected', subject: { type: 'task', id: task.id, label: task.name },
        divisionId: task.division_id, projectId: task.project_id, targetUserId: task.assignee_id,
        changes: { status: ['review', approve ? 'done' : 'in_progress'], ...(reason?.trim() ? { reason: reason.trim() } : {}) },
      },
      true,
    ),
  ])
  const row = updated.results[0]
  if (!row) throw new HTTPException(409, { message: 'This task is not waiting for review' })
  if (row.assignee_id !== null) {
    await notify(c.env.DB, [row.assignee_id], 'task_reviewed', { taskId: row.id, taskName: row.name, actorId: me, approved: approve })
  }
  if (approve && (await createNextOccurrence(c.env.DB, row.id, c.get('user')))) row.repeat = null
  return c.json(toTask(row))
})

tasks.post('/tasks/:id{[0-9]+}/deadline-requests', async (c) => {
  const me = c.get('user').id
  const task = await teamTask(c)
  if (task.assignee_id !== me || (await isReviewer(c.env.DB, task, me))) {
    throw new HTTPException(403, { message: 'Only the assignee, when not a reviewer, can ask for more time' })
  }
  const body = await readBody(c)
  const newDue = dbDate(body.newDue, 'newDue')
  if (typeof body.reason !== 'string' || !body.reason.trim()) throw bad('reason must be a non-empty string')
  // Only open tasks can be overdue (decision 0004), and an extension moves the date later.
  if (task.status !== 'waiting' && task.status !== 'in_progress') throw new HTTPException(422, { message: 'Only an open task can get more time' })
  if (newDue <= (task.due_date ?? dbDate(new Date().toISOString(), 'now'))) {
    throw new HTTPException(422, { message: 'newDue must be later than the current due date' })
  }
  // One pending request per task; the guard is in the insert so a double tap can't add a second.
  const [{ meta }] = await c.env.DB.batch([
    c.env.DB.prepare(
      `insert into task_deadline_requests (task_id, requester_id, current_due_date, requested_due_date, reason, status, created_at, updated_at)
       select id, ?2, due_date, ?3, ?4, 'pending', datetime('now'), datetime('now') from tasks
       where id = ?1 and not exists (select 1 from task_deadline_requests where task_id = ?1 and status = 'pending')`,
    ).bind(task.id, me, newDue, body.reason.trim()),
    logRow(
      c.env.DB,
      {
        actor: c.get('user'), action: 'deadline.requested', subject: { type: 'task', id: task.id, label: task.name },
        divisionId: task.division_id, projectId: task.project_id, changes: { dueDate: [iso(task.due_date), iso(newDue)], reason: body.reason.trim() },
      },
      true,
    ),
  ])
  if (!meta.changes) {
    const gone = !(await c.env.DB.prepare('select 1 from tasks where id = ?').bind(c.req.param('id')).first())
    throw gone ? new HTTPException(404, { message: 'No such task' }) : new HTTPException(409, { message: 'A request for this task is already pending' })
  }
  return c.body(null, 204)
})
