# SWRPG Beta — Live Dashboard

The player- and GM-facing dashboard for a Star Wars FFG
(Edge of the Empire / Age of Rebellion / Force and Destiny) group campaign.
It's a full campaign companion, not just a stat board: character sheets, a
shared dice roller with real FFG dice mechanics, a live combat tracker,
and a couple of small GM utilities, all kept in sync across everyone's
browser during a session.

## Session state, the Enemy board, and the Battle Map

Three shared, Durable-Object-backed stores sit alongside the campaign
store described below:

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

This app lives in this `dashboard/` subdirectory so Cloudflare builds only
this folder. The `wiki/` folder at the repo root is built separately by
GitHub Actions and is never part of the Cloudflare build.

## Where the data lives

- **The campaign store** (`/campaign`, `CampaignLog` Durable Object) —
  character sheets, vehicle, campaign title, wiki link, XP history,
  character-creation drafts and XP purchase requests. The GM edits it from
  the GM page; players change it only through specific actions (credits,
  creation drafts, XP purchase requests). Players get a copy with GM-only
  fields and hidden entries removed.
- **The `/manual` store** — the values that change during play (see Data
  model below).
- `public/data/ledger.json` — a sample of the campaign file format. Import it
  from GM page → Campaign data to start a new deployment; Import also
  replaces the campaign, and Export downloads it in the same format.

Whatever players can see is visible to **anyone with the deployed
dashboard URL**. Treat "would I say this out loud at the table" as the bar
for anything outside GM-only fields.

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
- **Wiki tab** — the campaign wiki, from the campaign's top-level
  `wikiUrl` (set on GM page → Campaign settings). Shown inline when the wiki's host allows embedding, with an
  "Open in new tab" link either way.
- **GM Notes** tab — a private inbox of notes players have sent from
  their character tab.
- **Experience** — the GM awards XP from GM page → Experience. Players
  spend it in the Advancement Planner and **Submit for approval**; the GM
  approves or rejects it in the same section, and the ★ GM tab pulses
  while anything is waiting. The worker prices every request with the same
  rules as the planner (`src/chargen.js`) and re-checks it on approval, so
  a purchase can't exceed available XP.
- **Character creation** — GM page → Character creation starts a draft and
  gives a private link for the player; the GM approves the finished
  character into the campaign.
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
  out until someone's assigned. Only shown when the campaign has a
  `vehicle` object. The GM adds and edits it on GM page → Vehicle,
  starting from a stock ship (`public/data/starship-index.json`, Genesys
  conversions built from `reference/starships.json` by
  `reference/scripts/build_starship_index.py`) or a blank one. The crew
  positions come from `public/data/vehicle-template.json`.

## Data model

Two sources, two different update rhythms:

- **The campaign store** (`CampaignLog`) — the GM-managed source of truth
  for character sheets: names, characteristics, skills, talents, weapons,
  armor, inventory. Changes when the GM imports a campaign, approves a new
  character or approves an XP purchase. Critical
  Injuries are **not** kept here — they live only in the shared `/manual` store,
  so there is exactly one place to read or clear them. Any weapon or
  inventory entry may carry `"isNew": true`, which shows a NEW badge
  beside it on the Character tab — set it when the party picks something
  up and clear it later. A character may also carry `"forceSensitive": true` — a GM-only flag that is never shown on the sheet. Its only effect is that the Advancement Planner offers Force talents (`talents.json` entries with `"force": "Yes"`) to that character and hides them from everyone else. The GM page's Force Sensitivity section can override it live (stored in the GM-write `/visibility` store), and "Reset overrides" falls back to the character record. The planner's talent search reads `public/data/talents.json` (a copy of `reference/talents.json`) and renders its rules-text glyphs with the same die and symbol artwork as the Dice Roller. An optional top-level
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
    `liveId` (set on that character record). Thresholds stay on the
    character record.
  - `destiny` — the shared party Destiny Pool.
  - `vehicle` — current Hull Trauma / System Strain (thresholds stay on the
    campaign's `vehicle`) plus any Vehicle Critical Hits.
  - `criticalInjuries` — Table 6-10 result numbers only (e.g. `[30, 66]`),
    one array per character, assigned from the GM page. The dashboard
    resolves each number to its name via a built-in lookup table. This is
    the only place Critical Injuries are recorded — the character record
    does not carry them at all.
  - `initiative` — combat order: `order` is the fixed PC/NPC seat
    sequence for the encounter (empty when there's no active fight),
    `taken` is how many seats from the front have acted this round. The
    dashboard hides the tracker automatically whenever `order` is empty.
  - `itemQty` / `wornArmor` — live item counts and which armor each
    character currently has on.

  POSTs to `/manual` are a shallow per-field merge, so two browsers
  clicking different things at once don't clobber each other. No build or
  redeploy is ever needed for any of this.

## Several campaigns

The Worker serves many campaigns. A campaign's pages and API calls live
under `/campaign/<slug>/`; the router at the bottom of `worker/index.js` strips
that prefix and runs the normal routes with every Durable Object named
`<slug>:<store>`, so campaigns share nothing. `CampaignRegistry` (one
Durable Object) holds the campaign list, names, "listed" flags and hashed
GM passwords; `/api/campaigns` serves the front page and `/api/admin/*`
(master password, `x-admin-key`) manages it. In the browser, `apiFetch`
adds the `/campaign/<slug>` prefix to every Worker call and `campaignStorage`
prefixes every saved key with `<slug>:` (only the dice sound/animation
switches are shared). Static files (`/data`, `/images`, `/sounds`,
`/assets`) are the same for every campaign.

## Architecture

This deploys as a single **Cloudflare Worker with static assets** (not
Cloudflare Pages) — see `worker/index.js` and `wrangler.jsonc`. The Worker
handles these custom routes and falls back to serving the built React app
for everything else:

- **`GET/POST/DELETE /rolls`** — the shared dice-roll log, backed by a
  **Durable Object** (`RollLog`) rather than KV, so writes from multiple
  players posting at once are serialized (no lost rolls) and reads are
  strongly consistent (no propagation lag). 
- **`GET/POST /notes`** — the GM notes inbox, same pattern, backed by a
  second Durable Object (`NotesLog`).
- **`GET/POST /bio`** — the Character tab's shared Description field
  (size, colour, appearance etc), backed by a third Durable Object
  (`BioLog`). Unlike `RollLog`/`NotesLog`, this isn't an append-only log —
  it's an upsert-by-`characterId` store, so `GET` returns the current
  `{ characterId: text }` map for every character and `POST` overwrites
  just the one character's entry. Players edit and save this themselves
  from their own Character tab; it's separate from the character record.
- **`GET/POST /crew`** — the Vehicle tab's shared crew assignments (who's
  in which seat on the ship), backed by a fourth Durable Object
  (`CrewLog`). Same upsert-by-key pattern as `BioLog`, but keyed by crew
  position id (`pilot`, `gunner`, etc. — from the campaign's
  `vehicle.crewPositions`) rather than character id: `GET` returns
  `{ positionId: characterKey }` for every filled seat, `POST` sets or
  clears one seat. Any player can claim a seat from the Vehicle tab's
  dropdown without the GM editing anything.
- **`GET /campaign`, `/gm/campaign/*`** — the campaign store
  (`CampaignLog`): import/export/undo, character-creation drafts,
  `/campaign/advance` (player XP purchase requests),
  `/gm/campaign/advance/<id>/approve|reject` and `/gm/campaign/xp`
  (GM XP awards), `/gm/campaign/settings` (title, wiki link) and
  `/gm/campaign/vehicle` (add or edit a vehicle by id, or `{ removeId }`)
- **`GET /wiki/<path>`, `/gm/wiki/begin|file|commit`, `DELETE /gm/wiki`** —
  the campaign's uploaded wiki: the `docs/` folder from `wiki/build.py`
  (index.html, img/…). The GM page unzips the zip in the browser and sends
  each file into a new version, which goes live only on commit (the old
  version is then deleted). Files are stored in `CampaignLog` in 1 MB
  chunks (limits: 15 MB per file, 100 MB and 2,000 files per wiki); the
  campaign record carries only `wiki: { fileName, size, files, uploadedAt }`.
  HTML and SVG are served with a `Content-Security-Policy: sandbox` header
  (no same-origin) and the Wiki tab uses a sandboxed iframe, so the wiki
  can't read the site's saved sign-ins. `run_worker_first` in `wrangler.jsonc` sends `/campaign/*` (and old `/c/*` links, which redirect) and
  `/api/*` to the Worker so it can serve it, and
  `/gm/campaign/character` + `/gm/campaign/character/undo` (GM fixes to a
  sheet; the liveId never changes, and the previous version of each
  character is kept for one-step undo), and `/gm/campaign/character/import`
  (one character from a file: replaces by liveId/name, or adds).
- **Vehicles** — the campaign holds a `vehicles` list; each has an `id`
  that keys its live Hull Trauma / System Strain / Critical Hits
  (`/manual` → `vehicles[id]`) and its crew seats (`/crew` → `<id>:<seat>`).
  An older file with one top-level `vehicle` is moved into the list on
  import. Each visible vehicle gets a nav tab named after it.
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
   what keeps the build scoped to this subfolder — `wiki/` is never
   part of the build input path). Build command `npm run build`. Output
   directory `dist`.
3. Settings → Variables and Secrets → add `GM_PASSWORD` as a **secret**
   (encrypted, not a plaintext env var) — it gates the GM page's writes.
4. Deploy. Every push to the tracked branch triggers a rebuild.

Or, from a local checkout: `npm run build && npx wrangler deploy` (set
`GM_PASSWORD` once via `npx wrangler secret put GM_PASSWORD` or the
dashboard).

Redeploys are needed only when the app's code changes. Campaign data and
live session state live in Durable Objects and never need one.

## Repo/site access — who can see what

- The GitHub repo is private: only invited collaborators can browse its
  source.
- The deployed Cloudflare site is a public URL by default (that's how
  players load it without a GitHub account). It serves only the built
  `dashboard/dist` output.
- If the campaign needs the *site itself* restricted to known players
  (not just "unlisted URL"), put it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  (Zero Trust) rather than relying on the repo being private — repo
  privacy and site privacy are two separate settings.
