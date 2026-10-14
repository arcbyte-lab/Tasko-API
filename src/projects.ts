import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './auth'
import { bad, parseDue, readBody } from './tasks'

export const projects = new Hono<AppEnv>()

/**
 * A division's admin or supervisor creates a project and becomes its owner
 * (arcbyte decision 0010). It starts as `planning`.
 */
projects.post('/', async (c) => {
  const me = c.get('user').id
  const body = await readBody(c)
  const { divisionId, name, description, dueDate } = body
  if (!Number.isInteger(divisionId)) throw bad('divisionId must be a division id')
  if (typeof name !== 'string' || !name.trim()) throw bad('name must be a non-empty string')
  if (description != null && typeof description !== 'string') throw bad('description must be a string or null')
  if (dueDate != null && !parseDue(dueDate)) throw bad('dueDate must be an ISO 8601 date')

  const role = await c.env.DB.prepare(
    `select m.role_type from division_members m join divisions d on d.id = m.division_id
     where m.division_id = ? and m.user_id = ? and d.deleted_at is null`,
  )
    .bind(divisionId, me)
    .first<string>('role_type')
  if (role !== 'admin' && role !== 'supervisor') throw new HTTPException(403, { message: 'Only a division admin or supervisor can create a project' })

  // projects.due_date is a date: keep the day the user picked, not its UTC shift.
  const [project] = await c.env.DB.batch<{ id: number; name: string }>([
    c.env.DB.prepare(
      `insert into projects (name, description, due_date, creator_id, division_id, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, 'planning', datetime('now'), datetime('now')) returning id, name`,
    ).bind(name.trim(), description ?? null, dueDate == null ? null : (dueDate as string).slice(0, 10), me, divisionId),
    c.env.DB.prepare(
      `insert into project_members (project_id, user_id, role, invited_by, created_at, updated_at)
       values (last_insert_rowid(), ?, 'owner', null, datetime('now'), datetime('now'))`,
    ).bind(me),
  ])
  return c.json({ kind: 'project', ...project.results[0], role: 'owner' }, 201)
})
