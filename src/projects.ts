import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logRow, type NewId } from './activity'
import type { AppEnv } from './auth'
import { notify } from './notifications'
import { assertMember } from './tabs'
import { bad, parseDue, readBody } from './tasks'

const ROLES = ['owner', 'person-in-charge', 'member', 'viewer']
const manages = (role: string | null) => role === 'owner' || role === 'person-in-charge'

const roleIn = (db: D1Database, projectId: number, userId: number) =>
  db.prepare('select role from project_members where project_id = ? and user_id = ?').bind(projectId, userId).first<string>('role')

/** SQL that is true unless the change would take away the project's last owner (?1 project, ?2 user). */
const KEEPS_AN_OWNER = `(role != 'owner' or (select count(*) from project_members where project_id = ?1 and role = 'owner') > 1)`

const ownersOnly = () => new HTTPException(403, { message: 'Only an owner can make or remove an owner' })
const needsOwner = () => new HTTPException(422, { message: 'A project needs an owner' })
const notMember = () => new HTTPException(404, { message: 'Not a member of this project' })

function readRole(value: unknown) {
  if (typeof value !== 'string' || !ROLES.includes(value)) throw bad('role must be one of ' + ROLES.join(', '))
  return value
}

/** The project id and the viewer's role in it; 403 unless they can see the project. */
async function viewer(c: Context<AppEnv>) {
  const id = Number(c.req.param('id'))
  const me = c.get('user').id
  await assertMember(c.env.DB, 'project', id, me)
  return { id, me, myRole: await roleIn(c.env.DB, id, me) }
}

/** The project the batch just created, read back through its owner's member row, the last insert. */
const JUST_CREATED: NewId = { sql: '(select project_id from project_members where rowid = last_insert_rowid())' }

const projectOf = (db: D1Database, id: number) =>
  db.prepare('select name, division_id from projects where id = ?').bind(id).first<{ name: string; division_id: number }>()

/** A guarded `member.*` log row for [user] in [project] (arcbyte decision 0014). */
const memberLog = (c: Context<AppEnv>, project: { id: number; division_id: number }, action: string, user: { id: number; name: string }, changes: Record<string, unknown>) =>
  logRow(
    c.env.DB,
    {
      actor: c.get('user'), action, subject: { type: 'member', id: user.id, label: user.name },
      divisionId: project.division_id, projectId: project.id, targetUserId: user.id, changes,
    },
    true,
  )

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
    logRow(
      c.env.DB,
      {
        actor: c.get('user'), action: 'project.created', subject: { type: 'project', id: JUST_CREATED, label: name.trim() },
        divisionId: divisionId as number, projectId: JUST_CREATED, changes: { dueDate: dueDate == null ? null : (dueDate as string).slice(0, 10) },
      },
      true,
    ),
  ])
  return c.json({ kind: 'project', ...project.results[0], role: 'owner' }, 201)
})

/** An owner or person-in-charge adds someone directly; there is no invitation step (decision 0010). */
projects.post('/:id{[0-9]+}/members', async (c) => {
  const { id, me, myRole } = await viewer(c)
  const body = await readBody(c)
  if (!Number.isInteger(body.userId)) throw bad('userId must be a user id')
  const role = 'role' in body ? readRole(body.role) : 'member'
  if (!manages(myRole)) throw new HTTPException(403, { message: 'Only an owner or person-in-charge can add members' })
  if (role === 'owner' && myRole !== 'owner') throw ownersOnly()

  const user = await c.env.DB.prepare('select id, name, is_active from users where id = ?').bind(body.userId).first<{ id: number; name: string; is_active: number }>()
  if (!user) throw new HTTPException(404, { message: 'No such user' })
  if (!user.is_active) throw new HTTPException(422, { message: 'That user is not active' })
  const project = (await projectOf(c.env.DB, id))!
  const [{ meta }] = await c.env.DB.batch([
    c.env.DB.prepare(
      `insert or ignore into project_members (project_id, user_id, role, invited_by, created_at, updated_at)
       values (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).bind(id, user.id, role, me),
    memberLog(c, { ...project, id }, 'member.added', user, { role }),
  ])
  if (!meta.changes) throw new HTTPException(409, { message: 'Already a member' })

  await notify(c.env.DB, [user.id], 'project_member_added', { projectId: id, projectName: project.name, actorId: me })
  return c.json({ user: { id: user.id, name: user.name }, role }, 201)
})

projects.patch('/:id{[0-9]+}/members/:userId{[0-9]+}', async (c) => {
  const { id, myRole } = await viewer(c)
  const userId = Number(c.req.param('userId'))
  const role = readRole((await readBody(c)).role)
  if (!manages(myRole)) throw new HTTPException(403, { message: 'Only an owner or person-in-charge can change roles' })
  const current = await roleIn(c.env.DB, id, userId)
  if (current === null) throw notMember()
  if ((role === 'owner' || current === 'owner') && myRole !== 'owner') throw ownersOnly()

  const name = (await c.env.DB.prepare('select name from users where id = ?').bind(userId).first<string>('name'))!
  const project = (await projectOf(c.env.DB, id))!
  // The owner count is checked in the update itself, so two owners demoting each other can't both win.
  const [{ meta }] = await c.env.DB.batch([
    c.env.DB.prepare(
      `update project_members set role = ?3, updated_at = datetime('now')
       where project_id = ?1 and user_id = ?2 and (?3 = 'owner' or ${KEEPS_AN_OWNER})`,
    ).bind(id, userId, role),
    ...(role === current ? [] : [memberLog(c, { ...project, id }, 'member.role_changed', { id: userId, name }, { role: [current, role] })]),
  ])
  if (!meta.changes) throw needsOwner()
  return c.json({ user: { id: userId, name }, role })
})

/**
 * A manager removes someone, or anyone removes themselves (leaving). Their
 * not-yet-started or in-progress tasks in the project lose their assignee;
 * tasks in review keep it (decision 0010).
 */
projects.delete('/:id{[0-9]+}/members/:userId{[0-9]+}', async (c) => {
  const { id, me, myRole } = await viewer(c)
  const userId = Number(c.req.param('userId'))
  const self = userId === me
  if (!self && !manages(myRole)) throw new HTTPException(403, { message: 'Only an owner or person-in-charge can remove members' })
  const current = self ? myRole : await roleIn(c.env.DB, id, userId)
  if (current === null) throw notMember()
  if (!self && current === 'owner' && myRole !== 'owner') throw ownersOnly()

  const name = (await c.env.DB.prepare('select name from users where id = ?').bind(userId).first<string>('name'))!
  const project = { ...(await projectOf(c.env.DB, id))!, id }
  // ponytail: read before the batch, so a task assigned to them meanwhile is unassigned but not logged.
  const { results: open } = await c.env.DB.prepare(
    `select id, name from tasks where project_id = ? and assignee_id = ? and status in ('todo', 'waiting', 'in_progress')`,
  )
    .bind(id, userId)
    .all<{ id: number; name: string }>()
  const unassigned = open.map((t) =>
    logRow(
      c.env.DB,
      {
        actor: c.get('user'), action: 'task.unassigned', subject: { type: 'task', id: t.id, label: t.name },
        divisionId: project.division_id, projectId: id, targetUserId: userId, changes: { assigneeId: [userId, null], assigneeName: name },
      },
      true,
    ),
  )
  const [removed] = await c.env.DB.batch([
    c.env.DB.prepare(`delete from project_members where project_id = ?1 and user_id = ?2 and ${KEEPS_AN_OWNER}`).bind(id, userId),
    // The log rows follow the delete; then the unassign.
    memberLog(c, project, self ? 'member.left' : 'member.removed', { id: userId, name }, { role: current, unassignedTaskIds: open.map((t) => t.id) }),
    ...unassigned,
    // Runs only if the delete did: the guard sees the row gone.
    c.env.DB.prepare(
      `update tasks set assignee_id = null, updated_at = datetime('now')
       where project_id = ?1 and assignee_id = ?2 and status in ('todo', 'waiting', 'in_progress')
         and not exists (select 1 from project_members where project_id = ?1 and user_id = ?2)`,
    ).bind(id, userId),
  ])
  if (!removed.meta.changes) throw needsOwner()
  return c.body(null, 204)
})
