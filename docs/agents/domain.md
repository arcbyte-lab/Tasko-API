# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo does not keep its own `CONTEXT.md` or `docs/adr/`. Per [AGENTS.md](../../AGENTS.md), tasko-api holds **code**; the product vocabulary, specs, and decisions live in a sibling repo, **Arcbyte** (`~/Projects/arcbyte` on this machine, checked out separately — not a build dependency, and CI must not assume it's present).

## Before exploring, read these

- **`../../arcbyte/ideas/tasko/CONTEXT.md`** — the glossary, once it exists. Until then, vocabulary is in `../../arcbyte/ideas/tasko/decisions/` (0002 names **Workspace**, **Project** and the tabs) and the tables in `../../arcbyte/ideas/tasko/assets/sqlite-schema.sql`.
- **`../../arcbyte/ideas/tasko/hipster/`** and **`../../arcbyte/ideas/tasko/hacker/`** — specs. Read the spec before implementing the feature it describes. `hacker/flutter-app-as-built.md` describes what the app expects from this API.
- **`../../arcbyte/ideas/tasko/decisions/`** — numbered, dated ADRs for *why* a product/design choice was made. Don't re-litigate a settled decision without checking whether one already exists.

If Arcbyte isn't checked out locally, or a given file doesn't exist yet, **proceed silently** — don't flag the absence or suggest creating it from this repo. Arcbyte's own domain-modeling workflow owns creating and updating these files; this repo only reads them.

## Layout

Single-context, but hosted outside this repo:

```
arcbyte/ideas/tasko/
├── CONTEXT.md      ← not yet
├── assets/sqlite-schema.sql
├── decisions/
├── hipster/        ← specs
└── hacker/         ← specs
```

There is no local `CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/` in this repo for the product domain. A decision purely about this repo's own code shape *may* live here as a normal ADR under `docs/adr/` if one is created — see AGENTS.md — but that directory doesn't exist yet and skills should not assume it does.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a route, a hypothesis, a test name), use the term as Arcbyte defines it. Don't drift to synonyms, and don't invent a new term locally — if the concept has no word in Arcbyte yet, say so and get it added there first (see AGENTS.md, "Code implements the domain model. It does not define it.").

## Flag ADR/decision conflicts

If your output contradicts an existing Arcbyte decision, surface it explicitly rather than silently overriding:

> _Contradicts decision 0004 (checkbox-goes-to-review-only-when-needed) — but worth reopening because…_
