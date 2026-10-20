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
