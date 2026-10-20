/** An id the batch is still creating, as SQL from this codebase, never from a request. */
export type NewId = { sql: string }
/** The row the batch inserted last, for a log written right after its insert. */
export const JUST_INSERTED: NewId = { sql: 'last_insert_rowid()' }

export type LogEntry = {
  actor: { id: number; name: string }
  action: string
  subject: { type: string; id: number | NewId; label: string }
  divisionId: number
  projectId: number | null | NewId
  targetUserId?: number | null
  changes?: Record<string, unknown>
}

/**
 * One `activity_logs` row (arcbyte decision 0014), as a statement to put in the
 * same batch as its change. [guarded] writes it only if the statement before it
 * changed exactly one row; a guarded row changes one itself, so several in a
 * row all follow the first. Acting on yourself has no target.
 */
export function logRow(db: D1Database, e: LogEntry, guarded = false) {
  const values: unknown[] = []
  const value = (v: unknown) => (typeof v === 'object' && v !== null && 'sql' in v ? (v as NewId).sql : (values.push(v), '?'))
  const columns = [
    e.actor.id, e.actor.name, e.action, e.subject.type, e.subject.id, e.subject.label, e.divisionId, e.projectId,
    e.targetUserId === e.actor.id ? null : (e.targetUserId ?? null), e.changes ? JSON.stringify(e.changes) : null,
  ].map(value)
  return db
    .prepare(
      `insert into activity_logs (actor_id, actor_name, action, subject_type, subject_id, subject_label, division_id, project_id,
         target_user_id, changes, created_at)
       select ${columns.join(', ')}, datetime('now')${guarded ? ' where changes() = 1' : ''}`,
    )
    .bind(...values)
}

/** SQL: user [v] is an admin or supervisor of division [d], who open its log (arcbyte decision 0014). */
export const LEADS_DIVISION = (d: string, v: string) =>
  `exists (select 1 from division_members m where m.division_id = ${d} and m.user_id = ${v} and m.role_type in ('admin', 'supervisor'))`

/** SQL: user [v] owns or is in charge of project [p]; leading its division is not enough. */
export const MANAGES_PROJECT = (p: string, v: string) =>
  `exists (select 1 from project_members m where m.project_id = ${p} and m.user_id = ${v} and m.role in ('owner', 'person-in-charge'))`

/** Whether [me] opens the log of a task in [tab], or of the tab itself. */
export async function opensLog(db: D1Database, tab: { kind: 'division' | 'project'; id: number }, me: number) {
  const sql = tab.kind === 'project' ? MANAGES_PROJECT('?1', '?2') : LEADS_DIVISION('?1', '?2')
  return !!(await db.prepare(`select ${sql} ok`).bind(tab.id, me).first<number>('ok'))
}
