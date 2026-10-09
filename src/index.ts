import { Hono } from 'hono'
import { auth, requireUser, type AppEnv } from './auth'
import { tabs } from './tabs'

const app = new Hono<AppEnv>()

// Public: a health check for uptime probes, and login.
app.get('/', (c) => c.json({ ok: true }))
app.route('/auth', auth)
app.use('*', requireUser)

app.get('/me', (c) => c.json(c.get('user')))
app.route('/tabs', tabs)

export default app
