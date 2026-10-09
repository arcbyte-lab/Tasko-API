import type { D1Migration } from 'cloudflare:test'

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
      TEST_SEED: string[]
      TEST_CASES: string[]
    }
  }
}
