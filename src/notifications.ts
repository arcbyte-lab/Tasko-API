import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './auth'
import { iso } from './tabs'

type Data = { taskId: number; taskName: string; actorId: number; approved?: boolean }

/** `notifications.type`, and the sentence the bell shows for it. */
const TEXT: Record<string, (actor: string, d: Data) => string> = {
  task_assigned: (actor, d) => `${actor} assigned you ${d.taskName}`,
  task_review_requested: (actor, d) => `${actor} sent ${d.taskName} for review`,
  task_reviewed: (actor, d) => `${actor} ${d.approved ? 'approved' : 'declined'} ${d.taskName}`,
}

/** Writes one notification of [type] to each of [userIds] except the actor. */
export async function notify(db: D1Database, userIds: number[], type: keyof typeof TEXT, data: Data) {
  const to = [...new Set(userIds)].filter((id) => id !== data.actorId)
  if (!to.length) return
  await db.batch(
    to.map((id) =>
      db
        .prepare(
          `insert into notifications (id, type, notifiable_type, notifiable_id, data, created_at, updated_at)
           values (?, ?, 'user', ?, ?, datetime('now'), datetime('now'))`,
        )
        .bind(crypto.randomUUID(), type, id, JSON.stringify(data)),
    ),
  )
}

export const notifications = new Hono<AppEnv>()

notifications.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `select n.id, n.type, n.data, n.created_at, n.read_at, u.id actor_id, u.name actor_name
     from notifications n left join users u on u.id = json_extract(n.data, '$.actorId')
     where n.notifiable_type = 'user' and n.notifiable_id = ?
     order by n.created_at desc, n.rowid desc`,
  )
    .bind(c.get('user').id)
    .all<{ id: string; type: string; data: string; created_at: string; read_at: string | null; actor_id: number | null; actor_name: string | null }>()
  return c.json(
    results.map((n) => ({
      id: n.id,
      text: TEXT[n.type]?.(n.actor_name ?? 'Someone', JSON.parse(n.data)) ?? n.type,
      createdAt: iso(n.created_at),
      actor: n.actor_id === null ? null : { id: n.actor_id, name: n.actor_name },
      readAt: iso(n.read_at),
    })),
  )
})

notifications.post('/read-all', async (c) => {
  await c.env.DB.prepare(
    "update notifications set read_at = datetime('now') where notifiable_type = 'user' and notifiable_id = ? and read_at is null",
  )
    .bind(c.get('user').id)
    .run()
  return c.body(null, 204)
})

notifications.post('/:id/read', async (c) => {
  const { meta } = await c.env.DB.prepare(
    "update notifications set read_at = coalesce(read_at, datetime('now')) where id = ? and notifiable_type = 'user' and notifiable_id = ?",
  )
    .bind(c.req.param('id'), c.get('user').id)
    .run()
  if (!meta.changes) throw new HTTPException(404, { message: 'No such notification' })
  return c.body(null, 204)
})
