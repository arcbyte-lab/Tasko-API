```txt
bun install
bun run db:migrate   # schema into the local D1
bun run db:seed      # FakeTasksApi's world, then seed/cases.sql: every role, visibility and status case
bun run dev
bun run test         # vitest in workerd, fresh seeded DB per test
```

```txt
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiating `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```
