import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach } from 'vitest'

// Storage is shared by every test in a file, so before each test: empty every
// table, reset the ids, and seed again.
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  const { results } = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name not glob '_cf_*' and name != 'd1_migrations'",
  ).all<{ name: string }>()
  await env.DB.batch([
    env.DB.prepare('pragma defer_foreign_keys = on'),
    ...results.map((t) => env.DB.prepare(`delete from "${t.name}"`)),
    ...env.TEST_SEED.map((q) => env.DB.prepare(q)),
  ])
})
