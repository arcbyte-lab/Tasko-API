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
type Occurrence = TaskRow & { division_id: number; series_id: number; finished_at: string | null; proof_url: string | null }

const OCCURRENCE = `${TEAM_TASK_COLUMNS}, division_id,
  case when status = 'done' then coalesce(review_date, completed_date) end finished_at,
  (select p.file from proofs p where p.task_id = t.id order by p.created_at desc, p.id desc limit 1) proof_url`

const result = (r: Occurrence) => ({
  finishedAt: iso(r.finished_at),
  onTime: r.finished_at === null || r.due_date === null ? null : r.finished_at <= r.due_date,
})

export const repeating = new Hono<AppEnv>()

/** Each live series (its open task still carries the rule), soonest first, with its last 5 finished occurrences. */
repeating.get('/divisions/:id{[0-9]+}/repeating', async (c) => {
  const id = Number(c.req.param('id'))
  const me = c.get('user').id
  await assertMember(c.env.DB, 'division', id, me)
  await assertLead(c.env.DB, id, me)
  const { results: live } = await c.env.DB.prepare(
    `select ${OCCURRENCE} from tasks t
     where division_id = ? and project_id is null and parent_id is null and repeat is not null
     order by due_date, id`,
  )
    .bind(id)
    .all<Occurrence>()
  const { results: done } = await c.env.DB.prepare(
    `select ${OCCURRENCE} from tasks t
     where status = 'done' and series_id in (select value from json_each(?))
     order by due_date desc, id desc`,
  )
    .bind(JSON.stringify(live.map((r) => r.series_id)))
    .all<Occurrence>()
  return c.json(
    live.map((r) => ({
      task: toTask(r),
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
