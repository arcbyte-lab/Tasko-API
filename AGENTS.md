---
title: AGENTS — where this repo ends and the thinking starts
kind: meta
updated: 2026-10-08
---

# How an AI works in this repo

This repo holds Tasko's **server API** (Hono on Cloudflare Workers). The
app is a separate repo, `arcbyte-lab/Tasko-Flutter`. Both have a sibling
thinking space, Arcbyte, which holds the product vocabulary, specs, and
decisions. That split is deliberate — see Arcbyte's own
[AGENTS.md](../../arcbyte/AGENTS.md): "Arcbyte holds thinking, not code."
Neither repo's rules apply inside the other.

On this machine, Arcbyte lives at `~/Projects/arcbyte`, this repo at
`~/Projects/Dev/tasko-api`. The paths below (`../../arcbyte/...`) are for a
human or AI reading this file locally, not a build dependency; nothing here
should import across that path, and CI must not assume Arcbyte is checked
out.

## The domain model lives in Arcbyte, not here

Tasko has no `CONTEXT.md` yet. Until it does, its vocabulary is in
`../../arcbyte/ideas/tasko/decisions/` (0002 names **Workspace**, **Project**
and the tabs) and its tables in
`../../arcbyte/ideas/tasko/assets/sqlite-schema.sql`
([decision 0001](../../arcbyte/ideas/tasko/decisions/0001-adopt-sqlite-schema-over-schema-zero.md)).
Use those exact names for routes, types, and columns wherever the code names
a domain concept.

- **Code implements the domain model. It does not define it.** If you need a
  concept Arcbyte has no word for yet, don't invent one locally and move on.
  Say so, and get the term added in Arcbyte first — then use it here.
- If a term stops fitting what the code needs, that's the model drifting,
  not a reason to quietly rename it in code. Flag it back to Arcbyte.
- Purely technical vocabulary — a handler, a DTO, a middleware — is exempt.

## Specs and decisions live in Arcbyte too

- **What to build** — specs under `../../arcbyte/ideas/tasko/hacker/` and
  `.../hipster/`. Read the spec before implementing the feature it describes.
- **What the app expects from this API** — the app talks to the server
  through one seam, `TasksApi`, currently backed by `FakeTasksApi`. See
  [Flutter app, as built](../../arcbyte/ideas/tasko/hacker/flutter-app-as-built.md).
  The server decides permissions: task detail carries `canReview`,
  `canArchive` and `canRequestExtension`, so reviewer rules
  ([0004](../../arcbyte/ideas/tasko/decisions/0004-checkbox-goes-to-review-only-when-needed.md))
  are enforced here, not in the app.
- **Why a product choice was made** — `../../arcbyte/ideas/tasko/decisions/`,
  numbered and dated. Don't re-litigate a settled decision here.
- A decision purely about this repo's own code shape can live here as a
  normal ADR. If it changes what the product does, it belongs in Arcbyte.

## Everything else

Normal engineering rules apply here — tests, conventions, tooling — same as
any code repo. Nothing in Arcbyte's `AGENTS.md` (lenses, `evidence:` fields,
`status: draft`, etc.) is relevant on this side.
