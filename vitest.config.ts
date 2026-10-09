import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const seeds = await readD1Migrations('seed')
  const seed = seeds.find((m) => m.name === 'seed.sql')!
  const cases = seeds.find((m) => m.name === 'cases.sql')!
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: await readD1Migrations('migrations'), TEST_SEED: seed.queries, TEST_CASES: cases.queries },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.ts'] },
  }
})
