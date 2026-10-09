import { Hono } from 'hono'
import { auth, requireUser, type AppEnv } from './auth'

const app = new Hono<AppEnv>()

// Public: a health check for uptime probes, and login.
app.get('/', (c) => c.json({ ok: true }))
app.route('/auth', auth)
app.use('*', requireUser)

app.get('/me', (c) => c.json(c.get('user')))

export default app
