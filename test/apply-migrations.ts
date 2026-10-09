import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach } from 'vitest'

// Storage is shared by every test in a file. The schema doesn't change within
// a file, so migrate once; then before each test empty every table, reset the
// ids, and seed again.
let tables: string[]
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  const { results } = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name not glob '_cf_*' and name != 'd1_migrations'",
  ).all<{ name: string }>()
  tables = results.map((t) => t.name)
})

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('pragma defer_foreign_keys = on'),
    ...tables.map((t) => env.DB.prepare(`delete from "${t}"`)),
    ...env.TEST_SEED.map((q) => env.DB.prepare(q)),
  ])
})
