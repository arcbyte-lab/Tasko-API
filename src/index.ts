import { Hono } from 'hono'
import { auth, requireUser, type AppEnv } from './auth'

const app = new Hono<AppEnv>()

app.route('/auth', auth)
app.use('*', requireUser)

app.get('/me', (c) => c.json(c.get('user')))

export default app
