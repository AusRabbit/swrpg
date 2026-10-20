# [Campaign Name] — Master Continuation Ledger

**Version:** [DD Mon YYYY] — new campaign. No session has been played yet.
**Current Arc:** Not yet established
**Current Phase:** Awaiting Session 1

| Field | Value |
|---|---|
| Campaign | [Campaign Name] |
| Current Arc | Not yet established |
| Current Phase | Awaiting Session 1 |
| Tone | [Unverified — set at the table] |
| Themes | [Unverified — set at the table] |
| Current Ship | [Ship name — class] (see Section 1.5) |
| Core PC Relationship | [Unverified — not yet established] |
| System | Star Wars FFG / Edge of the Empire with Genesys talents and Order 66 vehicle-conversion guidance |

**Table Conventions:** PCs roll all PC checks; the GM adjudicates outcomes and rolls NPC/oracle checks openly using scripted RNG. The GM never rolls on behalf of a PC — if this occurs it is retconned on request. Check difficulty is presented up front when a check is proposed. Difficulty varies with the actual stakes of each action rather than defaulting to a fixed pool. This table uses open action declarations rather than the five-numbered-options format. Initiative slots are unnamed and may be filled by any eligible actor on that side. Roll history is omitted from this ledger; it retains outcomes, state, key relationships, clocks, objectives, and mechanical values only.

**Verification Rule:** Values unsupported by a prior ledger remain **[Unverified]**. GM-constructed stat blocks are explicitly marked **Provisional GM-Use** with the archetype they were scaled from.

---

# 0. Ledger Protocol

Rules for maintaining this document. Any GM session (any Claude model) must follow these without altering the ledger's structure.

1. **Section 2 (Resume Play Marker) is rewritten** at each save point to describe the exact live situation.
2. **PC sheets (Section 5, one lettered sub-section per PC: 5a, 5b, 5c, …) are static** between saves. Edit them only when XP is spent, gear is permanently gained/lost, or a characteristic/threshold changes; deduct spent XP from Available XP in Section 1.2. Adding or losing a PC only adds/removes a letter under Section 5 — it never renumbers any other section.
3. **Archive rule:** Deceased or campaign-irrelevant NPCs are deleted from Section 6, leaving only a one-line entry in the Off-Screen Continuity Index or Chronicle. The player retains dated copies of every ledger in an offline annex folder — if a retired figure or any historical detail is needed again, **prompt the player to retrieve the relevant dated ledger** rather than reconstructing from memory.
4. **Save convention:** GitHub manages commits and version control, so override the current version of this ledger instead of creating duplicates. (This applies to full rewrites of this file — see items 5-7 below for the lighter-weight Quick Save option used between full rewrites.)
5. **Quick Save (incremental update).** Between full rewrites, a save may instead be committed as a small new file in `ledgers/updates/`, named `YYYY-MM-DD-session-update.md` (append `-2`, `-3`, etc. if more than one save happens on the same date). This file records **only what changed** since the last save, using **absolute current values, never deltas** (e.g. "Wounds: 3/13," not "+3 wounds"). Use the structure in `ledgers/updates/_TEMPLATE.md`, including only the sections that actually changed:
   - `## 1. Active Mechanical Ledger` — updated fields only (Party State, PC Vitals, Position Tracker, Equipment, Vehicle Status, Medical Notes)
   - `## 2. Resume Play Marker` — full replacement text if the scene has moved
   - `## 3. Mission Objectives Ledger` — changed/completed objectives only
   - `## 4. Campaign Chronicle` — new append-only entries
   - `## 5. PC Ledger changes` — only if XP was spent, gear changed, or a threshold changed (label each by its sub-section letter)
   - `## 6. NPC and Ally Ledger` — new, changed, or retired dossiers
   - `## 7-10.` — only if changed

   Main `ledgers/Ledger.md` is left untouched during a Quick Save.
6. **Session Start Merge.** At the start of any session, read `ledgers/Ledger.md` first, then read every file in `ledgers/updates/` in date order, and apply them in sequence to reconstruct the current live state before play begins. The most recent update file's values always take precedence over the base ledger or earlier update files for any field they touch.
7. **Consolidation.** When told to "consolidate" (or automatically suggested by the GM after roughly 3-5 accumulated update files), fold every update file back into `ledgers/Ledger.md` as a single full rewrite reflecting the current merged state, then delete the consolidated files from `ledgers/updates/`. This resets the update chain to zero and keeps `ledgers/Ledger.md` as the clean single source of truth. A full end-of-session rewrite (as under the original Save Convention) always counts as a consolidation.

---

# 1. Active Mechanical Ledger

## 1.1 Party State

| Field | Current State |
|---|---|
| Destiny Pool | **Not yet rolled** — roll Light/Dark at the start of Session 1 per the core rules. |
| Current Mode | **Scribe. No combat active.** No session has been played. |
| Current Location | [Unverified — not yet established] |
| Obligation State | [Total — list each PC's Obligation type and value; see Section 5 sheets for the full note.] |
| Command Structure | [Unverified — not yet established] |

### Clock Ledger

| Clock | Status | Meaning |
|---|---|---|
| — | — | No clocks established yet. |

## 1.2 PC Vitals

| PC | Wounds | Strain | Soak / Defense | Critical Injuries & Conditions | Credits | Available XP | XP Earned (audit) |
|---|---:|---:|---|---|---:|---:|---:|
| [PC 1 Name] | **0 / [WT]** | **0 / [ST]** | Soak [#]; Defense [M]/[R] | None | [#] | **[#]** | [#] |

*Add one row per PC.*

## 1.3 Scene & Position Tracker

**Range band:** none tracked — no scene is live.

| Actor / Element | Position | Condition | Disposition / Notes |
|---|---|---|---|
| — | — | — | No scene established yet. |

## 1.4 Equipment & Evidence Distribution

No shared party funds, evidence, or salvage have been established. Each PC's personal gear is recorded on their own sheet in Section 5.

## 1.5 Vehicle Status

| Vehicle | Location / Access | Hull Trauma | System Strain | Notes |
|---|---|---:|---:|---|
| [Ship Name] | [Docked / location] | **0 / [HTT]** | **0 / [SST]** | [Class, silhouette, description. Weapons with Genesys-converted stats — see dashboard/public/data/vehicle-weapons.json — and which crew position mans each.] |

## 1.6 Medical & Recovery Notes

- **[PC 1 Name]:** 0/[WT] wounds, 0/[ST] strain. Untouched.

---

# 2. Resume Play Marker

## 2.1 Exact Resume Point

The party has not yet met the story. No opening scene has been written; the facilitator or GM should establish the hook, the job, and how the PCs came to be together before the first check is called.

## 2.2 Scene & Atmosphere

[Unverified — not yet established]

---

# 3. Mission Objectives Ledger

## 3.1 Primary Objectives

1. [Unverified — no objectives set. Establish during Session 1.]

## 3.2 Standing Protocols

None established yet.

---

# 4. Campaign Chronicle (append-only)

No sessions have been played. This section begins recording events once play starts.

---

# 5a. Player Character Ledger — [PC 1 Name]

*Dynamic values (wounds, strain, XP, credits, conditions) live in Section 1. This sheet holds stable data only. Copy this whole sub-section for each additional PC as 5b, 5c, 5d, …*

## Identity

| Field | Value |
|---|---|
| Name | [PC 1 Name] |
| Species | [Species] |
| Career | [Career] |
| Specialization | [Specialization] |
| Crew Role | [Role in the party] |
| Obligation | [Type] ([Value]) — [Note] |
| XP Expenditure Record | Chargen: [purchases] = [#] spent, [#] unspent. |

## Concept

[One short paragraph on who this character is and what they're built to do.]

## Characteristics

| Brawn | Agility | Intellect | Cunning | Willpower | Presence |
|---:|---:|---:|---:|---:|---:|
| 2 | 2 | 2 | 2 | 2 | 2 |

## Derived Stats

| Stat | Value |
|---|---|
| Wound Threshold | [#] |
| Strain Threshold | [#] |
| Soak | [#], including [armour] |
| Melee Defense | [#] |
| Ranged Defense | [#] |
| Encumbrance Threshold | [#] |
| Species Ability | [If any] |

## Talent Pyramid

T1 0 / T2 0 / T3 0 / T4 0 / T5 0 — Legal.

## Talents

| Talent | Tier | Activation | Effect |
|---|:---:|---|---|
| [Talent] | 1 | [Activation] | [Effect] |

## Skills

| Skill | Characteristic | Career? | Rank | Pool | Notes |
|---|---|:---:|---:|---|---|
| [Skill] | [Characteristic #] | Yes/No | 0 | 🟩🟩 | [Career / specialisation / species bonus] |

## Weapons, Armour, and Gear

| Item | Mechanical Detail / Current Note |
|---|---|
| [Weapon] | [Skill]; Dam [#]; Crit [#]; [Range]; [Qualities] |
| [Armour] | Encum [#]; +[#] Soak, +[#] Defense (included above). |
| [Gear] | Carried. |

## Hooks

- [Character hook]
- Free-entry notes (flags, cooperation goals, in-play developments) players add under the dashboard's Hooks section are stored live per-character and aren't duplicated here — fold anything worth keeping into this ledger at consolidation.

---

# 6. NPC and Ally Ledger

**Continuity rule:** Dossiers here hold retained identity, history, capabilities, and gear. Live positions, conditions, and dispositions are tracked in Section 1.3; where an older dossier detail conflicts with the live state, the live state governs.

No NPCs have been introduced yet.

## Off-Screen Continuity Index

| Figure | Continuity Note |
|---|---|
| — | None yet. |

---

# 7. Faction and Threat Ledger

No factions or threats have been established yet.

---

# 8. Evidence and Mystery Ledger

## Confirmed (player-known)

None yet.

## GM-Only Truths (locked / strong)

None yet.

## Open Questions

None yet.

---

# 9. Continuation Priorities and Scene Hooks

## Immediate Moves

1. **Establish the opening scene.** Who brought the PCs together, and what's the job that opens Session 1?
2. **Fill in the PC sheets** (Section 5, one lettered sub-section per PC) and mirror the player-safe parts into `dashboard/public/data/ledger.json`.
3. **Set Obligations** and record the party total in Section 1.1.
4. **Define the ship** in Section 1.5 and in `dashboard/public/data/ledger.json` (or remove the `vehicle` object there if the party has no ship).
5. **Decide starting credits and shared party funds.**

## Strong Next Complications

*(None yet — populate once Session 1 establishes the opening scenario.)*

---

# 10. GM Handling Reminders

- Default meaningful resistance is **Average (🟪🟪)** — but vary difficulty with the actual stakes of each specific action. Routine or established-safe tasks stay Average; genuine escalation (unknown-threat proximity, elite opposition, extreme pressure) goes **Hard (🟪🟪🟪)**. Do not default to a fixed pool across consecutive checks.
- Add ⬛ Setback only for a real environmental or situational reason: atmosphere, sealed suits, panic, unstable ground, bad comms, voice pressure — not by habit.
- Present the difficulty when a check is proposed, before the player rolls.
- PCs roll all PC checks. The GM never rolls for a PC; NPC checks are rolled openly with scripted RNG and cached provisional stat blocks recorded in Section 6.
- Use Dark Side Destiny to increase pressure when the crew is succeeding repeatedly.
- For vehicle scenes, use the Order 66 / Genesys conversion: range-based attack difficulty, one Defense value, steering/forced movement as narrative assumption, and Star Wars Piloting skills.
- For uncertain world facts, use the campaign oracle rather than inventing certainty.
- Keep decisive choices, risk acceptance, and salvage/mission ownership with the PCs.
- Do not jump time forward unless the players request it.
