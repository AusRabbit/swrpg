# SWRPG Beta: moving off ledger.json and the ledger workflow

Goal: the website is the single source of truth for the campaign. The GM runs
everything from the GM page (signed in with `GM_PASSWORD`). No `ledger.json`,
no `live.json`, no `ledgers/` folder, no Quick Saves or consolidation, and no
Claude edits to character data.

---

## 0. Status: rebased on the current campaign dashboards (done, 20 Oct 2026)

The Beta's old dashboard has been replaced with the current one from
`salvage-rights-manual` and `deniable-assets` (both read only, not changed).
Those two are identical apart from two generic improvements that only
`salvage-rights-manual` had, so the Beta now carries both:

- talent-labelled weapon tags (`overrideTalent`, `freeAdvantage`,
  `freeAdvantageTalent` on weapons);
- the shared dice pool tray resetting the owner's Dice Roller after "Roll now".

Also brought across: the 18 Oct talent list (`reference/talents.json` and
`dashboard/public/data/talents.json`, 625 talents with Force flags), the
newer armour and equipment indexes, and the clean two-step Durable Object
migration list. Not copied: campaign data (`ledger.json`, portraits,
`prep/`, `transcripts/`). The Beta's placeholder `ledger.json` was kept.

Campaign-specific values were reset: browser title "SWRPG - Beta",
Worker name `YOUR-WORKER-NAME`. `dashboard/data/live.json` was deleted (the
current dashboard no longer reads it). The site builds cleanly.

A copy of the Beta's previous dashboard, reference folder and README is in
the session's output folder (`beta-backup-2026-10-20`) if anything needs
recovering.

Good news from the rebase: a lot of the old live.json work is already gone.
The `/live` route, `GITHUB_TOKEN`, Manual Mode toggle and the scene tracker
no longer exist; wounds, strain, destiny, crits, vehicle damage, initiative
and obligation strain all live in the `ManualLog` Durable Object, always on.
What remains is **ledger.json** (and the docs/ledgers that describe the
Claude workflow).

---

## 1. Everything that still points at ledger.json or the ledger workflow

### 1.1 Files

| File | What it is | Action |
|---|---|---|
| `dashboard/public/data/ledger.json` | Character, vehicle, NPC, location, campaign data, bundled into the site and fetched by every browser | Stop using it at runtime. Keep one placeholder copy as an **import sample** (§3.5). |
| `ledgers/Ledger.md` | GM master ledger: protocol, mechanical state, resume marker, objectives, chronicle, PC sheets, NPCs, factions, clocks | Delete. Narrative sections move to a GM Journal (§3.6). |
| `ledgers/updates/_TEMPLATE.md` | Quick Save template | Delete. |
| `README.md` (root) | Checklist steps for ledger.json / live.json / `GITHUB_TOKEN`, "Ledger maintenance", "two in one repo" | Rewrite (§5). |
| `dashboard/README.md` | Describes ledger.json and the deploy flow | Rewrite (§5). |
| `public/images/portraits/` | Portrait files referenced by `character.portrait` | Move to R2 with GM upload (§3.4). |
| `reference/*.json`, `public/data/*-index.json`, `public/data/talents.json` | Rules reference data | **Keep.** Not campaign state. |

### 1.2 Worker (`dashboard/worker/index.js`)

No route reads ledger.json any more. What's left is wording plus two stores
that only exist to work around ledger.json being a static file:

| Lines | Item | Action |
|---|---|---|
| 10, 32-33, 346 | Comments: "XP in the ledger repo", "GM actions notes in the ledger repo" | Rewrite. |
| 460-474 | `BioLog` "credits" field stored as `{value, base}` against the ledger.json figure | Credits move onto the character record (§3.1); drop the workaround. |
| 549-554 | `CrewLog` comments mention ledger.json's `vehicle.crewPositions` | Wording only. |
| 624-718 | `VisibilityLog`: live hide/reveal overrides on top of ledger.json's `hidden` flags (and `forceSensitive`) | Retire once the GM edits `hidden` / `forceSensitive` on the character record directly. |
| 754, 771, 860 | `ManualLog` comments on "ledger baseline" armour / quantities | Wording only. |
| 1146-1163 | `GearLog` "field-acquired gear" kept separate from ledger.json gear | Keep for now; later fold into the character's own gear lists. |

### 1.3 Front end (`dashboard/src/App.jsx`)

**Load plumbing to replace**

| Lines | Item | Action |
|---|---|---|
| 4-30 | File header describing "static, bundled ledger.json" and legacy fallbacks | Rewrite. |
| 45-99 | `DEMO_LEDGER` sample character shown before ledger.json loads | Replace with an empty campaign and a "GM: create your first character" prompt. |
| 101-146 | `SAMPLE_SCHEMA` text block | Delete. |
| 8990 | `const [ledger, setLedger] = useState(DEMO_LEDGER)` | Becomes the campaign store (§3.1). |
| 9001, 9274-9286, 9596-9620 | Paste-a-ledger box ("Test data ▼"), `handlePasteLoad`, "Loads /data/ledger.json at build time" text | Delete; replaced by GM-only Import (§3.5). |
| 9178-9190 | `fetch("/data/ledger.json")` on boot | Replace with the campaign store. |
| 9261-9272, 9430-9434 | `reload()` and the "Reload ↻" button | The store polls itself; remove. |
| 5389-5440 | `applyLiveOverlay()` legacy fallback for old static `current`/`destiny` values in ledger.json | Remove the fallback. |
| 843-947 | `LiveCreditsField` "ledger base" logic | Save credits straight onto the character record. |
| 5557+, 8799+ (GM page), 9091 | Visibility overrides and "Reset overrides falls back to ledger.json" | Edit `hidden` / `forceSensitive` on the record instead. |

**Wording only** (no behaviour change): lines 334, 374, 408, 425, 520, 625,
672, 948, 1044-1050, 1319 (Advancement Planner: "GM applies it into the
ledger by hand"), 3952-3997 (NPC panel "from the GM master ledger"), 4109,
4183 and 4223 (wiki URL "set in public/data/ledger.json"), 4305 (vehicle),
5086-5089, 5396-5407, 5439, 5541-5544, 5601-5620, 5769, 7181-7196, 8509,
8814, 8875-8878, 8928-8929, 9288-9354.

### 1.4 Every field the site reads from ledger.json

Each needs a home in the campaign store and a GM editor.

**Campaign:** `campaign` (title), `wikiUrl`, `characters[]`, `vehicle`,
`npcs[]`, `locations[]`.

**Character:** `name`, `liveId`, `hidden`, `forceSensitive`, `career`,
`species`, `speciesAbilities[]` (`boostsSkills`), `portrait`, `updated`,
`vitals.wounds.threshold`, `vitals.strain.threshold`, `vitals.soak`,
`vitals.criticalInjuries` (static list), `xp.available`, `xp.total`,
`credits`, `motivationObligation.motivation`,
`motivationObligation.obligation.{type,value,note}`, `hooks[]`,
`characteristics.{brawn,agility,intellect,cunning,willpower,presence}`,
`skills[].{name,rank,career}`,
`talents[].{name,tier,rank,ranked,activation,description,boostsSkills}`,
`weapons[].{name,skill,damage,crit,range,special,hidden,isNew,modes,characteristicOverride,overrideTalent,freeAdvantage,freeAdvantageTalent}`,
`inventory[].{name,note,hidden,isNew}`,
`armor.{name,soakBonus,rangedDefense,meleeDefense,defenseBonus,special,hidden}`.

**Vehicle:** `name`, `class`, `hidden`, `silhouette`, `speed`, `handling`,
`defense`, `armor`, `hullTrauma.threshold`, `systemStrain.threshold`,
`sensors`, `specialFeatures[]`,
`weapons[].{name,fireArc,range,damage,crit,qualities}`,
`crewPositions[].{id,name,description,manoeuvres[],actions[]}`.

**NPC (player-facing):** `name`, `role`, `species`, `gender`, `status`,
`summary`, `whatPartyKnows`.

**Location:** `name`, `type`, `summary`, `current`.

---

## 2. Where each piece of state lives in the Beta

| State | Now | Beta home | Who can write |
|---|---|---|---|
| Campaign title, wiki link, character sheets, vehicle, NPCs, locations | ledger.json | **New `CampaignLog` Durable Object** | GM; players only through specific actions (credits, XP purchases) |
| Wounds, strain, destiny, crits, vehicle damage, initiative, obligation strain, quantities, worn armour | `ManualLog` | Unchanged | Anyone at the table, as now |
| Hidden/revealed gear and characters, Force sensitivity | ledger.json + `VisibilityLog` overrides | Flags on the `CampaignLog` record | GM |
| Field-acquired gear | `GearLog` | Keep for now, merge into sheets later | GM |
| Credits | ledger.json + `BioLog` workaround | On the character record | Player or GM |
| Enemies, map, rolls, notes, descriptions, crew seats | Existing Durable Objects | Unchanged | As now |
| Portraits | Files in the repo | **R2 bucket** | GM upload |
| Story notes (resume marker, objectives, chronicle, NPC secrets, clocks) | `ledgers/Ledger.md` | **GM Journal** in `CampaignLog`, GM-only | GM |
| Backups and history | Git commits | Snapshots and a change history in `CampaignLog` | Automatic |

Why one `CampaignLog` rather than one per character: a Durable Object
handles requests one at a time, so an XP purchase can check the balance,
change the sheet and write the history entry as a single step, with no
chance of two requests tangling. A whole campaign is a few hundred KB, well
inside a Durable Object's limits.

---

## 3. Design

### 3.1 `CampaignLog` Durable Object

SQLite tables:

- `campaign`: title, wiki link, settings (e.g. XP approval mode).
- `characters`: id, full sheet as JSON (same shape as today, so the existing
  sheet, party, vehicle and NPC views keep working), version number.
- `vehicle`, `npcs`, `locations`: JSON.
- `xp_requests`: pending player purchases (§4).
- `history`: append-only log of every change (when, who, what, before and
  after). Powers undo and replaces git history.
- `journal`: GM-only story sections.
- `snapshots`: whole-campaign copies, taken daily by a Durable Object alarm
  and before any import; keep the last 30.

Routes:

- `GET /campaign`: what players may see. Hidden characters and gear, and
  GM-only NPC fields, are removed **on the server**. Today ledger.json is a
  public file, so "hidden" items can be read by anyone who opens it; this
  fixes that.
- `GET /gm/campaign`: everything, GM key required.
- `PUT /gm/character/:id`, `/gm/vehicle`, `/gm/npcs`, `/gm/locations`,
  `/gm/campaign-meta`: GM edits. Each carries the version it started from; if
  the record changed in the meantime the Worker refuses, so nothing is
  silently overwritten.
- `POST /character/:id/credits`: player credits edit.
- XP routes (§4).
- `GET /gm/export`, `POST /gm/import`, `GET /gm/history`, `POST /gm/undo`.

Front end: a `useCampaignStore(gmKey)` hook with the same poll-and-save
pattern as the enemy and gear stores. `ledger` in `CampaignDashboard` becomes
the store's data.

### 3.2 GM editors (GM page)

- **Characters:** create, duplicate, hide/reveal, delete; edit every field in
  §1.4. Talents use the existing talent search, gear uses the existing
  quality pickers and reference lookups.
- **Vehicle:** stat block, weapons, special features.
- **NPCs and locations:** list editors. NPCs get a GM-only "secrets" field.
- **Campaign:** title and wiki link.

### 3.3 Session state

No change needed: `ManualLog` already holds everything that used to be in
live.json.

### 3.4 Portraits

R2 bucket binding. The GM uploads from the character editor; the Worker
checks type and size and serves it back at `/portrait/:id`.

### 3.5 Import and export

- **Import** (GM page): load an existing campaign's `ledger.json` into
  `CampaignLog`, taking a snapshot first. This is how Salvage Rights, Deniable
  Assets and the others can move across.
- **Export**: download the whole campaign as one JSON file, for offline
  backup or copying to another site.

### 3.6 GM Journal (replaces `ledgers/Ledger.md`)

GM-only tab with the ledger's story sections as editable text: Resume
Marker, Mission Objectives, Campaign Chronicle (dated, append-only), NPC
Dossiers and secrets, Factions and Threats, Evidence and Mysteries, Clocks,
Continuation Hooks.

---

## 4. Levelling up without ledger.json

The Advancement Planner already does most of the player side: skill ranks,
talents picked by name from the 625-talent list, Force talents hidden for
non-Force-sensitive characters, costs and the pyramid check. Today it ends in
"copy the summary or send it to the GM inbox" and the GM types the result
into the ledger. The Beta replaces that last step.

### 4.1 The loop

1. **GM awards XP.** GM page "Award XP": one PC or the whole party, amount,
   reason. Adds to `xp.total` and `xp.available` and writes a history entry.
2. **Player plans** in the existing Advancement Planner.
3. **Player submits.** The campaign setting decides what happens:
   - **GM approval (recommended default):** the purchase waits in a queue,
     the GM Inbox pulses, and the GM sees exactly what will change and clicks
     Approve or Reject (with a note).
   - **Direct spend:** it applies immediately and the GM sees it in history.
4. **The Worker applies it.** Before touching the sheet it re-checks
   everything itself: skill and talent costs, enough XP, ranks no higher than
   5, the pyramid, the talent exists and is allowed (Force talents). Then it
   deducts XP, updates skills and talents, applies talent effects (§4.2),
   bumps the version and records the before and after sheet. A player can't
   cheat by editing the request in their browser, because the browser's
   numbers are never trusted.
5. **Undo.** GM page history: undo any purchase, which restores the earlier
   sheet and refunds the XP.

### 4.2 Talents that change numbers

| Talent | Effect per rank |
|---|---|
| Toughened | Wound threshold +2 |
| Grit | Strain threshold +1 |
| Enduring | Soak +1 |
| Dedication | +1 to a characteristic the player picks (max 5 unless the GM allows 6) |
| Talents with `boostsSkills` | Already handled by the sheet |

Raising Brawn also raises the wound threshold by 1; raising Willpower raises
the strain threshold by 1. Anything else, the GM adjusts in the character
editor.

### 4.3 One copy of the rules

`skillRankCost`, `talentTierCost`, `pyramidLegal` and the talent effects move
into a shared file that both the Worker and the website import, so the
planner's preview and the server's check can never disagree.

### 4.4 Who can submit for a character

Anyone viewing the site can already act for any character (credits, notes,
quantities work that way). With GM approval on, that's fine for XP too. For
direct spend, add a short per-character player code that the GM sets and the
Worker checks.

---

## 5. Docs and cleanup

- Root `README.md`: new checklist (deploy, set `GM_PASSWORD`, sign in, create
  characters or import a ledger.json). Remove the ledger sections.
- `dashboard/README.md`: document `CampaignLog`, XP flow, import/export,
  backups.
- Delete `ledgers/`. Remove `public/data/ledger.json` once import exists.
- `wrangler.jsonc`: add `CAMPAIGN_LOG` and the R2 bucket. The Beta has never
  been deployed (Worker name is still the placeholder), so its migration list
  can simply gain a `v3`.

---

## 6. Order of work

1. ~~Rebase on the current dashboards.~~ Done.
2. ~~`CampaignLog` with read, import, export and undo; the site reads from
   it. Remove the ledger.json fetch, paste box, demo ledger, reload button.~~
   Done 20 Oct 2026 (see §7).
3. GM editors for characters, vehicle, NPCs, locations and campaign settings.
   Move credits, hidden and Force flags onto the record; retire
   `VisibilityLog`.
4. Levelling: XP award, submit/approve, server checks, talent effects,
   history and undo.
5. Portraits in R2, automatic snapshots, GM Journal.
6. Docs and file cleanup.

Each step leaves a working site that can be deployed and tried.

---

## 7. Progress log

### 20 Oct 2026: step 2 done, wiki folder added

**Campaign store.** `CampaignLog` Durable Object (`wrangler.jsonc`: binding
`CAMPAIGN_LOG`, migration `v3`). Routes:

| Route | Who | What |
|---|---|---|
| `GET /campaign` | anyone | Campaign with hidden characters, hidden gear and a hidden vehicle removed by the Worker. The GM page's live hide/reveal toggles are applied too, so a reveal reaches players on their next poll. |
| `GET /gm/campaign` | GM key | Everything, plus whether an undo is available. |
| `POST /gm/campaign/import` | GM key | Replace the campaign with an uploaded ledger.json (max 1.5 MB, 40 characters, every character needs a name). The replaced campaign is kept. |
| `POST /gm/campaign/restore` | GM key | Swap the kept campaign back in (and keep the replaced one, so it can be redone). |
| `GET /gm/campaign/export` | GM key | Download the whole campaign as `<title>-<date>.json`. |

Both GETs take `?since=<revision>` and reply `{ unchanged: true }` when
nothing moved; the site polls every 5 seconds.

**Site.** `useCampaignStore` replaces the ledger.json fetch. Removed: the
demo character, the sample schema, the "Test data" paste box and the
"Reload" button. Until a campaign is imported every tab shows a "No campaign
loaded" panel pointing the GM at Import. GM page: new "Campaign data"
section (Import with a preview and confirm, Export, Undo last import).
On-screen text that told the GM to edit ledger.json now refers to the
campaign file.

**Checked** against a local copy of the Worker (`wrangler dev`): import,
player redaction (hidden character, weapon, inventory item, armour and
vehicle all absent), GM view complete, `since` replies, a live reveal
reaching players, player writes refused, three kinds of bad file refused
with a clear message, export identical to the imported file, the real
Salvage Rights ledger.json (copied, not changed) imported and exported
identically, undo and redo. Not yet tried in a browser.

**Worker name.** `wrangler.jsonc` now says `swrpg-beta`: wrangler refuses the
old `YOUR-WORKER-NAME` placeholder (it must be lowercase letters, numbers and
dashes).

**Wiki.** New `wiki/` folder based on the deniable-assets wiki repo: same
`build.py` and `template.html`, a starter vault in `wiki/content/`, and
`.github/workflows/wiki.yml`, which builds it and publishes it to GitHub
Pages on every push that touches `wiki/`. It reads the talent list from
`reference/talents.json` and the dice icons from `dashboard/public/images/`
instead of keeping its own copies. `wiki/docs/` is git-ignored. Cloudflare
never builds or serves it. See `wiki/README.md`.

### 20 Oct 2026: character creation

**Data.** `dashboard/public/data/chargen.json`, built from the Star Wars RPG
(FFG) wiki's Category:Species and Category:Specialization pages: 97 species
(characteristics, wound and strain base, starting XP, free starting skill
ranks and talents, subspecies and Droid flags), 20 careers with their career
skills, and 129 specialisations with their bonus career skills and which
careers they belong to. Community homebrew pages (reSpecialized and the
homebrew species) are left out. Species special abilities are linked to the
wiki rather than copied.

**Rules.** `dashboard/src/chargen.js`, used by both the wizard and the Worker:
characteristics at 10 × new value (max 5); free ranks from species, career
(4, or 3 for six-skill careers) and specialisation (2), Droids +2/+1; no
skill above rank 2; bought ranks at 5 × new rank, +5 if non-career; talents
at tier × 5 with the house pyramid; optional extra Obligation for XP or
credits; 500 starting credits; Obligation 10 (GM can change on approval).

**Flow.**
1. GM page → Character creation → New character: makes a private link
   (`/?create=<code>`).
2. The player opens it and steps through: You, Species, Career,
   Characteristics, Skills, Talents, Motivation & Obligation, Review. Every
   change saves to the Worker; they can close the page and come back.
3. Send to the GM: the Worker checks the build and refuses an unfinished one.
4. GM reviews it on the GM page, then **Add to campaign** (shown or hidden)
   or **Send back** with a note. Adding re-runs the rules on the Worker,
   gives the character a unique id, and puts the player's description into
   the sheet's Description box.

**Routes.** Player: `GET/PUT /creation/<code>`, `POST /creation/<code>/submit`.
GM: `GET/POST /gm/creation`, `DELETE /gm/creation/<code>`,
`POST /gm/creation/<code>/approve`, `POST /gm/creation/<code>/reopen`.
Drafts live in `CampaignLog` (max 20).

**Checked.** Rules by hand-worked example; the full invite → save → submit
→ approve flow against a local Worker; the wizard rendered and clicked
through every step in a simulated browser (jsdom) with no errors, ending in
"Everything checks out". Not yet tried in a real browser.

### 21 Oct 2026: XP flow, cleanup, working wiki

- NPC Summary and Locations tabs removed from the dashboard.
- `ledgers/` deleted. Root and dashboard READMEs rewritten for the Beta.
- XP: GM awards XP from GM page → Experience. Players submit purchases from
  the Advancement Planner; the worker prices them (`priceAdvancement` in
  `src/chargen.js`), allows one pending request per character, and re-prices
  on approval before applying (`applyAdvancement`). Over-budget purchases
  can't be submitted. The ★ GM tab pulses while anything is waiting.
- Wiki: the old `.github/workflows/pages` (no extension, uploaded raw
  `wiki/`) replaced by `wiki.yml`, which runs `wiki/build.py` and deploys
  `wiki/docs`. Outline pages added (how we play, character creation, crew,
  ship, factions, Outer Rim).
