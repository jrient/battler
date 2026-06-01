# AgentClash — project working agreement

## Completion workflow (MANDATORY after every code or content change)

Do all of these, in order, before treating any change as done:

1. **Test** — `pnpm test` must stay green (and `pnpm build` if types changed).
2. **Check & update ALL related docs** — *not optional*. A stat or mechanic
   change is not complete until every place that mirrors it is updated. Use the
   documentation map below and grep for the value you changed.
3. **Rebuild the container** — `docker-compose up -d --build`. `public/` and
   `src/` are baked into the image, so the live site is stale until you rebuild.
   curl checks need `--noproxy '*'`; the home page is `/zh` (no trailing slash).
4. **Commit** — only when the user asks; why-focused message, repo's existing
   style (sentence-case subject, no conventional-commit prefix).

## Documentation map — where unit stats / mechanics are mirrored

One stat lives in several files. When you change one, update the rest:

- `src/engine/units.ts` — **source of truth** (the `UNITS` table).
- `AGENT_GUIDE.md` — the stat table (`HP | ATK | Range | Move | Initiative |
  Cost | Special`), the inline `range = {…}` / `COST = {…}` maps in the example
  snippets, and any prose that cites a number (e.g. "range-N envelope").
- `public/replay.js` — the unit stat-card object (`hp/atk/range/move/special`).
- `public/changelog.json` — add a **bilingual (zh + en)** entry for any balance
  or mechanic change.
- `src/bots/*.js` — the `COST` / `RANGE` / `MOVE` / `ATK` maps in each practice
  bot, **and** header comments that cite numbers (e.g. "Archers (range N)").

Do **not** sync `SPEC.md` (frozen pre-MVP design doc) or `README.md` milestone
snapshots — they describe an older design and are intentionally not live stat
references. If a change seems to belong there, flag it instead of editing.

## Conventions

- User-facing communication in **Chinese**; code, commit messages, and
  agent-facing surfaces (AGENT_GUIDE, changelog `en`, API fields) stay English.
- UI verification: build + curl (`--noproxy '*'`) + mint a cookie — headless
  Chrome screenshots hang in this environment.
- Balance work: the harness in `tmp/` (`balance.ts`, `balance-mixed.ts`) runs
  the round-robin / marginal-value sims. Naive clumped-fight AI over-rates
  splash (mage); test with the `SPREAD`/`DIVE` flags for skilled-play balance.
