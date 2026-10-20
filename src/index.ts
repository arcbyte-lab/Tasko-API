import { Hono } from 'hono'
import { auth, requireUser, type AppEnv } from './auth'
import { tabs } from './tabs'
import { tasks } from './tasks'
import { notifications } from './notifications'
import { projects } from './projects'
import { repeating } from './repeating'
import { logs } from './logs'

const app = new Hono<AppEnv>()

// Public: a health check for uptime probes, and login.
app.get('/', (c) => c.json({ ok: true }))
app.route('/auth', auth)
app.use('*', requireUser)

app.get('/me', (c) => c.json(c.get('user')))

/** Active users whose name or email contains `q`, for the member picker. */
app.get('/users', async (c) => {
  const q = (c.req.query('q') ?? '').trim().replace(/[!%_]/g, '!$&')
  const { results } = await c.env.DB.prepare(
    `select id, name, email from users
     where is_active = 1 and (name like ?1 escape '!' or email like ?1 escape '!')
     order by name, id limit 20`,
  )
    .bind(`%${q}%`)
    .all()
  return c.json(results)
})
app.route('/tabs', tabs)
app.route('/', tasks)
app.route('/notifications', notifications)
app.route('/projects', projects)
app.route('/', repeating)
app.route('/', logs)

export default app
