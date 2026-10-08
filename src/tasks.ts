import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './auth'
import { assertMember, PERSONAL_TASK_COLUMNS, TEAM_TASK_COLUMNS, toTask, type TaskRow } from './tabs'

/** The app sends the Dart enum name; the database holds the snake_case value. */
const DB_STATUS: Record<string, string> = { todo: 'todo', waiting: 'waiting', inProgress: 'in_progress', review: 'review', done: 'done' }

/**
 * The checkbox rules (arcbyte decisions 0004 and 0005): what else to set for
 * `from → to`, or null when the move is not allowed.
 */
function teamMove(from: string, to: string, needsReview: boolean): string | null {
  const open = from === 'waiting' || from === 'in_progress'
  if (open && to === 'done' && !needsReview) return "completed_date = datetime('now')"
  if (open && to === 'review' && needsReview) return "review_date = datetime('now')"
  if (from === 'done' && to === 'waiting') return 'completed_date = null'
  if (from === 'waiting' && to === 'in_progress') return ''
  return null
}

function personalMove(from: string, to: string): string | null {
  if ((from === 'todo' || from === 'in_progress') && to === 'done') return "completed_at = datetime('now')"
  if (from === 'done' && to === 'todo') return 'completed_at = null'
  return null
}

async function newStatus(c: Context<AppEnv>) {
  const { status } = await c.req.json<{ status?: unknown }>().catch(() => ({}) as never)
  const to = typeof status === 'string' ? DB_STATUS[status] : undefined
  if (!to) throw new HTTPException(400, { message: 'status must be one of ' + Object.keys(DB_STATUS).join(', ') })
  return to
}

const notAllowed = (from: string, to: string) => new HTTPException(422, { message: `Cannot move a task from ${from} to ${to}` })
const changedMeanwhile = () => new HTTPException(409, { message: 'The task changed meanwhile; reload it' })

export const tasks = new Hono<AppEnv>()

tasks.patch('/tasks/:id{[0-9]+}/status', async (c) => {
  const me = c.get('user').id
  const to = await newStatus(c)
  const task = await c.env.DB.prepare('select status, division_id, project_id, assignee_id, required_proof_type from tasks where id = ?')
    .bind(c.req.param('id'))
    .first<{ status: string; division_id: number; project_id: number | null; assignee_id: number | null; required_proof_type: string | null }>()
  if (!task) throw new HTTPException(404, { message: 'No such task' })

  // The assignee ticks it; an unassigned task, anyone in its tab.
  if (task.assignee_id === null) {
    await assertMember(c.env.DB, task.project_id ? 'project' : 'division', task.project_id ?? task.division_id, me)
  } else if (task.assignee_id !== me) {
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
  if (!row) throw changedMeanwhile()
  return c.json(toTask(row))
})

tasks.patch('/personal-tasks/:id{[0-9]+}/status', async (c) => {
  const to = await newStatus(c)
  // Someone else's personal task does not exist, as far as the viewer can tell.
  const task = await c.env.DB.prepare('select status from personal_tasks where id = ? and user_id = ?')
    .bind(c.req.param('id'), c.get('user').id)
    .first<{ status: string }>()
  if (!task) throw new HTTPException(404, { message: 'No such task' })

  const also = personalMove(task.status, to)
  if (also === null) throw notAllowed(task.status, to)
  const row = await c.env.DB.prepare(
    `update personal_tasks set status = ?1, ${also}, updated_at = datetime('now')
     where id = ?2 and status = ?3 returning ${PERSONAL_TASK_COLUMNS}`,
  )
    .bind(to, c.req.param('id'), task.status)
    .first<TaskRow>()
  if (!row) throw changedMeanwhile()
  return c.json(toTask(row))
})
