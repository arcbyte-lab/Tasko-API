import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './auth'
import { assertMember, iso, TEAM_TASK_COLUMNS, toTask, type TaskRow } from './tabs'
import { assertLead } from './tasks'

/**
 * A division lead's view of its repeating tasks (arcbyte decision 0012). An
 * occurrence counts as finished when it was sent for review, or else ticked
 * done, so waiting on an approval never makes it late.
 */
type Occurrence = TaskRow & {
  division_id: number
  series_id: number
  repeat_ended: string | null
  finished_at: string | null
  proof_url: string | null
}

const OCCURRENCE = `${TEAM_TASK_COLUMNS}, division_id, repeat_ended,
  case when status = 'done' then coalesce(review_date, completed_date) end finished_at,
  (select p.file from proofs p where p.task_id = t.id order by p.created_at desc, p.id desc limit 1) proof_url`

const result = (r: Occurrence) => ({
  finishedAt: iso(r.finished_at),
  onTime: r.finished_at === null || r.due_date === null ? null : r.finished_at <= r.due_date,
})

export const repeating = new Hono<AppEnv>()

/**
 * Each series still set up: live ones (the open task carries the rule) soonest
 * first, then ended ones (stopped or run out, decision 0013) latest first, each
 * with its rule and its last 5 finished occurrences.
 */
repeating.get('/divisions/:id{[0-9]+}/repeating', async (c) => {
  const id = Number(c.req.param('id'))
  const me = c.get('user').id
  await assertMember(c.env.DB, 'division', id, me)
  await assertLead(c.env.DB, id, me)
  const { results: heads } = await c.env.DB.prepare(
    `select ${OCCURRENCE} from tasks t
     where division_id = ? and project_id is null and parent_id is null and (repeat is not null or repeat_ended is not null)
     order by repeat is null, case when repeat is null then null else due_date end, due_date desc, id`,
  )
    .bind(id)
    .all<Occurrence>()
  const { results: done } = await c.env.DB.prepare(
    `select ${OCCURRENCE} from tasks t
     where status = 'done' and series_id in (select value from json_each(?))
     order by due_date desc, id desc`,
  )
    .bind(JSON.stringify(heads.map((r) => r.series_id)))
    .all<Occurrence>()
  return c.json(
    heads.map((r) => ({
      task: toTask(r),
      rule: JSON.parse((r.repeat ?? r.repeat_ended)!),
      ended: r.repeat === null,
      recent: done
        .filter((d) => d.series_id === r.series_id)
        .slice(0, 5)
        .map((d) => ({ dueDate: iso(d.due_date), ...result(d) })),
    })),
  )
})

/** Every occurrence of one series, newest first. */
repeating.get('/series/:id{[0-9]+}', async (c) => {
  const { results } = await c.env.DB.prepare(`select ${OCCURRENCE} from tasks t where series_id = ? order by due_date desc, id desc`)
    .bind(c.req.param('id'))
    .all<Occurrence>()
  if (!results.length) throw new HTTPException(404, { message: 'No such series' })
  const me = c.get('user').id
  await assertMember(c.env.DB, 'division', results[0].division_id, me)
  await assertLead(c.env.DB, results[0].division_id, me)
  return c.json(results.map((r) => ({ task: toTask(r), ...result(r), proofUrl: r.proof_url })))
})

/**
 * Deletes a repeat: it and its history leave the repeating view (decision
 * 0013). A live one's open task is deleted too, only while nobody has started
 * it; a started one must be stopped first. Finished tasks stay in their tab.
 */
repeating.delete('/series/:id{[0-9]+}', async (c) => {
  const id = c.req.param('id')
  const head = await c.env.DB.prepare(
    'select id, division_id, status, repeat from tasks where series_id = ? and (repeat is not null or repeat_ended is not null)',
  )
    .bind(id)
    .first<{ id: number; division_id: number; status: string; repeat: string | null }>()
  if (!head) throw new HTTPException(404, { message: 'No such repeating task' })
  const me = c.get('user').id
  await assertMember(c.env.DB, 'division', head.division_id, me)
  await assertLead(c.env.DB, head.division_id, me)
  const live = head.repeat !== null
  if (live && head.status !== 'waiting') throw new HTTPException(409, { message: 'Already started — stop repeating instead' })
  // One transaction. A task started meanwhile is not deleted, and then, as its
  // row is still there, nothing is unlinked either.
  const unlink = c.env.DB.prepare(
    'update tasks set series_id = null, repeat_ended = null where series_id = ?1 and not exists (select 1 from tasks where id = ?2 and repeat is not null)',
  ).bind(id, head.id)
  const [deleted] = await c.env.DB.batch(
    live ? [c.env.DB.prepare("delete from tasks where id = ? and status = 'waiting'").bind(head.id), unlink] : [unlink],
  )
  if (live && !deleted.meta.changes) throw new HTTPException(409, { message: 'Already started — stop repeating instead' })
  return c.body(null, 204)
})
