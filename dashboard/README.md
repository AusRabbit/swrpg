# Salvage Rights — Live Dashboard

The player- and GM-facing dashboard for *Salvage Rights*, a Star Wars FFG
(Edge of the Empire / Age of Rebellion / Force and Destiny) group campaign.
It's a full campaign companion, not just a stat board: character sheets, a
shared dice roller with real FFG dice mechanics, a live combat tracker,
and a couple of small GM utilities, all kept in sync across everyone's
browser during a session.

## Session state, the Enemy board, and the Battle Map

Three shared, Durable-Object-backed stores sit on top of the static
ledger described below:

- **Session state** — Wounds, Strain, Destiny, Critical Injuries,
  Initiative, and the Vehicle's Hull Trauma/System Strain/Critical Hits
  all live in one shared, click-driven store (`/manual` route, `ManualLog`
  Durable Object — open write, same trust model as `/rolls`/`/notes`/
  `/bio`/`/crew`). Every browser polls it and writes to it directly: every
  Wound/Strain/Hull/System-Strain pip row is numbered left-to-right and
  clickable (click a pip to set that value directly; +/- buttons sit
  alongside, and hovering a pip previews the result before you commit to
  the click), and clicking a Destiny token flips it to the other side of
  the pool. The GM page's Session Tracker, Initiative Tracker creator (add
  PC/NPC slots, flip a slot's side, reorder, advance the turn with
  automatic round-wrap) and Critical Injury / Vehicle Critical Hit
  assign-and-remove tools all write to this same store. (This replaced the
  old `data/live.json` + `/live` GitHub-polling model.)
- **Enemy board** — a GM-only combat tracker in this system's own terms:
  Minion / Rival / Nemesis, a Wound Threshold, Soak, and (Nemesis only) a
  Strain Threshold. A Minion entry also takes a **Minions in group** count;
  the wound bar then scales to Wound Threshold × that count, with a wider
  gap marking off each minion's own block of pips, and both the GM and
  player views report how many minions are still standing. Entering a raw
  damage number and hitting Apply subtracts Soak automatically before it
  hits the wound bar. Backed by `/enemies` + `/gm/enemies` (`EnemyLog`
  Durable Object) — GM key required to write; the public read strips Soak
  so players never see it. Players see the redacted board on the
  **Enemies** tab.
- **Battle Map** — zone-based rather than a fixed grid: the GM adds or
  removes thick-outlined zone cells one at a time (a "+" button sits on
  every open edge of the current shape), each carrying its own faint 5x5
  sub-grid for placing tokens precisely within it. Backed by `/map` +
  `/gm/map` (`ZoneMapLog` Durable Object). Anyone can move their own PC
  token; only the GM can move an enemy token or reshape the zones — both
  enforced server-side, not just hidden in the UI.

This app lives in this `dashboard/` subdirectory so it can be built and
deployed independently of the GM-only `ledgers/` directory at the repo
root — see the [repo root README](../README.md) for how the two are kept
separate, and why they share one private repo.

## What this app reads — and what it never touches

- `public/data/ledger.json` — the full player-facing character sheets
  (bundled into the build; served as a static asset). This is a
  **curated export**, written for players: full PC sheets, and NPC
  entries limited to a `whatPartyKnows` summary. It must never contain
  GM-only material (hidden motives, unrevealed clocks,
  "[Unverified]"/GM-scratchpad notes, anything the party hasn't learned
  in play).
- The shared `/manual` store — the small set of values that change
  *during* play (see Data model below), a Durable Object read and written
  at runtime by every browser. Nothing else lives there.
- `ledgers/Ledger.md` and `ledgers/updates/` at the repo root are the
  GM's master ledger — full campaign state, GM-only notes, and
  unrevealed plot material. **Nothing in `dashboard/` reads from
  `ledgers/`, at build time or runtime.** When the GM updates the
  party's public-facing state, they hand-copy only the safe, current
  values across into `dashboard/public/data/ledger.json` — the same way a GM would only tell
  players what their characters actually know.

Whatever ends up in `dashboard/public/data/ledger.json` or the `/manual`
store is visible to **anyone with the deployed dashboard URL** — the repo
being private does not make either private once it's built/served. Treat
"would I say this out loud at the table" as the bar before putting
anything in either.

## What it does

- **Character tab** — one full sheet per PC: portrait, Species and a
  player-editable Description (size, colour, appearance etc — shared with
  everyone who has the dashboard URL, saved via the `/bio` route, see
  Architecture below), Motivation & Obligation, live initiative tracker,
  Destiny Pool, Wounds/Strain/Soak, XP (click through to the Advancement
  Planner), Credits, Critical Injuries, Weapons,
  Armor, Characteristics, Skills, Talents, Inventory, and a note box to send
  the GM a message. Clicking a skill or weapon jumps straight to the Dice
  Roller preloaded with the right dice.
- **Party tab** — a side-by-side skill comparison table for the whole
  party, plus the live initiative tracker and shared Destiny Pool.
- **Dice Roller tab** — build an FFG dice pool (Ability/Proficiency/Boost/
  Difficulty/Challenge/Setback/Force), pick a difficulty or maneuver
  preset, upgrade or downgrade dice (RAW-correct: once you're out of base
  dice to upgrade, it adds one instead of doing nothing, and the undo
  button can unwind that exact sequence), and roll. Results are computed
  client-side from the real FFG face tables and posted to a **shared roll
  log** everyone at the table sees within a couple of seconds, tagged with
  any weapon Special text if the roll was loaded from a weapon. Click a
  log entry to copy it to your clipboard.
- **NPC Summary** and **Locations** tabs — quick player-facing reference
  lists, no secrets.
- **Wiki tab** — the campaign wiki, from `ledger.json`'s top-level
  `wikiUrl`. Shown inline when the wiki's host allows embedding, with an
  "Open in new tab" link either way.
- **GM Notes** tab — a private inbox of notes players have sent from
  their character tab (e.g. "I'd like to spend XP on X").
- **Live initiative tracker** — a row of PC (blue) / NPC (red) boxes
  showing turn order; spent seats darken to a tinted version of their own
  color rather than going flat grey, and the current seat pulses gently.
  Shown on the Party tab, the Dice Roller tab, and every character tab.
- **Vehicle tab** — the ship's static profile (Silhouette/Speed/Handling/
  Defense/Armor), live Hull Trauma / System Strain pips, its weapon(s), and
  a card per crew position (Pilot, Gunner, etc.). Each card has a dropdown
  to assign any party member to that seat — shared live across everyone's
  browser via the `/crew` route (see Architecture below) — and a button per
  likely action (e.g. "Fire Forward Light Laser Cannon") that loads the
  assigned character's actual skill dice pool into the Dice Roller, greyed
  out until someone's assigned. Only shown when `ledger.json` has a
  `vehicle` object.

## Data model

Two sources, two different update rhythms:

- **`public/data/ledger.json`** — the static, GM-authored source of truth
  for character sheets: names, characteristics, skills, talents, weapons,
  armor, inventory, NPCs, locations. Only changes when the GM edits it
  directly (typically once per session, at consolidation). Critical
  Injuries are **not** kept here — they live only in the shared `/manual` store,
  so there is exactly one place to read or clear them. Any weapon or
  inventory entry may carry `"isNew": true`, which shows a NEW badge
  beside it on the Character tab — set it when the party picks something
  up, remove it at the next consolidation. A character may also carry `"forceSensitive": true` — a GM-only flag that is never shown on the sheet. Its only effect is that the Advancement Planner offers Force talents (`talents.json` entries with `"force": "Yes"`) to that character and hides them from everyone else. The GM page's Force Sensitivity section can override it live (stored in the GM-write `/visibility` store), and "Reset overrides" falls back to the ledger value. The planner's talent search reads `public/data/talents.json` (a copy of `reference/talents.json`) and renders its rules-text glyphs with the same die and symbol artwork as the Dice Roller. An optional top-level
  `vehicle` object (silhouette/speed/handling/defense/armor, `hullTrauma`/
  `systemStrain` thresholds, a `weapons` array, and a `crewPositions`
  array of `{ id, name, description, actions: [{ name, skill }], weaponIndex? }`)
  drives the Vehicle tab — omit it entirely for a campaign with no
  trackable ship. `skill` in each action must match a name in
  `FULL_SKILL_LIST` (`src/App.jsx`) so it resolves to whichever crew
  member is assigned that seat.
- **The `/manual` store** (`ManualLog` Durable Object) — the small set of
  values that change *during* play, clicked in by anyone at the table and
  polled by every browser automatically. Its shape:

  ```json
  {
    "destiny": { "light": 0, "dark": 0 },
    "wounds": { "<liveId>": 0 },
    "strain": { "<liveId>": 0 },
    "criticalInjuries": { "<liveId>": [] },
    "vehicle": { "hull": 0, "systemStrain": 0, "criticalHits": [] },
    "initiative": { "order": [], "taken": 0 },
    "itemQty": {},
    "wornArmor": {}
  }
  ```

  - `wounds` / `strain` — current values, keyed by each character's
    `liveId` (set on that character in ledger.json). Thresholds stay in
    ledger.json.
  - `destiny` — the shared party Destiny Pool.
  - `vehicle` — current Hull Trauma / System Strain (thresholds stay in
    `ledger.json`) plus any Vehicle Critical Hits.
  - `criticalInjuries` — Table 6-10 result numbers only (e.g. `[30, 66]`),
    one array per character, assigned from the GM page. The dashboard
    resolves each number to its name via a built-in lookup table. This is
    the only place Critical Injuries are recorded — ledger.json does not
    carry them at all.
  - `initiative` — combat order: `order` is the fixed PC/NPC seat
    sequence for the encounter (empty when there's no active fight),
    `taken` is how many seats from the front have acted this round. The
    dashboard hides the tracker automatically whenever `order` is empty.
  - `itemQty` / `wornArmor` — live item counts and which armor each
    character currently has on.

  POSTs to `/manual` are a shallow per-field merge, so two browsers
  clicking different things at once don't clobber each other. No build or
  redeploy is ever needed for any of this.

## Architecture

This deploys as a single **Cloudflare Worker with static assets** (not
Cloudflare Pages) — see `worker/index.js` and `wrangler.jsonc`. The Worker
handles these custom routes and falls back to serving the built React app
for everything else:

- **`GET/POST/DELETE /rolls`** — the shared dice-roll log, backed by a
  **Durable Object** (`RollLog`) rather than KV, so writes from multiple
  players posting at once are serialized (no lost rolls) and reads are
  strongly consistent (no propagation lag). Never touches `ledger.json`.
- **`GET/POST /notes`** — the GM notes inbox, same pattern, backed by a
  second Durable Object (`NotesLog`).
- **`GET/POST /bio`** — the Character tab's shared Description field
  (size, colour, appearance etc), backed by a third Durable Object
  (`BioLog`). Unlike `RollLog`/`NotesLog`, this isn't an append-only log —
  it's an upsert-by-`characterId` store, so `GET` returns the current
  `{ characterId: text }` map for every character and `POST` overwrites
  just the one character's entry. Players edit and save this themselves
  from their own Character tab; it's never touched by `ledger.json`.
- **`GET/POST /crew`** — the Vehicle tab's shared crew assignments (who's
  in which seat on the ship), backed by a fourth Durable Object
  (`CrewLog`). Same upsert-by-key pattern as `BioLog`, but keyed by crew
  position id (`pilot`, `gunner`, etc. — from `ledger.json`'s
  `vehicle.crewPositions`) rather than character id: `GET` returns
  `{ positionId: characterKey }` for every filled seat, `POST` sets or
  clears one seat. Any player can claim a seat from the Vehicle tab's
  dropdown without the GM editing anything.
- **`GET/POST /manual`** — the shared session state described under Data
  model above (`ManualLog` Durable Object).
- **`/enemies`, `/gear`, `/map`, `/visibility`** (plus their `/gm/*`
  counterparts) — the Enemy board, field-acquired gear, battle map and
  GM visibility overrides, each its own Durable Object; writes that need
  it are gated by the `GM_PASSWORD` secret.

All of these Durable Objects run on Cloudflare's SQLite storage backend
(`new_sqlite_classes` in `wrangler.jsonc`'s `migrations`), which is
available on the Workers **Free** plan — no paid tier or KV namespace
required.

The client polls `/manual` every 3 seconds (`MANUAL_POLL_MS` in `src/App.jsx`)
and `/rolls` every 1.5 seconds while the Dice Roller tab is open.

## Local dev

```
npm install
npm run dev
```

## Deploy on Cloudflare (Workers & Pages)

This repo is **private**, so Cloudflare needs explicit repo access via its
GitHub App. The Worker never talks to GitHub at runtime — no GitHub token
is needed (an old `GITHUB_TOKEN` secret on the Worker can be deleted).

1. dash.cloudflare.com → Workers & Pages → Create application → Connect
   GitHub → select **your new campaign repo** (install/authorize the
   Cloudflare GitHub App with access scoped to this one repo, not all
   repos).
2. Framework preset: **Vite**. **Root directory: `dashboard`** (this is
   what keeps the build scoped to this subfolder — `ledgers/` is never
   part of the build input path). Build command `npm run build`. Output
   directory `dist`.
3. Settings → Variables and Secrets → add `GM_PASSWORD` as a **secret**
   (encrypted, not a plaintext env var) — it gates the GM page's writes.
4. Deploy. Every push to the tracked branch triggers a rebuild.

Or, from a local checkout: `npm run build && npx wrangler deploy` (set
`GM_PASSWORD` once via `npx wrangler secret put GM_PASSWORD` or the
dashboard).

Redeploys are needed when the app's code or `public/data/ledger.json`
changes (the ledger is bundled into the build). Live session state lives
in the `/manual` Durable Object and never needs one.

## Repo/site access — who can see what

- The GitHub repo is private: only invited collaborators can browse its
  source, including `ledgers/`.
- The deployed Cloudflare site is a public URL by default (that's how
  players load it without a GitHub account). It serves only the built
  `dashboard/dist` output — `ledgers/` is not part of that build and is
  never copied into it.
- If the campaign needs the *site itself* restricted to known players
  (not just "unlisted URL"), put it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  (Zero Trust) rather than relying on the repo being private — repo
  privacy and site privacy are two separate settings.
