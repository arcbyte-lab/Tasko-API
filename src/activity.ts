export type LogEntry = {
  actor: { id: number; name: string }
  action: string
  /** `id: null` is the row the batch inserted last, for a log written next to its insert. */
  subject: { type: string; id: number | null; label: string }
  divisionId: number
  projectId: number | null
  targetUserId?: number | null
  changes?: Record<string, unknown>
}

/**
 * One `activity_logs` row (arcbyte decision 0014), as a statement to put in the
 * same batch as its change. [guarded] writes it only if the statement before it
 * changed a row; a guarded row changes one itself, so several in a row all
 * follow the first. Acting on yourself has no target.
 */
export function logRow(db: D1Database, e: LogEntry, guarded = false) {
  return db
    .prepare(
      `insert into activity_logs (actor_id, actor_name, action, subject_type, subject_id, subject_label, division_id, project_id,
         target_user_id, changes, created_at)
       select ?, ?, ?, ?, coalesce(?, last_insert_rowid()), ?, ?, ?, ?, ?, datetime('now')${guarded ? ' where changes() = 1' : ''}`,
    )
    .bind(
      e.actor.id, e.actor.name, e.action, e.subject.type, e.subject.id, e.subject.label, e.divisionId, e.projectId,
      e.targetUserId === e.actor.id ? null : (e.targetUserId ?? null), e.changes ? JSON.stringify(e.changes) : null,
    )
}
