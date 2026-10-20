# Reference data (GM-only, local-first lookups)

Six bulk SWRPG reference files, checked here so lookups during play don't
depend on a web fetch. **Check these files first** for any weapon, armor,
piece of gear, starship, adversary stat block, or talent — only fall back to
a web search (or to building a scaled/GM-only stat block) when the thing
being looked up genuinely isn't in here.

This directory sits at the repo root next to `ledgers/`, not inside
`dashboard/`, for the same reason `ledgers/` does: it's GM-reference
material, never bundled into the public dashboard build (see
`dashboard/README.md`'s "What this app reads" section).

## Files

- **`weapons.json`** — every personal-scale weapon (Energy Weapons,
  Slugthrowers, Others/Thrown/Specialty, Explosives and Ordnance,
  Demolition and Mining Explosives, Brawl Weapons, Melee Weapons,
  Lightsabers), keyed by category. Each entry carries `name`, `skill`,
  `damage`, `crit`, `range`, `encumbrance`, `hp`, `price`, `rarity`,
  `restricted`, `special`, `special_description`, `ability_notes`,
  `book_set`, and `source`. These are personal-scale stats as printed —
  no Genesys vehicle-scale conversion applies to this file.

- **`armor.json`** — every piece of personal armor and protective clothing
  (Armour And Clothing, plus Tack for bestial riding armor), keyed by
  category. Each entry carries `name`, `defence`, `soak`, `price`,
  `restricted`, `encum`, `hard_points`, `rarity`, `ability`, `book_set`, and
  `source` — same as-printed-stats convention as `weapons.json`.

- **`equipment.json`** — general gear across every non-weapon, non-armor
  category (Communications, Drugs and Poisons, Cybernetic Enhancements,
  Scanning/Detection/Surveillance, Medical, Security/Infiltration/Espionage,
  Survival & Unique Gear, Tools and Electronics, Load Bearing/Carrying/
  Storage, Recreation, Droids, Relics/Focuses/Fetishes/Holocrons, Illegal
  Drugs), keyed by category. Each entry carries `name`, `price`,
  `restricted`, `encum`, `rarity`, `ability`, `book_set`, and `source`.

- **`starships.json`** — starships and vehicles, keyed by hull category
  (Starfighters, Freighter, Corvette, Star Destroyer, etc). Each entry has
  the as-printed FFG stat block (`silhouette`, `speed`, `handling`,
  `defense_fore_port_starboard_aft`, `armor`, `hull_trauma`,
  `system_strain`, `weapons` as free text, `cost`, `source`, etc.) **plus
  a nested `genesys_v2` object** with the already-converted Genesys vehicle
  stats and a `conversion_notes` list — use `genesys_v2` directly instead
  of hand-converting via the Order 66 guide when the ship is in this file.
  Only fall back to `Order_66_Conversion_Guide_Genesys_Vehicle_Rules_in_Star_Wars.pdf`
  and `Genesys_Vehicle_Combat_Rules_and_Lessons.md` (project files) to
  convert a ship that isn't listed here.

- **`adversaries.json`** — flat array of 1,431 adversary stat blocks (the
  full stoogoff/sw-adversaries dataset, pre-flattened — no GitHub fetch
  needed). Each entry has `name`, `type` (`Minion` / `Rival` / `Nemesis`),
  `characteristics`, `derived` (soak/wounds/strain/defence), `skills`,
  `talents`, `abilities`, `gear`, `weapons`, `notes`, `tags`, and
  `_source_file` (which sourcebook JSON it came from — the FFG/Edge book
  the block is originally printed in, e.g. `hobs.json`, `creatures.json`,
  `dawn-of-rebellion.json`). Search this file by `name` (case-insensitive
  substring match is fine) before falling back to the "stock foes first"
  generic blocks or the stoogoff GitHub repo directly.

- **`talents.json`** — 625 talents under a top-level `talents` key, plus a
  `_conversion_info` block describing how the list was built and a
  `force_rules` block (see below). The base is the project's own
  `Genesys Talents Expanded Version 5.0.xlsx` (sheet V5.0), revised on
  18 Oct 2026:
  - **Removed:** 47 magic talents from fantasy Genesys settings (spells,
    magic skills such as Runes/Divine/Verse, familiars, blood magic, Turn
    Undead, shapeshifting). The full list is in
    `_conversion_info.revision_2026_10_18.removed_magic_talents`.
  - **Added:** 158 talents from *Star Wars Genesys* (DrainSmith v0.0.11) —
    125 Force talents (the Force power trees Bind, Enhance, Force Leap,
    Heal/Harm, Influence, Misdirect, Move, Protect/Unleash and Sense; the
    lightsaber forms; Force Sensitive and Force Rating) and 33 other Star
    Wars talents (droids, jetpacks, stims, clones, Precision Strike, the
    Ichor line). Tiers are as DrainSmith prints them. Talents that duplicated
    or clashed with one already in the list were left out; see
    `_conversion_info.revision_2026_10_18`.
  - **Reflect comes in two versions.** `Reflect` / `Reflect (Improved)` /
    `Reflect (Supreme)` are the Genesys shield or melee-weapon talents;
    `Reflect (Lightsaber)` / `Reflect (Lightsaber, Improved)` /
    `Reflect (Lightsaber, Supreme)` are DrainSmith's lightsaber versions.
    Each entry's `notes` says which it is.

  Each entry has `name`, `tier`, `activation`, `ranked` (`Yes`/`No`),
  `force` (`Yes`/`No` — Force talents can only be bought by a Force
  Sensitive character), `text_original_genesys`, `text_swrpg`, `source`,
  `from`, `superseded_by_version`, and `notes`. **Use `text_swrpg`** when
  quoting a talent's effect — it's already in this project's symbol
  convention. Ten talent names appear twice in the source (`Bad Cop`,
  `Body Guard`, `Finesse`, `Good Cop`, `Grapple`, `Hard-Boiled`,
  `Heroic Recovery`, `Offensive Driving`, `Pressure Point`, `Shield Slam`),
  so a name lookup can return more than one entry; check
  `tier`/`source`/`text_swrpg` to pick the right one. This project's own
  Rank 1-5 talent costs (tier × 5 XP) apply on top of whatever's here —
  this file is rules text and metadata, not XP pricing.

  `force_rules` carries DrainSmith's Force rules that the Force talents
  rely on: Force Sensitive, Committing Force Dice, Combined Checks,
  Resisting Force Powers, Range, Duration, Magnitude and Morality.

  **Symbol key.** JSON can only hold text, so `text_swrpg` uses the
  shorthand glyphs below. The dashboard's Advancement Planner draws each
  one with the matching die or symbol image.

  | Glyph | Meaning | Image | | Glyph | Meaning | Image |
  |:-:|---|:-:|---|:-:|---|:-:|
  | ✔ | Success | <img src="../dashboard/public/images/symbol-success.png" alt="Success" width="16"> | | 🟩 | Ability die | <img src="../dashboard/public/images/die-ability.png" alt="Ability" width="16"> |
  | ✖ | Failure | <img src="../dashboard/public/images/symbol-failure.png" alt="Failure" width="16"> | | 🟨 | Proficiency die | <img src="../dashboard/public/images/die-proficiency.png" alt="Proficiency" width="16"> |
  | ▲ | Advantage | <img src="../dashboard/public/images/symbol-advantage.png" alt="Advantage" width="16"> | | 🟦 | Boost die | <img src="../dashboard/public/images/die-boost.png" alt="Boost" width="16"> |
  | ▼ | Threat | <img src="../dashboard/public/images/symbol-threat.png" alt="Threat" width="16"> | | ◆ | Difficulty die | <img src="../dashboard/public/images/die-difficulty.png" alt="Difficulty" width="16"> |
  | ★ | Triumph | <img src="../dashboard/public/images/symbol-triumph.png" alt="Triumph" width="16"> | | 🟥 | Challenge die | <img src="../dashboard/public/images/die-challenge.png" alt="Challenge" width="16"> |
  | ☠ | Despair | <img src="../dashboard/public/images/symbol-despair.png" alt="Despair" width="16"> | | ⬛ | Setback die | <img src="../dashboard/public/images/die-setback.png" alt="Setback" width="16"> |
  | ○ | Light side Force point | <img src="../dashboard/public/images/symbol-light-side.png" alt="Light side" width="16"> | | ⚪ | Force die | <img src="../dashboard/public/images/die-force.png" alt="Force" width="16"> |
  | ● | Dark side Force point | <img src="../dashboard/public/images/symbol-dark-side.png" alt="Dark side" width="16"> | | ◑ | Force point of either side | — |

## Lookup order (all six files)

1. **This directory.** Read the relevant file and search it directly
   (`name`/category match) — no need to fetch anything.
2. **Web search / GitHub fetch** — only if the item genuinely isn't in
   the local file (e.g. a very new or obscure printed source not yet
   folded into this dataset).
3. **GM-built, scaled from a real archetype** — per the project's
   Adversary Lookup Rules: anchor to a known profile, tune to the
   intended tier, and label it clearly as Provisional GM-Use.

## Updating these files

These are point-in-time exports, not live syncs — if a correction or a
newly-released stat block needs adding, edit the relevant JSON directly
(same discipline as any other repo file: read it, make the surgical
change, write it back) rather than re-fetching the whole file.

## Dashboard GM-page lookups

The GM page's own search boxes (adversary lookup on the Enemy Board; weapon/
armor/equipment lookup on the Field-Acquired Gear board) don't read these
files directly — they're too large to ship to every browser. Instead each
one has a small trimmed index checked into `dashboard/public/data/`:
`adversary-index.json`, `weapon-index.json`, `armor-index.json`, and
`equipment-index.json`, each just `{name, ...a few key stats}` flattened out
of the matching file above. `talents.json` itself is copied whole to `dashboard/public/data/talents.json`
for the Advancement Planner's talent search (which hides `"force": "Yes"`
talents from characters who aren't Force Sensitive) — keep the two copies
identical. If
one of the indexed reference files changes, regenerate the matching trimmed
index the same way (flatten every category into one array, keep only the
fields the add-form actually needs) rather than letting it drift out of
sync.
