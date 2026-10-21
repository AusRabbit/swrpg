import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { Swords } from "lucide-react";
import {
  CHARACTERISTICS, CHAR_LABEL, ALL_SKILLS, CREATION_MAX_CHARACTERISTIC, CREATION_MAX_RANK, BASE_OBLIGATION,
  OBLIGATION_BONUSES, emptyDraft, computeBuild, characteristicCost, skillRankCost as creationSkillRankCost, talentCost, specializationsFor,
  TALENT_EFFECTS, talentRankCounts,
} from "./chargen.js";

// ---------------------------------------------------------------------------
// Several campaigns, one site. Each campaign lives at /c/<slug>/ and the
// Worker keeps its data apart from every other campaign's. Two helpers make
// the browser side match:
//
//  - apiFetch: every call to the Worker's own routes (/rolls, /manual,
//    /campaign, /gm/…) is sent to /c/<slug>/… for this page's campaign.
//    Static files (/data, /images, /sounds, /assets) and the site-wide /api
//    routes are left alone.
//  - campaignStorage: everything this site saves in the browser (GM sign-in,
//    the dice pool and its cache, the dice-roller client id, the roll-log
//    name, the GM tab reveal) is saved under "<slug>:" so two campaigns open
//    in the same browser never read each other's. Only the dice sound and
//    animation switches are shared, since those are personal preferences.
// ---------------------------------------------------------------------------
const CAMPAIGN_SLUG = (() => {
  if (typeof window === "undefined") return "";
  const m = /^\/c\/([a-z0-9-]{1,40})(?:\/|$)/.exec(window.location.pathname);
  return m ? m[1] : "";
})();

// This campaign's home address, e.g. "/c/salvage-rights/" (or "/" off-campaign).
function campaignBase() {
  return CAMPAIGN_SLUG ? `/c/${CAMPAIGN_SLUG}/` : "/";
}

const STATIC_PREFIXES = ["/data/", "/images/", "/sounds/", "/assets/", "/api/"];
function campaignUrl(url) {
  if (!CAMPAIGN_SLUG || typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return url;
  if (STATIC_PREFIXES.some((p) => url.startsWith(p))) return url;
  return `/c/${CAMPAIGN_SLUG}${url}`;
}
function apiFetch(input, init) {
  return fetch(campaignUrl(input), init);
}

const SHARED_STORAGE_KEYS = new Set(["swrpg-dice-animations", "swrpg-dice-sound"]);
function scopedStorageKey(key) {
  const k = String(key);
  return !CAMPAIGN_SLUG || SHARED_STORAGE_KEYS.has(k) ? k : `${CAMPAIGN_SLUG}:${k}`;
}
const campaignStorage = {
  getItem: (key) => window.localStorage.getItem(scopedStorageKey(key)),
  setItem: (key, value) => window.localStorage.setItem(scopedStorageKey(key), value),
  removeItem: (key) => window.localStorage.removeItem(scopedStorageKey(key)),
};

// ---------------------------------------------------------------------------
// Full character/party dashboard. The campaign itself (characters, vehicle,
// NPCs, locations) comes from the CampaignLog Durable Object via
// useCampaignStore: the GM loads it with Import on the GM page, and every
// browser polls it for changes. Wounds / Strain / Destiny / Critical
// Injuries / Vehicle / Initiative come from the shared /manual Durable
// Object (see useManualStore and ManualLog in worker/index.js). Every
// browser at the table reads and writes that one store, so a click on any
// sheet shows up everywhere.
//
// Matching: each character can carry an optional "liveId" field. If it
// matches a key in the /manual store's wounds/strain maps, that character's
// current Wounds/Strain come from the store. Destiny is party-wide. The
// character record carries wound/strain *thresholds* and Soak (structural,
// tied to characteristics/talents/gear), not current values.
//
// Talent-granted skill boosts: a talent may carry "boostsSkills": ["Skill
// Name", ...] to represent a "add Boost die per rank to X checks" effect.
// buildSkills() sums matching talent ranks per skill and attaches it as
// `boost`, rendered as a small triangle badge next to that skill's dice pips.
//
// Live-change highlight: whenever Wounds/Strain/Destiny change via the live
// overlay, the affected pip/token row gets a one-shot directional "sweep" —
// bottom-to-top in the stat's own color when the number goes UP, top-to-
// bottom in green when it goes DOWN. See lastChangeRef / SWEEP_MS below.
// ---------------------------------------------------------------------------
const MANUAL_POLL_MS = 3_000;
const MANUAL_DIRTY_MS = 2_500;
const SWEEP_MS = 950;
const PULSE_MS = 2400;
const COPY_CONFIRM_MS = 1500;

const BLUE_TOKEN = "/images/blue-token.png";
const RED_TOKEN = "/images/red-token.png";
const BOOST_ICON = "/images/boost-icon.png";
const YELLOW_ICON = "/images/yellow-icon.png";
const GREEN_ICON = "/images/green-icon.png";
const NEW_BADGE = "/images/new-badge.png";

// What the site shows before a campaign has been imported (see
// useCampaignStore and CampaignLog in worker/index.js).
const EMPTY_CAMPAIGN = { campaign: "", characters: [], npcs: [], locations: [] };

// ---------------------------------------------------------------------------

const FULL_SKILL_LIST = [
  { name: "Astrogation", char: "intellect", group: "General" },
  { name: "Athletics", char: "brawn", group: "General" },
  { name: "Charm", char: "presence", group: "General" },
  { name: "Coercion", char: "willpower", group: "General" },
  { name: "Computers", char: "intellect", group: "General" },
  { name: "Cool", char: "presence", group: "General" },
  { name: "Coordination", char: "agility", group: "General" },
  { name: "Deception", char: "cunning", group: "General" },
  { name: "Discipline", char: "willpower", group: "General" },
  { name: "Leadership", char: "presence", group: "General" },
  { name: "Mechanics", char: "intellect", group: "General" },
  { name: "Medicine", char: "intellect", group: "General" },
  { name: "Negotiation", char: "presence", group: "General" },
  { name: "Perception", char: "cunning", group: "General" },
  { name: "Piloting: Planetary", char: "agility", group: "General" },
  { name: "Piloting: Space", char: "agility", group: "General" },
  { name: "Resilience", char: "brawn", group: "General" },
  { name: "Skulduggery", char: "cunning", group: "General" },
  { name: "Stealth", char: "agility", group: "General" },
  { name: "Streetwise", char: "cunning", group: "General" },
  { name: "Survival", char: "cunning", group: "General" },
  { name: "Vigilance", char: "willpower", group: "General" },
  { name: "Brawl", char: "brawn", group: "Combat" },
  { name: "Gunnery", char: "agility", group: "Combat" },
  { name: "Lightsaber", char: "brawn", group: "Combat" },
  { name: "Melee", char: "brawn", group: "Combat" },
  { name: "Ranged: Heavy", char: "agility", group: "Combat" },
  { name: "Ranged: Light", char: "agility", group: "Combat" },
  { name: "Knowledge: Core Worlds", char: "intellect", group: "Knowledge" },
  { name: "Knowledge: Education", char: "intellect", group: "Knowledge" },
  { name: "Knowledge: Lore", char: "intellect", group: "Knowledge" },
  { name: "Knowledge: Outer Rim", char: "intellect", group: "Knowledge" },
  { name: "Knowledge: Underworld", char: "intellect", group: "Knowledge" },
  { name: "Knowledge: Warfare", char: "intellect", group: "Knowledge" },
  { name: "Knowledge: Xenology", char: "intellect", group: "Knowledge" },
];

// One-line "what is this skill for" text, shown when hovering a skill name
// on the Character and Party tabs (see SkillNameTip).
const SKILL_DESCRIPTIONS = {
  "Astrogation": "Plotting hyperspace routes, reading navicharts and judging jump times.",
  "Athletics": "Climbing, swimming, jumping, running and other feats of raw physical effort.",
  "Charm": "Winning people over with flattery, kindness or genuine appeal.",
  "Coercion": "Threats, intimidation and forcing someone's hand.",
  "Computers": "Slicing, bypassing security, searching data and operating sensors.",
  "Cool": "Staying calm under pressure. Initiative when you're ready for trouble.",
  "Coordination": "Balance, flexibility and agility: tightropes, tight spaces, falling safely, escaping bonds.",
  "Deception": "Lying, bluffing, disguises and misdirection.",
  "Discipline": "Holding your nerve: resisting fear, Coercion and mental pressure.",
  "Leadership": "Inspiring, rallying and giving orders that people actually follow.",
  "Mechanics": "Repairing and modifying ships, droids, gear and weapons.",
  "Medicine": "Healing wounds, treating critical injuries, using stimpacks and medical gear.",
  "Negotiation": "Haggling, trading and striking deals.",
  "Perception": "Noticing things: spotting hidden details, searching, reading a scene.",
  "Piloting: Planetary": "Flying or driving anything in an atmosphere: speeders, airspeeders, swoops.",
  "Piloting: Space": "Flying starships and starfighters in space.",
  "Resilience": "Toughing it out: resisting poison, disease, fatigue, hunger and the elements.",
  "Skulduggery": "Picking locks, pickpocketing, sabotage and other criminal craft.",
  "Stealth": "Sneaking, hiding and staying unseen.",
  "Streetwise": "Finding contacts, rumours and the black market in the criminal underworld.",
  "Survival": "Tracking, foraging, finding shelter and handling animals in the wild.",
  "Vigilance": "Staying alert to danger. Initiative when you're caught by surprise.",
  "Brawl": "Fighting unarmed or with fist weapons like brass knuckles.",
  "Gunnery": "Firing vehicle-mounted and heavy emplacement weapons.",
  "Lightsaber": "Fighting with a lightsaber.",
  "Melee": "Fighting with hand-held weapons: vibroblades, staffs, clubs.",
  "Ranged: Heavy": "Firing two-handed weapons: blaster rifles, carbines, heavy repeaters.",
  "Ranged: Light": "Firing one-handed weapons: blaster pistols, holdouts, thrown weapons.",
  "Knowledge: Core Worlds": "The civilised heart of the galaxy: its worlds, cultures and politics.",
  "Knowledge: Education": "General learning: history, science, law and academic study.",
  "Knowledge: Lore": "Ancient myths, legends, lost civilisations and the Force.",
  "Knowledge: Outer Rim": "The frontier: its worlds, hazards, peoples and powers.",
  "Knowledge: Underworld": "Crime syndicates, smugglers, bounty hunters and how they operate.",
  "Knowledge: Warfare": "Military tactics, strategy, units and the history of war.",
  "Knowledge: Xenology": "Alien species: their biology, cultures and customs.",
};

// Skill name with a short hover description. Opens after a brief pause so
// running the mouse down the list doesn't flash every tooltip.
function SkillNameTip({ name, children }) {
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const body = SKILL_DESCRIPTIONS[name];
  if (!body) return children;
  return (
    <span
      className="relative inline-flex items-baseline"
      onMouseEnter={() => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 250); }}
      onMouseLeave={() => { clearTimeout(timer.current); setOpen(false); }}
    >
      {children}
      {open && <HoverTip title={name} body={body} width={260} />}
    </span>
  );
}

// Short-form characteristic tags shown next to each skill name, e.g.
// "Athletics (BR)" — matches the abbreviations used on the physical
// character sheets so players can find a skill's governing characteristic
// at a glance without hovering or cross-referencing.
const CHAR_ABBR = {
  brawn: "BR",
  agility: "AG",
  intellect: "INT",
  cunning: "CUN",
  willpower: "WIL",
  presence: "PR",
};

// FFG range bands, in order. Used to render the range ladder on weapon cards.
// A weapon whose `range` doesn't match one of these shows its raw text with no
// bands lit - GM free-text ("Engaged/Short", "Varies") degrades safely.
const RANGE_BANDS = ["Engaged", "Short", "Medium", "Long", "Extreme"];

function rangeBandIndex(range) {
  const r = (range || "").trim().toLowerCase();
  return RANGE_BANDS.findIndex((b) => b.toLowerCase() === r);
}

// "Stun setting - Tends to run out of charge" -> ["Stun setting", "Tends to run out of charge"]
// A lone em dash (e.g. a weapon whose special is "—" for "nothing special")
// yields an empty list, so no chips render.
function splitSpecial(special) {
  // Two different separators show up here: " - " joins a weapon's base
  // special with its currently-selected fire mode's special (see
  // WeaponCard's combinedSpecial), while the reference weapon data's own
  // `special` field is a comma-separated list of qualities (e.g. "Blast 6,
  // Limited Ammo 1") — sometimes even comma-plus-newline. Splitting on only
  // the dash left every comma-separated reference weapon rendering as one
  // fused chip with just one (often wrong) tooltip attached; splitting on
  // both gives each quality its own chip and its own correct tooltip.
  return (special || "")
    .split(/\s*,\s*|\s+[-–—]\s+/)
    .map((x) => x.trim())
    .filter((x) => x && x !== "—" && x !== "-");
}

function normalizeSkillName(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function buildSkills(character) {
  const chars = character?.characteristics || {};
  const rawSkills = character?.skills || [];
  const skillMap = new Map(rawSkills.map((s) => [normalizeSkillName(s.name), s]));

  const boostMap = new Map();
  // Talents and innate species abilities both express as "add a Boost die
  // to skill X" — species abilities live in their own array (see e.g. the
  // Duros's Astrogation boost) rather than the Talents list, since they
  // aren't a purchased talent and shouldn't render as one on the sheet.
  [...(character?.talents || []), ...(character?.speciesAbilities || [])].forEach((t) => {
    if (Array.isArray(t.boostsSkills)) {
      t.boostsSkills.forEach((skillName) => {
        const key = normalizeSkillName(skillName);
        boostMap.set(key, (boostMap.get(key) || 0) + (t.rank || 1));
      });
    }
  });

  return FULL_SKILL_LIST.map((canon) => {
    const match = skillMap.get(normalizeSkillName(canon.name));
    return {
      name: canon.name,
      group: canon.group,
      char: canon.char,
      rank: match?.rank ?? 0,
      career: match?.career ?? false,
      characteristic: chars[canon.char] ?? 0,
      boost: boostMap.get(normalizeSkillName(canon.name)) || 0,
    };
  });
}

function getDefense(character) {
  const armor = character?.armor || {};
  const ranged = armor.rangedDefense ?? armor.defenseBonus ?? 0;
  const melee = armor.meleeDefense ?? armor.defenseBonus ?? 0;
  return { ranged, melee };
}

// Melee/Brawl/Lightsaber weapons (and a handful of thrown ones) are printed
// as "+N" in reference/weapons.json — and typed by hand into ledger.json as
// either "+N" or the older "Brawn+N" spelling — meaning the wielder's Brawn
// is added on top of N, not a flat N. A plain number, on the other hand, is
// already a finished total (either a weapon whose damage genuinely doesn't
// scale with Brawn, or a GM who's already done the addition by hand) and is
// used as-is. This parses either spelling into a single shape; use
// weaponDamageTotal below to get the number that's actually rolled/shown.
function parseWeaponDamage(damage) {
  if (typeof damage === "number") return { brawnBonus: null, flat: damage };
  const s = String(damage ?? "").trim();
  const m = s.match(/^\+\s*(\d+)$/) || s.match(/^brawn\s*\+\s*(\d+)$/i);
  if (m) return { brawnBonus: Number(m[1]), flat: Number(m[1]) };
  const n = Number(s);
  return { brawnBonus: null, flat: Number.isFinite(n) ? n : 0 };
}

// The number actually rolled/displayed for a weapon — Brawn-based weapons
// add the wielder's current Brawn on top of the printed bonus, so this
// always reflects the sheet's live Brawn rather than whatever it was when
// the weapon was added.
function weaponDamageTotal(damage, brawn) {
  const { brawnBonus, flat } = parseWeaponDamage(damage);
  return brawnBonus != null ? (brawn || 0) + brawnBonus : flat;
}

function weaponQualityRank(text, quality) {
  const match = new RegExp(`\\b${quality}(?:\\s+(\\d+))?\\b`, "i").exec(String(text || ""));
  return match ? Math.max(1, Number(match[1]) || 1) : 0;
}

function weaponRollAdjustments(special) {
  return {
    boost: weaponQualityRank(special, "Accurate"),
    setback: weaponQualityRank(special, "Inaccurate"),
    advantage: weaponQualityRank(special, "Superior") ? 1 : 0,
    threat: weaponQualityRank(special, "Inferior") ? 1 : 0,
    damage: (weaponQualityRank(special, "Superior") ? 1 : 0) - (weaponQualityRank(special, "Inferior") ? 1 : 0),
  };
}

// Every suit of armor a character could currently have on — the ledger.json
// baseline (if any) plus whatever field-acquired armor has been revealed to
// them via GearLog (see useGearStore) — feeding the worn-armor picker below.
// Only one is ever actually worn at a time (Soak/Defense don't stack across
// suits), so this list is informational until pickWornArmor narrows it down.
function armorOptionsFor(characterId, character, gearList) {
  const options = [];
  const baseline = character?.armor;
  if (baseline?.name) {
    options.push({
      id: "ledger",
      name: baseline.name,
      soakBonus: baseline.soakBonus || 0,
      rangedDefense: baseline.rangedDefense,
      meleeDefense: baseline.meleeDefense,
      defenseBonus: baseline.defenseBonus,
    });
  }
  for (const g of gearList || []) {
    if (g.characterId !== characterId || g.category !== "armor" || g.hidden) continue;
    options.push({
      id: g.id,
      name: g.name,
      soakBonus: g.soakBonus || 0,
      defenseBonus: g.defenseBonus || 0,
      note: g.note,
      isNew: isRecentlyAdded(g.addedAt),
    });
  }
  return options;
}

// Resolves which of armorOptionsFor()'s entries is actually worn right now.
// `stored` is manual.wornArmorOf(characterId): undefined means nobody has
// touched the picker yet, so default to the ledger baseline (keeps existing
// campaigns behaving exactly as before until a GM or player actually picks
// something) or, failing that, whatever the only option is. An explicit ""
// means the player has deliberately taken everything off.
function pickWornArmor(options, stored) {
  if (stored === "") return null;
  if (stored != null) {
    const match = options.find((o) => o.id === stored);
    if (match) return match;
  }
  return options.find((o) => o.id === "ledger") || options[0] || null;
}

function armorSoakBonus(wornArmor) {
  return wornArmor?.soakBonus || 0;
}

// Same Ranged/Melee expansion getDefense() uses for the ledger baseline,
// generalized to whichever armor is currently worn (baseline or gear).
function armorDefense(wornArmor) {
  if (!wornArmor) return { ranged: 0, melee: 0 };
  const ranged = wornArmor.rangedDefense ?? wornArmor.defenseBonus ?? 0;
  const melee = wornArmor.meleeDefense ?? wornArmor.defenseBonus ?? 0;
  return { ranged, melee };
}

// ---------------------------------------------------------------------------
// Critical Injury reference — Table 6-10: Critical Injury Result from the
// Edge of the Empire core rulebook. Ledger entries are free text (e.g.
// "30 - Discouraging Wound" or a GM-authored one-off like "Grazed — minor
// bleeding"), so lookupCriticalInjury() tries to match a leading d100 number
// against the table's ranges first, then falls back to matching the injury's
// name against the table by substring. GM-authored injuries with no d100
// number and no matching name just won't expand — that's expected, not a
// bug, since they were never meant to be table results in the first place.
// ---------------------------------------------------------------------------
const CRITICAL_INJURY_TABLE = [
  { min: 1, max: 5, severity: "Easy (♦)", name: "Minor Nick", effect: "The target suffers 1 strain." },
  { min: 6, max: 10, severity: "Easy (♦)", name: "Slowed Down", effect: "The target can only act during the last allied Initiative slot on his next turn." },
  { min: 11, max: 15, severity: "Easy (♦)", name: "Sudden Jolt", effect: "The target drops whatever is in hand." },
  { min: 16, max: 20, severity: "Easy (♦)", name: "Distracted", effect: "The target cannot perform a free maneuver during his next turn." },
  { min: 21, max: 25, severity: "Easy (♦)", name: "Off-Balance", effect: "Add ▼ (Setback) to his next skill check." },
  { min: 26, max: 30, severity: "Easy (♦)", name: "Discouraging Wound", effect: "Flip one light side Destiny Point to a dark side Destiny Point (reverse if NPC)." },
  { min: 31, max: 35, severity: "Easy (♦)", name: "Stunned", effect: "The target is staggered until the end of his next turn." },
  { min: 36, max: 40, severity: "Easy (♦)", name: "Stinger", effect: "Increase difficulty of next check by one." },
  { min: 41, max: 45, severity: "Average (♦♦)", name: "Bowled Over", effect: "The target is knocked prone and suffers 1 strain." },
  { min: 46, max: 50, severity: "Average (♦♦)", name: "Head Ringer", effect: "The target increases the difficulty of all Intellect and Cunning checks by one until the end of the encounter." },
  { min: 51, max: 55, severity: "Average (♦♦)", name: "Fearsome Wound", effect: "The target increases the difficulty of all Presence and Willpower checks by one until the end of the encounter." },
  { min: 56, max: 60, severity: "Average (♦♦)", name: "Agonizing Wound", effect: "The target increases the difficulty of all Brawn and Agility checks by one until the end of the encounter." },
  { min: 61, max: 65, severity: "Average (♦♦)", name: "Slightly Dazed", effect: "The target is disoriented until the end of the encounter." },
  { min: 66, max: 70, severity: "Average (♦♦)", name: "Scattered Senses", effect: "The target removes all ▲ (Boost) from skill checks until the end of the encounter." },
  { min: 71, max: 75, severity: "Average (♦♦)", name: "Hamstrung", effect: "The target loses his free maneuver until the end of the encounter." },
  { min: 76, max: 80, severity: "Average (♦♦)", name: "Overpowered", effect: "The target leaves himself open, and the attacker may immediately attempt another free attack against him, using the exact same pool as the original attack." },
  { min: 81, max: 85, severity: "Average (♦♦)", name: "Winded", effect: "Until the end of the encounter, the target cannot voluntarily suffer strain to activate any abilities or gain additional maneuvers." },
  { min: 86, max: 90, severity: "Average (♦♦)", name: "Compromised", effect: "Increase difficulty of all skill checks by one until the end of the encounter." },
  { min: 91, max: 95, severity: "Hard (♦♦♦)", name: "At the Brink", effect: "The target suffers 1 strain each time he performs an action." },
  { min: 96, max: 100, severity: "Hard (♦♦♦)", name: "Crippled", effect: "One of the target's limbs (selected by the GM) is crippled until healed or replaced. Increase difficulty of all checks that require use of that limb by one." },
  { min: 101, max: 105, severity: "Hard (♦♦♦)", name: "Maimed", effect: "One of the target's limbs (selected by the GM) is permanently lost. Unless the target has a cybernetic replacement, the target cannot perform actions that would require the use of that limb. All other actions gain ▲ (Boost)." },
  { min: 106, max: 110, severity: "Hard (♦♦♦)", name: "Horrific Injury", effect: "Randomly roll 1d10 to determine one of the target's characteristics — 1-3 Brawn, 4-6 Agility, 7 Intellect, 8 Cunning, 9 Presence, 10 Willpower. Until this Critical Injury is healed, treat that characteristic as one point lower." },
  { min: 111, max: 115, severity: "Hard (♦♦♦)", name: "Temporarily Lame", effect: "Until this Critical Injury is healed, the target cannot perform more than one maneuver during his turn." },
  { min: 116, max: 120, severity: "Hard (♦♦♦)", name: "Blinded", effect: "The target can no longer see. Upgrade the difficulty of all checks twice. Upgrade the difficulty of Perception and Vigilance checks three times." },
  { min: 121, max: 125, severity: "Hard (♦♦♦)", name: "Knocked Senseless", effect: "The target is staggered for the remainder of the encounter." },
  { min: 126, max: 130, severity: "Daunting (♦♦♦♦)", name: "Gruesome Injury", effect: "Randomly roll 1d10 to determine one of the target's characteristics — 1-3 Brawn, 4-6 Agility, 7 Intellect, 8 Cunning, 9 Presence, 10 Willpower. That characteristic is permanently reduced by one, to a minimum of one." },
  { min: 131, max: 140, severity: "Daunting (♦♦♦♦)", name: "Bleeding Out", effect: "Every round, the target suffers 1 wound and 1 strain at the beginning of his turn. For every five wounds he suffers beyond his wound threshold, he suffers one additional Critical Injury — roll on this chart (if this result comes up again this way, roll again)." },
  { min: 141, max: 150, severity: "Daunting (♦♦♦♦)", name: "The End is Nigh", effect: "The target will die after the last Initiative slot during the next round." },
  { min: 151, max: 9999, severity: "Dead", name: "Dead", effect: "Complete, obliterated death." },
];

// Vehicle Critical Hit reference — Table 7-9: Critical Hit Result. Widely
// republished in fan cheat-sheets (e.g. thealexandrian.net's SWRPG system
// cheat sheet), so text below is a condensed paraphrase drawn from that
// public compilation rather than a scan of the rulebook itself. Same
// min/max/severity/name/effect shape as CRITICAL_INJURY_TABLE above so both
// tables can share the same lookup/render code.
const CRITICAL_HIT_TABLE = [
  { min: 1, max: 9, severity: "Easy (♦)", name: "Mechanical Stress", effect: "The ship suffers 1 system strain." },
  { min: 10, max: 18, severity: "Easy (♦)", name: "Jostled", effect: "A small explosion or impact rocks the ship. Crew suffer 1 strain and are disoriented for 1 round." },
  { min: 19, max: 27, severity: "Easy (♦)", name: "Losing Power to Shields", effect: "The ship suffers -1 defense in one defense zone (GM's choice) until repaired. If the ship has no defense rating, it suffers 1 strain instead." },
  { min: 28, max: 36, severity: "Easy (♦)", name: "Knocked Off Course", effect: "On its next turn, the ship cannot execute any maneuvers, and the pilot must succeed at a Piloting check (difficulty equal to the ship's speed) to regain control." },
  { min: 37, max: 45, severity: "Easy (♦)", name: "Tailspin", effect: "All attacks made from the ship suffer ▼▼ (two Setback), and all crew are immobilized until the end of the pilot's next turn." },
  { min: 46, max: 54, severity: "Easy (♦)", name: "Component Hit", effect: "One component of the GM's choice is rendered inoperable until the end of the next round." },
  { min: 55, max: 63, severity: "Average (♦♦)", name: "Shields Failing", effect: "The ship suffers -1 defense in all zones until repaired. If the ship has no defense rating, it suffers 2 strain instead." },
  { min: 64, max: 72, severity: "Average (♦♦)", name: "Navicomputer Failure", effect: "The ship's navicomputer (or astromech unit) fails until repaired. If the ship has no hyperdrive, its navigation systems fail instead, and the pilot is effectively flying blind." },
  { min: 73, max: 81, severity: "Average (♦♦)", name: "Power Fluctuations", effect: "The pilot cannot voluntarily suffer system strain to activate abilities or gain additional maneuvers until this is repaired." },
  { min: 82, max: 90, severity: "Hard (♦♦♦)", name: "Shields Down", effect: "Defense in the affected zone drops to 0, and the ship suffers -1 defense in all other zones until repaired. If the ship has no defense rating, it suffers 4 system strain instead." },
  { min: 91, max: 99, severity: "Hard (♦♦♦)", name: "Engine Damaged", effect: "The ship's speed is reduced by 1 (to a minimum of 1) until repaired." },
  { min: 100, max: 108, severity: "Hard (♦♦♦)", name: "Shield Overload", effect: "The ship suffers 2 strain, and its defense drops to 0 in all zones; this cannot be repaired until the end of the encounter. If the ship has no defense rating, it loses 1 point of armor instead." },
  { min: 109, max: 117, severity: "Hard (♦♦♦)", name: "Engines Down", effect: "The ship's speed drops to 0 and it cannot perform maneuvers until repaired, though it continues coasting on its present course." },
  { min: 118, max: 126, severity: "Hard (♦♦♦)", name: "Major System Failure", effect: "One component of the GM's choice is rendered inoperable until repaired." },
  { min: 127, max: 133, severity: "Daunting (♦♦♦♦)", name: "Major Hull Breach", effect: "The ship begins to depressurize. On a small ship the crew has only a few rounds before exposure to vacuum; a larger ship may only partially depressurize, at the GM's discretion." },
  { min: 134, max: 138, severity: "Daunting (♦♦♦♦)", name: "Destabilized", effect: "The ship's Hull Trauma Threshold and System Strain Threshold are both reduced to half their normal values until repaired." },
  { min: 139, max: 144, severity: "Daunting (♦♦♦♦)", name: "Fire!", effect: "The ship suffers 2 strain and a fire breaks out; crew caught in it take damage. Putting it out takes one round per 2 points of the ship's silhouette, requiring Cool and Vigilance checks." },
  { min: 145, max: 153, severity: "Daunting (♦♦♦♦)", name: "Breaking Up", effect: "The ship is coming apart and will be completely destroyed at the end of the next round." },
  { min: 154, max: 9999, severity: "Destroyed", name: "Vaporized", effect: "The ship is destroyed in a spectacular fireball. Nothing aboard survives." },
];

function lookupCriticalHitByRoll(n) {
  return CRITICAL_HIT_TABLE.find((r) => n >= r.min && n <= r.max) || null;
}

function lookupCriticalInjury(text) {
  if (!text) return null;
  const numMatch = /^\s*(\d{1,4})\s*[-–—:]/.exec(text);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    const byNumber = CRITICAL_INJURY_TABLE.find((r) => n >= r.min && n <= r.max);
    if (byNumber) return byNumber;
  }
  const lower = text.toLowerCase();
  return CRITICAL_INJURY_TABLE.find((r) => lower.includes(r.name.toLowerCase())) || null;
}

// Weapon-quality glossary. Matched by substring against the ledger's free-text
// `special` field, exactly the way lookupCriticalInjury() matches Table 6-10.
// No match = no tooltip, so GM prose ("Tends to run out of charge") renders as a
// plain chip instead of a wrong rule. Adding a quality is one line.
const QUALITY_GLOSSARY = [
  ["stun setting", "Stun Setting", "The weapon can be switched to stun as an incidental. While set to stun, hits deal strain instead of wounds."],
  ["stun damage", "Stun Damage", "This weapon only ever deals strain, never wounds."],
  ["stun", "Stun N", "On activation, the target suffers N strain."],
  ["pierce", "Pierce N", "Ignores N points of the target's soak."],
  ["vicious", "Vicious N", "Add 10 x N to any Critical Injury roll this weapon causes."],
  // Inaccurate before Accurate: lookupQuality matches by substring, and
  // "inaccurate" contains "accurate".
  ["inaccurate", "Inaccurate N", "Add N Setback dice to combat checks with this weapon."],
  ["accurate", "Accurate N", "Add N Boost dice to combat checks with this weapon."],
  ["auto-fire", "Auto-fire", "Adds 1 Difficulty to the check. May then spend 2 Advantage to score an additional hit, repeatedly."],
  ["blast", "Blast N", "On activation, everything engaged with the target takes N damage."],
  ["breach", "Breach N", "Ignores 10 x N soak and any planetary-scale armour."],
  ["burn", "Burn N", "The target catches fire and takes the weapon's damage each round for N rounds."],
  ["concussive", "Concussive N", "The target is staggered for N rounds - no actions."],
  ["cumbersome", "Cumbersome N", "Brawn below N adds that many Setback dice to the check."],
  ["defensive", "Defensive N", "Grants +N melee defence while wielded."],
  ["deflection", "Deflection N", "Grants +N ranged defence while wielded."],
  ["disorient", "Disorient N", "The target is disoriented for N rounds - Setback on all checks."],
  ["ensnare", "Ensnare N", "The target is immobilised for N rounds."],
  ["knockdown", "Knockdown", "On activation, the target is knocked prone."],
  ["limited ammo", "Limited Ammo N", "May only be fired N times per encounter before reloading."],
  ["linked", "Linked N", "May spend Advantage to score up to N additional hits."],
  ["prepare", "Prepare N", "Requires N maneuvers to ready before it can be fired."],
  ["slow-firing", "Slow-Firing N", "Cannot be fired again for N rounds after use."],
  ["sunder", "Sunder", "On activation, damage or destroy a piece of the target's gear."],
  ["superior", "Superior", "Adds an automatic Advantage to every check made with it."],
  ["unwieldy", "Unwieldy N", "Agility below N adds that many Setback dice to the check."],
  ["cortosis", "Cortosis", "Weapon: immune to Sunder. Armor: immune to Pierce and Breach."],
  ["inferior", "Inferior", "Adds an automatic Threat to every check made with it. Weapons deal 1 less damage; armor loses 1 defence (or 1 soak if it has no defence)."],
  ["guided", "Guided N", "If the attack misses, spend 3 Advantage to make a guided attack at the end of the round with N Ability dice."],
  ["tractor", "Tractor N", "The target can't move unless it passes a Piloting check with difficulty N."],
  ["ion", "Ion", "Damage is dealt as system strain instead of wounds or hull trauma."],
];

// Options for the GM page's quality pickers. A label ending in " N" takes a
// rating (Pierce 2), the rest are on/off (Superior).
const QUALITY_OPTIONS = QUALITY_GLOSSARY
  .map(([, title, body]) => ({ title, base: title.replace(/ N$/, ""), rated: / N$/.test(title), body }))
  .sort((a, b) => a.base.localeCompare(b.base));

// Pick one or more item qualities from a dropdown (with a rating where the
// quality has one). `value` is an array like ["Pierce 2", "Superior"].
function QualityPicker({ value, onChange }) {
  const [choice, setChoice] = useState("");
  const [rating, setRating] = useState("1");
  const option = QUALITY_OPTIONS.find((o) => o.title === choice);
  function add() {
    if (!option) return;
    const n = Math.max(1, Math.min(20, Number(rating) || 1));
    const text = option.rated ? `${option.base} ${n}` : option.base;
    // One entry per quality: picking it again replaces the old rating.
    onChange([...value.filter((q) => !q.toLowerCase().startsWith(option.base.toLowerCase())), text]);
    setChoice("");
    setRating("1");
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <select
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        className="bg-transparent border px-1.5 py-1 text-[11px]"
        style={{ borderColor: "#3a3f42", color: choice ? "#e7e2d2" : "#8a8f93", background: "#101315" }}
        title={option ? option.body : "Add an item quality"}
      >
        <option value="">+ Quality…</option>
        {QUALITY_OPTIONS.map((o) => <option key={o.title} value={o.title}>{o.base}{o.rated ? " (N)" : ""}</option>)}
      </select>
      {option?.rated && (
        <input type="number" min={1} max={20} value={rating} onChange={(e) => setRating(e.target.value)} className="w-12 bg-transparent border px-1.5 py-1 text-[11px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} title="Rating" />
      )}
      {option && (
        <button type="button" onClick={add} className="text-[10px] uppercase px-1.5 py-1 border" style={{ borderColor: "#5ec8d866", color: "#5ec8d8" }}>Add</button>
      )}
      {value.map((q) => (
        <span key={q} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 border" style={{ borderColor: "#c9a15a66", color: "#c9a15a" }}>
          {q}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== q))} title={`Remove ${q}`} style={{ color: "#8a8f93" }}>✕</button>
        </span>
      ))}
    </span>
  );
}

function lookupQuality(text) {
  const lower = (text || "").toLowerCase();
  const hit = QUALITY_GLOSSARY.find(([key]) => lower.includes(key));
  return hit ? { title: hit[1], body: hit[2] } : null;
}

const STAT_TIPS = {
  dmg: ["Damage", "Base damage before soak. Each uncancelled Success adds 1 more. For a melee/Brawl weapon this already has the wielder's Brawn added in."],
  crit: ["Critical Rating", "Advantage needed to trigger a Critical Injury once the attack hits."],
  pool: ["Dice Pool", "The pool this weapon's skill rolls right now - yellow Proficiency, green Ability, plus any talent Boost. Click the card to load it."],
  range: ["Range Band", "How far the weapon reaches. Firing beyond its band isn't possible; shorter bands may change difficulty."],
  soak: ["Soak", "Subtracted from every hit before wounds are applied. A weapon that deals 7 damage against 2 Soak only does 5 wounds."],
  defense: ["Defense", "Adds Setback dice to attacks made against this character - Ranged Defense to ranged attacks, Melee Defense to melee attacks. Makes the character harder to hit, not harder to hurt once hit."],
};

// Turns a raw Table 6-10 roll result (a plain number, as recorded in the
// shared /manual store — see applyLiveOverlay) into the same "NN - Name" text
// format the static ledger.json entries already use, so both render through
// the same CriticalInjuryTile.
function criticalInjuryTextFromNumber(n) {
  const match = CRITICAL_INJURY_TABLE.find((r) => n >= r.min && n <= r.max);
  return match ? `${n} - ${match.name}` : `Critical Injury ${n}`;
}

// Selectable tile for one Critical Injury — click to expand the full
// Table 6-10 effect text (if the injury matches a known table result).
// GM-authored injuries with no match just show their recorded text with no
// expandable detail.
function CriticalInjuryTile({ text }) {
  const [expanded, setExpanded] = useState(false);
  const match = lookupCriticalInjury(text);
  return (
    <div
      onClick={() => setExpanded((e) => !e)}
      className="cursor-pointer border px-3 py-2 transition-colors"
      style={{ borderColor: "#c23b3b44", background: expanded ? "#c23b3b1a" : "#c23b3b0d" }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] flex items-center gap-1.5" style={{ color: "#e7e2d2" }}>
          ▸ {text}
        </span>
        <span className="flex items-center gap-2 flex-shrink-0">
          {match && (
            <span className="text-[10px] tracking-[0.15em] uppercase px-1.5 py-0.5" style={{ color: "#c23b3b", border: "1px solid #c23b3b66" }}>
              {match.severity}
            </span>
          )}
          <span className="text-[11px]" style={{ color: "#5a5f62" }}>{expanded ? "▲" : "▼"}</span>
        </span>
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t text-[12px] leading-relaxed" style={{ borderColor: "#c23b3b33", color: "#8a8f93" }}>
          {match ? match.effect : "No matching Table 6-10 entry found for this injury — check the GM's notes for its effect."}
        </div>
      )}
    </div>
  );
}

// A player-editable "Description" field (size, colour, appearance etc) shown
// under the character's class/species on their sheet. Backed by the shared
// /bio Durable Object (see BioLog in worker/index.js) — an upsert-by-
// characterId store, not an append log, so this is always "the current
// description" for that character, visible to everyone with the dashboard
// URL. Entirely separate from ledger.json and the /manual store: nothing here is
// authoritative except this field itself, and the GM never has to copy it
// anywhere for it to show up.
//
// Fetches the saved value once when the character changes rather than
// polling continuously — this is occasional flavour text, not combat state,
// and continuous polling would risk clobbering an in-progress edit. Saves
// itself automatically a short beat after typing stops (see
// LIVE_NOTE_DEBOUNCE_MS) rather than waiting on a Save button — same
// debounced-write idiom as useGearStore/useManualStore elsewhere in this
// file, just for a single text value instead of a whole store.
// Shared live text field backing the Character tab's Description field and
// the "dumb" mid-play note fields under Weapons/Armor/Inventory — same
// component, different `field` key into the /bio Durable Object (see BioLog
// in worker/index.js). "Dumb" means exactly that: no parsing, no mechanical
// effect, just a shared scratchpad players can jot notes into mid-session
// (e.g. "picked up a second holdout blaster") without waiting on the GM.
//
// Auto-grows to fit whatever's already typed/loaded (up to a generous cap,
// beyond which it scrolls) rather than defaulting to a fixed few rows, so a
// character with a long-since-written Description isn't hidden behind a
// scrollbar the moment the tab opens. `resize: vertical` is still set, so a
// player can drag it shorter by hand — typing further will grow it again,
// same as any auto-growing textarea.
const LIVE_NOTE_DEBOUNCE_MS = 600;

function LiveNoteField({ characterId, field, label, placeholder, helper, maxLength = 500 }) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState({ state: "idle" });
  const textareaRef = useRef(null);
  const saveTimer = useRef(null);
  const lastSavedRef = useRef(""); // guards flush() against re-sending a value that's already saved
  const pendingRef = useRef(null); // latest unsaved draft, so unmounting mid-debounce can still flush it

  const flush = useCallback(async (value) => {
    if (value === lastSavedRef.current) return;
    setStatus({ state: "saving" });
    try {
      const res = await apiFetch("/bio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId, field, text: value.trim().slice(0, maxLength) }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const saved = data?.text ?? value.trim();
      lastSavedRef.current = saved;
      pendingRef.current = null;
      setText(saved);
      setStatus({ state: "saved" });
      setTimeout(() => setStatus((s) => (s.state === "saved" ? { state: "idle" } : s)), COPY_CONFIRM_MS);
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }, [characterId, field, maxLength]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setStatus({ state: "idle" });
    async function load() {
      try {
        const res = await apiFetch(`/bio?_=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const saved = (characterId && data?.bios?.[characterId]?.[field]) || "";
        setText(saved);
        setDraft(saved);
        lastSavedRef.current = saved;
      } catch {
        // Best-effort — leave the field editable and blank rather than
        // blocking the sheet if the Worker/Durable Object isn't reachable.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    if (characterId) load();
    else setLoaded(true);
    return () => {
      cancelled = true;
      // Switching character/field (or navigating away) shouldn't drop the
      // last few keystrokes just because the debounce timer hadn't fired
      // yet — flush whatever's pending against the field this effect was
      // actually watching before it tears down.
      clearTimeout(saveTimer.current);
      if (pendingRef.current !== null) flush(pendingRef.current);
    };
  }, [characterId, field, flush]);

  // Same last-chance flush for a tab/browser close mid-debounce.
  useEffect(() => {
    function onHide() {
      if (pendingRef.current !== null) flush(pendingRef.current);
    }
    window.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, [flush]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft, loaded]);

  function handleChange(e) {
    const value = e.target.value;
    setDraft(value);
    pendingRef.current = value;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flush(value), LIVE_NOTE_DEBOUNCE_MS);
  }

  if (!characterId) return null;

  return (
    <div>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#8a8f93" }}>{label}</div>
      {helper && <p className="text-[11px] leading-relaxed mb-2" style={{ color: "#5a5f62" }}>{helper}</p>}
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={handleChange}
        placeholder={placeholder}
        rows={2}
        maxLength={maxLength}
        disabled={!loaded}
        className="w-full bg-transparent border px-2 py-1.5 text-[13px] mb-2 disabled:opacity-50"
        style={{
          borderColor: "#3a3f42", color: "#e7e2d2", fontFamily: "'JetBrains Mono', monospace",
          resize: "vertical", minHeight: 44, maxHeight: 320, overflowY: "auto",
        }}
      />
      <div className="flex items-center gap-3 flex-wrap">
        {status.state === "saving" && <span className="text-[11px]" style={{ color: "#5a5f62" }}>Saving…</span>}
        {status.state === "saved" && <span className="text-[12px]" style={{ color: "#6fae60" }}>Saved ✔</span>}
        {status.state === "error" && <span className="text-[12px]" style={{ color: "#c23b3b" }}>Failed to save: {status.msg} — will retry automatically</span>}
        <span className="text-[10px] ml-auto" style={{ color: draft.length >= maxLength ? "#c23b3b" : "#5a5f62" }}>
          {draft.length}/{maxLength}
        </span>
      </div>
    </div>
  );
}

// Player-editable credit balance on the Character tab. Stored in the same
// /bio Durable Object as Description (field "credits") as
// {"value": n, "base": ledgerCredits}, where base is the ledger.json figure
// at the time of the edit. While ledger.json still says `base`, the live
// value is shown. Once the ledger's credits change (the GM has folded the
// balance into the ledger, or set a new one), the ledger figure takes over
// again, so a consolidation never gets overridden by an old live edit.
// Accepts a plain number, or "+250" / "-100" to adjust the current balance.
const CREDITS_POLL_MS = 10000;
const CREDITS_MAX = 99999999;

function parseLiveCredits(raw) {
  try {
    const v = JSON.parse(raw);
    if (v && Number.isFinite(v.value) && Number.isFinite(v.base)) return v;
  } catch { /* not set or not valid */ }
  return null;
}

function LiveCreditsField({ characterId, ledgerCredits }) {
  const ledger = Number(ledgerCredits) || 0;
  const [live, setLive] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState({ state: "idle" });
  const editingRef = useRef(false);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/bio?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (editingRef.current) return;
      setLive(parseLiveCredits(data?.bios?.[characterId]?.credits));
    } catch { /* keep last known value */ }
  }, [characterId]);

  useEffect(() => {
    setLive(null);
    setEditing(false);
    if (!characterId) return undefined;
    load();
    const timer = setInterval(load, CREDITS_POLL_MS);
    return () => clearInterval(timer);
  }, [characterId, load]);

  const current = live && live.base === ledger ? live.value : ledger;

  function startEdit() {
    editingRef.current = true;
    setDraft(String(current));
    setStatus({ state: "idle" });
    setEditing(true);
  }

  async function commit() {
    // Enter and the blur that follows it would otherwise both save.
    if (!editingRef.current) return;
    editingRef.current = false;
    const text = draft.replace(/[,\s]/g, "");
    let next;
    if (/^[+-]\d+$/.test(text)) next = current + Number(text);
    else if (/^\d+$/.test(text)) next = Number(text);
    else { editingRef.current = true; setStatus({ state: "error", msg: "Enter a number, or +n / -n" }); return; }
    next = Math.max(0, Math.min(CREDITS_MAX, next));
    setEditing(false);
    if (next === current) return;
    const value = { value: next, base: ledger };
    setLive(value);
    setStatus({ state: "saving" });
    try {
      const res = await apiFetch("/bio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId, field: "credits", text: JSON.stringify(value) }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setStatus({ state: "saved" });
      setTimeout(() => setStatus((s) => (s.state === "saved" ? { state: "idle" } : s)), COPY_CONFIRM_MS);
    } catch (err) {
      setStatus({ state: "error", msg: `Failed to save: ${err.message}` });
    }
  }

  if (editing) {
    return (
      <div>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { editingRef.current = false; setEditing(false); }
          }}
          onBlur={commit}
          inputMode="numeric"
          className="w-full bg-transparent border px-2 py-0.5 text-xl mono-num"
          style={{ borderColor: "#ffb00088", color: "#ffb000" }}
        />
        <div className="text-[10px] mt-1" style={{ color: "#5a5f62" }}>New total, or +250 / -100. Enter to save, Esc to cancel.</div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={startEdit}
        title="Click to change credits"
        className="text-xl mono-num border-b border-dashed"
        style={{ color: "#ffb000", borderColor: "#ffb00055", background: "transparent" }}
      >
        {current.toLocaleString()}
      </button>
      {status.state === "saving" && <span className="text-[11px] ml-2" style={{ color: "#5a5f62" }}>Saving…</span>}
      {status.state === "saved" && <span className="text-[11px] ml-2" style={{ color: "#6fae60" }}>Saved ✔</span>}
      {status.state === "error" && <div className="text-[11px] mt-1" style={{ color: "#c23b3b" }}>{status.msg}</div>}
    </div>
  );
}

// Species strings in the ledger read like "Duros (adds a Boost die to
// Astrogation checks)" or "Trandoshan (Claws — ...; Regeneration — ...)" —
// one field doing two jobs. Split the race name from its parenthesized
// racial advantage text so the advantage can render on its own line below
// the race, rather than crammed into the same line.
function splitSpeciesText(species) {
  const s = (species || "").trim();
  if (!s) return { race: "", advantage: "" };
  const match = s.match(/^(.*?)\s*\(([\s\S]*)\)\s*$/);
  if (!match) return { race: s, advantage: "" };
  return { race: match[1].trim(), advantage: match[2].trim() };
}

function CharacterDescriptionField({ characterId, species }) {
  if (!characterId) return null;
  // The race name itself now sits in the header line next to the portrait
  // (see the PERSONNEL FILE block) — only the racial-advantage text, if any,
  // still needs room here.
  const { advantage } = splitSpeciesText(species);
  return (
    <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
      {advantage && (
        <div className="text-[12px] mb-3" style={{ color: "#8a8f93" }}>
          <span className="text-[10px] tracking-[0.15em] uppercase mr-1.5" style={{ color: "#5a5f62" }}>Species Trait</span>
          {advantage}
        </div>
      )}
      <LiveNoteField
        characterId={characterId}
        field="description"
        label="Description"
        placeholder="Size, colour, appearance etc"
        maxLength={500}
      />
    </div>
  );
}

// A short free-text note from a player to the GM (e.g. desired XP spend),
// posted to the shared /notes Durable Object (same pattern as the dice
// roller's /rolls log — see NotesLog in worker/index.js). Purely additive:
// never touches wounds/strain/destiny/XP itself, just puts a message in the
// GM's inbox for them to action manually.
function GMNoteBox({ characterName }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState({ state: "idle" });

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setStatus({ state: "sending" });
    try {
      const res = await apiFetch("/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ player: characterName || "Unknown", text: trimmed }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setText("");
      setStatus({ state: "sent" });
      setTimeout(() => setStatus({ state: "idle" }), COPY_CONFIRM_MS);
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }

  return (
    <div className="mt-5 pt-5 border-t" style={{ borderColor: "#2a2e31" }}>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>Note to GM</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Note from ${characterName || "your character"}...`}
        rows={3}
        maxLength={500}
        className="w-full bg-transparent border px-2 py-1.5 text-[13px]"
        style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
      />
      <div className="flex items-center gap-3 mt-2">
        <button
          onClick={handleSend}
          disabled={!text.trim() || status.state === "sending"}
          className="text-[11px] tracking-wide uppercase px-3 py-1.5 disabled:opacity-40"
          style={{ background: "#e0763a", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
        >
          {status.state === "sending" ? "Sending…" : "Send to GM"}
        </button>
        {status.state === "sent" && <span className="text-[12px]" style={{ color: "#6fae60" }}>Sent ✔</span>}
        {status.state === "error" && <span className="text-[12px]" style={{ color: "#c23b3b" }}>Failed to send: {status.msg}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// XP / Advancement Planner — an OPTIONAL, self-contained planning tool.
// Never modifies ledger.json or any shared/live state — it just
// seeds from the character's current skills/talents/available XP, lets the
// player click through planned skill-rank and talent-tier purchases, tallies
// the XP cost, and produces a plain-text summary the player can copy or send
// to the GM's existing /notes inbox (same Durable Object GMNoteBox posts to,
// above). The GM still applies anything approved into the ledger by hand,
// exactly like every other advancement — this never writes XP anywhere.
//
// Cost rules (Star Wars FFG core, plus this campaign's Genesys Talents
// Expanded v5.0 simplification):
//   - Skill rank: new rank x 5 XP, +5 XP more if the skill isn't a career
//     skill.
//   - Talent: tier x 5 XP, flat — regardless of which specialization the
//     talent nominally belongs to, and regardless of how many ranks of that
//     named talent are already owned. That's this campaign's house rule
//     ("tier and XP cost are fixed per talent regardless of source
//     specialization tree"), which is exactly what makes a "pick a tier, not
//     a name" planner line up with how this table actually prices talents.
//
// Pyramid legality mirrors the convention already used by hand in the
// ledger's own "Talent Pyramid" tables: every tier that has at least one
// talent must have STRICTLY FEWER talents than the tier below it (4/3/2/0/0
// and 4/2/0/0/0 are the two pyramids already recorded as Legal — both
// strictly decreasing; a tie, e.g. 4/4/2/0/0, is not a valid pyramid). An
// empty tier (0) never triggers the check on its own — two adjacent zero
// tiers are fine, it's only a *populated* tier tying or exceeding the tier
// below it that's illegal. Flag anything this calls illegal to the GM
// before relying on it for an edge case.
// ---------------------------------------------------------------------------
function skillRankCost(newRank, career) {
  return newRank * 5 + (career ? 0 : 5);
}
function talentTierCost(tier) {
  return tier * 5;
}
function pyramidLegal(counts) {
  for (let t = 2; t <= 5; t++) {
    if (counts[t] > 0 && counts[t] >= counts[t - 1]) return false;
  }
  return true;
}


function useTalentLibrary() {
  const [talentIndex, setTalentIndex] = useState(null);
  const [talentLoadState, setTalentLoadState] = useState({ state: "idle" });
  const loadTalents = useCallback(() => {
    if (talentIndex || talentLoadState.state === "loading") return;
    setTalentLoadState({ state: "loading" });
    apiFetch("/data/talents.json")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        setTalentIndex(Array.isArray(data) ? data : Array.isArray(data?.talents) ? data.talents : []);
        setTalentLoadState({ state: "ok" });
      })
      .catch((err) => setTalentLoadState({ state: "error", msg: err.message }));
  }, [talentIndex, talentLoadState.state]);
  return { talentIndex, talentLoadState, loadTalents };
}

function TalentTierSearch({ tier, value, onSelect, library, forceSensitive = false }) {
  const [query, setQuery] = useState(value?.name || "");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    if (!library.talentIndex || !query.trim()) return [];
    return library.talentIndex
      .filter((talent) => Number(talent.tier) === tier)
      .filter((talent) => forceSensitive || talent.force !== "Yes")
      .map((talent) => ({ talent, score: fuzzyMatch(query, talent.name) }))
      .filter((item) => item.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((item) => item.talent);
  }, [library.talentIndex, query, tier, forceSensitive]);

  return (
    <div className="relative border p-3" style={{ borderColor: value ? "#6fae6066" : "#ffb00066", background: "#101315" }}>
      <div className="text-[10px] uppercase tracking-[0.15em] mb-1.5" style={{ color: "#8fd3f4" }}>Tier {tier} talent</div>
      <input
        value={query}
        onFocus={() => { library.loadTalents(); setOpen(true); }}
        onChange={(e) => { setQuery(e.target.value); onSelect(null); setOpen(true); }}
        placeholder={library.talentLoadState.state === "loading" ? `Loading Tier ${tier} talents…` : `Search Tier ${tier} talents…`}
        className="w-full bg-transparent border px-2.5 py-2 text-[12px]"
        style={{ borderColor: value ? "#6fae60" : "#3a3f42", color: "#e7e2d2" }}
      />
      {value && (
        <div className="mt-2 text-[11px] leading-relaxed" style={{ color: "#c7c2b2" }}>
          <span style={{ color: "#6fae60", fontWeight: 700 }}>Selected: {value.name}</span>
          {value.activation && <span style={{ color: "#8a8f93" }}> · {value.activation}</span>}
          {value.text_swrpg && <div className="mt-1"><TalentRulesText text={value.text_swrpg} size={13} /></div>}
        </div>
      )}
      {library.talentLoadState.state === "error" && <div className="text-[11px] mt-1" style={{ color: "#c23b3b" }}>Talent library could not load.</div>}
      {open && query.trim() && results.length > 0 && (
        <div className="absolute z-30 left-3 right-3 mt-1 max-h-80 overflow-y-auto" style={{ background: "#101315", border: "1px solid #3a3f42" }}>
          {results.map((talent, i) => (
            <button
              key={`${talent.name}-${talent.source || i}`}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onSelect(talent); setQuery(talent.name); setOpen(false); }}
              className="w-full text-left px-3 py-2 border-b"
              style={{ borderColor: "#2a2e31", color: "#e7e2d2" }}
            >
              <div className="text-[12px]" style={{ fontWeight: 700 }}>{talent.name}</div>
              <div className="text-[10px] mt-0.5" style={{ color: "#8a8f93" }}>{talent.activation}{talent.ranked ? ` · Ranked: ${talent.ranked}` : ""}</div>
              {talent.text_swrpg && <div className="text-[11px] leading-snug mt-1" style={{ color: "#c7c2b2" }}><TalentRulesText text={talent.text_swrpg} size={13} /></div>}
            </button>
          ))}
        </div>
      )}
      {open && query.trim() && library.talentIndex && results.length === 0 && (
        <div className="text-[11px] mt-1" style={{ color: "#5a5f62" }}>No matching Tier {tier} talent.</div>
      )}
    </div>
  );
}

function AdvancementPlanner({ character, skills, talents, xpAvailable, onBack, forceSensitive = false, onSubmitted }) {
  const characterId = character.liveId || character.name;
  const { requests: allRequests, refresh: refreshRequests } = useAdvanceRequests(true);
  const myRequests = allRequests.filter((r) => r.characterId === characterId).slice(0, 5);
  const myPending = myRequests.find((r) => r.status === "pending");
  const [submitStatus, setSubmitStatus] = useState({ state: "idle" });
  const [plannedSkillRanks, setPlannedSkillRanks] = useState({}); // skill name -> planned rank
  const [plannedTalents, setPlannedTalents] = useState({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }); // tier -> count to add
  const [selectedTalents, setSelectedTalents] = useState({ 1: [], 2: [], 3: [], 4: [], 5: [] });
  const talentLibrary = useTalentLibrary();
  const [copyStatus, setCopyStatus] = useState(false);
  // The message sent/copied is editable free text, not just the computed
  // summary — the planner only knows tiers, not talent names, so players
  // need to be able to type "Toughened" etc. into it before sending. It
  // auto-fills from the computed summary and re-fills any time the plan
  // itself changes (another skill/talent click below), so a fresh click is
  // always the way back to the computed text — no separate sync control to
  // find. Typing in the box doesn't change the plan, so it doesn't trigger
  // a re-fill; only the +/- buttons above do.
  const [message, setMessage] = useState("");

  // Counted in talent ranks (Grit ×2 counts as two Tier 1 talents), the same
  // way the Worker checks the pyramid when a purchase is approved.
  const existingByTier = [1, 2, 3, 4, 5].reduce((acc, t) => {
    acc[t] = talents.filter((tal) => Number(tal.tier) === t).reduce((n, tal) => n + Math.max(1, Number(tal.rank) || 1), 0);
    return acc;
  }, {});

  function getPlannedRank(skill) {
    return plannedSkillRanks[skill.name] ?? skill.rank;
  }

  function bumpSkill(skill, delta) {
    setPlannedSkillRanks((prev) => {
      const current = prev[skill.name] ?? skill.rank;
      const next = Math.max(skill.rank, Math.min(5, current + delta));
      return { ...prev, [skill.name]: next };
    });
  }

  function bumpTalent(tier, delta) {
    setPlannedTalents((prev) => ({ ...prev, [tier]: Math.max(0, (prev[tier] ?? 0) + delta) }));
    setSelectedTalents((prev) => {
      const choices = [...(prev[tier] || [])];
      if (delta > 0) choices.push(null);
      else if (delta < 0) choices.pop();
      return { ...prev, [tier]: choices };
    });
  }

  function selectTalent(tier, index, talent) {
    setSelectedTalents((prev) => {
      const choices = [...(prev[tier] || [])];
      choices[index] = talent;
      return { ...prev, [tier]: choices };
    });
  }

  // One priced line per rank purchased above current — a jump from rank 0 to
  // rank 2 is really two purchases (rank 1, then rank 2), and non-career
  // status applies its +5 surcharge to each one individually, so the total
  // is computed rank-by-rank rather than as a single (target - current)
  // formula.
  const skillLines = skills
    .map((s) => {
      const target = getPlannedRank(s);
      if (target <= s.rank) return null;
      let cost = 0;
      for (let r = s.rank + 1; r <= target; r++) cost += skillRankCost(r, s.career);
      return { name: s.name, from: s.rank, to: target, career: s.career, cost };
    })
    .filter(Boolean);

  const talentLines = [1, 2, 3, 4, 5]
    .filter((t) => plannedTalents[t] > 0)
    .map((t) => ({ tier: t, count: plannedTalents[t], choices: selectedTalents[t] || [], cost: plannedTalents[t] * talentTierCost(t) }));

  const skillTotal = skillLines.reduce((sum, l) => sum + l.cost, 0);
  const talentTotal = talentLines.reduce((sum, l) => sum + l.cost, 0);
  const totalCost = skillTotal + talentTotal;
  const remaining = xpAvailable - totalCost;
  const overBudget = remaining < 0;

  const projectedByTier = [1, 2, 3, 4, 5].reduce((acc, t) => {
    acc[t] = existingByTier[t] + plannedTalents[t];
    return acc;
  }, {});
  const legal = pyramidLegal(projectedByTier);
  const hasChanges = skillLines.length > 0 || talentLines.length > 0;
  const talentSelectionsComplete = talentLines.every((line) => line.choices.length === line.count && line.choices.every(Boolean));

  function reset() {
    setPlannedSkillRanks({});
    setPlannedTalents({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    setSelectedTalents({ 1: [], 2: [], 3: [], 4: [], 5: [] });
  }

  const summaryText = [
    `Advancement plan — ${character.name || "Unknown"}`,
    ...skillLines.map((l) => `${l.name} ${l.from}→${l.to} (${l.career ? "career" : "non-career"}, ${l.cost} XP)`),
    ...talentLines.flatMap((l) => l.choices.map((talent) => `Tier ${l.tier} talent — ${talent?.name || "SELECTION REQUIRED"} (${talentTierCost(l.tier)} XP)`)),
    `Total: ${totalCost} XP spent · ${xpAvailable} available → ${remaining} remaining${overBudget ? " (OVER BUDGET)" : ""}`,
    `Projected pyramid: ${[1, 2, 3, 4, 5].map((t) => `T${t} ${projectedByTier[t]}`).join(" / ")} — ${legal ? "Legal" : "Illegal shape — check with GM"}`,
  ].join("\n");

  // Re-fill the editable message from the computed summary whenever the
  // plan itself changes — summaryText only changes when a skill/talent
  // button above is clicked, not when the player types in the textarea, so
  // this doesn't fight with manual edits made in between clicks.
  useEffect(() => {
    setMessage(hasChanges ? summaryText : "");
  }, [summaryText, hasChanges]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopyStatus(true);
      setTimeout(() => setCopyStatus(false), COPY_CONFIRM_MS);
    } catch {
      // Clipboard unavailable (insecure context, permissions, etc.) — the
      // message is still visible in the textarea below for manual copy.
    }
  }

  // The real purchase: sent to the Worker, which prices it again and holds
  // it for the GM to approve on the GM page.
  async function handleSubmitPurchase() {
    setSubmitStatus({ state: "sending" });
    try {
      const res = await apiFetch("/campaign/advance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          characterId,
          skills: Object.fromEntries(skillLines.map((l) => [l.name, l.to])),
          talents: talentLines.flatMap((l) => l.choices.map((t) => ({ name: t.name, tier: l.tier, ranked: t.ranked, force: t.force, activation: t.activation, text_swrpg: t.text_swrpg }))),
          note: message.split("\n").filter((line) => !line.startsWith("Advancement plan") && !line.startsWith("Total:") && !line.startsWith("Projected pyramid")).join("\n").slice(0, 500),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The Worker said ${res.status}`);
      setSubmitStatus({ state: "sent" });
      reset();
      refreshRequests();
      onSubmitted?.();
    } catch (err) {
      setSubmitStatus({ state: "error", msg: err.message });
    }
  }



  return (
    <div className="relative overflow-hidden border" style={{ borderColor: "#3a3f42", background: "#16191b", boxShadow: "0 0 30px rgba(94,200,216,0.06)" }}>
      <div className="p-5 sm:p-7">
        <div className="flex items-start justify-between mb-1">
          <div>
            <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#5ec8d8" }}>SPEND XP</div>
            <h1 className="text-2xl sm:text-3xl uppercase tracking-wide" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
              🧮 Advancement Planner
            </h1>
            <div className="text-[13px] mt-0.5" style={{ color: "#8a8f93" }}>{character.name || "Unknown"}</div>
          </div>
          <button
            onClick={onBack}
            className="text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border flex-shrink-0"
            style={{ color: "#8a8f93", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}
          >
            ← Character Sheet
          </button>
        </div>
        <p className="text-[12px] leading-relaxed mb-5 pb-5 border-b" style={{ color: "#5a5f62", borderColor: "#2a2e31" }}>
          Click skills and talent tiers to build a purchase and watch the XP tally update live. Nothing changes on your sheet until
          you press <strong style={{ color: "#e7e2d2" }}>Submit for approval</strong> at the bottom and the GM approves it; then the
          XP comes off and the new ranks and talents appear on your sheet.
        </p>

        <div className="grid sm:grid-cols-3 gap-4 mb-6">
          <div className="border p-3 text-center" style={{ borderColor: "#2a2e31" }}>
            <div className="text-[10px] tracking-[0.2em] uppercase mb-1" style={{ color: "#5a5f62" }}>Available XP</div>
            <div className="text-2xl mono-num" style={{ color: "#e7e2d2" }}>{xpAvailable}</div>
          </div>
          <div className="border p-3 text-center" style={{ borderColor: "#2a2e31" }}>
            <div className="text-[10px] tracking-[0.2em] uppercase mb-1" style={{ color: "#5a5f62" }}>Planned Spend</div>
            <div className="text-2xl mono-num" style={{ color: "#ffb000" }}>{totalCost}</div>
          </div>
          <div
            className="border p-3 text-center"
            style={{ borderColor: overBudget ? "#c23b3b" : "#2a2e31", background: overBudget ? "#c23b3b11" : "transparent" }}
          >
            <div className="text-[10px] tracking-[0.2em] uppercase mb-1" style={{ color: "#5a5f62" }}>Remaining</div>
            <div className="text-2xl mono-num" style={{ color: overBudget ? "#c23b3b" : "#6fae60" }}>{remaining}</div>
          </div>
        </div>

        <div className="mb-6 pb-6 border-b" style={{ borderColor: "#2a2e31" }}>
          <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>
            Skills — new rank × 5 XP, +5 XP more if it isn't a career skill
          </div>
          {["General", "Combat", "Knowledge"].map((group) => (
            <div key={group} className="mb-3 last:mb-0">
              <div className="text-[10px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#5a5f62" }}>{group}</div>
              <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
                {skills.filter((s) => s.group === group).map((s) => {
                  const planned = getPlannedRank(s);
                  const nextCost = planned < 5 ? skillRankCost(planned + 1, s.career) : null;
                  return (
                    <div key={s.name} className="flex items-center justify-between gap-2 text-[13px] py-0.5">
                      <span style={{ color: s.career ? "#5ec8d8" : "#e7e2d2" }}>{s.name}</span>
                      <div className="flex items-center gap-3">
                        <SkillPips rank={planned} characteristic={s.characteristic} boost={s.boost} />
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => bumpSkill(s, -1)}
                            disabled={planned <= s.rank}
                            className="w-5 h-5 border text-[12px] disabled:opacity-30"
                            style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
                          >
                            −
                          </button>
                          <span className="mono-num w-12 text-center" style={{ color: planned > s.rank ? "#ffb000" : "#8a8f93" }}>
                            {s.rank}{planned > s.rank ? `→${planned}` : ""}
                          </span>
                          <button
                            onClick={() => bumpSkill(s, 1)}
                            disabled={planned >= 5}
                            title={nextCost != null ? `+${nextCost} XP` : "Already at rank 5"}
                            className="w-5 h-5 border text-[12px] disabled:opacity-30"
                            style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mb-6 pb-6 border-b" style={{ borderColor: "#2a2e31" }}>
          <div className="text-[11px] tracking-[0.2em] uppercase mb-1" style={{ color: "#8a8f93" }}>
            Talents — choose a tier, then select a talent (tier × 5 XP)
          </div>
          <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#5a5f62" }}>
            Add a slot in the correct pyramid tier, then search the talent library inside that slot. Only talents from the purchased tier can be selected.
          </p>
          <div className="grid grid-cols-5 gap-2 mb-3">
            {[1, 2, 3, 4, 5].map((t) => (
              <div key={t} className="border p-2 text-center" style={{ borderColor: "#2a2e31" }}>
                <div className="text-[10px] tracking-[0.15em] uppercase mb-1" style={{ color: "#8fd3f4" }}>Tier {t}</div>
                <div className="text-[10px] mb-1.5" style={{ color: "#5a5f62" }}>{talentTierCost(t)} XP</div>
                <div className="flex items-center justify-center gap-1.5">
                  <button
                    onClick={() => bumpTalent(t, -1)}
                    disabled={plannedTalents[t] <= 0}
                    className="w-5 h-5 border text-[12px] disabled:opacity-30"
                    style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
                  >
                    −
                  </button>
                  <span
                    className="mono-num w-12 text-center"
                    style={{ color: plannedTalents[t] > 0 ? "#ffb000" : "#8a8f93" }}
                  >
                    {existingByTier[t]}{plannedTalents[t] > 0 ? `→${existingByTier[t] + plannedTalents[t]}` : ""}
                  </span>
                  <button
                    onClick={() => bumpTalent(t, 1)}
                    className="w-5 h-5 border text-[12px]"
                    style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="text-[12px] flex items-center gap-2" style={{ color: legal ? "#6fae60" : "#c23b3b" }}>
            {legal ? "✔ Legal pyramid shape" : "✖ Illegal shape — a tier has as many or more talents than the tier below it"}
          </div>
          {talentLines.length > 0 && (
            <div className="grid md:grid-cols-2 gap-3 mt-4">
              {talentLines.flatMap((line) => line.choices.map((choice, index) => (
                <TalentTierSearch key={`${line.tier}-${index}`} tier={line.tier} value={choice} onSelect={(talent) => selectTalent(line.tier, index, talent)} library={talentLibrary} forceSensitive={forceSensitive} />
              )))}
            </div>
          )}
          {!talentSelectionsComplete && <div className="text-[11px] mt-2" style={{ color: "#ffb000" }}>Select a talent for every purchased tier slot before sending the plan.</div>}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#8a8f93" }}>Summary and note for the GM</div>
            {hasChanges && (
              <button onClick={reset} className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "#5a5f62" }}>
                Reset plan
              </button>
            )}
          </div>
          <p className="text-[11px] leading-relaxed mb-2" style={{ color: "#5a5f62" }}>
            Pre-filled from your choices above. Anything you add is sent to the GM with the purchase. Clicking another skill or
            talent button re-fills this box, so add your note last.
          </p>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="No changes planned yet — click a skill or talent tier above, then edit this to name the exact talent(s) you want."
            rows={6}
            maxLength={500}
            className="w-full bg-transparent border px-2 py-1.5 text-[12px] mb-1"
            style={{ borderColor: "#3a3f42", color: "#e7e2d2", fontFamily: "'JetBrains Mono', monospace" }}
          />
          <div className="text-[10px] text-right mb-3" style={{ color: message.length >= 500 ? "#c23b3b" : "#5a5f62" }}>
            {message.length}/500
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleCopy}
              disabled={!message.trim()}
              className="text-[11px] tracking-wide uppercase px-3 py-1.5 disabled:opacity-40"
              style={{ background: "#5ec8d8", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
            >
              {copyStatus ? "Copied ✔" : "Copy message"}
            </button>
            <button
              onClick={handleSubmitPurchase}
              disabled={!hasChanges || overBudget || !legal || !talentSelectionsComplete || !!myPending || submitStatus.state === "sending"}
              className="text-[11px] tracking-wide uppercase px-3 py-1.5 disabled:opacity-40"
              style={{ background: "#ffb000", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
              title={overBudget ? "That costs more XP than you have" : myPending ? "You already have a purchase waiting for the GM" : undefined}
            >
              {submitStatus.state === "sending" ? "Submitting…" : "Submit for approval"}
            </button>
            {submitStatus.state === "sent" && <span className="text-[12px]" style={{ color: "#6fae60" }}>Sent to the GM for approval ✔</span>}
            {submitStatus.state === "error" && <span className="text-[12px]" style={{ color: "#c23b3b" }}>{submitStatus.msg}</span>}
            {overBudget && hasChanges && <span className="text-[12px]" style={{ color: "#c23b3b" }}>That's {-remaining} XP more than you have.</span>}
          </div>
          {myRequests.length > 0 && (
            <div className="mt-5 pt-4 border-t" style={{ borderColor: "#2a2e31" }}>
              <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>Your purchases</div>
              <div className="space-y-1.5">
                {myRequests.map((r) => (
                  <div key={r.id} className="text-[12px]" style={{ color: "#c7c2b2" }}>
                    <span className="uppercase text-[10px] tracking-[0.12em] mr-2" style={{ color: r.status === "pending" ? "#ffb000" : r.status === "approved" ? "#6fae60" : "#c23b3b" }}>
                      {r.status === "pending" ? "Waiting for GM" : r.status}
                    </span>
                    {r.cost} XP — {r.lines.join("; ")}
                    {r.gmNote && <span style={{ color: "#8a8f93" }}> · GM: “{r.gmNote}”</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared dice roller — exact FFG face tables (see FFG Dice Tables reference
// in the GM project knowledge). Rolls are computed client-side with
// Math.random(), never fudged or approximated. Results are posted to a small
// shared log (Cloudflare Worker /rolls route, backed by a KV namespace) that
// every viewer of this dashboard polls, so a roll one player makes shows up
// for everyone within a couple seconds. This log is entirely separate from
// the campaign ledger/live overlay above — it never reads or writes Wounds,
// Strain, Destiny, or any character-sheet field.
// ---------------------------------------------------------------------------
// Custom blank die-face artwork (Cameron's own designs) — one PNG per die
// type, dropped in public/images/ with these filenames.
const DIE_TYPES = [
  { key: "ability", label: "Ability", sides: 8, img: "/images/die-ability.png",
    faces: { 1: [], 2: ["s"], 3: ["s"], 4: ["a"], 5: ["a"], 6: ["s", "a"], 7: ["a", "a"], 8: ["s", "s"] } },
  { key: "proficiency", label: "Proficiency", sides: 12, img: "/images/die-proficiency.png",
    faces: { 1: [], 2: ["tr"], 3: ["s"], 4: ["s"], 5: ["a"], 6: ["s", "a"], 7: ["s", "a"], 8: ["s", "a"], 9: ["s", "s"], 10: ["s", "s"], 11: ["a", "a"], 12: ["a", "a"] } },
  { key: "boost", label: "Boost", sides: 6, img: "/images/die-boost.png",
    faces: { 1: [], 2: [], 3: ["s"], 4: ["a"], 5: ["a", "a"], 6: ["s", "a"] } },
  { key: "difficulty", label: "Difficulty", sides: 8, img: "/images/die-difficulty.png",
    faces: { 1: [], 2: ["f"], 3: ["t"], 4: ["t"], 5: ["t"], 6: ["f", "f"], 7: ["f", "t"], 8: ["t", "t"] } },
  { key: "challenge", label: "Challenge", sides: 12, img: "/images/die-challenge.png",
    faces: { 1: [], 2: ["d"], 3: ["f"], 4: ["f"], 5: ["t"], 6: ["t"], 7: ["f", "f"], 8: ["f", "f"], 9: ["t", "t"], 10: ["t", "t"], 11: ["t", "f"], 12: ["t", "f"] } },
  { key: "setback", label: "Setback", sides: 6, img: "/images/die-setback.png",
    faces: { 1: [], 2: [], 3: ["f"], 4: ["f"], 5: ["t"], 6: ["t"] } },
  { key: "force", label: "Force", sides: 12, img: "/images/die-force.png",
    faces: { 1: ["lp"], 2: ["lp"], 3: ["lp", "lp"], 4: ["lp", "lp"], 5: ["lp", "lp"], 6: ["dp"], 7: ["dp"], 8: ["dp"], 9: ["dp"], 10: ["dp"], 11: ["dp"], 12: ["dp", "dp"] } },
];

function DieFaceIcon({ img, label, size = 20 }) {
  return (
    <img
      src={img}
      alt={label}
      title={label}
      style={{ width: size, height: size, display: "block", flexShrink: 0, objectFit: "contain" }}
    />
  );
}

// Custom symbol artwork (Cameron's own designs) — one PNG per FFG dice
// symbol, dropped in public/images/ with these filenames.
const SYMBOL_META = {
  s: { label: "Success", img: "/images/symbol-success.png" },
  f: { label: "Failure", img: "/images/symbol-failure.png" },
  a: { label: "Advantage", img: "/images/symbol-advantage.png" },
  t: { label: "Threat", img: "/images/symbol-threat.png" },
  tr: { label: "Triumph", img: "/images/symbol-triumph.png" },
  d: { label: "Despair", img: "/images/symbol-despair.png" },
  lp: { label: "Light Side Point", img: "/images/symbol-light-side.png" },
  dp: { label: "Dark Side Point", img: "/images/symbol-dark-side.png" },
};

function SymbolIcon({ sym, size = 16 }) {
  const meta = SYMBOL_META[sym];
  if (!meta) return null;
  return (
    <img
      src={meta.img}
      alt={meta.label}
      title={meta.label}
      style={{ width: size, height: size, display: "inline-block", verticalAlign: "middle" }}
    />
  );
}

// "N <icon>" for a symbol tally — renders nothing if count is 0/falsy.
function SymbolTally({ sym, count, size = 15, withLabel = false, fontSize }) {
  if (!count) return null;
  const meta = SYMBOL_META[sym];
  return (
    <span className="inline-flex items-center gap-2 mono-num" style={fontSize ? { fontSize } : undefined}>
      {count}
      <SymbolIcon sym={sym} size={size} />
      {withLabel && meta && <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 600 }}>{meta.label}</span>}
    </span>
  );
}

// Talent rules text (talents.json "text_swrpg", and ledger talent
// descriptions) is written in this project's shorthand glyphs. Render each
// glyph with the same die/symbol artwork the dice roller uses. ◑ (a Force
// point of either side) has no artwork of its own, so it stays as text.
const TALENT_GLYPH_ICONS = {
  "✔": { sym: "s" }, "✖": { sym: "f" }, "▲": { sym: "a" }, "▼": { sym: "t" },
  "★": { sym: "tr" }, "☠": { sym: "d" }, "○": { sym: "lp" }, "●": { sym: "dp" },
  "🟩": { die: "ability" }, "🟨": { die: "proficiency" }, "🟦": { die: "boost" },
  "◆": { die: "difficulty" }, "🟥": { die: "challenge" }, "⬛": { die: "setback" },
  "⚪": { die: "force" },
};

function TalentRulesText({ text, size = 14 }) {
  if (!text) return null;
  const parts = [];
  let buf = "";
  for (const ch of Array.from(String(text))) {
    if (ch === "\uFE0F") continue; // emoji variation selector
    const hit = TALENT_GLYPH_ICONS[ch];
    if (!hit) { buf += ch; continue; }
    if (buf) { parts.push(buf); buf = ""; }
    parts.push(hit);
  }
  if (buf) parts.push(buf);
  return (
    <>
      {parts.map((p, i) => {
        if (typeof p === "string") return <span key={i}>{p}</span>;
        if (p.sym) return <SymbolIcon key={i} sym={p.sym} size={size} />;
        const dt = DIE_TYPES.find((d) => d.key === p.die);
        return dt ? (
          <img key={i} src={dt.img} alt={dt.label} title={dt.label} style={{ width: size, height: size, display: "inline-block", verticalAlign: "middle", objectFit: "contain" }} />
        ) : null;
      })}
    </>
  );
}

function rollDie(dieType) {
  const face = Math.floor(Math.random() * dieType.sides) + 1;
  return { face, symbols: dieType.faces[face] || [] };
}

// `manual` (optional) folds in symbols added by hand via the "Add dice
// results" panel — situations that grant a result directly (a GM-awarded
// Advantage, a Triumph from a talent, etc.) without a corresponding die
// actually being rolled. Same shape as EMPTY_MANUAL: one count per symbol
// key. Handled identically to symbols read off an actual die face — a
// manual Triumph still counts as a success too, a manual Despair still
// counts as a failure too — so netSuccess/netAdvantage/triumph/despair stay
// correct without the caller needing to know the difference.
function rollPool(pool, manual = null) {
  const rolls = [];
  DIE_TYPES.forEach((dt) => {
    const count = pool[dt.key] || 0;
    for (let i = 0; i < count; i++) {
      const r = rollDie(dt);
      rolls.push({ die: dt.key, label: dt.label, img: dt.img, face: r.face, symbols: r.symbols });
    }
  });

  let success = 0, failure = 0, advantage = 0, threat = 0, triumph = 0, despair = 0, lightPoint = 0, darkPoint = 0;
  rolls.forEach((r) => {
    r.symbols.forEach((sym) => {
      if (sym === "s") success += 1;
      if (sym === "f") failure += 1;
      if (sym === "a") advantage += 1;
      if (sym === "t") threat += 1;
      if (sym === "tr") { triumph += 1; success += 1; }
      if (sym === "d") { despair += 1; failure += 1; }
      if (sym === "lp") lightPoint += 1;
      if (sym === "dp") darkPoint += 1;
    });
  });

  if (manual) {
    success += manual.s || 0;
    failure += manual.f || 0;
    advantage += manual.a || 0;
    threat += manual.t || 0;
    if (manual.tr) { triumph += manual.tr; success += manual.tr; }
    if (manual.d) { despair += manual.d; failure += manual.d; }
  }

  return { rolls, netSuccess: success - failure, netAdvantage: advantage - threat, triumph, despair, lightPoint, darkPoint };
}

function poolLabel(pool) {
  const parts = DIE_TYPES.filter((dt) => (pool[dt.key] || 0) > 0).map((dt) => `${pool[dt.key]} ${dt.label}`);
  return parts.length ? parts.join(", ") : "No dice selected";
}

// GM rolls in the shared log. When the GM is signed in, every roll they post
// is marked as a GM roll by the Worker (it checks the GM key, so players
// can't fake it), shown as "GM: <name>", and filled with the colour the GM
// picked next to their name: blue for a friendly NPC, green for a neutral
// one, red for an enemy.
const GM_TONE_STORAGE = "swrpg-gm-roll-tone";
const GM_TONES = [
  { key: "friend", label: "Friend", color: "#4a8fd8" },
  { key: "neutral", label: "Neutral", color: "#5aa860" },
  { key: "enemy", label: "Enemy", color: "#c23b3b" },
];
function gmToneColor(tone) {
  return (GM_TONES.find((t) => t.key === tone) || GM_TONES[2]).color;
}
// A GM roll with no name typed in shows as just "GM", not "GM: Unnamed".
function gmRollHasName(entry) {
  const name = (entry.player || "").trim();
  return !!name && name !== "Unnamed";
}
function rollEntryName(entry, fallback) {
  if (entry.gm) return gmRollHasName(entry) ? `GM: ${entry.player}` : "GM";
  return entry.player || fallback;
}

// Plain-text one-liner for a shared-log entry, meant for pasting into a
// Discord/text chat when someone needs to reference a roll outside the
// dashboard itself. Deliberately plain text — no icons, no markup.
function formatRollForClipboard(entry) {
  if (entry.utility) {
    const u = entry.utility;
    const label = rollEntryName(entry, "Utility Roll");
    if (u.kind === "d100") {
      return `${label}: ${u.roll}`;
    }
    if (u.kind === "obligation") {
      return u.triggered
        ? `${label}: roll ${u.roll} vs total ${u.total} — triggers ${u.triggered}`
        : `${label}: roll ${u.roll} vs total ${u.total} — no trigger`;
    }
    const result = u.name ? `${u.roll} - ${u.name}${u.severity ? ` (${u.severity})` : ""}` : `${u.roll}`;
    return u.effect ? `${label}: ${result} — ${u.effect}` : `${label}: ${result}`;
  }
  const parts = [];
  // With no Difficulty/Challenge dice (initiative, for example) a roll with
  // no net successes is "0 Success", not a Failure.
  const opposed = (entry.pool?.difficulty || 0) + (entry.pool?.challenge || 0) + (entry.manual?.f || 0) + (entry.manual?.d || 0) > 0;
  if (entry.netSuccess > 0) parts.push(`${entry.netSuccess} Success`);
  else if (entry.netSuccess < 0) parts.push(`${Math.abs(entry.netSuccess)} Failure`);
  else parts.push(opposed ? "Failure" : "0 Success");
  if (entry.netAdvantage > 0) parts.push(`${entry.netAdvantage} Advantage`);
  else if (entry.netAdvantage < 0) parts.push(`${Math.abs(entry.netAdvantage)} Threat`);
  if (entry.triumph > 0) parts.push(`${entry.triumph} Triumph`);
  if (entry.despair > 0) parts.push(`${entry.despair} Despair`);
  if (entry.lightPoint > 0) parts.push(`${entry.lightPoint} Light Side Point`);
  if (entry.darkPoint > 0) parts.push(`${entry.darkPoint} Dark Side Point`);
  const damage = entry.damage != null ? ` — Total damage: ${entry.damage}` : "";
  const base = `${rollEntryName(entry, "Unnamed")}: ${parts.join(", ")}${damage}`;
  return entry.weaponNote ? `${base} (${entry.weaponNote})` : base;
}

// Custom "new roll landed in the shared log" sound — Cameron's own uploaded
// clips (a set of saber-strike variants), one picked at random each time so
// a busy table doesn't hear the identical clip back-to-back.
const ROLL_SOUNDS = [
  "/sounds/dice-roll-a.wav",
  "/sounds/dice-roll-b.wav",
  "/sounds/dice-roll-c.wav",
  "/sounds/dice-roll-d.wav",
  "/sounds/dice-roll-e.wav",
  "/sounds/dice-roll-f.wav",
  "/sounds/dice-roll-g.wav",
  "/sounds/dice-roll-h.wav",
  "/sounds/dice-roll-i.wav",
];

function playRandomRollSound() {
  const src = ROLL_SOUNDS[Math.floor(Math.random() * ROLL_SOUNDS.length)];
  const audio = new Audio(src);
  audio.volume = 0.1;
  audio.play().catch(() => { /* blocked until a user gesture unlocks audio — see handleRoll */ });
}

// Mandatory Despair sting (Cameron's own uploaded clip) — plays whenever a
// new shared-log entry carries a Despair result, regardless of the mute
// toggle below. This is deliberately not gated on soundOnRef: a Despair is
// meant to be heard by the whole table. It replaces the ambient roll chime
// for that entry rather than layering on top of it.
const DESPAIR_SOUND = "/sounds/despair-scream.wav";

function playDespairSound() {
  const audio = new Audio(DESPAIR_SOUND);
  audio.volume = 0.6;
  audio.play().catch(() => { /* blocked until a user gesture unlocks audio — see handleRoll */ });
}

// Mandatory Triumph sting (Cameron's own uploaded clip) — plays whenever a
// new shared-log entry carries a Triumph result, regardless of the mute
// toggle below. Same treatment as Despair: a Triumph is meant to be heard by
// the whole table, and replaces the ambient roll chime for that entry.
const TRIUMPH_SOUND = "/sounds/triumph-sound.wav";

function playTriumphSound() {
  const audio = new Audio(TRIUMPH_SOUND);
  audio.volume = 0.6;
  audio.play().catch(() => { /* blocked until a user gesture unlocks audio — see handleRoll */ });
}

// Icons-only readout of the current pool — sits next to Roll/Clear pool so
// players can see exactly what's selected at a glance. Renders one icon per
// die (not a single icon + ×N count) so the row visibly grows/shrinks as
// dice are added or removed — easier to recognise at a glance than mixing
// icons with numerals. Each icon still carries its own alt/title text (see
// DieFaceIcon) for anyone who needs the name. Display order pairs each
// upgraded die next to its base type (Proficiency before Ability, Challenge
// before Difficulty) with no gap between type groups, so the row reads as
// one continuous strip rather than clusters — display order only, doesn't
// touch DIE_TYPES itself, which still drives the dice counters elsewhere.
const POOL_DISPLAY_ORDER = ["proficiency", "ability", "boost", "challenge", "difficulty", "setback", "force"];
// onRemoveOne (optional): called with a die's key when one of its icons is
// clicked, so the panel can decrement that die type by 1 - lets players pull
// dice back out of the pool directly from the graphical summary rather than
// only via the +/- counters above. Icons stay purely visual (no click
// handler) when onRemoveOne isn't passed, e.g. read-only summaries elsewhere.
function SelectedDiceSummary({ pool, size = 18, onRemoveOne }) {
  const active = DIE_TYPES
    .filter((dt) => (pool[dt.key] || 0) > 0)
    .sort((a, b) => POOL_DISPLAY_ORDER.indexOf(a.key) - POOL_DISPLAY_ORDER.indexOf(b.key));
  if (active.length === 0) {
    return <span className="text-[12px]" style={{ color: "#5a5f62" }}>No dice selected</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-y-1.5">
      {active.map((dt) => (
        <span key={dt.key} className="flex items-center gap-1">
          {Array.from({ length: pool[dt.key] }, (_, i) =>
            onRemoveOne ? (
              <button
                key={i}
                type="button"
                onClick={() => onRemoveOne(dt.key)}
                title={`Remove one ${dt.label} die`}
                className="p-0 border-0 bg-transparent leading-none transition-opacity hover:opacity-50"
                style={{ cursor: "pointer" }}
              >
                <DieFaceIcon img={dt.img} label={dt.label} size={size} />
              </button>
            ) : (
              <DieFaceIcon key={i} img={dt.img} label={dt.label} size={size} />
            )
          )}
        </span>
      ))}
    </span>
  );
}

// Icons-only dice pool readout — no spelled-out labels, just each active die
// type's icon with an ×N count. Used in the shared roll log so a scan of the
// table shows what was rolled before the summarised result underneath it.
function PoolIconStrip({ pool, size = 16 }) {
  const active = DIE_TYPES.filter((dt) => (pool?.[dt.key] || 0) > 0);
  if (active.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-2.5">
      {active.map((dt) => (
        <span key={dt.key} className="flex items-center gap-1">
          <DieFaceIcon img={dt.img} label={dt.label} size={size} />
          <span className="text-[11px] mono-num" style={{ color: "#8a8f93" }}>×{pool[dt.key]}</span>
        </span>
      ))}
    </span>
  );
}

// Per-die results readout for the shared roll log — one icon per die that
// was actually rolled, immediately followed by the symbols it landed on.
// Deliberately omits the numeric face value (e.g. "7:") — that level of
// detail is accurate but more than a glance at the log needs; the symbols
// are what matter at the table. Falls back to PoolIconStrip for older log
// entries posted before this field existed (they only have entry.pool).
function RollResultsStrip({ rolls, size = 16 }) {
  if (!rolls || rolls.length === 0) return null;
  // Rolls land in this array in DIE_TYPES order (whatever order rollPool
  // iterated dice types in), which doesn't match the pool's own display
  // order — re-sort to POOL_DISPLAY_ORDER (yellow, green, blue, red,
  // purple, black, white) so the log's results line reads left-to-right
  // the same way the dice pool itself does.
  const sorted = [...rolls].sort((a, b) => POOL_DISPLAY_ORDER.indexOf(a.die) - POOL_DISPLAY_ORDER.indexOf(b.die));
  return (
    <span className="flex flex-wrap items-center gap-3">
      {sorted.map((r, i) => {
        const dt = DIE_TYPES.find((d) => d.key === r.die);
        if (!dt) return null;
        return (
          <span key={i} className="flex items-center gap-1">
            <DieFaceIcon img={dt.img} label={dt.label} size={size} />
            {r.symbols && r.symbols.length ? (
              r.symbols.map((s, si) => <SymbolIcon key={si} sym={s} size={size - 1} />)
            ) : (
              <span style={{ color: "#5a5f62" }}>—</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

// Difficulty tier readout: Challenge dice count toward the same tier as
// Difficulty dice (both represent the check's base difficulty — Challenge
// is just Difficulty "upgraded" per FFG's dice-upgrade rule), so the tier
// name is derived from Difficulty + Challenge combined, then flagged
// "(Upgraded)" whenever any Challenge dice are in the pool.
const DIFFICULTY_TIER_NAMES = { 1: "Easy", 2: "Average", 3: "Hard", 4: "Daunting", 5: "Formidable" };

function difficultyTierLabel(pool) {
  const difficultyCount = pool.difficulty || 0;
  const challengeCount = pool.challenge || 0;
  const total = difficultyCount + challengeCount;
  if (total <= 0) return null;
  const tierName = DIFFICULTY_TIER_NAMES[Math.min(total, 5)];
  const upgraded = challengeCount > 0;
  return `${total} Difficulty (${tierName})${upgraded ? " (Upgraded)" : ""}`;
}

// Cyan hover-glow used across the Dice Roller's interactive controls (quick
// difficulty/range presets, maneuvers, upgrade/downgrade buttons, Roll/Clear
// pool) — same treatment as the character-tab weapon cards: border shifts to
// cyan and a soft glow appears on hover, then reverts to the button's own
// resting border color on mouse-out. Applied imperatively (not via the
// style prop) so it doesn't fight each button's own active/selected fill
// color; pass `restBorder` as whatever that button's border should be when
// not hovered, and `disabled: true` to skip the effect entirely (matching
// each button's own disabled/not-allowed state). `hoverColor`/`hoverShadow`
// default to the cyan treatment but each button family passes its own —
// purple for difficulty presets, ivory for the neutral/grey buttons, gold
// for Roll — so the hover glow reads as "this button's own accent, lit up"
// rather than one uniform color painted over everything.
function hoverGlow(restBorder, { disabled = false, hoverColor = "#5ec8d8", hoverShadow = "0 0 14px rgba(94,200,216,0.22)" } = {}) {
  if (disabled) return {};
  return {
    onMouseEnter: (e) => {
      e.currentTarget.style.borderColor = hoverColor;
      e.currentTarget.style.boxShadow = hoverShadow;
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.borderColor = restBorder;
      e.currentTarget.style.boxShadow = "none";
    },
  };
}

// Hard cap on how many of any single die type the roller will hold — FFG
// pools essentially never get anywhere close to this in practice, it's just
// a sane ceiling so a mis-click can't run a counter up indefinitely.
const MAX_DICE_PER_TYPE = 8;

// Neutral/grey hover treatment shared by the two upgrade-dice buttons and
// the dice-counter rows below — same ivory (#e7e2d2) glow as Clear pool and
// the Called Shot maneuvers, so every "plain" control in the roller reads
// consistently even though they don't share a single accent color otherwise.
const IVORY_HOVER = { hoverColor: "#e7e2d2", hoverShadow: "0 0 14px rgba(231,226,210,0.22)" };

// Clicking anywhere on the row adds one die, up to `max`. Right-clicking
// the row removes one instead, with the browser's own context menu
// suppressed for this element only — click to add, right-click to remove,
// no separate +/- buttons needed on the row itself. The count is still
// shown (turns out reading it purely from the tinted border, or from
// SelectedDiceSummary further down the panel, was confusing at the table)
// — just as a plain number, not a stepper control.
function DiceCounter({ dieType, count, onChange, max = MAX_DICE_PER_TYPE }) {
  const atMax = count >= max;
  const active = count > 0;
  const restBorder = active ? "#e7e2d866" : "#2a2e31";
  const restBg = active ? "#e7e2d20d" : "transparent";
  const titleParts = [];
  if (!atMax) titleParts.push(`Click to add a ${dieType.label} die`);
  if (count > 0) titleParts.push("right-click to remove one");
  return (
    <div
      onClick={() => { if (!atMax) onChange(Math.min(max, count + 1)); }}
      onContextMenu={(e) => { e.preventDefault(); if (count > 0) onChange(Math.max(0, count - 1)); }}
      title={titleParts.length ? titleParts.join(" — ") : undefined}
      className="flex items-center justify-between border px-3 py-2 transition-colors select-none"
      style={{ borderColor: restBorder, background: restBg, cursor: atMax ? "default" : "pointer", WebkitUserSelect: "none", userSelect: "none" }}
      onMouseEnter={(e) => { if (!atMax) { e.currentTarget.style.borderColor = "#e7e2d2"; e.currentTarget.style.background = "#e7e2d215"; } }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = restBorder; e.currentTarget.style.background = restBg; }}
    >
      <span className="flex items-center gap-2 text-[13px]" style={{ color: "#e7e2d2" }}>
        <DieFaceIcon img={dieType.img} label={dieType.label} size={22} />
        {dieType.label}
      </span>
      <span className="w-5 text-center mono-num" style={{ color: active ? "#e7e2d2" : "#5a5f62" }}>{count}</span>
    </div>
  );
}

const EMPTY_POOL = { proficiency: 0, ability: 0, boost: 0, challenge: 0, difficulty: 0, setback: 0, force: 0 };

// Symbol results a player can add to a roll by hand, for situations that
// grant a result directly (a GM-awarded Advantage, a Triumph off a talent,
// etc.) rather than one earned by an actual die face. Paired the same way
// FFG pairs its own symbols — Success/Failure, Advantage/Threat, Triumph/
// Despair — so the "Add dice results" panel lays out in matching rows.
const MANUAL_SYMBOL_TYPES = ["s", "f", "a", "t", "tr", "d"];
const EMPTY_MANUAL = { s: 0, f: 0, a: 0, t: 0, tr: 0, d: 0 };

// Same click-to-add/right-click-to-remove interaction as DiceCounter, but
// for a plain symbol instead of a die — used by the "Add dice results"
// panel. Same reasoning for dropping the +/- buttons but keeping the count
// visible as a plain number: the border tint alone was confusing at a
// glance without it.
function ManualSymbolCounter({ sym, count, onChange, max = MAX_DICE_PER_TYPE }) {
  const meta = SYMBOL_META[sym];
  const atMax = count >= max;
  const active = count > 0;
  const restBorder = active ? "#e7e2d866" : "#2a2e31";
  const restBg = active ? "#e7e2d20d" : "transparent";
  const titleParts = [];
  if (!atMax) titleParts.push(`Click to add 1 ${meta.label}`);
  if (count > 0) titleParts.push("right-click to remove one");
  return (
    <div
      onClick={() => { if (!atMax) onChange(Math.min(max, count + 1)); }}
      onContextMenu={(e) => { e.preventDefault(); if (count > 0) onChange(Math.max(0, count - 1)); }}
      title={titleParts.length ? titleParts.join(" — ") : undefined}
      className="flex items-center justify-between border px-3 py-2 transition-colors select-none"
      style={{ borderColor: restBorder, background: restBg, cursor: atMax ? "default" : "pointer", WebkitUserSelect: "none", userSelect: "none" }}
      onMouseEnter={(e) => { if (!atMax) { e.currentTarget.style.borderColor = "#e7e2d2"; e.currentTarget.style.background = "#e7e2d215"; } }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = restBorder; e.currentTarget.style.background = restBg; }}
    >
      <span className="flex items-center gap-2 text-[13px]" style={{ color: "#e7e2d2" }}>
        <SymbolIcon sym={sym} size={20} />
        {meta.label}
      </span>
      <span className="w-5 text-center mono-num" style={{ color: active ? "#e7e2d2" : "#5a5f62" }}>{count}</span>
    </div>
  );
}

// Push-button toggle for the "Add dice results" panel — sized and styled
// like a DiceCounter row so it drops cleanly into the empty second cell
// next to the Force die (7 die types is an odd number for a 2-column
// grid, so that cell would otherwise just sit blank). Click toggles it
// open/closed; right-click also closes it — so however it's currently
// showing, either gesture on it turns it back off.
function ManualResultsToggle({ open, onOpen, onClose, hasPending }) {
  const restBorder = open ? "#ffb000" : hasPending ? "#ffb00066" : "#2a2e31";
  const restBg = open ? "#ffb0001a" : hasPending ? "#ffb0000d" : "transparent";
  return (
    <div
      onClick={() => { open ? onClose() : onOpen(); }}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      title={open ? "Click or right-click to close" : "Click to open — right-click to close"}
      className="flex items-center justify-between border px-3 py-2 transition-colors select-none"
      style={{ borderColor: restBorder, background: restBg, cursor: "pointer", WebkitUserSelect: "none", userSelect: "none" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#ffb000"; e.currentTarget.style.background = "#ffb0001a"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = restBorder; e.currentTarget.style.background = restBg; }}
    >
      <span className="flex items-center gap-2 text-[13px]" style={{ color: "#e7e2d2" }}>
        <SymbolIcon sym="tr" size={22} />
        Add dice results
      </span>
      <span className="text-[10px] tracking-[0.15em] uppercase" style={{ color: open ? "#ffb000" : "#5a5f62" }}>
        {open ? "On" : "Off"}
      </span>
    </div>
  );
}

// Fixed Boost/Setback contribution per maneuver — mirrors the boost/setback
// values passed into each button below, kept as a standalone lookup (rather
// than reading it back out of the render-time button array) so
// selectManeuver can know exactly what the *previously* active maneuver
// added, in order to subtract only that amount when switching to a
// different one. See selectManeuver for how this is used.
const MANEUVER_DELTAS = {
  aim: { boost: 1, setback: 0 },
  "double-aim": { boost: 2, setback: 0 },
  "called-shot": { boost: 0, setback: 2 },
  "double-called-shot": { boost: 0, setback: 1 },
};

// --- Initiative tracker -----------------------------------------------------
// Small combat-order strip, GM-maintained via the shared /manual store's
// "initiative" field (see useManualStore and the GM page's initiative
// editor). Schema is deliberately minimal —
// two fields, no round counter, no timestamp:
//   "initiative": { "order": ["pc", "npc", "pc", "npc"], "taken": 2 }
// "order" is the FIXED initiative order for the whole encounter (per the
// table's own rules, slots are unnamed PC/NPC seats rolled once and reused
// every round — it never needs to be reshuffled turn to turn). "taken" is
// just how many seats, counting from the front, have already gone this
// round. Update workflow is a single number: increment "taken" by 1 after
// each turn; when it reaches order.length, wrap it back to 0 for the new
// round — same order, no rewriting the array. The UI turns that one number
// into the whole display: acted seats render darkened, the seat at index
// "taken" is the one up now (highlighted + breathing), everything after is
// still bright and waiting. A wrap back to 0 (taken decreasing) reads as a
// full round completing and flashes gold instead of the usual cyan "this
// just updated" flash.
function InitiativeBox({ kind, spent, active }) {
  const isPC = String(kind).toLowerCase() === "pc";
  const baseColor = isPC ? "#3b82c2" : "#c23b3b";
  // Spent seats stay tinted with their PC/NPC hue instead of going flat
  // grey — a heavily darkened version of the same blue/red so "used" is
  // still readable as PC or NPC at a glance, not just from the letters.
  const spentBg = isPC ? "#0f1f2c" : "#2c0f0f";
  const spentText = isPC ? "#3d6485" : "#85403d";
  const spentBorder = isPC ? "#1c3247" : "#471c1c";
  return (
    <div
      className={`flex items-center justify-center text-[10px] flex-shrink-0 ${active ? "init-breathe" : ""}`}
      style={{
        width: 30, height: 30,
        background: spent ? spentBg : baseColor,
        color: spent ? spentText : "#0d0f10",
        fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
        letterSpacing: "0.03em",
        transition: "background 0.4s ease-out, color 0.4s ease-out",
        border: active ? "1px solid #e7e2d2" : `1px solid ${spent ? spentBorder : "rgba(0,0,0,0.35)"}`,
      }}
    >
      {isPC ? "PC" : "NPC"}
    </div>
  );
}

// GM page's initiative tracker creator: builds the `order` array the
// read-only InitiativeTracker above renders. Add a PC or NPC slot, flip an
// existing slot's side, nudge a selected slot forward/back through the
// order, and advance the round — which wraps `taken` back to 0 (a new
// round, same seat order) the instant it reaches the end, exactly like the
// GM ledger's own initiative convention.
// Scores are integer pairs: 3.10 means three successes and ten advantages.
function initiativeNameKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function parseInitiativeResults(text, playerNames = []) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Enter at least one result, for example 3.2P 2.1 Kess: 3 successes 2 advantages.");
  // A player matches by full name or first name ("Kess" for "Kess Varyn").
  const pcNames = new Set(playerNames.flatMap((n) => [initiativeNameKey(n), initiativeNameKey(String(n || "").trim().split(/\s+/)[0])]));
  const checked = (successes, advantages, label) => {
    if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(advantages) || successes > 999 || advantages > 999) {
      throw new Error(`Result for "${label}" exceeds the maximum of 999 successes or advantages.`);
    }
    return { successes, advantages };
  };
  // Shorthand is successes.advantages plus an optional P (PC) or N (NPC):
  // 3.2P, 3P, .2P, 3, 3.2, P, N. Any missing number counts as 0, and no
  // letter means NPC.
  const shorthand = (entry) => {
    const match = /^(\d*)(?:\.(\d*))?([PN])?$/i.exec(entry);
    if (!match) return null;
    return { successes: Number(match[1] || 0), advantages: Number(match[2] || 0), suffix: (match[3] || "").toUpperCase() };
  };
  const results = [];
  trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    // "Name: result" — a name that matches a player is a PC, any other name
    // is an NPC. The result may be "3 successes 2 advantages", "3s 2a",
    // shorthand like 3.2, or empty (0).
    const named = /^([^:]{1,80}):\s*(.*)$/.exec(line);
    if (named) {
      // Shorthand entries written before a name on the same line (3.2P 2.1 Kess: 2s)
      // are peeled off first; they always contain a digit, a name never does.
      const nameTokens = named[1].trim().split(/\s+/);
      while (nameTokens.length > 1 && /^(?=.*\d)\d*(?:\.\d*)?[PN]?$/i.test(nameTokens[0])) {
        const lead = shorthand(nameTokens.shift());
        results.push({ kind: lead.suffix === "P" ? "pc" : "npc", ...checked(lead.successes, lead.advantages, "entry") });
      }
      const name = nameTokens.join(" ");
      const result = named[2].trim();
      const successMatch = /(\d+)\s*s(?:uccess(?:es)?)?\b/i.exec(result);
      const advantageMatch = /(\d+)\s*a(?:dvantages?)?\b/i.exec(result);
      let successes = 0;
      let advantages = 0;
      let suffix = "";
      if (successMatch || advantageMatch) {
        successes = Number(successMatch?.[1] || 0);
        advantages = Number(advantageMatch?.[1] || 0);
      } else if (result) {
        const short = shorthand(result.split(/\s+/)[0]);
        if (/\b(failure|threat|despair|blank|none|zero)\b/i.test(result)) {
          // A copied roll with no net success or advantage ("GM: Failure",
          // "Kess: 2 Threat") is a legitimate 0.0 initiative result. Checked
          // before shorthand so the 2 in "2 Threat" isn't read as successes.
          successes = 0;
          advantages = 0;
        } else if (short) {
          ({ successes, advantages, suffix } = short);
        } else {
          throw new Error(`Could not read a result for "${name}". Use "3 successes 2 advantages", 3.2, or leave it blank for 0.`);
        }
      }
      const score = checked(successes, advantages, name);
      const isPc = suffix === "P" || (suffix !== "N" && pcNames.has(initiativeNameKey(name)));
      results.push({ kind: isPc ? "pc" : "npc", ...score });
      return;
    }
    // Unnamed shorthand entries, any number per line, mixed freely.
    line.split(/[\s,;]+/).filter(Boolean).forEach((entry) => {
      const short = shorthand(entry);
      if (!short) throw new Error(`Invalid result "${entry}". Use successes.advantages with an optional P (PC) or N (NPC), or Name: result.`);
      results.push({ kind: short.suffix === "P" ? "pc" : "npc", ...checked(short.successes, short.advantages, entry) });
    });
  });
  return results;
}

function appendInitiativeResults(initiative, text, playerNames = []) {
  const existing = (initiative?.order || []).map((kind, index) => ({ kind, score: initiative.results?.[index] || null }));
  const added = parseInitiativeResults(text, playerNames).map(({ kind, successes, advantages }) => ({ kind, score: { successes, advantages } }));
  if (existing.length + added.length > 40) throw new Error("An encounter can contain at most 40 initiative slots.");
  const sorted = [...existing, ...added].sort((a, b) => {
    if (!a.score || !b.score) return a.score ? -1 : b.score ? 1 : 0;
    return b.score.successes - a.score.successes || b.score.advantages - a.score.advantages || (a.kind === b.kind ? 0 : a.kind === "pc" ? -1 : 1);
  });
  return { order: sorted.map((entry) => entry.kind), results: sorted.map((entry) => entry.score), taken: 0 };
}


function GmInitiativeEditor({ initiative, onChange, playerNames = [], fill = false, hideEmptyMessage = false }) {
  const order = Array.isArray(initiative?.order) ? initiative.order : [];
  const taken = Math.min(Math.max(0, Number(initiative?.taken) || 0), order.length);
  const [selected, setSelected] = useState(null);
  const [shorthand, setShorthand] = useState("");
  const [importError, setImportError] = useState("");
  const results = order.map((_, index) => initiative?.results?.[index] || null);
  function importResults(event) {
    event.preventDefault();
    try {
      const next = appendInitiativeResults(initiative, shorthand, playerNames);
      onChange(next);
      setSelected(null);
      setShorthand("");
      setImportError("");
    } catch (error) { setImportError(error.message); }
  }

  function commit(nextOrder, nextTaken, nextResults = results) {
    onChange({
      order: nextOrder,
      results: nextOrder.map((_, index) => nextResults[index] || null),
      taken: Math.min(Math.max(0, nextTaken ?? taken), nextOrder.length),
    });
  }

  function addSlot(kind) {
    if (order.length >= 40) return;
    commit([...order, kind], taken, [...results, null]);
  }

  function flipSlot(i) {
    const next = order.slice();
    next[i] = next[i] === "pc" ? "npc" : "pc";
    commit(next, taken);
  }

  function removeSlot(i) {
    const next = order.filter((_, idx) => idx !== i);
    const newTaken = i < taken ? taken - 1 : taken;
    setSelected(null);
    commit(next, newTaken, results.filter((_, idx) => idx !== i));
  }

  function moveSlot(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setSelected(j);
    const nextResults = results.slice();
    [nextResults[i], nextResults[j]] = [nextResults[j], nextResults[i]];
    commit(next, taken, nextResults);
  }

  // Advancing past the last seat starts a new round: same order, taken
  // wraps back to 0, exactly the GM ledger's own convention.
  function advance() {
    const next = taken + 1 >= order.length ? 0 : taken + 1;
    commit(order, next);
  }

  function newRound() {
    commit(order, 0);
  }

  return (
    <div className={`border p-4 ${fill ? "h-full" : ""}`} style={{ borderColor: "#3a3f4266", background: "#101315" }}>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#5ec8d8" }}>Initiative Tracker</div>
        <div className="flex items-center gap-2">
          <GhostButtonLike onClick={() => addSlot("pc")} color="#5ec8d8">+ PC slot</GhostButtonLike>
          <GhostButtonLike onClick={() => addSlot("npc")} color="#c23b3b">+ NPC slot</GhostButtonLike>
        </div>
      </div>

      <form onSubmit={importResults} className="mb-4">
        <label className="block text-[12px] mb-2" style={{ color: "#e7e2d2" }}>
          Initiative results — mix shorthand (3.2P = PC, no letter = NPC) and "Name: 3 successes 2 advantages" lines
          <textarea value={shorthand} onChange={(event) => setShorthand(event.target.value)} placeholder={"3.2P 2.1 3P 1.1\nKess: 3 successes 2 advantages\nStormtrooper: 2.1"} rows={3} maxLength={1200} className="block w-full mt-1 border bg-transparent px-3 py-2 resize-y" style={{ borderColor: "#3a3f42" }} />
        </label>
        <div className="flex gap-3 items-center flex-wrap">
          <button type="submit" className="text-[11px] px-3 py-2 border" style={{ color: "#5ec8d8", borderColor: "#5ec8d8" }}>Append & sort</button>
          <button type="button" onClick={() => { if (window.confirm("Clear the initiative order and saved results?")) { commit([], 0, []); setSelected(null); } }} className="text-[11px] px-3 py-2" style={{ color: "#c23b3b" }}>Clear order</button>
        </div>
        {importError && <p role="alert" className="text-[12px] mt-2" style={{ color: "#c23b3b" }}>{importError}</p>}
      </form>
      {order.length === 0 ? (
        hideEmptyMessage ? null : <span className="text-[12px]" style={{ color: "#5a5f62" }}>No slots yet — add PC/NPC seats to start combat.</span>
      ) : (
        <>
          <div className="flex items-center gap-1.5 flex-wrap mb-3">
            {order.map((kind, i) => (
              <div key={i} className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSelected(selected === i ? null : i)}
                  title="Select this slot to move it"
                  className="flex items-center justify-center text-[10px]"
                  style={{
                    width: 30, height: 30,
                    background: kind === "pc" ? "#3b82c2" : "#c23b3b",
                    color: "#0d0f10",
                    fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                    border: i === taken ? "2px solid #ffb000" : selected === i ? "2px solid #e7e2d2" : "1px solid rgba(0,0,0,0.35)",
                    opacity: i < taken ? 0.5 : 1,
                  }}
                >
                  {kind === "pc" ? "PC" : "NPC"}
                </button>
                {results[i] && <span className="text-[10px]" style={{ color: "#8a8f93" }}>{results[i].successes}.{results[i].advantages}</span>}
                <div className="flex items-center gap-0.5">
                  <button type="button" onClick={() => moveSlot(i, -1)} disabled={i === 0} className="text-[10px] px-1 disabled:opacity-30" style={{ color: "#8a8f93" }} title="Move back">◀</button>
                  <button type="button" onClick={() => flipSlot(i)} className="text-[9px] px-0.5" style={{ color: "#8a8f93" }} title="Flip PC/NPC">⇄</button>
                  <button type="button" onClick={() => moveSlot(i, 1)} disabled={i === order.length - 1} className="text-[10px] px-1 disabled:opacity-30" style={{ color: "#8a8f93" }} title="Move forward">▶</button>
                  <button type="button" onClick={() => removeSlot(i)} className="text-[10px] px-1" style={{ color: "#c23b3b" }} title="Remove slot">✕</button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={advance}
              className="text-[11px] tracking-wide uppercase px-3 py-1.5"
              style={{ background: "#ffb000", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
            >
              Advance turn
            </button>
            <GhostButtonLike onClick={newRound} color="#8a8f93">New round (reset to start)</GhostButtonLike>
            <span className="text-[11px]" style={{ color: "#5a5f62" }}>
              Seat {Math.min(taken + 1, order.length)} of {order.length}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function GhostButtonLike({ onClick, color, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] tracking-[0.1em] uppercase px-2.5 py-1 border transition-colors"
      style={{ color, borderColor: `${color}66`, fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
    >
      {children}
    </button>
  );
}

function InitiativeTracker({ initiative, fill = false }) {
  const [flashColor, setFlashColor] = useState(null);
  const flashTimerRef = useRef(null);
  const prevRef = useRef(null);

  const order = Array.isArray(initiative?.order) ? initiative.order : [];
  const takenRaw = Number(initiative?.taken);
  const taken = order.length ? Math.min(Math.max(0, Number.isFinite(takenRaw) ? takenRaw : 0), order.length) : 0;

  useEffect(() => {
    if (!initiative || order.length === 0) return;
    const orderKey = JSON.stringify(order);
    const prev = prevRef.current;
    if (prev !== null) {
      const changed = prev.orderKey !== orderKey || prev.taken !== taken;
      if (changed) {
        setFlashColor(taken < prev.taken ? "gold" : "cyan");
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlashColor(null), 1100);
      }
    }
    prevRef.current = { orderKey, taken };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initiative]);

  useEffect(() => () => clearTimeout(flashTimerRef.current), []);

  if (order.length === 0) return null;

  const glow = flashColor === "gold" ? "255,176,0" : flashColor === "cyan" ? "94,200,216" : null;

  return (
    <div
      className={`border p-3 ${fill ? "h-full" : "mb-4"}`}
      style={{
        borderColor: "#3a3f42",
        background: "#101315",
        transition: "box-shadow 0.3s ease-out",
        boxShadow: glow ? `0 0 22px 4px rgba(${glow},0.55)` : "0 0 0 0 rgba(0,0,0,0)",
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#5ec8d8" }}>
          Initiative
        </span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {order.map((kind, i) => (
          <InitiativeBox key={i} kind={kind} spent={i < taken} active={i === taken} />
        ))}
      </div>
    </div>
  );
}

function useRollLog() {
  const [log, setLog] = useState([]);
  const [sharedPools, setSharedPools] = useState([]);
  const seenOwnPoolRef = useRef(false);
  const [logStatus, setLogStatus] = useState({ status: "idle" });
  const pollRef = useRef(null);
  // Which shared-log entry (by id) just had its result copied to the
  // clipboard — drives a brief "Copied!" confirmation badge, cleared after
  // COPY_CONFIRM_MS.
  const [copiedEntryId, setCopiedEntryId] = useState(null);
  const copiedTimerRef = useRef(null);
  const [animationsOn, setAnimationsOn] = useState(() => {
    try { return campaignStorage.getItem("swrpg-dice-animations") !== "off"; } catch { return true; }
  });
  const animationsOnRef = useRef(animationsOn);
  const [burstEntry, setBurstEntry] = useState(null);
  const burstTimerRef = useRef(null);

  // There is no value in replaying a backlog when a sleeping phone/browser
  // wakes. Replace any current animation with only the newest recent result.
  function showLatestDiceBurst(entry) {
    if (!animationsOnRef.current || !entry || entry.utility) return;
    clearTimeout(burstTimerRef.current);
    setBurstEntry({ ...entry, burstKey: `${entry.id}-${Date.now()}` });
    burstTimerRef.current = setTimeout(() => setBurstEntry(null), 4700);
  }

  // Chime on new shared-log entries. soundOn is mirrored into a ref because
  // fetchLog's setInterval closure is created once on mount and would
  // otherwise only ever see the initial value of the state variable.
  const [soundOn, setSoundOn] = useState(() => {
    try { return campaignStorage.getItem("swrpg-dice-sound") !== "off"; } catch { return true; }
  });
  const soundOnRef = useRef(soundOn);
  useEffect(() => {
    soundOnRef.current = soundOn;
    try { campaignStorage.setItem("swrpg-dice-sound", soundOn ? "on" : "off"); } catch { /* ignore */ }
  }, [soundOn]);
  const hasFetchedRef = useRef(false);
  const prevTopIdRef = useRef(undefined);

  useEffect(() => {
    animationsOnRef.current = animationsOn;
    try { campaignStorage.setItem("swrpg-dice-animations", animationsOn ? "on" : "off"); } catch { /* ignore */ }
    if (!animationsOn) {
      clearTimeout(burstTimerRef.current);
      setBurstEntry(null);
    }
  }, [animationsOn]);

  useEffect(() => () => {
    clearTimeout(copiedTimerRef.current);
    clearTimeout(burstTimerRef.current);
  }, []);

  const fetchLog = async () => {
    try {
      const res = await apiFetch(`/rolls?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const rolls = Array.isArray(data.rolls) ? data.rolls : [];
      const pools = Array.isArray(data.pools) ? data.pools : [];
      setSharedPools(pools);
      // Keep this browser's Dice Roller cache aligned with edits made from
      // the Battle Map by any participant. If a pool that this browser has
      // actually seen disappears (because it was rolled, cleared, or
      // expired), clear the cache too so changing tabs cannot resurrect it.
      try {
        const ownClientId = campaignStorage.getItem("swrpg-dice-pool-client");
        const ownDraft = pools.find((draft) => draft.id === ownClientId);
        if (ownDraft) {
          seenOwnPoolRef.current = true;
          if (ownDraft.updatedBy === "battlemap") {
            const cached = JSON.parse(campaignStorage.getItem("swrpg-dice-pool-cache") || "{}");
            if ((ownDraft.updatedAt || 0) > (cached.gmUpdatedAt || 0)) {
              campaignStorage.setItem("swrpg-dice-pool-cache", JSON.stringify({ pool: { ...EMPTY_POOL, ...ownDraft.pool }, gmUpdatedAt: ownDraft.updatedAt, presetNonce: cached.presetNonce ?? null }));
            }
          }
        } else if (ownClientId && seenOwnPoolRef.current) {
          const cached = JSON.parse(campaignStorage.getItem("swrpg-dice-pool-cache") || "{}");
          campaignStorage.setItem("swrpg-dice-pool-cache", JSON.stringify({ pool: EMPTY_POOL, gmUpdatedAt: cached.gmUpdatedAt || 0, presetNonce: cached.presetNonce ?? null }));
          seenOwnPoolRef.current = false;
        }
      } catch { /* storage can be unavailable in privacy modes */ }
      const newest = rolls[0];
      const newestId = newest?.id;
      if (hasFetchedRef.current && newestId && newestId !== prevTopIdRef.current) {
        const ageMs = Date.now() - Number(newest.ts || 0);
        const recent = ageMs >= -30000 && ageMs <= 120000;
        if (recent && document.visibilityState === "visible") {
          if (newest.despair > 0) {
            playDespairSound();
          } else if (newest.triumph > 0) {
            playTriumphSound();
          } else if (soundOnRef.current) {
            playRandomRollSound();
          }
          showLatestDiceBurst(newest);
        }
      }
      hasFetchedRef.current = true;
      prevTopIdRef.current = newestId;
      setLog(rolls);
      setLogStatus({ status: "ok" });
    } catch (err) {
      setLogStatus({ status: "error", msg: err.message });
    }
  };

  useEffect(() => {
    const startPolling = () => {
      clearInterval(pollRef.current);
      if (document.visibilityState !== "visible") return;
      fetchLog();
      pollRef.current = setInterval(fetchLog, 1500);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        startPolling();
      } else {
        clearInterval(pollRef.current);
        clearTimeout(burstTimerRef.current);
        setBurstEntry(null);
      }
    };
    startPolling();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(pollRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  async function handleClearLog() {
    if (!window.confirm("Clear the shared roll log for everyone? This can't be undone.")) return;
    try {
      const res = await apiFetch("/rolls", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLogStatus({ status: "error", msg: data.error || `Could not clear log (${res.status})` });
        return;
      }
      setLog([]);
      setLogStatus({ status: "ok" });
    } catch (err) {
      setLogStatus({ status: "error", msg: err.message });
    }
  }

  // Click a shared-log entry to copy its result as plain text (for pasting
  // into Discord/chat elsewhere). navigator.clipboard requires a secure
  // context (HTTPS) and can be blocked by browser permissions, so this
  // falls back to a hidden-textarea + execCommand copy if it throws.
  async function handleCopyEntry(entry) {
    const text = formatRollForClipboard(entry);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        return; // Copy genuinely unavailable — don't show a false "Copied!"
      }
    }
    setCopiedEntryId(entry.id);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedEntryId(null), COPY_CONFIRM_MS);
  }

  return { log, sharedPools, logStatus, setLogStatus, fetchLog, soundOn, setSoundOn, animationsOn, setAnimationsOn, burstEntry, copiedEntryId, handleClearLog, handleCopyEntry };
}

function SharedDicePoolTray({ pools, logStatus, onRefresh }) {
  const [rollingId, setRollingId] = useState(null);

  async function editPool(draft, dieKey, delta) {
    const nextPool = { ...EMPTY_POOL, ...draft.pool, [dieKey]: Math.max(0, Math.min(MAX_DICE_PER_TYPE, (draft.pool?.[dieKey] || 0) + delta)) };
    try {
      const res = await apiFetch("/rolls", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: draft.id, pool: nextPool }),
      });
      if (res.ok) onRefresh?.();
    } catch { /* the shared-log status reports connectivity failures */ }
  }

  async function rollNow(draft) {
    if (rollingId) return;
    setRollingId(draft.id);
    const automatic = { ...EMPTY_MANUAL, ...(draft.automaticResults || {}) };
    const hasAutomatic = Object.values(automatic).some((value) => value > 0);
    const result = rollPool({ ...EMPTY_POOL, ...draft.pool }, hasAutomatic ? automatic : null);
    const entry = {
      player: draft.player || "Unnamed",
      poolLabel: draft.label || poolLabel(draft.pool),
      weaponNote: draft.weaponNote || null,
      pool: { ...EMPTY_POOL, ...draft.pool },
      rolls: result.rolls.map((roll) => ({ die: roll.die, symbols: roll.symbols })),
      manual: hasAutomatic ? automatic : null,
      netSuccess: result.netSuccess,
      netAdvantage: result.netAdvantage,
      triumph: result.triumph,
      despair: result.despair,
      lightPoint: result.lightPoint,
      darkPoint: result.darkPoint,
      damage: draft.damage == null ? null : (result.netSuccess > 0 ? draft.damage + result.netSuccess : 0),
      clientId: draft.id,
    };
    try {
      const res = await apiFetch("/rolls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (res.ok) {
        try {
          if (campaignStorage.getItem("swrpg-dice-pool-client") === draft.id) {
            const cached = JSON.parse(campaignStorage.getItem("swrpg-dice-pool-cache") || "{}");
            campaignStorage.setItem("swrpg-dice-pool-cache", JSON.stringify({ pool: EMPTY_POOL, gmUpdatedAt: cached.gmUpdatedAt || 0, presetNonce: cached.presetNonce ?? null }));
          }
        } catch { /* ignore */ }
        announcePoolConsumed(draft.id);
        await onRefresh?.();
      }
    } catch { /* the shared-log status reports connectivity failures */ }
    finally { setRollingId(null); }
  }

  return (
    <div className="border p-4" style={{ borderColor: "#5ec8d855", background: "#101315", boxShadow: "0 0 24px rgba(94,200,216,0.05)" }}>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#5ec8d8" }}>Shared dice pools</div>
      </div>
      {pools.length === 0 ? (
        <div className="text-[12px]" style={{ color: logStatus.status === "error" ? "#c23b3b" : "#8a8f93" }}>
          {logStatus.status === "error" ? "Shared pools are not reachable." : "No one is building a dice pool."}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
          {pools.map((draft) => (
            <div key={draft.id} data-shared-pool-id={draft.id} className="border px-3 py-2.5 min-w-0" style={{ borderColor: "#3a3f42", background: "#16191b" }}>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="text-[13px] truncate" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>{draft.gm ? rollEntryName(draft, "Unnamed") : draft.player}</div>
                <button type="button" onClick={() => rollNow(draft)} disabled={!!rollingId} className="border px-2 py-1 text-[9px] tracking-[0.14em] uppercase disabled:opacity-50" style={{ color: "#101315", borderColor: "#5ec8d8", background: "#5ec8d8", fontWeight: 700 }}>
                  {rollingId === draft.id ? "Rolling…" : "Roll now"}
                </button>
              </div>
              {draft.label && <div className="text-[10px] truncate mb-2" style={{ color: "#8a8f93" }}>From {draft.label}</div>}
              <div className="min-h-7 flex items-center">
                <SelectedDiceSummary pool={draft.pool} size={24} onRemoveOne={(dieKey) => editPool(draft, dieKey, -1)} />
              </div>
              <div className="mt-2 pt-2 border-t" style={{ borderColor: "#2a2e31" }}>
                <div className="text-[9px] tracking-[0.14em] uppercase mb-1.5" style={{ color: "#5a5f62" }}>Dice controls · click pool die to remove</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {DIE_TYPES.slice().sort((a, b) => POOL_DISPLAY_ORDER.indexOf(a.key) - POOL_DISPLAY_ORDER.indexOf(b.key)).map((die) => (
                    <button key={die.key} type="button" onClick={() => editPool(draft, die.key, 1)} title={`Add one ${die.label} die`} className="p-1 border transition-colors hover:opacity-70" style={{ borderColor: "#3a3f42", background: "#101315" }}>
                      <DieFaceIcon img={die.img} label={die.label} size={20} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AnimatedFaceSymbol({ sym, dieKey, size }) {
  // Animation-only contrast. The shared log continues to use SymbolIcon and
  // therefore retains its established white artwork and layout.
  let imageSym = sym;
  if (dieKey === "force") {
    // The supplied light-side artwork is a filled disc and the dark-side
    // artwork is a ring. Swap their shapes for the physical Force-die faces:
    // dark = filled black; light = black ring with the white die showing
    // through its transparent centre.
    if (sym === "dp") imageSym = "lp";
    if (sym === "lp") imageSym = "dp";
  }
  const meta = SYMBOL_META[imageSym];
  const actual = SYMBOL_META[sym];
  if (!meta) return null;
  const needsBlack = dieKey === "ability" || dieKey === "proficiency" || dieKey === "boost" || dieKey === "force";
  return (
    <img
      src={meta.img}
      alt={actual?.label || sym}
      title={actual?.label || sym}
      style={{ width: size, height: size, display: "inline-block", filter: needsBlack ? "brightness(0)" : "none" }}
    />
  );
}

function RolledDieFace({ roll, size = 44 }) {
  const die = DIE_TYPES.find((candidate) => candidate.key === roll.die);
  if (!die) return null;
  const symbols = Array.isArray(roll.symbols) ? roll.symbols : [];
  const symbolSize = Math.round(size * (symbols.length > 1 ? 0.31 : 0.44));
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }} title={`${die.label}: ${symbols.length ? symbols.map((sym) => SYMBOL_META[sym]?.label || sym).join(" + ") : "Blank"}`}>
      <DieFaceIcon img={die.img} label={die.label} size={size} />
      <span className={`absolute inset-0 flex items-center justify-center ${symbols.length > 1 ? "flex-col gap-0" : "gap-[1px]"}`}>
        {symbols.map((sym, index) => <AnimatedFaceSymbol key={`${sym}-${index}`} sym={sym} dieKey={roll.die} size={symbolSize} />)}
      </span>
    </span>
  );
}

// The dice picker allows up to MAX_DICE_PER_TYPE of each of the 7 die types,
// so a full pool can be 56 dice; the animation shows every die up to that.
const DICE_BURST_MAX = 64;
function DiceBurst({ entry, enabled }) {
  if (!enabled || !entry || entry.utility) return null;
  const logRect = typeof document !== "undefined" ? document.querySelector("[data-shared-roll-log]")?.getBoundingClientRect() : null;
  const logTargetX = logRect ? logRect.left + Math.min(logRect.width / 2, 90) - 22 : (typeof window !== "undefined" ? window.innerWidth - 80 : 800);
  const logTargetY = logRect && typeof window !== "undefined" ? logRect.top + 30 - window.innerHeight + 22 : -80;
  const dice = Array.isArray(entry.rolls) && entry.rolls.length > 0
    ? entry.rolls
    : POOL_DISPLAY_ORDER.flatMap((key) => Array.from({ length: Math.max(0, Number(entry.pool?.[key]) || 0) }, () => ({ die: key, symbols: [] })));
  if (dice.length === 0) return null;
  const visibleDice = dice.slice(0, DICE_BURST_MAX);
  const columns = Math.min(visibleDice.length > 24 ? 8 : 6, visibleDice.length);
  const cell = visibleDice.length > 24 ? 48 : 56;
  const rows = Math.ceil(visibleDice.length / columns);
  return (
    <div key={entry.burstKey || entry.id} className="dice-burst-layer" aria-hidden="true">
      {visibleDice.map((roll, i) => {
        const column = i % columns;
        const row = Math.floor(i / columns);
        const xOffset = (column - (columns - 1) / 2) * cell;
        const yOffset = (row - (rows - 1) / 2) * cell;
        return (
          <span
            key={`${roll.die}-${i}`}
            className="dice-burst-item"
            style={{
              animationDelay: `${Math.min(i, 10) * 25}ms`,
              "--burst-x": `calc(50vw + ${xOffset - 22}px)`,
              "--burst-y": `calc(-50vh + ${yOffset + 22}px)`,
              "--burst-turn": `${720 + (i % 3) * 360}deg`,
              "--log-x": `${logTargetX}px`,
              "--log-y": `${logTargetY}px`,
            }}
          >
            <RolledDieFace roll={roll} size={44} />
          </span>
        );
      })}
    </div>
  );
}

function SharedRollLog({ log, logStatus, soundOn, setSoundOn, animationsOn, setAnimationsOn, burstEntry, copiedEntryId, handleClearLog, handleCopyEntry, allowClear = true, maxEntries = null }) {
  const visibleLog = maxEntries == null ? log : log.slice(0, maxEntries);
  return (
        <div className="pt-4 border-t" style={{ borderColor: "#2a2e31" }} data-shared-roll-log="1">
          <DiceBurst entry={burstEntry} enabled={animationsOn} />
          <div className="flex items-center justify-between mb-2 flex-wrap gap-y-1">
            <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#8a8f93" }}>Shared roll log</div>
            <div className="flex items-center gap-3">
              {logStatus.status === "error" && (
                <span className="text-[11px]" style={{ color: "#c23b3b" }}>{logStatus.msg}</span>
              )}
              <button
                onClick={() => setAnimationsOn((on) => !on)}
                className="text-[11px] tracking-[0.15em] uppercase px-3 py-1 border transition-colors"
                style={{ color: animationsOn ? "#ffb000" : "#5a5f62", borderColor: animationsOn ? "#ffb00066" : "#3a3f42" }}
                title={animationsOn ? "Turn off dice animations on this browser" : "Turn on dice animations on this browser"}
              >
                {animationsOn ? "◆ Dice motion on" : "◇ Dice motion off"}
              </button>
              <button
                onClick={() => setSoundOn((s) => !s)}
                className="text-[11px] tracking-[0.15em] uppercase px-3 py-1 border transition-colors"
                style={{ color: soundOn ? "#5ec8d8" : "#5a5f62", borderColor: soundOn ? "#5ec8d866" : "#3a3f42" }}
                title={soundOn ? "Mute sound on new rolls" : "Unmute sound on new rolls"}
              >
                {soundOn ? "🔔 Sound on" : "🔕 Muted"}
              </button>
              {allowClear && log.length > 0 && (
                <button
                  onClick={handleClearLog}
                  className="text-[11px] tracking-[0.15em] uppercase px-3 py-1 border transition-colors"
                  style={{ color: "#c23b3b", borderColor: "#c23b3b44" }}
                >
                  Clear log
                </button>
              )}
            </div>
          </div>
          {log.length === 0 ? (
            <span className="text-[13px]" style={{ color: "#5a5f62" }}>
              No rolls yet.{logStatus.status === "error" ? " Shared log isn't reachable yet — see setup note in the repo README." : ""}
            </span>
          ) : (
            <div className={maxEntries == null ? "space-y-2 max-h-[32rem] overflow-y-auto" : "space-y-2"}>
              {visibleLog.map((entry) => {
                // GM rolls get a coloured fill (friend / neutral / enemy)
                // plus a matching left edge so they stand out from player rolls.
                const toneColor = entry.gm ? gmToneColor(entry.gmTone) : null;
                const restBg = toneColor ? `${toneColor}2e` : "transparent";
                const hoverBg = toneColor ? `${toneColor}44` : "#5ec8d80a";
                const restBorder = toneColor ? `${toneColor}88` : "#2a2e31";
                return (
                <div
                  key={entry.id}
                  className={`relative pb-3 cursor-pointer transition-colors${toneColor ? " pt-2 px-2" : ""}`}
                  style={{ borderBottom: `1px solid ${restBorder}`, background: restBg, borderLeft: toneColor ? `3px solid ${toneColor}` : undefined }}
                  onClick={() => handleCopyEntry(entry)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = hoverBg; e.currentTarget.style.borderBottomColor = toneColor || "#5ec8d855"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = restBg; e.currentTarget.style.borderBottomColor = restBorder; }}
                  title="Click to copy this roll's result"
                >
                  {copiedEntryId === entry.id && (
                    <span
                      className="absolute right-0 -top-1 text-[10px] tracking-[0.15em] uppercase px-2 py-0.5"
                      style={{ color: "#6fae60", background: "#101315", border: "1px solid #6fae6066" }}
                    >
                      Copied!
                    </span>
                  )}
                  <div className="flex justify-between text-[12px] mb-1.5">
                    <span style={{ color: entry.gm ? "#e7e2d2" : entry.utility ? "#ffb000" : "#5ec8d8", fontWeight: entry.gm ? 700 : undefined }}>
                      {entry.gm ? (
                        <>
                          <span style={{ color: "#ffffff" }}>GM{gmRollHasName(entry) ? ": " : ""}</span>
                          {gmRollHasName(entry) ? entry.player : null}
                        </>
                      ) : entry.player}
                    </span>
                    <span style={{ color: "#5a5f62" }}>{new Date(entry.ts).toLocaleTimeString()}</span>
                  </div>
                  {entry.utility ? (
                    <div style={{ color: "#e7e2d2" }}>
                      {entry.utility.kind === "d100" && (
                        <div>D100 result: <span style={{ fontWeight: 700 }}>{entry.utility.roll}</span></div>
                      )}

                      {entry.utility.kind === "obligation" && (
                        <div>
                          <div className="mb-1">
                            Party Obligation total: <span style={{ fontWeight: 700 }}>{entry.utility.total}</span> — roll: <span style={{ fontWeight: 700 }}>{entry.utility.roll}</span>
                          </div>
                          {entry.utility.table && entry.utility.table.length > 0 && (
                            <table className="w-full text-left mb-1" style={{ borderCollapse: "collapse" }}>
                              <thead>
                                <tr style={{ color: "#8a8f93" }}>
                                  <th className="pr-3 py-0.5">Character</th>
                                  <th className="pr-3 py-0.5">Type</th>
                                  <th className="pr-3 py-0.5">Value</th>
                                </tr>
                              </thead>
                              <tbody>
                                {entry.utility.table.map((o, i) => (
                                  <tr key={i} style={{ color: entry.utility.triggered && entry.utility.triggered.startsWith(o.name) ? "#ffb000" : "#e7e2d2" }}>
                                    <td className="pr-3 py-0.5">{o.name}</td>
                                    <td className="pr-3 py-0.5">{o.type}</td>
                                    <td className="pr-3 py-0.5">{o.value}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          <div style={{ fontWeight: 700, color: entry.utility.triggered ? "#ffb000" : "#8a8f93" }}>
                            {entry.utility.triggered ? `Obligation triggers: ${entry.utility.triggered}` : "No Obligation triggers."}
                          </div>
                          {entry.utility.triggered && (
                            <div className="text-[12px] mt-1" style={{ color: "#c7c2b2" }}>
                              Strain thresholds reduced: triggered character −{entry.utility.double ? 4 : 2}; everyone else −{entry.utility.double ? 2 : 1}{entry.utility.double ? " (doubles rolled)" : ""}.
                            </div>
                          )}
                        </div>
                      )}

                      {(entry.utility.kind === "critInjury" || entry.utility.kind === "critHit") && (
                        <div>
                          <div className="mb-1 text-[12px]" style={{ color: "#8a8f93" }}>
                            {(entry.utility.kind === "critInjury" ? "Table VI-10" : "Table VII-9")} roll: <span style={{ fontWeight: 700, color: "#e7e2d2" }}>{entry.utility.roll}</span>
                            {entry.utility.modifier > 0 && <span> ({entry.utility.baseRoll} + {entry.utility.modifier})</span>}
                          </div>
                          {entry.utility.name ? (
                            <div>
                              <div className="mb-0.5" style={{ fontWeight: 700 }}>
                                {entry.utility.severity} — {entry.utility.name}
                              </div>
                              <div className="text-[13px]" style={{ color: "#c7c2b2" }}>{entry.utility.effect}</div>
                            </div>
                          ) : (
                            <div style={{ color: "#8a8f93" }}>No table entry matches that roll.</div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      {entry.weaponNote && (
                        <div className="mb-1.5 flex flex-wrap gap-1.5">
                          {splitSpecial(entry.weaponNote).map((sp, i) => <SpecialChip key={i} text={sp} placement="below" />)}
                        </div>
                      )}
                      {entry.rolls && entry.rolls.length > 0 ? (
                        <div className="mb-1.5"><RollResultsStrip rolls={entry.rolls} /></div>
                      ) : entry.pool && (
                        <div className="mb-1.5">
                          <PoolIconStrip pool={entry.pool} />
                        </div>
                      )}
                      {entry.manual && MANUAL_SYMBOL_TYPES.some((sym) => entry.manual[sym] > 0) && (
                        <div className="mb-1.5 flex flex-wrap items-center gap-3 text-[11px]" style={{ color: "#5a5f62" }}>
                          <span>+ added by hand:</span>
                          {MANUAL_SYMBOL_TYPES.filter((sym) => entry.manual[sym] > 0).map((sym) => (
                            <SymbolTally key={sym} sym={sym} count={entry.manual[sym]} size={14} />
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-5" style={{ color: "#e7e2d2" }}>
                        {entry.netSuccess !== 0 ? (
                          <SymbolTally sym={entry.netSuccess > 0 ? "s" : "f"} count={Math.abs(entry.netSuccess)} size={42} withLabel fontSize={22} />
                        ) : (entry.pool?.difficulty || 0) + (entry.pool?.challenge || 0) + (entry.manual?.f || 0) + (entry.manual?.d || 0) > 0 ? (
                          <span style={{ fontSize: 22, fontFamily: "'Rajdhani', sans-serif", fontWeight: 600 }}>Failure</span>
                        ) : (
                          // Unopposed roll (e.g. initiative) with nothing left after cancelling.
                          <span style={{ fontSize: 22, fontFamily: "'Rajdhani', sans-serif", fontWeight: 600, color: "#8a8f93" }}>0 Success</span>
                        )}
                        {entry.netAdvantage !== 0 && (
                          <SymbolTally sym={entry.netAdvantage > 0 ? "a" : "t"} count={Math.abs(entry.netAdvantage)} size={42} withLabel fontSize={22} />
                        )}
                        {entry.triumph > 0 && <SymbolTally sym="tr" count={entry.triumph} size={42} withLabel fontSize={22} />}
                        {entry.despair > 0 && <SymbolTally sym="d" count={entry.despair} size={42} withLabel fontSize={22} />}
                        {entry.lightPoint > 0 && <SymbolTally sym="lp" count={entry.lightPoint} size={42} withLabel fontSize={22} />}
                        {entry.darkPoint > 0 && <SymbolTally sym="dp" count={entry.darkPoint} size={42} withLabel fontSize={22} />}
                      </div>
                      {entry.damage != null && (
                        <div className="mt-1.5 text-[13px]" style={{ color: entry.damage > 0 ? "#ffb000" : "#8a8f93", fontWeight: 700 }}>
                          Total damage: <span className="mono-num">{entry.damage}</span>{entry.damage === 0 ? " (attack missed)" : ""}
                        </div>
                      )}
                    </>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
  );
}

// Fired when a pool has been used up (rolled from the tray or the roller,
// or cleared). The weapon preset that seeded it lives in App state and is
// re-read whenever the Dice Roller remounts, so it has to be dropped too or
// its weapon note, damage and automatic results come back on later rolls.
const POOL_CONSUMED_EVENT = "swrpg-pool-consumed";
function announcePoolConsumed(clientId) {
  try { window.dispatchEvent(new CustomEvent(POOL_CONSUMED_EVENT, { detail: { clientId } })); } catch { /* ignore */ }
}

function getDicePoolClientId() {
  try {
    const existing = campaignStorage.getItem("swrpg-dice-pool-client");
    if (existing) return existing;
    const id = crypto.randomUUID();
    campaignStorage.setItem("swrpg-dice-pool-client", id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function readDicePoolCache() {
  try {
    const cached = JSON.parse(campaignStorage.getItem("swrpg-dice-pool-cache") || "{}");
    return {
      pool: cached?.pool ? { ...EMPTY_POOL, ...cached.pool } : null,
      gmUpdatedAt: cached?.gmUpdatedAt || 0,
      presetNonce: cached?.presetNonce ?? null,
    };
  } catch {
    return { pool: null, gmUpdatedAt: 0, presetNonce: null };
  }
}

function DiceRollerPanel({ playerName, setPlayerName, preset, partyDestiny, destinyLightSweepOn, destinyDarkSweepOn, destinyLightDir, destinyDarkDir, initiative, party, manual, gmKey }) {
  // gmKey is only set while the GM is signed in. Every roll this panel posts
  // then carries it, so the Worker marks the roll as "GM:" in the shared log,
  // filled with the friend/neutral/enemy colour chosen beside the name box.
  const isGm = !!gmKey;
  const [gmTone, setGmTone] = useState(() => {
    try {
      const saved = campaignStorage.getItem(GM_TONE_STORAGE);
      return GM_TONES.some((t) => t.key === saved) ? saved : "enemy";
    } catch { return "enemy"; }
  });
  useEffect(() => {
    try { campaignStorage.setItem(GM_TONE_STORAGE, gmTone); } catch { /* ignore */ }
  }, [gmTone]);
  function rollHeaders() {
    return isGm ? { "content-type": "application/json", "x-gm-key": gmKey } : { "content-type": "application/json" };
  }
  const initialPoolCacheRef = useRef(null);
  if (!initialPoolCacheRef.current) initialPoolCacheRef.current = readDicePoolCache();
  const initialPoolCache = initialPoolCacheRef.current;
  const presetIsNew = !!preset && preset.nonce !== initialPoolCache.presetNonce;
  const [pool, setPool] = useState(() => presetIsNew ? preset.pool : (initialPoolCache.pool || preset?.pool || { ...EMPTY_POOL }));
  const activePresetNonceRef = useRef(presetIsNew ? preset.nonce : initialPoolCache.presetNonce);
  const [loadedLabel, setLoadedLabel] = useState(preset?.label || null);
  // Weapon Special text (e.g. "Pierce 2, Vicious 1"), only set when the
  // current preset came from clicking a weapon row — carried through to
  // the posted roll-log entry so it can show as its own small tag on the
  // entry (see handleRoll and the log entry render below) and gets folded
  // into the copied clipboard text too.
  const [loadedWeaponNote, setLoadedWeaponNote] = useState(preset?.weaponNote || null);
  const [loadedDamage, setLoadedDamage] = useState(preset?.damage ?? null);
  const [lastResult, setLastResult] = useState(null);
  const [selectedDifficultyPreset, setSelectedDifficultyPreset] = useState(null);
  const [selectedManeuver, setSelectedManeuver] = useState(null);
  // Per-click history of what the upgrade buttons actually did, so the
  // downgrade buttons can undo the exact most recent step rather than
  // guess from the pool totals alone. FFG RAW: to upgrade a die, exchange
  // one die for the next die up (Ability→Proficiency, Difficulty→
  // Challenge); if there's no die of the base type left to upgrade, add a
  // die of that base type to the pool instead (it is NOT immediately
  // upgraded — a later click converts it once it's actually present). That
  // means repeated clicking past zero alternates "add" / "convert", and
  // once both the base and upgraded type are non-zero there's no way to
  // tell from the pool counts alone which action was most recent — hence
  // the stack. Each entry is "convert" or "add"; reset to [] whenever the
  // pool changes some other way (manual counter edit, a difficulty-preset
  // pick that force-resets Challenge, Clear pool, or loading a skill/
  // weapon preset), since at that point there's no reliable history left.
  const [abilityUpgradeStack, setAbilityUpgradeStack] = useState([]);
  const [difficultyUpgradeStack, setDifficultyUpgradeStack] = useState([]);
  // "Add dice results" panel — lets a player fold a manually-granted symbol
  // (a GM-awarded Advantage, a Triumph, etc.) into the next roll without a
  // die actually producing it. Collapsed by default (manualOpen) since it's
  // rarely needed; cleared after each Roll (see handleRoll) since it's
  // meant as a one-off addition to that specific roll, not a standing part
  // of the pool the way dice are.
  const [manualOpen, setManualOpen] = useState(false);
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [criticalInjuryModifier, setCriticalInjuryModifier] = useState(0);
  const [criticalHitModifier, setCriticalHitModifier] = useState(0);
  const [manualSymbols, setManualSymbols] = useState(EMPTY_MANUAL);
  const [automaticSymbols, setAutomaticSymbols] = useState(() => ({ ...EMPTY_MANUAL, ...(preset?.automaticResults || {}) }));
  // Percentile utility rolls — d100-based subsystems that sit outside the
  // narrative dice pool entirely (Obligation, Critical Injury, Critical
  // Hit) plus a bare D100 for anything else that needs one. Each one posts
  // straight to the shared roll log (see postUtilityRoll) and is shown only
  // there — there's no separate local echo of the result here.
  const rollLog = useRollLog();
  const { fetchLog, setLogStatus } = rollLog;
  const poolPublishTimerRef = useRef(null);
  const latestPoolDraftRef = useRef(null);
  const poolDraftPendingRef = useRef(false);
  const lastGmPoolUpdateRef = useRef(initialPoolCache.gmUpdatedAt);
  const poolClientIdRef = useRef(null);
  if (!poolClientIdRef.current) poolClientIdRef.current = getDicePoolClientId();

  // A pool that was rolled elsewhere (the battle-map tray) or cleared: reset
  // everything the loaded weapon/skill put on it so nothing carries into the
  // next roll.
  useEffect(() => {
    function onConsumed(event) {
      if (event.detail?.clientId !== poolClientIdRef.current) return;
      setPool({ ...EMPTY_POOL });
      setLoadedLabel(null);
      setLoadedWeaponNote(null);
      setLoadedDamage(null);
      setAutomaticSymbols(EMPTY_MANUAL);
      setManualSymbols(EMPTY_MANUAL);
      setSelectedDifficultyPreset(null);
      setSelectedManeuver(null);
      setAbilityUpgradeStack([]);
      setDifficultyUpgradeStack([]);
    }
    window.addEventListener(POOL_CONSUMED_EVENT, onConsumed);
    return () => window.removeEventListener(POOL_CONSUMED_EVENT, onConsumed);
  }, []);

  async function publishPoolDraft(draft, keepalive = false) {
    poolDraftPendingRef.current = false;
    try {
      await apiFetch("/rolls", {
        method: "PUT",
        keepalive,
        headers: rollHeaders(),
        body: JSON.stringify(draft),
      });
    } catch { /* the normal roll-log status will show connection trouble */ }
  }

  // Publish the pool only after the player pauses editing for 500ms. Rapid
  // clicks therefore collapse into one Worker request instead of one write
  // per die. An empty pool removes this browser's draft from the tray.
  useEffect(() => {
    const draft = {
      clientId: poolClientIdRef.current,
      player: (playerName || "Unnamed").slice(0, 40),
      label: loadedLabel || "Custom pool",
      pool,
      weaponNote: loadedWeaponNote || null,
      damage: loadedDamage,
      automaticResults: automaticSymbols,
      gmTone,
    };
    latestPoolDraftRef.current = draft;
    poolDraftPendingRef.current = true;
    try {
      campaignStorage.setItem("swrpg-dice-pool-cache", JSON.stringify({ pool, gmUpdatedAt: lastGmPoolUpdateRef.current, presetNonce: activePresetNonceRef.current ?? null }));
    } catch { /* ignore */ }
    clearTimeout(poolPublishTimerRef.current);
    poolPublishTimerRef.current = setTimeout(() => publishPoolDraft(draft), 500);
    return () => clearTimeout(poolPublishTimerRef.current);
  }, [pool, loadedLabel, playerName, loadedWeaponNote, loadedDamage, automaticSymbols, gmTone, gmKey]);

  // If the player switches to the Battle Map inside that half-second, flush
  // the latest edit during unmount so the tray still shows what they built.
  useEffect(() => () => {
    clearTimeout(poolPublishTimerRef.current);
    if (poolDraftPendingRef.current && latestPoolDraftRef.current) {
      publishPoolDraft(latestPoolDraftRef.current, true);
    }
  }, []);

  // Battle Map edits are marked by the Worker. When this browser sees a
  // newer revision for its own draft, apply that complete pool locally so
  // the Dice Roller and battle tray remain the same pool.
  useEffect(() => {
    const remote = rollLog.sharedPools.find((draft) => draft.id === poolClientIdRef.current);
    if (!remote || remote.updatedBy !== "battlemap" || remote.updatedAt <= lastGmPoolUpdateRef.current) return;
    lastGmPoolUpdateRef.current = remote.updatedAt;
    const nextPool = { ...EMPTY_POOL, ...remote.pool };
    // Cancel any older debounced player write before applying the GM's
    // authoritative revision. Otherwise a quick tab change could flush that
    // stale draft during unmount and undo the GM edit on the Worker.
    clearTimeout(poolPublishTimerRef.current);
    poolDraftPendingRef.current = false;
    latestPoolDraftRef.current = {
      clientId: poolClientIdRef.current,
      player: remote.player,
      label: remote.label,
      pool: nextPool,
    };
    setPool(nextPool);
    try { campaignStorage.setItem("swrpg-dice-pool-cache", JSON.stringify({ pool: nextPool, gmUpdatedAt: remote.updatedAt, presetNonce: activePresetNonceRef.current ?? null })); } catch { /* ignore */ }
    setSelectedDifficultyPreset(null);
    setSelectedManeuver(null);
    setAbilityUpgradeStack([]);
    setDifficultyUpgradeStack([]);
  }, [rollLog.sharedPools]);

  // Clicking a skill's dice pips (Character Sheet tab or Party View) seeds
  // this pool with that skill's Proficiency/Ability/talent-Boost dice —
  // never Difficulty/Challenge/Setback/Force, since those are scene- and
  // GM-judgment-dependent, not part of the character's fixed dice pool.
  // Keyed on preset.nonce (not the pool object itself) so clicking the same
  // skill twice in a row still re-applies it.
  useEffect(() => {
    if (preset) {
      const cached = readDicePoolCache();
      // The same preset object remains in the parent while tabs change. It
      // must not overwrite a pool that the GM subsequently edited. A newly
      // clicked skill/weapon has a fresh nonce and still loads normally.
      if (preset.nonce === cached.presetNonce) return;
      activePresetNonceRef.current = preset.nonce;
      setPool(preset.pool);
      setLoadedLabel(preset.label || null);
      setLoadedWeaponNote(preset.weaponNote || null);
      setLoadedDamage(preset.damage ?? null);
      setManualSymbols(EMPTY_MANUAL);
      setAutomaticSymbols({ ...EMPTY_MANUAL, ...(preset.automaticResults || {}) });
      setSelectedDifficultyPreset(null);
      setSelectedManeuver(null);
      setAbilityUpgradeStack([]);
      setDifficultyUpgradeStack([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce]);

  function updateDie(key, value) {
    setPool((p) => ({ ...p, [key]: Math.max(0, Math.min(MAX_DICE_PER_TYPE, value)) }));
    if (key === "difficulty" || key === "challenge") setSelectedDifficultyPreset(null);
    // Boost/Setback deliberately do NOT clear the selected maneuver here —
    // the active maneuver (if any) still just adds its own fixed
    // contribution on top of whatever's in the pool, manual edits included,
    // rather than claiming exclusive ownership of Boost/Setback. See
    // selectManeuver below for how switching/deselecting stays exact.
    // A manual edit to any of the 4 dice types the upgrade/downgrade
    // buttons touch invalidates the upgrade-history stack — reset it
    // rather than risk the downgrade button acting on stale info.
    if (key === "ability" || key === "proficiency") setAbilityUpgradeStack([]);
    if (key === "difficulty" || key === "challenge") setDifficultyUpgradeStack([]);
  }

  // The 9 purple difficulty buttons (5 Quick difficulty tiers + 4 range/
  // melee presets) are a single mutually-exclusive group: picking one sets
  // the Difficulty pool to exactly what it represents (clearing any prior
  // Challenge-die upgrade, since that belonged to whichever tier was
  // selected before) and marks it as the selected button.
  function selectDifficultyPreset(id, count) {
    setPool((p) => ({ ...p, difficulty: Math.min(MAX_DICE_PER_TYPE, count), challenge: 0 }));
    setSelectedDifficultyPreset(id);
    // Challenge is force-reset to 0 here, so any upgrade-history for it
    // is moot.
    setDifficultyUpgradeStack([]);
  }

  // Clears whichever of the 9 difficulty-preset buttons is currently
  // active — zeroing both Difficulty and Challenge (a Challenge upgrade
  // only ever belonged to the preset that was selected when it happened).
  // Reachable two ways: right-clicking any button in the group, or
  // left-clicking the already-active one again.
  function deselectDifficultyPreset() {
    setPool((p) => ({ ...p, difficulty: 0, challenge: 0 }));
    setSelectedDifficultyPreset(null);
    setDifficultyUpgradeStack([]);
  }

  // The 4 Maneuver buttons (Aim/Double Aim/Called Shot/Double Called Shot)
  // are still mutually exclusive among themselves — only one can be active
  // at a time — but no longer overwrite Boost/Setback wholesale. Selecting
  // one adds its fixed contribution on top of whatever's already in the
  // pool (manual dice from the counters above); switching to a different
  // maneuver first subtracts the outgoing one's contribution, then adds
  // the new one; clicking the already-active maneuver again deselects it,
  // subtracting exactly what it added. All subtraction is clamped at 0 so
  // it can never take a manually-added die below zero.
  function selectManeuver(id, boost, setback) {
    const outgoing = selectedManeuver ? MANEUVER_DELTAS[selectedManeuver] : null;
    if (selectedManeuver === id) {
      // Already active — deselect, removing exactly what it added.
      setPool((p) => ({
        ...p,
        boost: Math.max(0, (p.boost || 0) - boost),
        setback: Math.max(0, (p.setback || 0) - setback),
      }));
      setSelectedManeuver(null);
      return;
    }
    setPool((p) => {
      let nextBoost = p.boost || 0;
      let nextSetback = p.setback || 0;
      if (outgoing) {
        nextBoost = Math.max(0, nextBoost - outgoing.boost);
        nextSetback = Math.max(0, nextSetback - outgoing.setback);
      }
      nextBoost = Math.min(MAX_DICE_PER_TYPE, nextBoost + boost);
      nextSetback = Math.min(MAX_DICE_PER_TYPE, nextSetback + setback);
      return { ...p, boost: nextBoost, setback: nextSetback };
    });
    setSelectedManeuver(id);
  }

  // FFG "upgrade" rule: to upgrade a die, exchange one die for the next
  // die up (Ability→Proficiency). If there is no Ability die in the pool
  // to upgrade, add an Ability die to the pool instead — it is NOT
  // immediately converted; a later upgrade click converts it once it's
  // actually present. Each click's action ("convert" or "add") is pushed
  // onto abilityUpgradeStack so downgrade can undo precisely.
  function upgradeAbilityToProficiency() {
    if ((pool.ability || 0) > 0) {
      if ((pool.proficiency || 0) >= MAX_DICE_PER_TYPE) return;
      setPool((p) => ({ ...p, ability: p.ability - 1, proficiency: (p.proficiency || 0) + 1 }));
      setAbilityUpgradeStack((st) => [...st, "convert"]);
    } else {
      if ((pool.ability || 0) >= MAX_DICE_PER_TYPE) return;
      setPool((p) => ({ ...p, ability: (p.ability || 0) + 1 }));
      setAbilityUpgradeStack((st) => [...st, "add"]);
    }
  }

  // Same rule for Difficulty → Challenge.
  function upgradeDifficultyToChallenge() {
    if ((pool.difficulty || 0) > 0) {
      if ((pool.challenge || 0) >= MAX_DICE_PER_TYPE) return;
      setPool((p) => ({ ...p, difficulty: p.difficulty - 1, challenge: (p.challenge || 0) + 1 }));
      setDifficultyUpgradeStack((st) => [...st, "convert"]);
    } else {
      if ((pool.difficulty || 0) >= MAX_DICE_PER_TYPE) return;
      setPool((p) => ({ ...p, difficulty: (p.difficulty || 0) + 1 }));
      setDifficultyUpgradeStack((st) => [...st, "add"]);
    }
  }

  // Undo one step of an upgrade mis-click. Pool-only, same as the upgrade
  // functions above — never touches the destiny pool. Pops the most
  // recent tracked action and reverses exactly that: "convert" gives the
  // die back to the base type, "add" just removes the die that was added.
  // Once the pool counts alone can no longer distinguish add from convert
  // (both Ability and Proficiency non-zero), the stack is what makes this
  // reliable rather than a guess. With no tracked history left — e.g. the
  // character's own innate Proficiency from the loaded skill, which was
  // never produced by a click — falls back to the plain reverse.
  function downgradeProficiencyToAbility() {
    if (abilityUpgradeStack.length > 0) {
      const last = abilityUpgradeStack[abilityUpgradeStack.length - 1];
      if (last === "convert") {
        if ((pool.proficiency || 0) <= 0) return;
        setPool((p) => ({ ...p, proficiency: p.proficiency - 1, ability: (p.ability || 0) + 1 }));
      } else {
        if ((pool.ability || 0) <= 0) return;
        setPool((p) => ({ ...p, ability: p.ability - 1 }));
      }
      setAbilityUpgradeStack((st) => st.slice(0, -1));
      return;
    }
    if ((pool.proficiency || 0) <= 0 || (pool.ability || 0) >= MAX_DICE_PER_TYPE) return;
    setPool((p) => ({ ...p, proficiency: p.proficiency - 1, ability: (p.ability || 0) + 1 }));
  }

  function downgradeChallengeToDifficulty() {
    if (difficultyUpgradeStack.length > 0) {
      const last = difficultyUpgradeStack[difficultyUpgradeStack.length - 1];
      if (last === "convert") {
        if ((pool.challenge || 0) <= 0) return;
        setPool((p) => ({ ...p, challenge: p.challenge - 1, difficulty: (p.difficulty || 0) + 1 }));
      } else {
        if ((pool.difficulty || 0) <= 0) return;
        setPool((p) => ({ ...p, difficulty: p.difficulty - 1 }));
      }
      setDifficultyUpgradeStack((st) => st.slice(0, -1));
      return;
    }
    if ((pool.challenge || 0) <= 0 || (pool.difficulty || 0) >= MAX_DICE_PER_TYPE) return;
    setPool((p) => ({ ...p, challenge: p.challenge - 1, difficulty: (p.difficulty || 0) + 1 }));
  }

  // Mirrors the click-time branching above, used to drive the buttons'
  // disabled state so the UI never claims a click will do nothing when it
  // actually would (or vice versa).
  function canUpgradeAbility() {
    if ((pool.ability || 0) > 0) return (pool.proficiency || 0) < MAX_DICE_PER_TYPE;
    return (pool.ability || 0) < MAX_DICE_PER_TYPE;
  }
  function canDowngradeAbility() {
    if (abilityUpgradeStack.length > 0) {
      const last = abilityUpgradeStack[abilityUpgradeStack.length - 1];
      return last === "convert" ? (pool.proficiency || 0) > 0 : (pool.ability || 0) > 0;
    }
    return (pool.proficiency || 0) > 0 && (pool.ability || 0) < MAX_DICE_PER_TYPE;
  }
  function canUpgradeDifficulty() {
    if ((pool.difficulty || 0) > 0) return (pool.challenge || 0) < MAX_DICE_PER_TYPE;
    return (pool.difficulty || 0) < MAX_DICE_PER_TYPE;
  }
  function canDowngradeDifficulty() {
    if (difficultyUpgradeStack.length > 0) {
      const last = difficultyUpgradeStack[difficultyUpgradeStack.length - 1];
      return last === "convert" ? (pool.challenge || 0) > 0 : (pool.difficulty || 0) > 0;
    }
    return (pool.challenge || 0) > 0 && (pool.difficulty || 0) < MAX_DICE_PER_TYPE;
  }

  // A flat, unweighted 1-100 — used directly by the D100 button and as the
  // shared underlying roll for the Obligation/Critical Injury/Critical Hit
  // buttons below, all of which are percentile checks rather than the
  // narrative symbol dice the rest of this panel builds pools for.
  function rollUtilityD100() {
    return Math.floor(Math.random() * 100) + 1;
  }

  function handleD100() {
    const roll = rollUtilityD100();
    postUtilityRoll("D100", { kind: "d100", roll });
  }

  // Obligation check, per the core rules: build a table of every party
  // member's Obligation (type + value, straight from the loaded ledger),
  // sum it, then roll d100. A roll at or under the total triggers whichever
  // PC's slice of that total the roll landed in (cumulative ranges in
  // ledger order). Nothing here is recorded anywhere — it's the GM's call
  // what happens next.
  function handleObligationCheck() {
    const table = (party || [])
      .map((c) => {
        const ob = c?.motivationObligation?.obligation;
        const value = Number(ob?.value) || 0;
        if (!ob || value <= 0) return null;
        return { id: c.liveId || c.name, name: c.name, type: ob.type || "Obligation", value };
      })
      .filter(Boolean);
    const total = table.reduce((sum, o) => sum + o.value, 0);
    const roll = rollUtilityD100();
    let triggered = null;
    if (total > 0 && roll <= total) {
      let cursor = 0;
      for (const o of table) {
        cursor += o.value;
        if (roll <= cursor) {
          triggered = o;
          break;
        }
      }
    }
    const doubleResult = roll < 100 && roll % 11 === 0;
    const multiplier = doubleResult ? 2 : 1;
    const penalties = triggered
      ? Object.fromEntries((party || []).filter((c) => c.liveId || c.name).map((c) => {
          const id = c.liveId || c.name;
          return [id, (id === triggered.id ? 2 : 1) * multiplier];
        }))
      : {};
    manual.setObligationStrain({
      active: !!triggered,
      triggeredId: triggered?.id || "",
      triggeredName: triggered?.name || "",
      multiplier,
      roll,
      penalties,
    });
    postUtilityRoll("Obligation Check", {
      kind: "obligation",
      roll,
      total,
      table,
      double: doubleResult,
      triggered: triggered ? `${triggered.name} (${triggered.type})` : null,
    });
  }

  // Posts a utility roll (D100, Obligation Check, Critical Injury, Critical
  // Hit) to the same shared log narrative rolls use, so everyone watching
  // the dashboard sees it without anyone needing to touch the log
  // themselves. Deliberately not attributed to any character — the
  // "player" field is a fixed label ("D100", "Obligation Check", "Critical
  // Injury", "Critical Hit"), not a PC/NPC name, matching the "dumb button,
  // don't record who it happens to" instruction. The result only ever shows
  // up in that shared log — there's deliberately no separate inline echo of
  // it here, so it isn't shown twice.
  async function postUtilityRoll(label, utility) {
    try {
      const res = await apiFetch("/rolls", {
        method: "POST",
        headers: rollHeaders(),
        body: JSON.stringify({ player: label, utility, gmTone }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLogStatus({ status: "error", msg: data.error || `Could not post roll (${res.status})` });
      } else {
        fetchLog();
      }
    } catch (err) {
      setLogStatus({ status: "error", msg: err.message });
    }
  }

  // Full Table VI-10: Critical Injury Result lookup (CRITICAL_INJURY_TABLE,
  // defined near lookupCriticalInjury above). "Dumb button" per the
  // facilitator's instructions — it doesn't ask who suffers it or record
  // anything beyond the roll and result, just returns the full named result
  // and effect and drops it in the shared log for everyone to see.
  function handleCriticalInjury() {
    const baseRoll = rollUtilityD100();
    const modifier = Math.max(0, Math.min(999, Number(criticalInjuryModifier) || 0));
    const roll = baseRoll + modifier;
    const entry = CRITICAL_INJURY_TABLE.find((r) => roll >= r.min && roll <= r.max);
    postUtilityRoll("Critical Injury", {
      kind: "critInjury",
      roll,
      baseRoll,
      modifier,
      severity: entry?.severity || "",
      name: entry?.name || "",
      effect: entry?.effect || "",
    });
  }

  // Same idea for Table VII-9: Critical Hit Result (CRITICAL_HIT_TABLE,
  // defined near lookupCriticalHitByRoll above) — vehicle/starship hits.
  function handleCriticalHit() {
    const baseRoll = rollUtilityD100();
    const modifier = Math.max(0, Math.min(999, Number(criticalHitModifier) || 0));
    const roll = baseRoll + modifier;
    const entry = lookupCriticalHitByRoll(roll);
    postUtilityRoll("Critical Hit", {
      kind: "critHit",
      roll,
      baseRoll,
      modifier,
      severity: entry?.severity || "",
      name: entry?.name || "",
      effect: entry?.effect || "",
    });
  }

  async function handleRoll() {
    // Clicking Roll is a user gesture, so use it to "unlock" playback —
    // browsers block audio.play() until one has occurred on the page. Play
    // silently and immediately pause so a viewer who only ever clicks Roll
    // (never anything else) still gets sound for everyone else's rolls too.
    try {
      const primer = new Audio(ROLL_SOUNDS[0]);
      primer.volume = 0;
      primer.play().then(() => primer.pause()).catch(() => {});
    } catch { /* ignore */ }
    const combinedSymbols = Object.fromEntries(MANUAL_SYMBOL_TYPES.map((key) => [key, (manualSymbols[key] || 0) + (automaticSymbols[key] || 0)]));
    const hasManual = Object.values(combinedSymbols).some((v) => v > 0);
    const result = rollPool(pool, hasManual ? combinedSymbols : null);
    setLastResult(result);
    const entry = {
      player: (playerName || "Unnamed").slice(0, 40),
      poolLabel: poolLabel(pool),
      weaponNote: loadedWeaponNote || null,
      pool: { ...pool },
      rolls: result.rolls.map((r) => ({ die: r.die, symbols: r.symbols })),
      manual: hasManual ? { ...combinedSymbols } : null,
      netSuccess: result.netSuccess,
      netAdvantage: result.netAdvantage,
      triumph: result.triumph,
      despair: result.despair,
      lightPoint: result.lightPoint,
      darkPoint: result.darkPoint,
      damage: loadedDamage == null ? null : (result.netSuccess > 0 ? loadedDamage + result.netSuccess : 0),
      clientId: poolClientIdRef.current,
      gmTone,
    };
    // Manual results are a one-off addition to this specific roll, not a
    // standing part of the pool — clear them once folded in, same way the
    // maneuver/difficulty-preset selections don't persist meaning beyond
    // the roll they were built for.
    if (hasManual) setManualSymbols(EMPTY_MANUAL);
    try {
      const res = await apiFetch("/rolls", {
        method: "POST",
        headers: rollHeaders(),
        body: JSON.stringify(entry),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLogStatus({ status: "error", msg: data.error || `Could not post roll (${res.status})` });
      } else {
        // A completed roll consumes the assembled pool. Clear every local
        // modifier tied to it; the Worker atomically removes its shared tray
        // draft using clientId, so everyone sees the same empty state.
        setPool({ ...EMPTY_POOL });
        setLoadedLabel(null);
        setLoadedWeaponNote(null);
        setLoadedDamage(null);
        setAutomaticSymbols(EMPTY_MANUAL);
        setSelectedDifficultyPreset(null);
        setSelectedManeuver(null);
        setAbilityUpgradeStack([]);
        setDifficultyUpgradeStack([]);
        announcePoolConsumed(poolClientIdRef.current);
        try { campaignStorage.setItem("swrpg-dice-pool-cache", JSON.stringify({ pool: EMPTY_POOL, gmUpdatedAt: lastGmPoolUpdateRef.current, presetNonce: activePresetNonceRef.current ?? null })); } catch { /* ignore */ }
        fetchLog();
      }
    } catch (err) {
      setLogStatus({ status: "error", msg: err.message });
    }
  }

  const forceDie = DIE_TYPES.find((d) => d.key === "force");
  const mainDice = DIE_TYPES.filter((d) => d.key !== "force");
  const setbackDie = DIE_TYPES.find((d) => d.key === "setback");
  const difficultyDie = DIE_TYPES.find((d) => d.key === "difficulty");
  const boostDie = DIE_TYPES.find((d) => d.key === "boost");

  return (
    <div className="relative overflow-hidden border" style={{ borderColor: "#3a3f42", background: "#16191b", boxShadow: "0 0 30px rgba(94,200,216,0.06)" }}>
      <div className="p-5 sm:p-7">
        <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#5ec8d8" }}>SHARED SESSION TOOL</div>
        <h1 className="text-2xl sm:text-3xl uppercase tracking-wide mb-4" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          Dice Roller
        </h1>

        <InitiativeTracker initiative={initiative} />
        {partyDestiny && (
          <div className="border p-3 mb-4 flex items-center gap-6 flex-wrap" style={{ borderColor: "#ffb00055", background: "#ffb00009" }}>
            <div className="text-[11px] tracking-[0.2em] uppercase flex items-center gap-1.5" style={{ color: "#ffb000" }}>
              <DestinyRulesTip>
                Party Destiny Pool
              </DestinyRulesTip>
            </div>
            <div className="flex items-center gap-1.5">
              <DestinyTokens count={partyDestiny.light} src={BLUE_TOKEN} alt="Light Side Destiny Point" sweepActive={destinyLightSweepOn} sweepDir={destinyLightDir} sweepColor="#8fd3f4" onFlip={() => manual.flipDestiny("light")} />
              <span className="text-[11px]" style={{ color: "#8a8f93" }}>light</span>
            </div>
            <div className="flex items-center gap-1.5">
              <DestinyTokens count={partyDestiny.dark} src={RED_TOKEN} alt="Dark Side Destiny Point" sweepActive={destinyDarkSweepOn} sweepDir={destinyDarkDir} sweepColor="#c23b3b" onFlip={() => manual.flipDestiny("dark")} />
              <span className="text-[11px]" style={{ color: "#8a8f93" }}>dark</span>
            </div>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="w-full sm:w-64">
            <label className="text-[11px] tracking-[0.2em] uppercase block mb-1.5" style={{ color: "#8a8f93" }}>
              {isGm ? "Name (shown as GM: name in the shared log)" : "Your name (shown in the shared log)"}
            </label>
            <input
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder={isGm ? "e.g. Stormtrooper Sergeant" : "e.g. your character name"}
              className="w-full bg-transparent border px-2 py-1.5 text-[13px]"
              style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
            />
          </div>
          {isGm && (
            <div>
              <div className="text-[11px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#8a8f93" }}>GM roll colour</div>
              <div role="radiogroup" aria-label="GM roll colour" className="inline-flex border" style={{ borderColor: "#3a3f42" }}>
                {GM_TONES.map((tone) => {
                  const active = gmTone === tone.key;
                  return (
                    <button
                      key={tone.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setGmTone(tone.key)}
                      title={`GM rolls show with a ${tone.label.toLowerCase()} fill in the shared log`}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] tracking-wide transition-colors"
                      style={{
                        background: active ? tone.color : "transparent",
                        color: active ? "#ffffff" : "#8a8f93",
                        fontFamily: "'Rajdhani', sans-serif",
                        fontWeight: 700,
                      }}
                    >
                      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: tone.color, boxShadow: active ? "0 0 0 1px #ffffff" : "none" }} />
                      {tone.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="grid sm:grid-cols-2 gap-2 mb-2">
          {mainDice.map((dt) => (
            <DiceCounter key={dt.key} dieType={dt} count={pool[dt.key]} onChange={(v) => updateDie(dt.key, v)} />
          ))}
        </div>
        <div className="grid sm:grid-cols-2 gap-2 mb-4">
          <DiceCounter dieType={forceDie} count={pool.force} onChange={(v) => updateDie("force", v)} />
          <ManualResultsToggle
            open={manualOpen}
            onOpen={() => setManualOpen(true)}
            onClose={() => setManualOpen(false)}
            hasPending={Object.values(manualSymbols).some((v) => v > 0) || Object.values(automaticSymbols).some((v) => v > 0)}
          />
        </div>

        {manualOpen && (
          <div className="mb-5">
            <p className="mb-2 text-[11px] leading-relaxed" style={{ color: "#5a5f62" }}>
              For situations that grant a result directly — a GM-awarded Advantage, a Threat from the scene, a Triumph off a
              talent — without a die actually producing it. Folded into the next Roll on top of whatever the dice land on,
              then cleared automatically.
            </p>
            <div className="grid sm:grid-cols-2 gap-2">
              {MANUAL_SYMBOL_TYPES.map((sym) => (
                <ManualSymbolCounter
                  key={sym}
                  sym={sym}
                  count={manualSymbols[sym] || 0}
                  onChange={(v) => setManualSymbols((m) => ({ ...m, [sym]: v }))}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mb-5">
          <button
            onClick={() => setUtilityOpen((o) => !o)}
            className="w-full flex items-center justify-between text-[11px] tracking-[0.2em] uppercase py-1.5"
            style={{ color: "#8a8f93" }}
          >
            <span>Utility rolls</span>
            <span style={{ fontSize: 10 }}>{utilityOpen ? "▲ Hide" : "▼ Show"}</span>
          </button>

          {utilityOpen && (
            <div className="mt-2">
              <div className="flex flex-wrap gap-2 mb-2">
                <button
                  onClick={handleD100}
                  className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                  style={{ color: "#e7e2d2", background: "transparent", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
                >
                  D100
                </button>
                <button
                  onClick={handleObligationCheck}
                  className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                  style={{ color: "#e7e2d2", background: "transparent", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
                >
                  Obligation Check
                </button>
                <div className="inline-flex items-stretch">
                  <button onClick={handleCriticalInjury} className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors" style={{ color: "#e7e2d2", background: "transparent", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>Critical Injury</button>
                  <label className="inline-flex items-center border border-l-0 px-2 text-[11px]" style={{ borderColor: "#3a3f42", color: "#8a8f93" }}>+
                    <input type="number" min={0} max={999} value={criticalInjuryModifier} onChange={(e) => setCriticalInjuryModifier(Math.max(0, Number(e.target.value) || 0))} className="w-12 bg-transparent ml-1 mono-num" style={{ color: "#e7e2d2" }} aria-label="Critical Injury roll modifier" />
                  </label>
                </div>
                <div className="inline-flex items-stretch">
                  <button onClick={handleCriticalHit} className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors" style={{ color: "#e7e2d2", background: "transparent", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>Critical Hit</button>
                  <label className="inline-flex items-center border border-l-0 px-2 text-[11px]" style={{ borderColor: "#3a3f42", color: "#8a8f93" }}>+
                    <input type="number" min={0} max={999} value={criticalHitModifier} onChange={(e) => setCriticalHitModifier(Math.max(0, Number(e.target.value) || 0))} className="w-12 bg-transparent ml-1 mono-num" style={{ color: "#e7e2d2" }} aria-label="Critical Hit roll modifier" />
                  </label>
                </div>
              </div>

              <p className="mb-2 text-[11px] leading-relaxed" style={{ color: "#5a5f62" }}>
                Each of these posts straight to the shared roll log below for everyone to see — unattributed, nothing here asks who it happens to.
              </p>
            </div>
          )}
        </div>

        <div className="mb-3">
          <div className="text-[10px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#5a5f62" }}>Quick difficulty</div>
          <div className="flex items-center gap-2 flex-wrap">
            {[1, 2, 3, 4, 5].map((n) => {
              const id = `quick-${n}`;
              const active = selectedDifficultyPreset === id;
              const restBorder = active ? "#8a5ec8" : "#8a5ec866";
              return (
                <button
                  key={n}
                  onClick={() => { active ? deselectDifficultyPreset() : selectDifficultyPreset(id, n); }}
                  onContextMenu={(e) => { e.preventDefault(); deselectDifficultyPreset(); }}
                  title={active ? "Click or right-click to deselect" : undefined}
                  className="inline-flex items-center gap-1.5 text-[11px] tracking-[0.1em] uppercase px-3 py-1.5 border transition-colors"
                  style={active
                    ? { background: "#8a5ec8", color: "#101315", borderColor: "#8a5ec8", fontWeight: 700 }
                    : { color: "#8a5ec8", borderColor: "#8a5ec866" }}
                  {...hoverGlow(restBorder, { hoverColor: "#8a5ec8", hoverShadow: "0 0 14px rgba(138,94,200,0.32)" })}
                >
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: n }, (_, i) => (
                      <DieFaceIcon key={i} img={difficultyDie.img} label={difficultyDie.label} size={15} />
                    ))}
                  </span>
                  · {DIFFICULTY_TIER_NAMES[n]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-3">
          <div className="text-[10px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#5a5f62" }}>Range/melee difficulty</div>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { n: 2, label: "Melee" },
              { n: 1, label: "Short Range" },
              { n: 2, label: "Medium Range" },
              { n: 3, label: "Long Range" },
            ].map(({ n, label }) => {
              const id = `range-${label}`;
              const active = selectedDifficultyPreset === id;
              const restBorder = active ? "#8a5ec8" : "#8a5ec866";
              return (
                <button
                  key={label}
                  onClick={() => { active ? deselectDifficultyPreset() : selectDifficultyPreset(id, n); }}
                  onContextMenu={(e) => { e.preventDefault(); deselectDifficultyPreset(); }}
                  title={active ? "Click or right-click to deselect" : undefined}
                  className="inline-flex items-center gap-1.5 text-[11px] tracking-[0.1em] uppercase px-3 py-1.5 border transition-colors"
                  style={active
                    ? { background: "#8a5ec8", color: "#101315", borderColor: "#8a5ec8", fontWeight: 700 }
                    : { color: "#8a5ec8", borderColor: "#8a5ec866" }}
                  {...hoverGlow(restBorder, { hoverColor: "#8a5ec8", hoverShadow: "0 0 14px rgba(138,94,200,0.32)" })}
                >
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: n }, (_, i) => (
                      <DieFaceIcon key={i} img={difficultyDie.img} label={difficultyDie.label} size={15} />
                    ))}
                  </span>
                  · {label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-5">
          <div className="text-[10px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#5a5f62" }}>Maneuvers</div>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { id: "aim", boost: 1, setback: 0, label: "Aim", color: "#5ec8d8", tooltipDie: boostDie, tooltipCount: 1, tooltipPrefix: "Gain", tooltipSuffix: "on the next combat check" },
              { id: "double-aim", boost: 2, setback: 0, label: "Double Aim", color: "#5ec8d8", tooltipDie: boostDie, tooltipCount: 2, tooltipPrefix: "Gain", tooltipSuffix: "on the next combat check" },
              { id: "called-shot", boost: 0, setback: 2, label: "Called Shot", color: "#8a8f93", tooltipDie: setbackDie, tooltipCount: 2, tooltipPrefix: "Target a specific part of the target. The next combat check suffers" },
              { id: "double-called-shot", boost: 0, setback: 1, label: "Double Called Shot", color: "#8a8f93", tooltipDie: setbackDie, tooltipCount: 1, tooltipPrefix: "Target a specific part of the target. The next combat check suffers" },
            ].map(({ id, boost, setback, label, color, tooltipDie, tooltipCount, tooltipPrefix, tooltipSuffix }) => {
              const active = selectedManeuver === id;
              const restBorder = active ? color : `${color}66`;
              // Aim/Double Aim keep their own cyan glow (they're already blue);
              // Called Shot/Double Called Shot use the same ivory highlight as
              // the other neutral/grey controls (Clear pool) instead.
              const isBlueFamily = color === "#5ec8d8";
              return (
                <div key={id} className="relative group">
                  <button
                    onClick={() => selectManeuver(id, boost, setback)}
                    title={active ? `Click to deselect ${label}` : undefined}
                    className="text-[11px] tracking-[0.1em] uppercase px-3 py-1.5 border transition-colors"
                    style={active
                      ? { background: color, color: "#101315", borderColor: color, fontWeight: 700 }
                      : { color, borderColor: `${color}66` }}
                    {...hoverGlow(restBorder, isBlueFamily
                      ? { hoverColor: "#5ec8d8", hoverShadow: "0 0 14px rgba(94,200,216,0.22)" }
                      : { hoverColor: "#e7e2d2", hoverShadow: "0 0 14px rgba(231,226,210,0.22)" })}
                  >
                    {label}
                  </button>
                  {tooltipCount > 0 && (
                    <div
                      className="hidden group-hover:flex absolute left-0 top-full mt-1.5 z-20 items-center flex-wrap gap-1.5 px-3 py-2 border normal-case text-left"
                      style={{ width: 230, borderColor: "#3a3f42", background: "#101315", color: "#e7e2d2", fontSize: 11, lineHeight: 1.4, letterSpacing: "normal" }}
                    >
                      <span>{tooltipPrefix}</span>
                      <span className="flex items-center gap-0.5 flex-shrink-0">
                        {Array.from({ length: tooltipCount }, (_, i) => (
                          <DieFaceIcon key={i} img={tooltipDie.img} label={tooltipDie.label} size={16} />
                        ))}
                      </span>
                      {tooltipSuffix && <span>{tooltipSuffix}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="mb-5">
          <div className="text-[10px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#5a5f62" }}>Upgrade dice</div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={upgradeAbilityToProficiency}
              disabled={!canUpgradeAbility()}
              title={(pool.ability || 0) <= 0 ? "No Ability dice left — adds an Ability die instead" : undefined}
              className="text-[11px] tracking-[0.1em] uppercase px-3 py-1.5"
              style={{
                background: "linear-gradient(90deg, #6fae60 0%, #6fae60 50%, #e8c547 50%, #e8c547 100%)",
                color: "#101315",
                border: "1px solid transparent",
                opacity: canUpgradeAbility() ? 1 : 0.4,
                cursor: canUpgradeAbility() ? "pointer" : "not-allowed",
                fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
              }}
              {...hoverGlow("transparent", { ...IVORY_HOVER, disabled: !canUpgradeAbility() })}
            >
              <span className="inline-flex items-center gap-1.5">
                <img src={BLUE_TOKEN} alt="Light Side Destiny Point" style={{ width: 33, height: 33 }} /> (Ability → Proficiency)
              </span>
            </button>
            <button
              onClick={downgradeProficiencyToAbility}
              disabled={!canDowngradeAbility()}
              title="Undo: Proficiency → Ability"
              className="w-7 h-7 flex items-center justify-center text-[13px] leading-none"
              style={{
                border: "1px solid #3a3f42",
                color: "#8a8f93",
                opacity: canDowngradeAbility() ? 1 : 0.35,
                cursor: canDowngradeAbility() ? "pointer" : "not-allowed",
              }}
              {...hoverGlow("#3a3f42", { ...IVORY_HOVER, disabled: !canDowngradeAbility() })}
            >
              ↺
            </button>
            <button
              onClick={upgradeDifficultyToChallenge}
              disabled={!canUpgradeDifficulty()}
              title={(pool.difficulty || 0) <= 0 ? "No Difficulty dice left — adds a Difficulty die instead" : undefined}
              className="text-[11px] tracking-[0.1em] uppercase px-3 py-1.5"
              style={{
                background: "linear-gradient(90deg, #8a5ec8 0%, #8a5ec8 50%, #c23b3b 50%, #c23b3b 100%)",
                color: "#f5f5f0",
                border: "1px solid transparent",
                opacity: canUpgradeDifficulty() ? 1 : 0.4,
                cursor: canUpgradeDifficulty() ? "pointer" : "not-allowed",
                fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
              }}
              {...hoverGlow("transparent", { ...IVORY_HOVER, disabled: !canUpgradeDifficulty() })}
            >
              <span className="inline-flex items-center gap-1.5">
                <img src={RED_TOKEN} alt="Dark Side Destiny Point" style={{ width: 33, height: 33 }} /> (Difficulty → Challenge)
              </span>
            </button>
            <button
              onClick={downgradeChallengeToDifficulty}
              disabled={!canDowngradeDifficulty()}
              title="Undo: Challenge → Difficulty"
              className="w-7 h-7 flex items-center justify-center text-[13px] leading-none"
              style={{
                border: "1px solid #3a3f42",
                color: "#8a8f93",
                opacity: canDowngradeDifficulty() ? 1 : 0.35,
                cursor: canDowngradeDifficulty() ? "pointer" : "not-allowed",
              }}
              {...hoverGlow("#3a3f42", { ...IVORY_HOVER, disabled: !canDowngradeDifficulty() })}
            >
              ↺
            </button>
          </div>
        </div>

        <div className="flex items-start gap-4 mb-5 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleRoll}
              className="text-[12px] tracking-[0.15em] uppercase px-5 py-2"
              style={{ background: "#ffb000", color: "#101315", border: "1px solid transparent", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
              {...hoverGlow("transparent", { hoverColor: "#ffe066", hoverShadow: "0 0 16px rgba(255,224,102,0.4)" })}
            >
              Roll
            </button>
            <button
              onClick={() => { setPool(EMPTY_POOL); setLoadedLabel(null); setLoadedWeaponNote(null); setLoadedDamage(null); setAutomaticSymbols(EMPTY_MANUAL); setSelectedDifficultyPreset(null); setSelectedManeuver(null); setAbilityUpgradeStack([]); setDifficultyUpgradeStack([]); setManualSymbols(EMPTY_MANUAL); announcePoolConsumed(poolClientIdRef.current); }}
              className="text-[11px] tracking-[0.15em] uppercase px-4 py-2 border"
              style={{ color: "#8a8f93", borderColor: "#3a3f42" }}
              {...hoverGlow("#3a3f42", { hoverColor: "#e7e2d2", hoverShadow: "0 0 14px rgba(231,226,210,0.22)" })}
            >
              Clear pool
            </button>
          </div>
          <SelectedDiceSummary pool={pool} size={36} onRemoveOne={(key) => updateDie(key, (pool[key] || 0) - 1)} />
        </div>

        {loadedLabel && (
          <div className="mb-4 -mt-3 text-[11px]" style={{ color: "#5ec8d8" }}>
            Loaded from {loadedLabel} — add Difficulty/Setback for the check, then Roll.
          </div>
        )}

        {difficultyTierLabel(pool) && (
          <div className="mb-5 -mt-3 text-[13px]" style={{ color: "#8a5ec8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
            {difficultyTierLabel(pool)}
          </div>
        )}

        <SharedRollLog {...rollLog} />
      </div>
    </div>
  );
}

// GM-facing inbox for the shared /notes log (see GMNoteBox above and
// NotesLog in worker/index.js). Polls like the dice roller's log, but on a
// slower cadence since notes are low-frequency and not time-critical.
function GMNotesPanel() {
  const [notes, setNotes] = useState([]);
  const [status, setStatus] = useState({ status: "idle" });
  const pollRef = useRef(null);

  const fetchNotes = async () => {
    try {
      const res = await apiFetch(`/notes?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      setStatus({ status: "ok" });
    } catch (err) {
      setStatus({ status: "error", msg: err.message });
    }
  };

  useEffect(() => {
    fetchNotes();
    pollRef.current = setInterval(fetchNotes, 3000);
    return () => clearInterval(pollRef.current);
  }, []);

  async function handleDismiss(id) {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    try {
      await apiFetch("/notes", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch {
      // best-effort — a stale re-fetch will bring it back if this failed
    }
  }

  // Ticking "actioned" is distinct from Dismiss — it marks a note as dealt
  // with (dimmed, checkmarked) without removing it from the inbox, so the
  // GM has a record of what's already been handled this session. Dismiss
  // still deletes outright.
  async function handleToggleActioned(id, actioned) {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, actioned } : n)));
    try {
      await apiFetch("/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, actioned }),
      });
    } catch {
      // best-effort — a stale re-fetch reconciles if this failed
    }
  }

  async function handleClearAll() {
    setNotes([]);
    try {
      await apiFetch("/notes", { method: "DELETE" });
    } catch {
      // best-effort
    }
  }

  return (
    <div className="relative overflow-hidden border" style={{ borderColor: "#3a3f42", background: "#16191b", boxShadow: "0 0 30px rgba(224,118,58,0.06)" }}>
      <div className="p-5 sm:p-7">
        <div className="flex items-start justify-between gap-3 mb-1 flex-wrap">
          <div className="text-[11px] tracking-[0.25em] uppercase" style={{ color: "#e0763a" }}>GM ONLY · SHARED SESSION TOOL</div>
          {notes.length > 0 && (
            <button
              onClick={handleClearAll}
              className="text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors"
              style={{ color: "#8a8f93", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}
            >
              Clear all
            </button>
          )}
        </div>
        <h1 className="text-2xl sm:text-3xl uppercase tracking-wide mb-2" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          GM Inbox
        </h1>
        <p className="text-[11px] leading-relaxed mb-5" style={{ color: "#5a5f62" }}>
          Notes players send from their character sheet — desired XP spends and the like. Tick a note once you've
          actioned it (dims it in place, no data lost); Dismiss clears it from the inbox entirely. Nothing here writes
          to the ledger automatically.
        </p>

        {status.status === "error" && (
          <p className="text-[12px] mb-3" style={{ color: "#c23b3b" }}>Couldn't load notes: {status.msg}</p>
        )}

        {notes.length === 0 ? (
          <span className="text-[13px]" style={{ color: "#5a5f62" }}>No notes yet.</span>
        ) : (
          <div className="space-y-2.5">
            {notes.map((n) => (
              <div
                key={n.id}
                className="border p-3"
                style={{
                  borderColor: n.actioned ? "#2a2e3188" : "#2a2e31",
                  background: n.actioned ? "#10131588" : "#101315",
                  opacity: n.actioned ? 0.6 : 1,
                }}
              >
                <div className="flex items-start justify-between gap-3 mb-1">
                  <span className="flex items-center gap-2">
                    <button
                      onClick={() => handleToggleActioned(n.id, !n.actioned)}
                      title={n.actioned ? "Mark not actioned" : "Mark actioned"}
                      className="w-4 h-4 flex-shrink-0 border flex items-center justify-center"
                      style={{
                        borderColor: n.actioned ? "#6fae60" : "#3a3f42",
                        background: n.actioned ? "#6fae60" : "transparent",
                        color: "#101315",
                        fontSize: 11,
                        lineHeight: 1,
                      }}
                    >
                      {n.actioned ? "✔" : ""}
                    </button>
                    <span
                      className="text-[13px]"
                      style={{
                        color: "#e0763a",
                        fontFamily: "'Rajdhani', sans-serif",
                        fontWeight: 700,
                        textDecoration: n.actioned ? "line-through" : "none",
                      }}
                    >
                      {n.player}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-[11px]" style={{ color: "#5a5f62" }}>
                      {n.ts ? new Date(n.ts).toLocaleString() : ""}
                    </span>
                    <button
                      onClick={() => handleDismiss(n.id)}
                      className="text-[11px] tracking-wide uppercase"
                      style={{ color: "#5a5f62" }}
                      title="Dismiss"
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: "#e7e2d2" }}>{n.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Campaign wiki — an external, publicly hosted page whose address lives in
// ledger.json's top-level "wikiUrl" (so this code stays identical across
// every campaign repo). The tab tries to show the wiki inline in an iframe
// and always offers an "open in a new tab" link. Many sites send headers that
// refuse to be framed (X-Frame-Options / CSP frame-ancestors); the browser
// then shows a blank or "refused to connect" box, and the new-tab link is
// the way in. Only http(s) addresses are accepted.
function safeWikiUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function WikiPanel({ url }) {
  const href = safeWikiUrl(url);
  return (
    <div className="relative overflow-hidden border" style={{ borderColor: "#3a3f42", background: "#16191b", boxShadow: "0 0 30px rgba(94,200,216,0.06)" }}>
      <div className="p-3 sm:p-4">
        <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#5ec8d8" }}>CAMPAIGN REFERENCE</div>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <h1 className="text-2xl sm:text-3xl uppercase tracking-wide" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
            Wiki
          </h1>
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] tracking-[0.15em] uppercase px-4 py-2"
              style={{ border: "1px solid #5ec8d8", color: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
            >
              Open in new tab ↗
            </a>
          )}
        </div>
        {!href ? (
          <p className="text-[13px]" style={{ color: "#5a5f62" }}>
            No wiki link set yet. The GM sets it on the GM page, under Campaign settings.
          </p>
        ) : (
          <>
            <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#5a5f62" }}>
              If the wiki doesn't appear below, that site doesn't allow being shown inside another page — use Open in new tab.
            </p>
            <iframe
              src={href}
              title="Campaign wiki"
              className="w-full border"
              style={{ height: "calc(100vh - 16rem)", minHeight: 480, borderColor: "#2a2e31", background: "#101315" }}
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
            />
          </>
        )}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Vehicle tab — the ship's static profile (Silhouette/Speed/Handling/Defense/
// Armor/Hull Trauma/System Strain, from ledger.json's `vehicle` object) plus
// live Hull Trauma / System Strain pips (from the shared /manual store's
// `vehicle` field — same convention as PC wounds/strain) and a set of crew
// position cards. Each position can be assigned to any party member via a
// dropdown — assignments are shared across everyone viewing the dashboard,
// backed by the /crew Durable Object (see CrewLog in worker/index.js), so a
// player can claim their own seat without waiting on the GM to edit anything.
// Clicking a position's action loads that assigned character's actual skill
// dice pool into the Dice Roller via the same loadSkillIntoRoller() path a
// weapon or skill click on the Character tab uses — so taking the gunner's
// seat and firing the forward cannon rolls exactly like that character
// rolling Gunnery themselves, no separate vehicle-combat dice logic needed.
function useCrewAssignments() {
  const [crew, setCrew] = useState({});

  const fetchCrew = useCallback(async () => {
    try {
      const res = await apiFetch(`/crew?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setCrew(data?.crew || {});
    } catch {
      // Best-effort — leave whatever was last loaded (or empty) rather than
      // blocking the tab if the Worker/Durable Object isn't reachable yet.
    }
  }, []);

  useEffect(() => {
    fetchCrew();
    const t = setInterval(fetchCrew, 4000);
    return () => clearInterval(t);
  }, [fetchCrew]);

  async function assign(positionId, characterId) {
    // Optimistic update so the dropdown feels instant; the next poll (or the
    // POST response, if it lands) reconciles with the shared value.
    setCrew((prev) => {
      const next = { ...prev };
      if (characterId) next[positionId] = characterId;
      else delete next[positionId];
      return next;
    });
    try {
      await apiFetch("/crew", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ positionId, characterId: characterId || "" }),
      });
    } catch {
      // Best-effort — see above.
    }
  }

  return { crew, assign };
}

// Vehicle-scale range bands (Genesys vehicle rules add Strategic; "Close"
// in some printed stat blocks is the same band as Short).
const VEHICLE_RANGE_BANDS = ["Engaged", "Short", "Medium", "Long", "Extreme", "Strategic"];
function vehicleRangeIndex(range) {
  const r = String(range || "").trim().toLowerCase();
  return VEHICLE_RANGE_BANDS.findIndex((b) => b.toLowerCase() === (r === "close" ? "short" : r));
}

// Which of the four firing arcs a weapon covers, from text like "Forward",
// "All", "Port and Starboard" or "Forward/Aft".
function fireArcSet(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (/\ball\b|turret|any/.test(t)) return { fore: true, aft: true, port: true, starboard: true };
  return { fore: /fore|forward|front/.test(t), aft: /aft|rear|back/.test(t), port: /port|left/.test(t), starboard: /starboard|right/.test(t) };
}

// A small top-down ship outline with the covered arcs lit.
function FireArcIcon({ arc, size = 30 }) {
  const on = "#5ec8d8";
  const off = "#2a2e31";
  const c = size / 2;
  const r = size / 2 - 1;
  // Quadrants of a circle, each 90 degrees, centred on fore/starboard/aft/port.
  const wedge = (startDeg) => {
    const a0 = ((startDeg - 45 - 90) * Math.PI) / 180;
    const a1 = ((startDeg + 45 - 90) * Math.PI) / 180;
    return `M ${c} ${c} L ${c + r * Math.cos(a0)} ${c + r * Math.sin(a0)} A ${r} ${r} 0 0 1 ${c + r * Math.cos(a1)} ${c + r * Math.sin(a1)} Z`;
  };
  const a = arc || {};
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <path d={wedge(0)} fill={a.fore ? on : off} fillOpacity={a.fore ? 0.55 : 1} stroke="#101315" strokeWidth="1" />
      <path d={wedge(90)} fill={a.starboard ? on : off} fillOpacity={a.starboard ? 0.55 : 1} stroke="#101315" strokeWidth="1" />
      <path d={wedge(180)} fill={a.aft ? on : off} fillOpacity={a.aft ? 0.55 : 1} stroke="#101315" strokeWidth="1" />
      <path d={wedge(270)} fill={a.port ? on : off} fillOpacity={a.port ? 0.55 : 1} stroke="#101315" strokeWidth="1" />
      <path d={`M ${c} ${c - size * 0.24} L ${c + size * 0.1} ${c + size * 0.2} L ${c} ${c + size * 0.13} L ${c - size * 0.1} ${c + size * 0.2} Z`} fill="#e7e2d2" />
    </svg>
  );
}

// One vehicle weapon, laid out like the Character tab's WeaponCard: big
// damage figure, crit, fire arc, range bands and a chip per quality (with
// the same rules tooltips). When `onRoll` is given the whole card is a
// button that loads the gunner's pool with this weapon's damage, so the roll
// log shows "Total damage: x" exactly as personal weapons do.
function VehicleWeaponCard({ weapon, skill, onRoll, rollTitle, compact = false }) {
  const adjustments = weaponRollAdjustments(weapon.qualities || "");
  const totalDamage = Math.max(0, (Number(weapon.damage) || 0) + adjustments.damage);
  const arc = fireArcSet(weapon.fireArc);
  const bandIdx = vehicleRangeIndex(weapon.range);
  const specials = splitSpecial(weapon.qualities || "");
  const clickable = !!onRoll;
  return (
    <div
      onClick={clickable ? () => onRoll(totalDamage, adjustments) : undefined}
      title={clickable ? rollTitle : undefined}
      className={`grid transition-colors ${clickable ? "cursor-pointer" : ""}`}
      style={{ gridTemplateColumns: "4px 1fr auto", border: "1px solid #2a2e31", background: "#131719" }}
      onMouseEnter={(e) => {
        if (!clickable) return;
        e.currentTarget.style.borderColor = "#5ec8d8";
        e.currentTarget.style.boxShadow = "0 0 18px rgba(94,200,216,0.14)";
        e.currentTarget.style.background = "#151a1d";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#2a2e31";
        e.currentTarget.style.boxShadow = "none";
        e.currentTarget.style.background = "#131719";
      }}
    >
      <div style={{ background: clickable ? "#5ec8d8" : "#3a3f42" }} />
      <div className={`${compact ? "px-3 py-2.5" : "px-4 py-3"} flex flex-col gap-2`}>
        <div className="flex items-baseline gap-2.5 flex-wrap">
          <span className={`${compact ? "text-[15px]" : "text-[18px]"} uppercase`} style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, letterSpacing: "0.03em" }}>
            {weapon.name}
          </span>
          <span className="text-[10px] tracking-[0.12em] uppercase" style={{ color: "#8a8f93" }}>Gunnery</span>
        </div>
        <div className="flex items-center gap-5 flex-wrap">
          <div className="flex items-baseline gap-1.5">
            <TipLabel text="Dmg" title={STAT_TIPS.dmg[0]} body={STAT_TIPS.dmg[1]} />
            <span className={`${compact ? "text-[22px]" : "text-[26px]"} leading-none mono-num`} style={{ color: "#ffb000" }}>{totalDamage}</span>
            {adjustments.damage !== 0 && <span className="text-[9px] uppercase tracking-wide" style={{ color: adjustments.damage > 0 ? "#6fae60" : "#c23b3b" }}>{adjustments.damage > 0 ? "+1 Superior" : "−1 Inferior"}</span>}
          </div>
          <div className="flex items-baseline gap-1.5">
            <TipLabel text="Crit" title={STAT_TIPS.crit[0]} body={STAT_TIPS.crit[1]} />
            <span className="text-[16px] leading-none mono-num" style={{ color: "#e7e2d2" }}>{weapon.crit ?? "—"}</span>
          </div>
          {arc && (
            <div className="flex items-center gap-1.5" title={`Fire arc: ${weapon.fireArc}`}>
              <span className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "#8a8f93" }}>Arc</span>
              <FireArcIcon arc={arc} size={compact ? 24 : 28} />
              <span className="text-[11px]" style={{ color: "#e7e2d2" }}>{weapon.fireArc}</span>
            </div>
          )}
          {weapon.range && (
            <div className="flex items-center gap-1.5">
              <TipLabel text="Range" title={STAT_TIPS.range[0]} body={STAT_TIPS.range[1]} />
              <span className="flex items-center gap-[3px]">
                {VEHICLE_RANGE_BANDS.map((band, i) => (
                  <span key={band} title={band} style={{ width: 13, height: 6, background: bandIdx >= 0 && i <= bandIdx ? "#5ec8d8" : "transparent", border: `1px solid ${bandIdx >= 0 && i <= bandIdx ? "#5ec8d8" : "#3a3f42"}` }} />
                ))}
                <span className="text-[11px] ml-1" style={{ color: "#e7e2d2" }}>{weapon.range}</span>
              </span>
            </div>
          )}
          {skill && (
            <div className="flex items-center gap-2">
              <TipLabel text="Pool" title={STAT_TIPS.pool[0]} body={STAT_TIPS.pool[1]} width={290} />
              <SkillPips rank={skill.rank} characteristic={skill.characteristic} boost={(skill.boost || 0) + adjustments.boost} setback={adjustments.setback} />
            </div>
          )}
        </div>
        {specials.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {specials.map((sp, i) => <SpecialChip key={i} text={sp} />)}
          </div>
        )}
      </div>
      <div className="flex items-center pl-2 pr-3">
        {clickable && (
          <span className="text-[12px] tracking-[0.18em] uppercase px-3 py-1.5 whitespace-nowrap" style={{ border: "1px solid #5ec8d8", color: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
            Fire ▶
          </span>
        )}
      </div>
    </div>
  );
}

function VehicleTab({ vehicle, party, partySkillSets, live, loadSkillIntoRoller, manual }) {
  const { crew, assign } = useCrewAssignments();

  if (!vehicle) {
    return (
      <div className="relative overflow-hidden border" style={{ borderColor: "#3a3f42", background: "#16191b" }}>
        <div className="p-5 sm:p-7">
          <span className="text-[13px]" style={{ color: "#5a5f62" }}>No vehicle yet. The GM adds one on the GM page, under Vehicle.</span>
        </div>
      </div>
    );
  }

  // Hull Trauma / System Strain come from the shared /manual store, mirrored
  // into live.vehicle by the sync effect in CampaignDashboard.
  const hasData = live?.status === "ok";
  const liveVehicle = hasData ? vehicleLiveOf(manual, vehicle.id) : null;
  const hull = { current: hasData ? (liveVehicle?.hull ?? 0) : null, threshold: vehicle.hullTrauma?.threshold ?? 0 };
  const systemStrain = { current: hasData ? (liveVehicle?.systemStrain ?? 0) : null, threshold: vehicle.systemStrain?.threshold ?? 0 };

  // A party member is keyed by liveId (falling back to name) in the crew
  // map, matching the same liveId convention used for wounds/strain overlay.
  function characterLabel(key) {
    const p = party.find((c) => (c.liveId || c.name) === key);
    return p?.name || key;
  }

  return (
    <div className="relative overflow-hidden border" style={{ borderColor: "#3a3f42", background: "#16191b", boxShadow: "0 0 30px rgba(94,200,216,0.06)" }}>
      <div className="p-5 sm:p-7">
        <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#5ec8d8" }}>VEHICLE</div>
        <h1 className="text-2xl sm:text-3xl uppercase tracking-wide mb-1" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          {vehicle.name}
        </h1>
        <p className="text-[12px] mb-5" style={{ color: "#8a8f93" }}>{vehicle.class}</p>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
          <Stat label="Silhouette"><span className="text-xl mono-num" style={{ color: "#e7e2d2" }}>{vehicle.silhouette ?? "—"}</span></Stat>
          <Stat label="Speed"><span className="text-xl mono-num" style={{ color: "#e7e2d2" }}>{vehicle.speed ?? "—"}</span></Stat>
          <Stat label="Handling"><span className="text-xl mono-num" style={{ color: "#e7e2d2" }}>{vehicle.handling ?? "—"}</span></Stat>
          <Stat label="Defense"><span className="text-xl mono-num" style={{ color: "#e7e2d2" }}>{vehicle.defense ?? "—"}</span></Stat>
          <Stat label="Armor"><span className="text-xl mono-num" style={{ color: "#e7e2d2" }}>{vehicle.armor ?? "—"}</span></Stat>
        </div>

        <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
          <Stat label="Hull Trauma">
            <PipRow
              current={hull.current}
              threshold={hull.threshold}
              colorClass="#c23b3b"
              onSet={manual ? (n) => manual.setVehicleHull(vehicle.id, n) : undefined}
              onAdjust={manual ? (d) => manual.adjustVehicleHull(vehicle.id, d) : undefined}
            />
          </Stat>
          <Stat label="System Strain">
            <PipRow
              current={systemStrain.current}
              threshold={systemStrain.threshold}
              colorClass="#ffb000"
              onSet={manual ? (n) => manual.setVehicleSystemStrain(vehicle.id, n) : undefined}
              onAdjust={manual ? (d) => manual.adjustVehicleSystemStrain(vehicle.id, d) : undefined}
            />
          </Stat>
          {(liveVehicle?.criticalHits || []).length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] tracking-[0.15em] uppercase mb-1.5" style={{ color: "#8a8f93" }}>Critical Hits</div>
              <div className="space-y-1">
                {liveVehicle.criticalHits.map((n, i) => {
                  const hit = lookupCriticalHitByRoll(n);
                  return (
                    <div key={i} className="text-[12px] leading-relaxed" style={{ color: "#c23b3b" }}>
                      • {hit ? `${n} — ${hit.name}` : `#${n}`}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {vehicle.weapons?.length > 0 && (
          <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
            <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>Weapons</div>
            <div className="space-y-2">
              {vehicle.weapons.map((w, i) => (
                <VehicleWeaponCard key={i} weapon={w} />
              ))}
            </div>
          </div>
        )}

        {vehicle.specialFeatures?.length > 0 && (
          <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
            <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>Special Features</div>
            <ul className="space-y-1">
              {vehicle.specialFeatures.map((f, i) => (
                <li key={i} className="text-[12px] leading-relaxed" style={{ color: "#8a8f93" }}>• {f}</li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <div className="text-[11px] tracking-[0.2em] uppercase mb-3" style={{ color: "#8a8f93" }}>
            Crew Positions
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {(vehicle.crewPositions || []).map((pos) => {
              const seatKey = `${vehicle.id}:${pos.id}`;
              const assignedKey = crew[seatKey] || "";
              const assignedIdx = party.findIndex((c) => (c.liveId || c.name) === assignedKey);
              const weapon = pos.weaponIndex != null ? vehicle.weapons?.[pos.weaponIndex] : null;

              return (
                <div key={pos.id} className="border p-3.5" style={{ borderColor: "#2a2e31", background: "#101315" }}>
                  <span
                    className="text-[15px] block mb-1.5"
                    style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
                  >
                    {pos.name}
                  </span>
                  {pos.description && (
                    <p className="text-[12px] leading-relaxed mb-2.5" style={{ color: "#8a8f93" }}>{pos.description}</p>
                  )}

                  <select
                    value={assignedKey}
                    onChange={(e) => assign(seatKey, e.target.value)}
                    className="w-full bg-transparent border px-2 py-1.5 text-[13px] mb-3"
                    style={{ borderColor: "#3a3f42", color: assignedKey ? "#e7e2d2" : "#5a5f62" }}
                  >
                    <option value="" style={{ background: "#101315" }}>— Unassigned —</option>
                    {party.map((p) => (
                      <option key={p.liveId || p.name} value={p.liveId || p.name} style={{ background: "#101315" }}>
                        {p.name}
                      </option>
                    ))}
                  </select>

                  {weapon && (() => {
                    const gunnery = assignedIdx > -1 ? partySkillSets[assignedIdx].find((s) => s.name === "Gunnery") : null;
                    return (
                      <div className="mb-3">
                        <VehicleWeaponCard
                          weapon={weapon}
                          skill={gunnery}
                          compact
                          onRoll={gunnery ? (dmg) => loadSkillIntoRoller(gunnery, characterLabel(assignedKey), weapon.qualities || null, dmg) : undefined}
                          rollTitle={`Load ${characterLabel(assignedKey)}'s Gunnery pool for ${weapon.name} into the Dice Roller`}
                        />
                      </div>
                    );
                  })()}

                  {pos.manoeuvres?.length > 0 && (
                    <div className="mb-3 pb-3 border-b" style={{ borderColor: "#2a2e3166" }}>
                      <div className="text-[10px] tracking-[0.15em] uppercase mb-1.5" style={{ color: "#5a5f62" }}>
                        Manoeuvres — free, no check
                      </div>
                      <div className="space-y-1">
                        {pos.manoeuvres.map((m, mi) => (
                          <div
                            key={mi}
                            title={m.description}
                            className="text-[12px] flex items-baseline justify-between gap-2"
                            style={{ color: "#8a8f93", cursor: "help", borderBottom: "1px dashed #2a2e3188" }}
                          >
                            <span>{m.name}</span>
                            {m.requirement && <span className="text-[10px] flex-shrink-0" style={{ color: "#5a5f62" }}>{m.requirement}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="text-[10px] tracking-[0.15em] uppercase mb-1.5" style={{ color: "#5a5f62" }}>
                    Actions — hover for rules
                  </div>
                  <div className="space-y-1.5">
                    {pos.actions.map((action, ai) => {
                      const skill = assignedIdx > -1 ? partySkillSets[assignedIdx].find((s) => s.name === action.skill) : null;
                      const clickable = !!skill;
                      // "Fire …" Gunnery actions roll this seat's weapon (or, for the
                      // pilot's slaved fire, the first forward-firing one), so the
                      // roll log shows Total damage like a personal weapon does.
                      const firesWeapon = /^fire\b/i.test(action.name) && /gunnery/i.test(action.skill || "");
                      const actionWeapon = firesWeapon
                        ? weapon || (vehicle.weapons || []).find((w) => fireArcSet(w.fireArc)?.fore) || null
                        : null;
                      const actionDamage = actionWeapon ? Math.max(0, (Number(actionWeapon.damage) || 0) + weaponRollAdjustments(actionWeapon.qualities || "").damage) : null;
                      const tooltip = [action.description, action.requirement ? `Requirement: ${action.requirement}` : null]
                        .filter(Boolean)
                        .join("\n\n");
                      return (
                        <button
                          key={ai}
                          disabled={!clickable}
                          onClick={
                            clickable
                              ? () => loadSkillIntoRoller(skill, characterLabel(assignedKey), actionWeapon ? actionWeapon.qualities || null : weapon ? weapon.qualities : null, actionDamage)
                              : undefined
                          }
                          title={clickable ? `${tooltip}\n\nClick to load ${action.skill} into the Dice Roller.` : `${tooltip}\n\nAssign a crew member to preview this action's pool.`}
                          className="w-full flex items-center justify-between gap-3 text-left px-2.5 py-1.5 border transition-colors disabled:cursor-not-allowed"
                          style={{
                            borderColor: clickable ? "#2a2e31" : "#2a2e3155",
                            background: clickable ? "#131719" : "transparent",
                          }}
                          onMouseEnter={(e) => {
                            if (!clickable) return;
                            e.currentTarget.style.borderColor = "#5ec8d8";
                            e.currentTarget.style.background = "#151a1d";
                          }}
                          onMouseLeave={(e) => {
                            if (!clickable) return;
                            e.currentTarget.style.borderColor = "#2a2e31";
                            e.currentTarget.style.background = "#131719";
                          }}
                        >
                          <span className="text-[13px]" style={{ color: clickable ? "#e7e2d2" : "#5a5f62" }}>{action.name}</span>
                          {clickable ? (
                            <SkillPips rank={skill.rank} characteristic={skill.characteristic} boost={skill.boost} />
                          ) : (
                            <span className="text-[10px] tracking-[0.1em] uppercase" style={{ color: "#5a5f62" }}>unassigned</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// `onSet`/`onAdjust` are what make a pip row interactive (see the call
// sites in VehicleTab, the Character tab and the GM page) — each writes to
// the shared /manual store. Without them the row is display-only. Each pip is numbered 1..threshold
// left to right; clicking a pip sets the count to that pip's number
// directly (per FFG convention, clicking an already-lit pip un-lights it and
// everything after it, same as clicking pip 1 while at 1 empties the bar).
function PipRow({ current, threshold, colorClass, size = "normal", onSet, onAdjust, scale = 1, overLabel }) {
  // Hooks must run unconditionally, so this is declared before the
  // early-return below (current == null renders a "Connecting…" message
  // instead of pips at all).
  const [hoverIndex, setHoverIndex] = useState(null);
  // current is null when there's no live overlay AND nothing static to fall
  // back on — show that plainly rather than rendering an all-empty row that
  // reads as "no wounds/strain" when it really means "unknown."
  if (current == null) {
    return <span className="text-[11px] italic" style={{ color: "#5a5f62" }}>Connecting…</span>;
  }
  const editable = !!onSet;
  // The pip row always tops out at exactly `threshold` boxes — it's the
  // printed max, not a moving target. A character isn't taken down until
  // wounds/strain actually EXCEED that max, so going over is tracked by the
  // numeric tally and `overLabel` (e.g. "Incapacitated"/"Unconscious") below
  // rather than by growing the box row itself; use the +/- buttons (or the
  // GM's own numeric entry) to push past threshold.
  const pips = Array.from({ length: threshold }, (_, i) => i < current);
  const over = current > threshold;
  const basePx = size === "small" ? 12 : 16;
  const pipPx = Math.round(basePx * scale);
  const numberSize = Math.round((size === "small" ? 7 : 8) * scale);
  const btnPx = Math.round(20 * scale);
  const btnFontPx = Math.round(12 * scale);
  const overflowColor = "#c23b3b";
  // Hovering pip i previews the exact result of clicking it (see onClick
  // below): everything up to and including the hovered pip lights up as a
  // dimmed preview, everything after goes dim-empty, so a player can see
  // what the bar will look like before committing to the click.
  const previewCount = hoverIndex == null ? null : (current === hoverIndex + 1 ? hoverIndex : hoverIndex + 1);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex flex-wrap gap-1.5" onMouseLeave={() => setHoverIndex(null)}>
        {pips.map((filled, i) => {
          const previewing = editable && previewCount != null;
          const previewFilled = previewing ? i < previewCount : filled;
          const changing = previewing && previewFilled !== filled;
          const common = {
            className: "border relative",
            style: {
              width: pipPx, height: pipPx,
              borderColor: previewFilled ? colorClass : "#3a3f42",
              background: previewFilled ? colorClass : "transparent",
              opacity: changing ? 0.45 : 1,
              boxShadow: filled && !previewing ? `0 0 6px ${colorClass}99` : "none",
              cursor: editable ? "pointer" : "default",
              transition: previewing ? "none" : "background 0.3s ease-out, border-color 0.3s ease-out",
            },
          };
          const numberLabel = (
            <span
              className="absolute inset-0 flex items-center justify-center leading-none pointer-events-none select-none"
              style={{ fontSize: numberSize, color: previewFilled ? "#101315" : "#5a5f62", fontWeight: 700 }}
            >
              {i + 1}
            </span>
          );
          return editable ? (
            <button
              key={i}
              type="button"
              onClick={() => onSet(current === i + 1 ? i : i + 1)}
              onMouseEnter={() => setHoverIndex(i)}
              title={`Set to ${i + 1} of ${threshold}`}
              {...common}
            >
              {numberLabel}
            </button>
          ) : (
            <span key={i} {...common}>
              {numberLabel}
            </span>
          );
        })}
      </div>
      <span className="text-[11px] mono-num" style={{ color: over ? overflowColor : "#8a8f93" }}>
        {current} / {threshold}
      </span>
      {over && overLabel && (
        <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: overflowColor, fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          {overLabel}
        </span>
      )}
      {editable && onAdjust && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onAdjust(-1)}
            className="flex items-center justify-center border leading-none"
            style={{ width: btnPx, height: btnPx, fontSize: btnFontPx, borderColor: "#3a3f42", color: "#e7e2d2" }}
            title="Decrease by 1"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => onAdjust(1)}
            className="flex items-center justify-center border leading-none"
            style={{ width: btnPx, height: btnPx, fontSize: btnFontPx, borderColor: "#3a3f42", color: "#e7e2d2" }}
            title="Increase by 1"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}

// One-shot directional highlight: sweeps bottom-to-top in `color` on an
// increase, top-to-bottom in green on a decrease. Renders nothing when idle.
function SweepOverlay({ active, dir, color }) {
  if (!active) return null;
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        background: dir === "down" ? "#6fae6066" : `${color}66`,
        animation: `${dir === "down" ? "sweepDown" : "sweepUp"} 0.9s ease-out 1`,
      }}
    />
  );
}

// `onFlip` writes to the shared /manual store. Clicking any token in
// the row flips exactly one point to the other side of the pool, per the
// core rules' spend-and-flip convention — it doesn't matter which token was
// clicked, since they're identical, so every click targets this side.
const DESTINY_FLIGHT_MS = 560;

function DestinyTokens({ count, src, alt, onFlip }) {
  const [pendingIndex, setPendingIndex] = useState(null);
  const [flight, setFlight] = useState(null);
  const [arrivalIndex, setArrivalIndex] = useState(null);
  const pendingTimerRef = useRef(null);
  const arrivalTimerRef = useRef(null);
  const rootRef = useRef(null);
  const previousCountRef = useRef(count ?? 0);
  const previousSourceRectRef = useRef(null);
  const side = /^Light/i.test(alt) ? "light" : "dark";
  useEffect(() => () => {
    clearTimeout(pendingTimerRef.current);
    clearTimeout(arrivalTimerRef.current);
  }, []);

  // Drive the flight from the shared count change rather than the local click.
  // A remote browser sees the same decrement on its next /manual poll, so it
  // now plays the same one-point movement as the browser that made the click.
  useLayoutEffect(() => {
    const nextCount = count ?? 0;
    const previousCount = previousCountRef.current;
    const sourceRect = previousSourceRectRef.current;

    // The shared store updates both counts before the flight begins. Keep
    // the newly-added destination point invisible (but occupying space) so
    // it appears only when the moving point arrives, rather than sitting
    // underneath the animation from its first frame.
    if (nextCount > previousCount) {
      setArrivalIndex(nextCount - 1);
      clearTimeout(arrivalTimerRef.current);
      arrivalTimerRef.current = setTimeout(() => setArrivalIndex(null), DESTINY_FLIGHT_MS);
    }

    if (nextCount < previousCount && sourceRect) {
      const sourceCenter = { x: sourceRect.left + sourceRect.width / 2, y: sourceRect.top + sourceRect.height / 2 };
      const otherSide = side === "light" ? "dark" : "light";
      const candidates = [...document.querySelectorAll(`[data-destiny-side="${otherSide}"]`)];
      const targetRoot = candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return Math.abs((ar.top + ar.height / 2) - sourceCenter.y) - Math.abs((br.top + br.height / 2) - sourceCenter.y);
      })[0];
      // Both rows grow away from their shared centre line. The last DOM
      // token is therefore the newly-added outer token on either side;
      // target its actual centre so the flight lands precisely on it even
      // when the pool container is much wider than the token row.
      const targetTokens = targetRoot?.querySelectorAll("[data-destiny-token]");
      const targetRect = targetTokens?.length ? targetTokens[targetTokens.length - 1].getBoundingClientRect() : null;
      const targetCenter = targetRect
        ? { x: targetRect.left + targetRect.width / 2, y: targetRect.top + targetRect.height / 2 }
        : { x: sourceCenter.x + (side === "light" ? 76 : -76), y: sourceCenter.y };

      setFlight({
        startX: sourceCenter.x - 16.5,
        startY: sourceCenter.y - 16.5,
        dx: targetCenter.x - sourceCenter.x,
        dy: targetCenter.y - sourceCenter.y,
      });
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = setTimeout(() => { setPendingIndex(null); setFlight(null); }, DESTINY_FLIGHT_MS);
    }

    previousCountRef.current = nextCount;
    const tokens = rootRef.current?.querySelectorAll("[data-destiny-token]");
    previousSourceRectRef.current = tokens?.length ? tokens[tokens.length - 1].getBoundingClientRect() : null;
  }, [count, side]);

  function handleFlip(index) {
    if (!onFlip || pendingIndex !== null) return;
    setPendingIndex(index);
    clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => { setPendingIndex(null); setFlight(null); }, DESTINY_FLIGHT_MS);
    onFlip();
  }

  return (
    <div ref={rootRef} className={`relative flex gap-1 w-full min-h-[33px] ${side === "light" ? "justify-end" : "justify-start"}`} aria-busy={pendingIndex !== null} data-destiny-side={side} data-destiny-count={count ?? 0}>
      <div className={`flex gap-1 ${side === "light" ? "flex-row-reverse" : ""}`}>
        {Array.from({ length: count ?? 0 }, (_, i) =>
          onFlip ? (
            <button
              key={i}
              type="button"
              data-destiny-token="1"
              data-destiny-arriving={arrivalIndex === i ? "1" : undefined}
              onClick={() => handleFlip(i)}
              disabled={pendingIndex !== null}
              aria-label={`Flip ${alt}`}
              title="Flip this Destiny Point to the other side of the pool"
              style={{
                width: 33,
                height: 33,
                display: "block",
                padding: 0,
                border: "2px solid transparent",
                borderRadius: "50%",
                background: "transparent",
                cursor: pendingIndex !== null ? "wait" : "pointer",
                opacity: arrivalIndex === i ? 0 : 1,
              }}
            >
              <img src={src} alt={alt} style={{ width: 29, height: 29, display: "block", filter: "drop-shadow(0 0 3px rgba(0,0,0,0.5))" }} />
            </button>
          ) : (
            <img
              key={i}
              data-destiny-token="1"
              data-destiny-arriving={arrivalIndex === i ? "1" : undefined}
              src={src}
              alt={alt}
              style={{ width: 33, height: 33, display: "block", opacity: arrivalIndex === i ? 0 : 1, filter: "drop-shadow(0 0 3px rgba(0,0,0,0.5))" }}
            />
          )
        )}
      </div>
      {flight && (
        <>
          <span
            className="destiny-flight-token"
            style={{ left: flight.startX, top: flight.startY, "--destiny-dx": `${flight.dx}px`, "--destiny-dy": `${flight.dy}px`, "--destiny-mid-x": `${flight.dx / 2}px`, "--destiny-mid-y": `${flight.dy / 2 - 22}px` }}
            aria-hidden="true"
          >
            <img src={src} alt="" />
          </span>
        </>
      )}
    </div>
  );
}


function GmDestinyCountControls({ destiny, onSet }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em]" style={{ color: "#8fd3f4" }}>
        Light
        <input
          aria-label="Set Light Destiny Points"
          type="number"
          min={0}
          max={20}
          value={destiny.light}
          onChange={(event) => onSet(Number(event.target.value), destiny.dark)}
          className="w-12 bg-transparent border px-1.5 py-1 text-[12px] mono-num"
          style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
        />
      </label>
      <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em]" style={{ color: "#c23b3b" }}>
        Dark
        <input
          aria-label="Set Dark Destiny Points"
          type="number"
          min={0}
          max={20}
          value={destiny.dark}
          onChange={(event) => onSet(destiny.light, Number(event.target.value))}
          className="w-12 bg-transparent border px-1.5 py-1 text-[12px] mono-num"
          style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
        />
      </label>
    </div>
  );
}

function SkillPips({ rank, characteristic, boost = 0, setback = 0 }) {
  const total = Math.max(rank, characteristic);
  const yellow = Math.min(rank, characteristic);
  return (
    <span className="flex items-center gap-1">
      {total === 0 ? (
        <span className="text-[11px]" style={{ color: "#3a3f42" }}>—</span>
      ) : (
        <span className="flex gap-1">
          {Array.from({ length: total }, (_, i) => (
            <img
              key={i}
              src={i < yellow ? YELLOW_ICON : GREEN_ICON}
              alt={i < yellow ? "Proficiency die" : "Ability die"}
              className="w-2.5 h-2.5"
              style={{ display: "block" }}
            />
          ))}
        </span>
      )}
      {boost > 0 && (
        <span className="text-[10px] leading-none inline-flex items-center gap-0.5" style={{ color: "#5ec8d8" }} title={`+${boost} Boost dice`}>
          <img src={BOOST_ICON} alt="Boost" style={{ width: 10, height: 10, display: "inline-block" }} />
          {boost > 1 ? `×${boost}` : ""}
        </span>
      )}
      {setback > 0 && (
        <span className="text-[10px] leading-none inline-flex items-center gap-0.5" style={{ color: "#8a8f93" }} title={`+${setback} Setback dice`}>
          <img src={BLACK_ICON} alt="Setback" style={{ width: 10, height: 10, display: "inline-block" }} />
          {setback > 1 ? `×${setback}` : ""}
        </span>
      )}
    </span>
  );
}

// Hover popup for weapon-card tooltips. Anchored to a position:relative parent.
// Because the trigger is a DESCENDANT of the weapon card, hovering it still counts
// as hovering the card, so the cyan border highlight stays lit while it's open.
// `placement="above"` (default) opens upward from the trigger - fine for the
// character-tab weapon cards, which have room above them. `placement="below"`
// opens downward instead, for triggers near the top of a scrollable container
// (e.g. the shared roll log) where an upward tip gets clipped by the container edge.
// `align="left"` (default) anchors the tooltip's LEFT edge to the trigger, so
// it opens rightward - fine for triggers near the left of their row. Triggers
// sitting further right (e.g. Defense, the last stat in the Armor line) need
// `align="right"` instead, anchoring the tooltip's RIGHT edge to the trigger
// so it opens leftward and doesn't run off the edge of the screen/panel.
function HoverTip({ title, body, width = 280, placement = "above", align = "left" }) {
  const posStyle = placement === "below" ? { top: "calc(100% + 10px)" } : { bottom: "calc(100% + 10px)" };
  const alignStyle = align === "right" ? { right: 0 } : { left: 0 };
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        ...posStyle, ...alignStyle, width, zIndex: 40,
        border: "1px solid #5ec8d855", background: "#101315",
        boxShadow: "0 10px 28px rgba(0,0,0,0.65)", padding: "10px 12px",
      }}
    >
      <div
        className="text-[12px] tracking-[0.14em] uppercase mb-1"
        style={{ color: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
      >
        {title}
      </div>
      <div className="text-[11px] leading-relaxed" style={{ color: "#8a8f93" }}>{body}</div>
    </div>
  );
}

// A dashed-underline stat label that reveals a HoverTip. `align="right"`
// passes through to HoverTip for labels sitting near the right edge of
// their row (see HoverTip above).
function TipLabel({ text, title, body, width, align = "left" }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <span
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="text-[10px] tracking-[0.2em] uppercase"
        style={{ color: "#5a5f62", borderBottom: "1px dashed #3a3f42", cursor: "help" }}
      >
        {text}
      </span>
      {open && <HoverTip title={title} body={body} width={width} align={align} />}
    </span>
  );
}

// Wraps a "Destiny Pool" label so hovering it surfaces the three canonical
// uses of a Destiny Point (per the core rules) plus the GM's own worked
// examples for the "introduce a helpful fact" use. Used at all three spots
// a Destiny Pool is shown (Dice Roller tab, Party tab, Character tab) — each
// usage is its own component instance, so the hover state never bleeds
// between them even though only one is ever mounted at a time.
function DestinyRulesTip({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex items-center gap-1.5"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{ borderBottom: "1px dashed #ffb00088", cursor: "help" }}
    >
      {children}
      {open && (
        <HoverTip
          title="Spending a Destiny Point"
          width={320}
          placement="below"
          body={
            <>
              <ol className="list-decimal list-inside space-y-0.5 mb-2">
                <li>A Helping Hand (upgrade your own dice)</li>
                <li>Raising the Stakes (upgrade the opposition's difficulty)</li>
                <li>Luck and narrative "facts" (Deus Ex Machina)</li>
              </ol>
              <p className="mb-1.5">
                Players can spend a Destiny Point to introduce a helpful detail into the fiction — subject to GM
                approval — examples:
              </p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>Dumb luck — something unlikely but not impossible turns up.</li>
                <li>Reasonable extrapolation — something that logically could be there is there.</li>
              </ul>
            </>
          }
        />
      )}
    </span>
  );
}

// Generic hover-tooltip wrapper for a Stat label — unlike TipLabel (which
// forces its own smaller, dimmer styling), this inherits whatever font size
// and color the caller's label already has and just adds a dashed underline
// + hover affordance, so it drops into an existing label (e.g. "Soak" next
// to "Wounds"/"Strain"/"Credits") without looking visually inconsistent.
function HoverLabel({ children, title, body, width = 260 }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex items-center gap-1.5"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{ borderBottom: "1px dashed currentColor", cursor: "help" }}
    >
      {children}
      {open && <HoverTip title={title} body={body} width={width} />}
    </span>
  );
}

// One Special quality chip. Tooltip only when QUALITY_GLOSSARY recognises the text;
// stops its own clicks so reading a rule never fires the dice roller (weapon card)
// or the copy-to-clipboard handler (roll log). Shared by both call sites - the roll
// log passes placement="below" since its entries sit near the top of a scrollable
// panel, where an upward tooltip gets clipped by the panel's edge.
function SpecialChip({ text, placement = "above" }) {
  const [open, setOpen] = useState(false);
  const q = lookupQuality(text);
  return (
    <span className="relative inline-flex">
      <span
        onMouseEnter={q ? () => setOpen(true) : undefined}
        onMouseLeave={q ? () => setOpen(false) : undefined}
        onClick={q ? (e) => e.stopPropagation() : undefined}
        className="text-[11px] px-2 py-0.5"
        style={{
          border: "1px solid #5ec8d833",
          borderBottom: q ? "1px dashed #5ec8d8aa" : "1px solid #5ec8d833",
          background: "#5ec8d80d",
          color: "#5ec8d8",
          cursor: q ? "help" : "default",
        }}
      >
        {text}
      </span>
      {open && q && <HoverTip title={q.title} body={q.body} width={300} placement={placement} />}
    </span>
  );
}

// One weapon as a click-to-roll card. `skill` is the resolved buildSkills() entry for
// this weapon's skill, or undefined when the ledger names a skill the character doesn't
// have - in that case the card is inert (matching the old table) and says so, rather
// than showing a misleading pool.
// "NEW" badge for recently acquired gear. A ledger.json weapon/inventory
// entry still controls it by hand with a plain `"isNew": true` flag — that
// never expires on its own, which is fine for a one-off ledger entry. Gear
// added via the GM tab's Field-Acquired Gear board (see GmGearAddForm)
// instead fades this out automatically NEW_BADGE_WINDOW_MS after it was
// added (see `addedAt` on the gear item, and isRecentlyAdded below) — once
// that board becomes the normal way gear gets onto a sheet rather than an
// occasional pickup, a badge that never turns off stops meaning anything.
const NEW_BADGE_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
function isRecentlyAdded(addedAt) {
  return typeof addedAt === "number" && addedAt > 0 && Date.now() - addedAt < NEW_BADGE_WINDOW_MS;
}
function NewBadge({ size = 22, title = "Recently acquired" }) {
  return (
    <img
      src={NEW_BADGE}
      alt="New"
      title={title}
      width={size}
      height={size}
      className="inline-block shrink-0 align-middle"
      style={{ filter: "drop-shadow(0 0 6px rgba(94,200,216,0.45))" }}
    />
  );
}

// A weapon can carry a `modes` array — e.g. the DDC MR6's rifle vs. carbine
// configuration — where only range and a short mode-specific quality change
// between them; damage, crit and the weapon's own base `special` (things
// true in every mode, like Stun setting) stay put. Rather than dump every
// attachment's own effect text onto a new player's card (hard points,
// which attachment does what), the mode toggle keeps it to what actually
// changes: pick a mode, see that mode's range and quality.
function WeaponCard({ weapon, skill, onLoad, qty, onAdjustQty, brawn }) {
  const modes = Array.isArray(weapon.modes) && weapon.modes.length > 0 ? weapon.modes : null;
  const [modeIdx, setModeIdx] = useState(0);
  const [blockedMsg, setBlockedMsg] = useState(null);
  const activeMode = modes ? modes[Math.min(modeIdx, modes.length - 1)] : null;
  const range = activeMode?.range ?? weapon.range;
  // Total damage rolled, not the printed "Brawn+N" text — see
  // weaponDamageTotal. Recomputed from the character's live Brawn every
  // render, so it stays correct if Brawn ever changes (advancement, a
  // critical injury, a talent).
  const combinedSpecial = [weapon.special, activeMode?.special].filter(Boolean).join(" - ");
  const rollAdjustments = weaponRollAdjustments(combinedSpecial);
  // A talent can grant a weapon a free Advantage (e.g. Two-Handed Stance for
  // Rethven's one-handed weapons). That is shown on the card as a reminder
  // only: whether it applies depends on the situation, so the player adds it
  // to the roll by hand and it is NOT folded into the pool or the roller.
  const freeAdvantage = Number(weapon.freeAdvantage) || 0;
  const talentLabel = weapon.overrideTalent || "Precision";
  const advTalentLabel = weapon.freeAdvantageTalent || talentLabel;
  const totalDamage = Math.max(0, weaponDamageTotal(weapon.damage, brawn) + rollAdjustments.damage);
  const bandIdx = rangeBandIndex(range);
  const specials = splitSpecial(combinedSpecial);
  const clickable = !!skill;
  // A quantity only means something for a weapon that actually gets used
  // up — Limited Ammo — so the stepper (and the out-of-stock dimming/block
  // below) only apply there; a rifle you never "run out of" doesn't get a
  // counter at all.
  const hasLimitedAmmo = /limited ammo/i.test(combinedSpecial);
  const outOfStock = hasLimitedAmmo && (qty ?? 1) <= 0;
  const effectiveClickable = clickable && !outOfStock;

  function handleClick() {
    if (outOfStock) {
      setBlockedMsg("You have run out of this item");
      setTimeout(() => setBlockedMsg(null), COPY_CONFIRM_MS);
      return;
    }
    if (clickable) onLoad(combinedSpecial, totalDamage, rollAdjustments);
  }

  return (
    <div
      onClick={clickable || outOfStock ? handleClick : undefined}
      title={outOfStock ? "You have run out of this item" : clickable ? `Load ${weapon.skill} into the shared pool and open the Battle Map` : undefined}
      className={`grid transition-colors ${effectiveClickable ? "cursor-pointer" : outOfStock ? "cursor-not-allowed" : ""}`}
      style={{ gridTemplateColumns: "4px 1fr auto", border: "1px solid #2a2e31", background: "#131719", opacity: outOfStock ? 0.5 : 1 }}
      onMouseEnter={(e) => {
        if (!effectiveClickable) return;
        e.currentTarget.style.borderColor = "#5ec8d8";
        e.currentTarget.style.boxShadow = "0 0 18px rgba(94,200,216,0.14)";
        e.currentTarget.style.background = "#151a1d";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#2a2e31";
        e.currentTarget.style.boxShadow = "none";
        e.currentTarget.style.background = "#131719";
      }}
    >
      <div style={{ background: effectiveClickable ? "#5ec8d8" : "#3a3f42" }} />

      <div className="px-4 py-3.5 flex flex-col gap-2.5">
        <div className="flex items-baseline gap-2.5 flex-wrap">
          <span
            className="text-[20px] uppercase"
            style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, letterSpacing: "0.03em" }}
          >
            {weapon.name}
          </span>
          <span className="text-[11px] tracking-[0.12em] uppercase" style={{ color: "#8a8f93" }}>
            {weapon.skill}
          </span>
          {weapon.characteristicOverride && (
            <span
              className="text-[10px] tracking-[0.1em] uppercase px-1.5 py-0.5"
              style={{ background: "#2a2e31", color: "#ffb000" }}
              title={`${talentLabel}: this weapon's pool is built from ${weapon.characteristicOverride} instead of the skill's usual characteristic. The Skills section keeps ${weapon.skill}'s normal characteristic — this override is per-weapon only.`}
            >
              {talentLabel} Talent ({weapon.characteristicOverride})
            </span>
          )}
          {freeAdvantage > 0 && (
            <span
              className="text-[10px] tracking-[0.1em] uppercase px-1.5 py-0.5"
              style={{ background: "#2a2e31", color: "#6fae60" }}
              title={`${advTalentLabel}: this weapon can gain ${freeAdvantage} free Advantage when the talent's conditions are met. It is not added automatically — add it to the roll yourself.`}
            >
              {advTalentLabel} Talent (+{freeAdvantage} Advantage, add manually)
            </span>
          )}
          {weapon.isNew && <NewBadge size={24} />}
          {hasLimitedAmmo && onAdjustQty && (
            <span onClick={(e) => e.stopPropagation()}>
              <QtyStepper value={qty} onAdjust={onAdjustQty} title="How many of this you're carrying — Limited Ammo, so it runs out" />
            </span>
          )}
          {modes && (
            <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              {modes.map((m, i) => (
                <button
                  key={m.name}
                  type="button"
                  onClick={() => setModeIdx(i)}
                  className="text-[9px] tracking-[0.1em] uppercase px-2 py-0.5 border"
                  style={{
                    borderColor: modeIdx === i ? "#5ec8d8" : "#3a3f42",
                    color: modeIdx === i ? "#5ec8d8" : "#8a8f93",
                    fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                  }}
                >
                  {m.name}
                </button>
              ))}
            </span>
          )}
        </div>

        <div className="flex items-center gap-5 flex-wrap">
          <div className="flex items-baseline gap-1.5">
            <TipLabel text="Dmg" title={STAT_TIPS.dmg[0]} body={STAT_TIPS.dmg[1]} />
            <span className="text-[26px] leading-none mono-num" style={{ color: "#ffb000" }}>{totalDamage}</span>
            {rollAdjustments.damage !== 0 && <span className="text-[9px] uppercase tracking-wide" style={{ color: rollAdjustments.damage > 0 ? "#6fae60" : "#c23b3b" }}>{rollAdjustments.damage > 0 ? "+1 Superior" : "−1 Inferior"}</span>}
          </div>
          <div className="flex items-baseline gap-1.5">
            <TipLabel text="Crit" title={STAT_TIPS.crit[0]} body={STAT_TIPS.crit[1]} />
            <span className="text-[16px] leading-none mono-num" style={{ color: "#e7e2d2" }}>{weapon.crit}</span>
          </div>
          <div className="flex items-center gap-2">
            <TipLabel text="Pool" title={STAT_TIPS.pool[0]} body={STAT_TIPS.pool[1]} width={290} />
            {skill ? (
              <span className="inline-flex items-center gap-2 flex-wrap">
                <SkillPips rank={skill.rank} characteristic={skill.characteristic} boost={(skill.boost || 0) + rollAdjustments.boost} setback={rollAdjustments.setback} />
                {rollAdjustments.advantage > 0 && <span className="inline-flex items-center gap-0.5 text-[10px]" style={{ color: "#6fae60" }}><SymbolIcon sym="a" size={13} /> +1</span>}
                {rollAdjustments.threat > 0 && <span className="inline-flex items-center gap-0.5 text-[10px]" style={{ color: "#c23b3b" }}><SymbolIcon sym="t" size={13} /> +1</span>}
              </span>
            ) : (
              <span className="text-[11px]" style={{ color: "#5a5f62" }}>skill not on sheet</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <TipLabel text="Range" title={STAT_TIPS.range[0]} body={STAT_TIPS.range[1]} />
            <span className="flex items-center gap-[3px]">
              {RANGE_BANDS.map((band, i) => (
                <span
                  key={band}
                  title={band}
                  style={{
                    width: 16,
                    height: 6,
                    background: bandIdx >= 0 && i <= bandIdx ? "#5ec8d8" : "transparent",
                    border: `1px solid ${bandIdx >= 0 && i <= bandIdx ? "#5ec8d8" : "#3a3f42"}`,
                  }}
                />
              ))}
              <span className="text-[11px] ml-1" style={{ color: "#e7e2d2" }}>{range}</span>
            </span>
          </div>
        </div>

        {specials.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {specials.map((sp, i) => <SpecialChip key={i} text={sp} />)}
          </div>
        )}
        {blockedMsg && (
          <div className="text-[11px]" style={{ color: "#c23b3b" }}>{blockedMsg}</div>
        )}
      </div>

      <div className="flex items-center pl-2 pr-4">
        {clickable && (
          <span
            className="text-[13px] tracking-[0.18em] uppercase px-3.5 py-2 whitespace-nowrap"
            style={{ border: "1px solid #5ec8d8", color: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
          >
            Roll ▶
          </span>
        )}
      </div>
    </div>
  );
}

// The "Experience — unspent" stat doubles as the entry point into the
// Advancement Planner — clicking it opens that page, and hovering shows what
// it does before committing to the click. Kept as its own small component
// (rather than folded into the generic Stat above) so it can own the
// open/close hover state that HoverTip needs.
function MetricBox({ label, children, accent = "#3a3f42" }) {
  return (
    <div className="border px-4 py-3 h-full" style={{ borderColor: "#2a2e31", background: "#131719", borderLeft: `4px solid ${accent}` }}>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-1.5 flex items-center gap-1.5" style={{ color: "#8a8f93", fontFamily: "'Rajdhani', sans-serif" }}>{label}</div>
      {children}
    </div>
  );
}

function XPUnspentStat({ available, onOpen }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={(event) => { setOpen(true); event.currentTarget.style.borderColor = "#5ec8d8"; event.currentTarget.style.boxShadow = "0 0 18px rgba(94,200,216,0.14)"; event.currentTarget.style.background = "#151a1d"; }}
      onMouseLeave={(event) => { setOpen(false); event.currentTarget.style.borderColor = "#2a2e31"; event.currentTarget.style.boxShadow = "none"; event.currentTarget.style.background = "#131719"; }}
      className="relative text-left w-full h-full border px-4 py-3 transition-colors"
      style={{ borderColor: "#2a2e31", borderLeft: "4px solid #5ec8d8", background: "#131719" }}
      title="Open Advancement Planner"
    >
      <div className="text-[11px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif" }}>Experience — unspent</div>
      <span className="text-xl mono-num" style={{ color: "#e7e2d2" }}>{available}</span>
      {open && <HoverTip title="Advancement Planner" body="Open a page to calculate XP purchases and directly message the GM" width={260} />}
    </button>
  );
}

function Stat({ label, live, children }) {
  return (
    <div className="mb-4">
      <div
        className="text-[11px] tracking-[0.2em] uppercase mb-1.5 flex items-center gap-1.5"
        style={{ color: "#8a8f93", fontFamily: "'Rajdhani', sans-serif" }}
      >
        {label}
        {live && (
          <span
            className="w-1.5 h-1.5 rounded-full inline-block"
            style={{ background: "#6fae60", boxShadow: "0 0 4px #6fae6099" }}
            title="Live-updated"
          />
        )}
      </div>
      {children}
    </div>
  );
}

function ObligationStrainBadge({ base, penalty, triggered }) {
  if (!penalty) return null;
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 border text-[10px] tracking-[0.08em] whitespace-nowrap"
      style={{
        color: triggered ? "#ffd166" : "#ffb000",
        borderColor: triggered ? "#ffb000aa" : "#ffb00066",
        background: triggered ? "#ffb00022" : "#ffb00012",
        boxShadow: triggered ? "0 0 10px rgba(255,176,0,0.18)" : "none",
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 700,
      }}
      title="Temporary strain-threshold reduction from the triggered Obligation roll"
    >
      <span aria-hidden="true">⚠</span>
      Base {base} · Obligation −{penalty}{triggered ? " · Triggered" : ""}
    </span>
  );
}

function severityColor(current, threshold) {
  if (!threshold) return "#e7e2d2";
  const pct = current / threshold;
  if (pct > 0.75) return "#c23b3b";
  if (pct > 0.5) return "#ffb000";
  return "#e7e2d2";
}

// `live` is the shared /manual store's data, mirrored into CampaignDashboard's
// `live` state by its sync effect (status "ok" once the store has loaded).
function applyLiveOverlay(character, live) {
  const liveId = character.liveId;
  const hasLive = !!live && live.status === "ok";
  const w = hasLive && liveId && live.wounds && live.wounds[liveId] != null ? live.wounds[liveId] : null;
  const s = hasLive && liveId && live.strain && live.strain[liveId] != null ? live.strain[liveId] : null;
  const d = hasLive && live.destiny ? live.destiny : null;
  // Critical injuries in the store are just Table 6-10 result numbers —
  // resolved here to the same "NN - Name" text the static ledger.json
  // entries use, so both render identically. Additive only: these are
  // appended alongside whatever's already in vitals.criticalInjuries.
  const liveCritNums =
    hasLive && liveId && live.criticalInjuries && Array.isArray(live.criticalInjuries[liveId])
      ? live.criticalInjuries[liveId]
      : [];

  const vitals = character.vitals || {};
  const staticWounds = vitals.wounds || {};
  const staticStrain = vitals.strain || {};
  // Everything live comes from the shared /manual store. Once it has loaded,
  // a character with no entry yet (e.g. just created) is simply unhurt: 0.
  // Only while the store hasn't answered is the value unknown (null).
  const woundsCurrent = w != null ? w : hasLive ? 0 : null;
  const strainCurrent = s != null ? s : hasLive ? 0 : null;
  const baseStrainThreshold = staticStrain.threshold ?? 0;
  const obligationPenalty = hasLive && liveId ? (live.obligationStrain?.penalties?.[liveId] || 0) : 0;
  const effectiveStrainThreshold = Math.max(1, baseStrainThreshold - obligationPenalty);

  return {
    wounds: { current: woundsCurrent, threshold: staticWounds.threshold ?? 0 },
    strain: { current: strainCurrent, threshold: effectiveStrainThreshold, baseThreshold: baseStrainThreshold, obligationPenalty },
    destiny: d || (hasLive ? { light: 0, dark: 0 } : null), // null only until the store has loaded
    criticalInjuriesLive: liveCritNums.map((n) => criticalInjuryTextFromNumber(n)),
  };
}

// ---------------------------------------------------------------------------
// GM tab — hidden behind a UI gesture, protected by a server-checked key.
//
// The gesture (five quick clicks on the campaign name) is purely a curtain:
// it stops a player from ever seeing a login form, but it isn't what makes
// GM stuff GM-only. The actual protection is GM_PASSWORD, a Worker secret
// the GM's browser sends as the x-gm-key header on every /gm/* request and
// every write to /visibility (see worker/index.js) — a tab nobody can see is
// still just a tab if a curious player finds it, so the Worker checks the
// key server-side rather than trusting the client to behave.
//
// What this buys, specifically: a weapon/armor/inventory item's *visibility*
// (shown vs. hidden) can only be changed by someone holding the key. It does
// NOT make the item's underlying stats secret from network traffic — this
// campaign's ledger.json is a public static file fetched in full by every
// browser, same as before this feature existed. If a player opens devtools
// they can already see a "hidden" item's full stat block; the GM tab and its
// key control who can *toggle* that item in front of the table, not who can
// theoretically read the wire. That's the same trade this project's ledger
// convention has always made — see the "hidden" comment further down.
const GM_KEY_STORAGE = "sr-gm-key";
const GM_REVEAL_STORAGE = "sr-gm-revealed";
const GM_REVEAL_CLICKS = 5;
const GM_REVEAL_WINDOW_MS = 2500;

function useGmAuth() {
  const [key, setKey] = useState(() => {
    try {
      return campaignStorage.getItem(GM_KEY_STORAGE) || "";
    } catch {
      return "";
    }
  });
  const [state, setState] = useState(key ? "checking" : "out");
  const [error, setError] = useState("");

  // Re-check on load: the secret may have been rotated since this browser
  // last stored a key, and finding that out at the door beats finding out as
  // an inexplicably empty GM page.
  useEffect(() => {
    let cancelled = false;
    if (!key) {
      setState("out");
      return undefined;
    }
    setState("checking");
    apiFetch("/gm/check", { headers: { "x-gm-key": key }, cache: "no-store" })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setState("in");
          setError("");
        } else {
          setState("out");
          setError("That key isn't accepted any more — it may have been changed.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState("out");
          setError("Couldn't reach the server to check the key.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  async function signIn(candidate) {
    const trimmed = candidate.trim();
    if (!trimmed) return;
    setState("checking");
    try {
      const res = await apiFetch("/gm/check", { headers: { "x-gm-key": trimmed }, cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState("out");
        setError(body.configured === false ? "No GM key is set on the server yet — see the deploy steps in the README." : "Wrong key.");
        return;
      }
      try {
        campaignStorage.setItem(GM_KEY_STORAGE, trimmed);
      } catch {
        /* private mode — the key just won't survive a reload */
      }
      setKey(trimmed);
      setError("");
      setState("in");
    } catch (err) {
      setState("out");
      setError(`Couldn't reach the server — ${err.message}`);
    }
  }

  function signOut() {
    try {
      campaignStorage.removeItem(GM_KEY_STORAGE);
    } catch {
      /* ignore */
    }
    setKey("");
    setState("out");
    setError("");
  }

  return { key: state === "in" ? key : "", state, error, signIn, signOut };
}

// Live weapon/armor/inventory visibility overrides (see VisibilityLog in
// worker/index.js). Read is open to every browser — the Character tab needs
// these too, to know whether a GM has revealed or re-hidden something this
// session — only writing a new override needs the GM key.
function visibilityKey(characterId, category, itemName) {
  return `${characterId}::${category}::${itemName}`;
}

// Force sensitivity is a GM-only attribute. ledger.json may set
// "forceSensitive": true on a character as the baseline, and the GM page can
// flip it live — stored in this same GM-write /visibility store under its own
// key, so "Reset overrides" falls back to the ledger value like everything
// else here. It is never shown on a character sheet; its only player-facing
// effect is that the Advancement Planner hides Force talents (talents.json
// "force": "Yes") unless the character is Force Sensitive.
function forceSensitiveKey(characterId) {
  return `${characterId}::force::sensitive`;
}

function isForceSensitive(character, overrides) {
  const key = forceSensitiveKey(character?.liveId || character?.name);
  return Object.prototype.hasOwnProperty.call(overrides || {}, key) ? !!overrides[key] : !!character?.forceSensitive;
}

function useVisibilityOverrides() {
  const [overrides, setOverrides] = useState({});

  const fetchOverrides = useCallback(async () => {
    try {
      const res = await apiFetch(`/visibility?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setOverrides(data?.overrides || {});
    } catch {
      // Best-effort — leave whatever was last loaded (or empty) rather than
      // blocking the sheet if the Worker/Durable Object isn't reachable.
    }
  }, []);

  useEffect(() => {
    fetchOverrides();
    const t = setInterval(fetchOverrides, 4000);
    return () => clearInterval(t);
  }, [fetchOverrides]);

  return { overrides, refresh: fetchOverrides };
}

// ---------------------------------------------------------------------------
// Shared session state — Wounds/Strain/Destiny/Critical Injuries/Vehicle/
// Initiative, plus item counts and worn armor — backed by the /manual route
// + ManualLog Durable Object (see worker/index.js). Open write, same trust
// model as /rolls, /notes, /bio and /crew, so any browser at the table can
// click a +/- or a destiny token without the GM key. CampaignDashboard
// mirrors it into its `live` state (see the sync effect there).
function emptyManualShape() {
  return {
    enabled: false,
    wounds: {},
    strain: {},
    destiny: { light: 0, dark: 0 },
    criticalInjuries: {},
    vehicle: { hull: 0, systemStrain: 0, criticalHits: [] },
    // Live Hull Trauma / System Strain / Critical Hits per campaign vehicle,
    // keyed by the vehicle's id.
    vehicles: {},
    initiative: { order: [], taken: 0 },
    obligationStrain: { active: false, triggeredId: "", triggeredName: "", multiplier: 1, roll: 0, penalties: {} },
    // Live, open-write item counts — how many of a given weapon/armor/
    // equipment item a character is currently carrying. Keyed by
    // `itemQtyKey()` (see below), not by liveId alone, since a character can
    // carry several distinct items at once. There's no ledger.json baseline for
    // "how many grenades are left", so this is always the source of truth.
    // Anyone
    // at the table can click +/- here, same trust model as wounds/strain.
    itemQty: {},
    // Which armor a character currently has on, when they own more than one
    // (see armorOptionsFor/pickWornArmor) — keyed by characterId, valued
    // with an armor option id ("ledger" for the baseline, or a GearLog
    // item's own id). Missing means "default to the ledger baseline", ""
    // means "explicitly nothing worn". Live/open-write, same as itemQty —
    // there's no ledger.json baseline for "which of my two jackets am I
    // wearing right now."
    wornArmor: {},
  };
}

// Stable key for the itemQty map above. Gear the GM added via the
// Field-Acquired Gear board (see useGearStore) already has its own stable
// `id`, so keying off that keeps the GM tab's stepper and the character
// tab's stepper pointed at the exact same counter. A ledger.json baseline
// item has no id, so it falls back to character+section+name — good enough
// since a character rarely carries two identically-named baseline items.
function itemQtyKey(characterId, item, kind) {
  return item?.id ? `gear:${item.id}` : `${kind}:${characterId}:${item?.name || ""}`;
}

// Live state for one vehicle, defaulting to undamaged.
function vehicleLiveOf(manualState, id) {
  return manualState?.vehicles?.[id] || { hull: 0, systemStrain: 0, criticalHits: [] };
}

// The campaign's vehicles as a list. Older files carry one top-level
// `vehicle`; that reads as a single-entry list with the id "ship".
function campaignVehicles(campaign) {
  if (Array.isArray(campaign?.vehicles)) return campaign.vehicles.filter((v) => v && typeof v === "object" && v.id);
  return campaign?.vehicle ? [{ id: "ship", ...campaign.vehicle }] : [];
}

function useManualStore() {
  const [state, setState] = useState(emptyManualShape());
  const stateRef = useRef(state);
  const [loadState, setLoadState] = useState({ state: "loading" });
  const dirtyUntil = useRef(0);
  const pollTimer = useRef(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await apiFetch(`/manual?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (Date.now() < dirtyUntil.current) return;
      const next = { ...emptyManualShape(), ...data };
      stateRef.current = next;
      setState(next);
      setLoadState({ state: "ok" });
    } catch (err) {
      setLoadState({ state: "error", msg: err.message });
    }
  }, []);

  useEffect(() => {
    fetchState();
    pollTimer.current = setInterval(fetchState, MANUAL_POLL_MS);
    return () => clearInterval(pollTimer.current);
  }, [fetchState]);

  // Optimistic: apply the patch locally right away (so a click feels
  // instant), mark the store "dirty" for a moment so the next poll can't
  // stomp it with a stale read, then post the same patch to the server.
  const patch = useCallback((partial) => {
    setState((prev) => {
      const next = { ...prev };
      if (partial.enabled !== undefined) next.enabled = partial.enabled;
      if (partial.wounds) next.wounds = { ...prev.wounds, ...partial.wounds };
      if (partial.strain) next.strain = { ...prev.strain, ...partial.strain };
      if (partial.destiny) next.destiny = { ...prev.destiny, ...partial.destiny };
      if (partial.criticalInjuries) next.criticalInjuries = { ...prev.criticalInjuries, ...partial.criticalInjuries };
      if (partial.vehicle) next.vehicle = { ...prev.vehicle, ...partial.vehicle };
      if (partial.vehicles) {
        next.vehicles = { ...prev.vehicles };
        for (const [id, v] of Object.entries(partial.vehicles)) next.vehicles[id] = { ...vehicleLiveOf(prev, id), ...v };
      }
      if (partial.initiative) next.initiative = { ...prev.initiative, ...partial.initiative };
      if (partial.obligationStrain) next.obligationStrain = { ...prev.obligationStrain, ...partial.obligationStrain };
      if (partial.itemQty) next.itemQty = { ...prev.itemQty, ...partial.itemQty };
      if (partial.wornArmor) next.wornArmor = { ...prev.wornArmor, ...partial.wornArmor };
      stateRef.current = next;
      return next;
    });
    dirtyUntil.current = Date.now() + MANUAL_DIRTY_MS;
    apiFetch("/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(partial),
    }).catch(() => {
      /* best-effort; the next poll after the dirty window reconciles */
    });
  }, []);

  const setWound = useCallback((liveId, n) => patch({ wounds: { [liveId]: Math.max(0, n) } }), [patch]);
  const adjustWound = useCallback((liveId, delta) => {
    setState((prev) => {
      const n = Math.max(0, (prev.wounds[liveId] || 0) + delta);
      patch({ wounds: { [liveId]: n } });
      return prev;
    });
  }, [patch]);
  const setStrain = useCallback((liveId, n) => patch({ strain: { [liveId]: Math.max(0, n) } }), [patch]);
  const adjustStrain = useCallback((liveId, delta) => {
    setState((prev) => {
      const n = Math.max(0, (prev.strain[liveId] || 0) + delta);
      patch({ strain: { [liveId]: n } });
      return prev;
    });
  }, [patch]);
  // Flipping a Destiny Point moves it from one side of the pool to the
  // other, per the core rules — the same conversion a light-side spend (or a
  // GM's dark-side spend) causes at the table.
  const flipDestiny = useCallback((side) => {
    const { light, dark } = stateRef.current.destiny;
    if (side === "light" && light > 0) patch({ destiny: { light: light - 1, dark: dark + 1 } });
    if (side === "dark" && dark > 0) patch({ destiny: { light: light + 1, dark: dark - 1 } });
  }, [patch]);
  // Directly sets the pool — for rolling a fresh pool at session start, or
  // any other correction that isn't a one-point flip.
  const setDestiny = useCallback((light, dark) => {
    patch({ destiny: { light: Math.max(0, Math.round(light) || 0), dark: Math.max(0, Math.round(dark) || 0) } });
  }, [patch]);
  const addCritInjury = useCallback((liveId, num) => {
    setState((prev) => {
      const existing = prev.criticalInjuries[liveId] || [];
      patch({ criticalInjuries: { [liveId]: [...existing, num] } });
      return prev;
    });
  }, [patch]);
  const removeCritInjury = useCallback((liveId, index) => {
    setState((prev) => {
      const existing = prev.criticalInjuries[liveId] || [];
      patch({ criticalInjuries: { [liveId]: existing.filter((_, i) => i !== index) } });
      return prev;
    });
  }, [patch]);
  // Every vehicle call takes the campaign vehicle's id first.
  const patchVehicle = useCallback((id, fields) => patch({ vehicles: { [id]: fields } }), [patch]);
  const setVehicleHull = useCallback((id, n) => patchVehicle(id, { hull: Math.max(0, n) }), [patchVehicle]);
  const adjustVehicleHull = useCallback((id, delta) => {
    patchVehicle(id, { hull: Math.max(0, (vehicleLiveOf(stateRef.current, id).hull || 0) + delta) });
  }, [patchVehicle]);
  const setVehicleSystemStrain = useCallback((id, n) => patchVehicle(id, { systemStrain: Math.max(0, n) }), [patchVehicle]);
  const adjustVehicleSystemStrain = useCallback((id, delta) => {
    patchVehicle(id, { systemStrain: Math.max(0, (vehicleLiveOf(stateRef.current, id).systemStrain || 0) + delta) });
  }, [patchVehicle]);
  const addVehicleCritHit = useCallback((id, num) => {
    patchVehicle(id, { criticalHits: [...(vehicleLiveOf(stateRef.current, id).criticalHits || []), num] });
  }, [patchVehicle]);
  const removeVehicleCritHit = useCallback((id, index) => {
    patchVehicle(id, { criticalHits: (vehicleLiveOf(stateRef.current, id).criticalHits || []).filter((_, i) => i !== index) });
  }, [patchVehicle]);
  const setInitiative = useCallback((initiative) => patch({ initiative }), [patch]);
  const setObligationStrain = useCallback((obligationStrain) => patch({ obligationStrain }), [patch]);
  // Item quantity: defaults to 1 when a key hasn't been touched yet (an item
  // that exists at all is assumed to start as "at least one"), floors at 0
  // rather than going negative once it's actually been tracked.
  const qtyOf = useCallback((key) => state.itemQty[key] ?? 1, [state.itemQty]);
  const adjustQty = useCallback((key, delta) => {
    setState((prev) => {
      const current = prev.itemQty[key] ?? 1;
      const n = Math.max(0, current + delta);
      patch({ itemQty: { [key]: n } });
      return prev;
    });
  }, [patch]);
  const setQty = useCallback((key, n) => patch({ itemQty: { [key]: Math.max(0, Math.round(n) || 0) } }), [patch]);
  // "" explicitly means "taken everything off" — distinct from the key
  // simply being absent, which defaults to the ledger baseline (see
  // pickWornArmor). Setting a different armor's id here is what makes the
  // "worn" checkboxes mutually exclusive: there's only ever one key per
  // character, so picking a new one silently un-picks whatever it replaces.
  const wornArmorOf = useCallback((characterId) => state.wornArmor[characterId], [state.wornArmor]);
  const setWornArmor = useCallback((characterId, armorId) => patch({ wornArmor: { [characterId]: armorId } }), [patch]);

  return {
    ...state,
    loadState,
    setWound,
    adjustWound,
    setStrain,
    adjustStrain,
    flipDestiny,
    setDestiny,
    addCritInjury,
    removeCritInjury,
    setVehicleHull,
    adjustVehicleHull,
    setVehicleSystemStrain,
    adjustVehicleSystemStrain,
    addVehicleCritHit,
    removeVehicleCritHit,
    setInitiative,
    setObligationStrain,
    qtyOf,
    adjustQty,
    setQty,
    wornArmorOf,
    setWornArmor,
  };
}

function GmSignIn({ onSignIn, state, error }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="max-w-sm">
      <div className="text-[11px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#e0763a" }}>GM key</div>
      <div className="mb-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSignIn(draft);
          }}
          placeholder="Key set on the Worker"
          maxLength={200}
          className="w-full bg-transparent border px-2 py-1.5 text-[13px] focus:outline-none"
          style={{ borderColor: error ? "#c23b3b" : "#3a3f42", color: "#e7e2d2", fontFamily: "'JetBrains Mono', monospace" }}
        />
      </div>
      <button
        type="button"
        onClick={() => onSignIn(draft)}
        disabled={!draft.trim() || state === "checking"}
        className="text-[11px] tracking-wide uppercase px-4 py-2 disabled:opacity-40"
        style={{ background: "#e0763a", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
      >
        {state === "checking" ? "Checking…" : "Unlock"}
      </button>
      {error && <p className="text-[12px] mt-2" style={{ color: "#c23b3b" }}>{error}</p>}
      <p className="text-[11px] leading-relaxed mt-3" style={{ color: "#5a5f62" }}>
        The key is checked by the Worker, not by this page — it's kept in this browser until you sign out.
      </p>
    </div>
  );
}

function GmVisibilityRow({ label, categoryLabel, baselineHidden, effectiveHidden, isOverridden, onToggle }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b" style={{ borderColor: "#2a2e3155" }}>
      <span className="text-[13px]" style={{ color: "#e7e2d2" }}>
        {label}
        <span className="ml-2 text-[10px] tracking-[0.15em] uppercase" style={{ color: "#5a5f62" }}>{categoryLabel}</span>
        {isOverridden && (
          <span className="ml-2 text-[10px] tracking-[0.1em] uppercase" style={{ color: "#5ec8d8" }} title={`Ledger default: ${baselineHidden ? "hidden" : "visible"}`}>
            live override
          </span>
        )}
      </span>
      <button
        onClick={() => onToggle(!effectiveHidden)}
        className="text-[11px] tracking-[0.1em] uppercase px-2.5 py-1 border flex-shrink-0"
        style={{
          borderColor: effectiveHidden ? "#3a3f42" : "#6fae60",
          color: effectiveHidden ? "#8a8f93" : "#6fae60",
          fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
        }}
      >
        {effectiveHidden ? "Hidden" : "Visible"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Enemy board — the GM's combat tracker, stated in this system's own terms:
// Minion / Rival / Nemesis, a Wound Threshold, Soak, and (Nemesis only) a
// Strain Threshold. Backed by /enemies + /gm/enemies (see worker/index.js's
// EnemyLog) — GM key required to write; the public read strips Soak and
// exact numbers players shouldn't see mid-fight, same redaction pattern as
// VisibilityLog uses for gear.
// ---------------------------------------------------------------------------
const ENEMY_POLL_MS = 4000;
const ENEMY_DIRTY_MS = 4000;
const ENEMY_SAVE_DEBOUNCE_MS = 500;
const ENEMY_TYPES = [
  { key: "minion", label: "Minion" },
  { key: "rival", label: "Rival" },
  { key: "nemesis", label: "Nemesis" },
];

// How many GM Inbox messages haven't been ticked as actioned yet. Polled from
// the same /notes log the inbox reads, so the nav tab can pulse from any
// other tab. Only runs for the signed-in GM; players never see the pulse.
const INBOX_POLL_MS = 5000;
// XP purchase requests (see CampaignLog.handleXp in worker/index.js). Players
// submit them from the Advancement Planner; the GM approves or rejects them
// on the GM page.
const ADVANCE_POLL_MS = 8000;
function useAdvanceRequests(enabled = true) {
  const [requests, setRequests] = useState([]);
  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(`/campaign/advance?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setRequests(Array.isArray(data.requests) ? data.requests : []);
    } catch { /* keep the last list */ }
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const t = setInterval(refresh, ADVANCE_POLL_MS);
    return () => clearInterval(t);
  }, [enabled, refresh]);
  return { requests, refresh };
}

// Things waiting for the signed-in GM on the GM page: XP purchases and
// finished character creations. Drives the pulse on the ★ GM tab.
function useGmPendingCount(gmKey) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!gmKey) { setCount(0); return undefined; }
    let cancelled = false;
    async function check() {
      try {
        const [a, c] = await Promise.all([
          apiFetch(`/campaign/advance?_=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})),
          apiFetch(`/gm/creation?_=${Date.now()}`, { cache: "no-store", headers: { "x-gm-key": gmKey } }).then((r) => (r.ok ? r.json() : {})),
        ]);
        const n = (a.requests || []).filter((r) => r.status === "pending").length + (c.drafts || []).filter((d) => d.status === "submitted").length;
        if (!cancelled) setCount(n);
      } catch { /* leave the last count */ }
    }
    check();
    const t = setInterval(check, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, [gmKey]);
  return count;
}

// GM page: award XP, and approve or reject what players want to buy.
function GmExperienceSection({ gmKey, party, onChanged }) {
  const { requests, refresh } = useAdvanceRequests(true);
  const [who, setWho] = useState({});
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState({ state: "idle", msg: "" });
  const pending = requests.filter((r) => r.status === "pending");
  const recent = requests.filter((r) => r.status !== "pending").slice(0, 6);
  const cid = (c) => c.liveId || c.name;
  const chosen = party.filter((c) => who[cid(c)]);

  async function call(path, body) {
    const res = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json", "x-gm-key": gmKey || "" }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `The Worker said ${res.status}`);
    return out;
  }
  async function run(fn, done) {
    setStatus({ state: "busy", msg: "" });
    try { const r = await fn(); setStatus({ state: "ok", msg: done(r) }); await refresh(); onChanged?.(); } catch (err) { setStatus({ state: "error", msg: err.message }); }
  }

  const btn = "text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 disabled:opacity-40";
  return (
    <div className="border p-4 mb-5" style={{ borderColor: "#ffb00066", background: "#101315" }}>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-1" style={{ color: "#ffb000" }}>Experience</div>
      <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8a8f93" }}>
        Award XP here; it's added to each character's available and total XP straight away. Players spend it from their
        sheet's Advancement Planner with "Submit for approval", and their purchases wait below until you approve them. A purchase
        that costs more XP than the character has can't be submitted, and is checked again when you approve.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button type="button" onClick={() => setWho(Object.fromEntries(party.map((c) => [cid(c), true])))} className="text-[10px] uppercase tracking-[0.12em] px-2 py-1 border" style={{ borderColor: "#3a3f42", color: "#8a8f93" }}>Whole party</button>
        {party.map((c) => (
          <label key={cid(c)} className="text-[12px] flex items-center gap-1.5 px-2 py-1 border" style={{ borderColor: who[cid(c)] ? "#ffb000" : "#3a3f42", color: "#e7e2d2" }}>
            <input type="checkbox" checked={!!who[cid(c)]} onChange={(e) => setWho((w) => ({ ...w, [cid(c)]: e.target.checked }))} />
            {c.name} <span className="mono-num" style={{ color: "#8a8f93" }}>{c.xp?.available ?? 0} XP</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XP" className="w-20 bg-transparent border px-2 py-1.5 text-[12px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Reason (e.g. Session 3)" className="flex-1 min-w-[180px] bg-transparent border px-2 py-1.5 text-[12px]" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
        <button
          type="button"
          disabled={!chosen.length || !Number(amount) || status.state === "busy"}
          onClick={() => run(() => call("/gm/campaign/xp", { characterIds: chosen.map(cid), amount: Number(amount), reason }), (r) => { setAmount(""); setReason(""); return `${r.amount > 0 ? "+" : ""}${r.amount} XP to ${r.names.join(", ")}.`; })}
          className={btn}
          style={{ background: "#ffb000", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
        >
          Award XP
        </button>
      </div>

      <div className="text-[11px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#8a8f93" }}>Waiting for approval ({pending.length})</div>
      {pending.length === 0 ? <div className="text-[12px] mb-3" style={{ color: "#5a5f62" }}>Nothing waiting.</div> : (
        <div className="space-y-2 mb-3">
          {pending.map((r) => {
            const c = party.find((p) => cid(p) === r.characterId);
            return (
              <div key={r.id} className="border p-3" style={{ borderColor: "#ffb00066", background: "#16191b" }}>
                <div className="text-[12px] mb-1" style={{ color: "#e7e2d2" }}>
                  <strong>{r.characterName}</strong> wants to spend <strong style={{ color: "#ffb000" }}>{r.cost} XP</strong>
                  <span style={{ color: "#8a8f93" }}> · has {c?.xp?.available ?? "?"} XP · {new Date(r.createdAt).toLocaleString()}</span>
                </div>
                <ul className="text-[12px] list-disc pl-5" style={{ color: "#c7c2b2" }}>{r.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                {r.note && <div className="text-[12px] mt-1 italic" style={{ color: "#8a8f93" }}>“{r.note}”</div>}
                <div className="flex gap-2 mt-2">
                  <button type="button" disabled={status.state === "busy"} onClick={() => run(() => call(`/gm/campaign/advance/${r.id}/approve`, {}), (o) => `Approved: ${r.characterName} now has ${o.xpLeft} XP left.`)} className={btn} style={{ background: "#6fae60", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>Approve</button>
                  <button type="button" disabled={status.state === "busy"} onClick={() => { const note = window.prompt(`Why are you rejecting ${r.characterName}'s purchase? (shown to the player)`); if (note !== null) run(() => call(`/gm/campaign/advance/${r.id}/reject`, { note }), () => "Rejected."); }} className={`${btn} border`} style={{ borderColor: "#c23b3b66", color: "#c23b3b", fontFamily: "'Rajdhani', sans-serif" }}>Reject</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {recent.length > 0 && (
        <>
          <div className="text-[11px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#8a8f93" }}>Recently decided</div>
          <div className="text-[11px] space-y-0.5" style={{ color: "#8a8f93" }}>
            {recent.map((r) => <div key={r.id}><span style={{ color: r.status === "approved" ? "#6fae60" : "#c23b3b" }}>{r.status}</span> · {r.characterName} · {r.cost} XP{r.gmNote ? ` · “${r.gmNote}”` : ""}</div>)}
          </div>
        </>
      )}
      {status.msg && <p className="mt-2 text-[12px]" style={{ color: status.state === "error" ? "#c23b3b" : "#6fae60" }}>{status.msg}</p>}
    </div>
  );
}

function useUnactionedNoteCount(enabled) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) { setCount(0); return undefined; }
    let cancelled = false;
    async function check() {
      try {
        const res = await apiFetch(`/notes?_=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const notes = Array.isArray(data.notes) ? data.notes : [];
        if (!cancelled) setCount(notes.filter((n) => !n.actioned).length);
      } catch { /* leave the last known count */ }
    }
    check();
    const timer = setInterval(check, INBOX_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled]);
  return count;
}

// Quick entry for the enemy board: one adversary per line,
//   type,name,soak,wounds,strain   (nemesis)
//   type,name,soak,wounds          (rival)
//   type,name,soak,wounds,number   (minion: last field is how many)
// type is m / r / n (or minion / rival / nemesis). Blank lines and lines
// starting with # are skipped. Returns the new rows plus any line errors.
function parseEnemyLines(text) {
  const rows = [];
  const errors = [];
  const kinds = { m: "minion", minion: "minion", r: "rival", rival: "rival", n: "nemesis", nemesis: "nemesis" };
  const num = (v) => (/^\d+$/.test(v) ? Number(v) : NaN);
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(",").map((p) => p.trim());
    if (i === 0 && parts[0].toLowerCase() === "type") return; // header row
    const lineNo = i + 1;
    const type = kinds[(parts[0] || "").toLowerCase()];
    if (!type) { errors.push({ lineNo, line, msg: "type must be m, r or n" }); return; }
    const name = parts[1] || "";
    if (!name) { errors.push({ lineNo, line, msg: "name is missing" }); return; }
    const soak = num(parts[2]);
    const woundThreshold = num(parts[3]);
    if (Number.isNaN(soak) || Number.isNaN(woundThreshold) || woundThreshold < 1) {
      errors.push({ lineNo, line, msg: "soak and wounds must be whole numbers (wounds at least 1)" });
      return;
    }
    let minionCount = 1;
    let strainThreshold = 0;
    if (type === "minion") {
      if (parts[4] !== undefined && parts[4] !== "") {
        minionCount = num(parts[4]);
        if (Number.isNaN(minionCount) || minionCount < 1 || minionCount > 20) {
          errors.push({ lineNo, line, msg: "minion number must be 1-20" });
          return;
        }
      }
    } else if (type === "nemesis") {
      strainThreshold = num(parts[4]);
      if (Number.isNaN(strainThreshold) || strainThreshold < 1) {
        errors.push({ lineNo, line, msg: "nemesis needs a strain threshold" });
        return;
      }
    }
    rows.push({
      lineNo,
      id: crypto.randomUUID(),
      name: name.slice(0, 60),
      type,
      soak: Math.min(soak, 60),
      woundThreshold: Math.min(woundThreshold, 60),
      minionCount,
      wounds: 0,
      strainThreshold: Math.min(strainThreshold, 60),
      strain: 0,
      hidden: true,
    });
  });
  return { rows, errors };
}

const ENEMY_BOARD_MAX = 30;
function EnemyBulkEntry({ enemyStore }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const { rows, errors } = parseEnemyLines(text);
  const room = Math.max(0, ENEMY_BOARD_MAX - enemyStore.enemies.length);

  function handleAdd() {
    const toAdd = rows.slice(0, room);
    if (toAdd.length === 0) return;
    enemyStore.save([...enemyStore.enemies, ...toAdd.map(({ lineNo, ...enemy }) => enemy)]);
    // Keep only the lines that didn't make it in (errors, or no room left),
    // so nothing typed is lost.
    const lines = text.split(/\r?\n/);
    const leftover = [...errors.map((e) => e.lineNo), ...rows.slice(room).map((r) => r.lineNo)].sort((x, y) => x - y);
    setText(leftover.map((n) => lines[n - 1]).join("\n"));
    setResult(`Added ${toAdd.length} enem${toAdd.length === 1 ? "y" : "ies"} (hidden from players until revealed).${rows.length > toAdd.length ? ` ${rows.length - toAdd.length} skipped: the board holds ${ENEMY_BOARD_MAX}.` : ""}`);
  }

  const typeLabel = { minion: "Minion", rival: "Rival", nemesis: "Nemesis" };
  return (
    <div className="border p-4" style={{ borderColor: "#3a3f42", background: "#16191b" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between text-[11px] tracking-[0.2em] uppercase" style={{ color: "#8a8f93" }}>
        <span>Quick add enemies (text)</span>
        <span style={{ fontSize: 10 }}>{open ? "▲ Hide" : "▼ Show"}</span>
      </button>
      {open && (
        <div className="mt-3">
          <p className="text-[11px] leading-relaxed mb-2" style={{ color: "#5a5f62" }}>
            One enemy per line: <span className="mono-num" style={{ color: "#c7c2b2" }}>type,name,soak,wounds,strain</span>.
            Type is m, r or n. Minions use the last field for how many are in the group (defaults to 1); rivals stop after wounds; nemeses need strain.
          </p>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null); }}
            rows={6}
            spellCheck={false}
            placeholder={"m,Stormtrooper,5,5,5\nr,Supervisor,4,12\nn,Jedi,5,14,16"}
            className="w-full bg-transparent border px-2 py-1.5 text-[13px] mono-num"
            style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
          />
          {rows.length > 0 && (
            <table className="w-full text-left text-[12px] mt-2" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "#8a8f93" }}>
                  <th className="pr-3 py-0.5">Type</th><th className="pr-3 py-0.5">Name</th><th className="pr-3 py-0.5">Soak</th><th className="pr-3 py-0.5">Wounds</th><th className="pr-3 py-0.5">Strain</th><th className="pr-3 py-0.5">Number</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ color: "#e7e2d2" }}>
                    <td className="pr-3 py-0.5">{typeLabel[r.type]}</td>
                    <td className="pr-3 py-0.5">{r.name}</td>
                    <td className="pr-3 py-0.5 mono-num">{r.soak}</td>
                    <td className="pr-3 py-0.5 mono-num">{r.woundThreshold}</td>
                    <td className="pr-3 py-0.5 mono-num">{r.type === "nemesis" ? r.strainThreshold : "—"}</td>
                    <td className="pr-3 py-0.5 mono-num">{r.type === "minion" ? r.minionCount : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {errors.length > 0 && (
            <div className="mt-2 text-[12px] space-y-0.5" style={{ color: "#c23b3b" }}>
              {errors.map((e) => <div key={e.lineNo}>Line {e.lineNo}: {e.msg} — <span className="mono-num">{e.line}</span></div>)}
            </div>
          )}
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleAdd}
              disabled={rows.length === 0 || room === 0}
              className="text-[12px] tracking-wide px-3 py-1.5 border disabled:opacity-40"
              style={{ color: "#101315", background: "#ffb000", borderColor: "#ffb000", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
            >
              Add {rows.length || ""} to enemy board
            </button>
            {room === 0 && <span className="text-[12px]" style={{ color: "#c23b3b" }}>Enemy board is full ({ENEMY_BOARD_MAX}).</span>}
            {result && <span className="text-[12px]" style={{ color: "#6fae60" }}>{result}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function useEnemyStore(gmKey) {
  const [enemies, setEnemies] = useState([]);
  const [loadState, setLoadState] = useState({ state: "loading" });
  const dirtyUntil = useRef(0);
  const pendingRef = useRef(null);
  const saveTimer = useRef(null);
  const pollTimer = useRef(null);
  const keyRef = useRef(gmKey);
  useEffect(() => { keyRef.current = gmKey; }, [gmKey]);

  const flush = useCallback(async () => {
    const next = pendingRef.current;
    if (!next || !keyRef.current) return;
    pendingRef.current = null;
    try {
      await apiFetch("/gm/enemies", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gm-key": keyRef.current },
        body: JSON.stringify({ enemies: next }),
      });
    } catch {
      /* best-effort; the next poll after the dirty window reconciles */
    }
  }, []);

  const save = useCallback((next) => {
    if (!keyRef.current) return;
    setEnemies(next);
    pendingRef.current = next;
    dirtyUntil.current = Date.now() + ENEMY_DIRTY_MS;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, ENEMY_SAVE_DEBOUNCE_MS);
  }, [flush]);

  const fetchEnemies = useCallback(async () => {
    const key = keyRef.current;
    try {
      const res = await apiFetch(`${key ? "/gm/enemies" : "/enemies"}?_=${Date.now()}`, {
        cache: "no-store",
        headers: key ? { "x-gm-key": key } : {},
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (Date.now() < dirtyUntil.current) return;
      setEnemies(Array.isArray(data.enemies) ? data.enemies : []);
      setLoadState({ state: "ok" });
    } catch (err) {
      setLoadState({ state: "error", msg: err.message });
    }
  }, []);

  useEffect(() => {
    fetchEnemies();
    pollTimer.current = setInterval(fetchEnemies, ENEMY_POLL_MS);
    return () => {
      clearInterval(pollTimer.current);
      clearTimeout(saveTimer.current);
    };
  }, [fetchEnemies, gmKey]);

  return { enemies, save, loadState, canEdit: !!gmKey };
}

const GEAR_POLL_MS = 4000;
const GEAR_DIRTY_MS = 4000;
const GEAR_SAVE_DEBOUNCE_MS = 500;

// GM-added weapons/armor/equipment — same shared-store shape as
// useEnemyStore above (poll/save/dirty-window/debounce), backed by /gear +
// /gm/gear (see GearLog in worker/index.js). Hidden items only ever come
// back from /gm/gear (signed-in GM); the public /gear read drops them
// entirely, so a signed-out browser never even learns they exist.
// ---------------------------------------------------------------------------
// Campaign data — characters, vehicle, NPCs, locations, title and wiki link,
// in the same shape ledger.json always had. Stored on the Worker (CampaignLog,
// see worker/index.js) instead of in a file: the GM loads a campaign with
// Import on the GM page and backs it up with Export. Players get a copy with
// hidden characters and gear already removed by the Worker; the signed-in GM
// gets everything. Polls every few seconds, and the Worker answers
// "unchanged" unless something actually moved.
// ---------------------------------------------------------------------------
const CAMPAIGN_POLL_MS = 5000;

function useCampaignStore(gmKey) {
  const [state, setState] = useState({ status: "loading", campaign: null, revision: null, updatedAt: 0, hasSnapshot: false, snapshotSummary: null, error: null });
  const revRef = useRef(null);
  const keyRef = useRef(gmKey);

  const fetchCampaign = useCallback(async (force = false) => {
    const key = keyRef.current;
    const since = !force && revRef.current != null ? `&since=${encodeURIComponent(revRef.current)}` : "";
    try {
      const res = await apiFetch(`${key ? "/gm/campaign" : "/campaign"}?_=${Date.now()}${since}`, {
        cache: "no-store",
        headers: key ? { "x-gm-key": key } : {},
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (keyRef.current !== key) return; // signed in/out mid-request
      if (data.unchanged) {
        setState((prev) => (prev.status === "ok" && !prev.error ? prev : { ...prev, status: "ok", error: null }));
        return;
      }
      revRef.current = data.revision ?? null;
      setState({
        status: "ok",
        campaign: data.campaign || null,
        revision: data.revision ?? null,
        updatedAt: data.updatedAt || 0,
        hasSnapshot: !!data.hasSnapshot,
        snapshotSummary: data.snapshotSummary || null,
        editUndo: data.editUndo || {},
        error: data.error || null,
      });
    } catch (err) {
      setState((prev) => ({ ...prev, status: prev.campaign ? "ok" : "error", error: err.message }));
    }
  }, []);

  useEffect(() => {
    keyRef.current = gmKey;
    revRef.current = null;
    fetchCampaign(true);
    const timer = setInterval(() => fetchCampaign(false), CAMPAIGN_POLL_MS);
    return () => clearInterval(timer);
  }, [gmKey, fetchCampaign]);

  async function gmPost(path, body) {
    const res = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gm-key": keyRef.current || "" },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `The Worker said ${res.status}`);
    await fetchCampaign(true);
    return data;
  }

  return {
    ...state,
    refresh: () => fetchCampaign(true),
    importCampaign: (text) => gmPost("/gm/campaign/import", text),
    restorePrevious: () => gmPost("/gm/campaign/restore", ""),
    saveSettings: (settings) => gmPost("/gm/campaign/settings", JSON.stringify(settings)),
    saveVehicle: (vehicle) => gmPost("/gm/campaign/vehicle", JSON.stringify({ vehicle })),
    removeVehicle: (id) => gmPost("/gm/campaign/vehicle", JSON.stringify({ removeId: id })),
    importCharacter: (text) => gmPost("/gm/campaign/character/import", text),
    saveCharacter: (characterId, character, note) => gmPost("/gm/campaign/character", JSON.stringify({ characterId, character, note })),
    undoCharacter: (characterId) => gmPost("/gm/campaign/character/undo", JSON.stringify({ characterId })),
    async exportCampaign() {
      const res = await apiFetch("/gm/campaign/export", { headers: { "x-gm-key": keyRef.current || "" }, cache: "no-store" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `The Worker said ${res.status}`);
      }
      const blob = await res.blob();
      const match = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = match ? match[1] : "campaign.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  };
}

function describeCampaign(c) {
  if (!c) return "nothing loaded";
  const parts = [
    `${c.characters} character${c.characters === 1 ? "" : "s"}${c.hiddenCharacters ? ` (${c.hiddenCharacters} hidden)` : ""}`,
    c.vehicles > 1 ? `${c.vehicles} vehicles` : c.vehicle || c.vehicles === 1 ? "a vehicle" : null,
  ].filter(Boolean);
  return `${c.title ? `"${c.title}": ` : ""}${parts.join(", ")}`;
}

function summariseCampaignFile(data) {
  const characters = Array.isArray(data?.characters) ? data.characters : [];
  return {
    title: typeof data?.campaign === "string" ? data.campaign : "",
    characters: characters.length,
    hiddenCharacters: characters.filter((c) => c?.hidden).length,
    vehicle: !!data?.vehicle || (Array.isArray(data?.vehicles) && data.vehicles.length > 0),
    vehicles: Array.isArray(data?.vehicles) ? data.vehicles.length : data?.vehicle ? 1 : 0,
    npcs: Array.isArray(data?.npcs) ? data.npcs.length : 0,
    locations: Array.isArray(data?.locations) ? data.locations.length : 0,
  };
}

// GM page: load a campaign in, take a copy out, or undo the last import.
function GmCampaignDataSection({ store }) {
  const [pending, setPending] = useState(null); // { name, text, summary }
  const [pendingChar, setPendingChar] = useState(null); // { name, text, character, replaces }
  const [exportId, setExportId] = useState("");
  const [status, setStatus] = useState({ state: "idle", msg: "" });
  const fileRef = useRef(null);
  const charFileRef = useRef(null);
  const allCharacters = store.campaign?.characters || [];

  function exportCharacter() {
    const c = allCharacters.find((x) => (x.liveId || x.name) === exportId);
    if (!c) return;
    const day = new Date().toISOString().slice(0, 10);
    const slug = String(c.name || "character").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";
    const blob = new Blob([JSON.stringify({ format: "swrpg-character", exportedAt: new Date().toISOString(), character: c }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}-${day}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setStatus({ state: "ok", msg: `Downloaded ${c.name}.` });
  }

  async function chooseCharacterFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setStatus({ state: "idle", msg: "" });
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (Array.isArray(data?.characters)) throw new Error("it's a whole campaign; use Import all for that");
      const character = data?.character && typeof data.character === "object" ? data.character : data;
      if (!character || typeof character !== "object" || !String(character.name || "").trim()) throw new Error("it has no character name");
      const replaces = allCharacters.find((c) => (character.liveId && c.liveId === character.liveId)) || allCharacters.find((c) => c.name === character.name) || null;
      setPendingChar({ name: file.name, text, character, replaces });
    } catch (err) {
      setPendingChar(null);
      setStatus({ state: "error", msg: `Can't use ${file.name}: ${err.message}` });
    }
  }
  const current = store.campaign ? summariseCampaignFile(store.campaign) : null;

  async function chooseFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setStatus({ state: "idle", msg: "" });
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data?.characters)) throw new Error(data?.character || data?.name ? "it's a single character; use Import character for that" : "it has no \"characters\" list, so it isn't a campaign file");
      setPending({ name: file.name, text, summary: summariseCampaignFile(data) });
    } catch (err) {
      setPending(null);
      setStatus({ state: "error", msg: `Can't use ${file.name}: ${err.message}` });
    }
  }

  async function run(label, fn) {
    setStatus({ state: "busy", msg: `${label}…` });
    try {
      const msg = await fn();
      setStatus({ state: "ok", msg });
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }

  const btn = "text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors disabled:opacity-40";
  return (
    <div className="border p-4 mb-5" style={{ borderColor: "#5ec8d866", background: "#101315" }}>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-1" style={{ color: "#5ec8d8" }}>Campaign data</div>
      <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8a8f93" }}>
        The characters and vehicles everyone sees. <strong style={{ color: "#e7e2d2" }}>Import all</strong> replaces the whole
        campaign from a file (the one it replaces is kept so you can undo); <strong style={{ color: "#e7e2d2" }}>Export all</strong> downloads
        everything as one file, your backup. <strong style={{ color: "#e7e2d2" }}>One character</strong> moves a single sheet in or out:
        importing replaces the character with the same name (undoable) or adds them if they're new. Players never receive hidden characters or gear.
      </p>
      <div className="text-[12px] mb-3" style={{ color: "#e7e2d2" }}>
        Loaded now: {store.status === "loading" ? "checking…" : describeCampaign(current)}
        {store.error && <span style={{ color: "#c23b3b" }}> · {store.error}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".json,application/json" onChange={chooseFile} className="hidden" />
        <span className="text-[10px] tracking-[0.15em] uppercase w-24" style={{ color: "#8a8f93" }}>Whole campaign</span>
        <button type="button" onClick={() => fileRef.current?.click()} className={btn} style={{ color: "#101315", background: "#5ec8d8", borderColor: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          Import all…
        </button>
        <button
          type="button"
          disabled={!store.campaign || status.state === "busy"}
          onClick={() => run("Exporting", async () => { await store.exportCampaign(); return "Downloaded."; })}
          className={btn}
          style={{ color: "#e7e2d2", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}
        >
          Export all
        </button>
        {store.hasSnapshot && (
          <button
            type="button"
            disabled={status.state === "busy"}
            onClick={() => {
              if (!window.confirm(`Undo the last import and go back to ${describeCampaign(store.snapshotSummary)}? The campaign loaded now is kept, so you can undo this too.`)) return;
              run("Restoring", async () => { const r = await store.restorePrevious(); return `Restored ${describeCampaign(r.summary)}.`; });
            }}
            className={btn}
            style={{ color: "#c9a15a", borderColor: "#c9a15a66", fontFamily: "'Rajdhani', sans-serif" }}
            title={`Go back to ${describeCampaign(store.snapshotSummary)}`}
          >
            Undo last import
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-2">
        <span className="text-[10px] tracking-[0.15em] uppercase w-24" style={{ color: "#8a8f93" }}>One character</span>
        <input ref={charFileRef} type="file" accept=".json,application/json" onChange={chooseCharacterFile} className="hidden" />
        <button type="button" onClick={() => charFileRef.current?.click()} disabled={status.state === "busy"} className={btn} style={{ color: "#5ec8d8", borderColor: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          Import character…
        </button>
        <select value={exportId} onChange={(e) => setExportId(e.target.value)} className="bg-[#0b0d0e] border px-2 py-1 text-[12px]" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}>
          <option value="">Choose a character…</option>
          {allCharacters.map((c) => <option key={c.liveId || c.name} value={c.liveId || c.name}>{c.name}{c.hidden ? " (hidden)" : ""}</option>)}
        </select>
        <button type="button" onClick={exportCharacter} disabled={!exportId} className={btn} style={{ color: "#e7e2d2", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}>
          Export character
        </button>
      </div>

      {pendingChar && (
        <div className="mt-3 p-3 border" style={{ borderColor: "#ffb00066", background: "#ffb0000d" }}>
          <div className="text-[12px] mb-2" style={{ color: "#e7e2d2" }}>
            {pendingChar.replaces
              ? <>Replace <strong>{pendingChar.replaces.name}</strong> with the copy in {pendingChar.name}? Their current sheet is kept, so <em>Undo last edit</em> under Edit a character puts it back.</>
              : <>Add <strong>{pendingChar.character.name}</strong> from {pendingChar.name} as a new character?</>}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={status.state === "busy"}
              onClick={() => {
                const { text, character, replaces } = pendingChar;
                setPendingChar(null);
                run("Importing", async () => { await store.importCharacter(text); return replaces ? `Replaced ${replaces.name}.` : `Added ${character.name}.`; });
              }}
              className={btn}
              style={{ color: "#101315", background: "#ffb000", borderColor: "#ffb000", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
            >
              {pendingChar.replaces ? "Replace character" : "Add character"}
            </button>
            <button type="button" onClick={() => setPendingChar(null)} className={btn} style={{ color: "#8a8f93", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending && (
        <div className="mt-3 p-3 border" style={{ borderColor: "#ffb00066", background: "#ffb0000d" }}>
          <div className="text-[12px] mb-2" style={{ color: "#e7e2d2" }}>
            Import <strong>{pending.name}</strong>: {describeCampaign(pending.summary)}.
            {current ? <> This replaces {describeCampaign(current)} for everyone.</> : null}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={status.state === "busy"}
              onClick={() => {
                const { text, name } = pending;
                setPending(null);
                run("Importing", async () => { const r = await store.importCampaign(text); return `Imported ${name}: ${describeCampaign(r.summary)}.`; });
              }}
              className={btn}
              style={{ color: "#101315", background: "#ffb000", borderColor: "#ffb000", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
            >
              Replace campaign
            </button>
            <button type="button" onClick={() => setPending(null)} className={btn} style={{ color: "#8a8f93", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {status.msg && (
        <p className="mt-2 text-[12px]" style={{ color: status.state === "error" ? "#c23b3b" : status.state === "busy" ? "#8a8f93" : "#6fae60" }}>{status.msg}</p>
      )}
    </div>
  );
}

// GM page: campaign title and the wiki link the Wiki tab shows.
function GmCampaignSettingsSection({ store }) {
  const savedTitle = store.campaign?.campaign || "";
  const savedWiki = store.campaign?.wikiUrl || "";
  const [title, setTitle] = useState(savedTitle);
  const [wiki, setWiki] = useState(savedWiki);
  const [status, setStatus] = useState({ state: "idle", msg: "" });
  const dirty = title !== savedTitle || wiki !== savedWiki;

  // Follow the server while the GM hasn't typed anything.
  useEffect(() => {
    if (!dirty) { setTitle(savedTitle); setWiki(savedWiki); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedTitle, savedWiki]);

  async function save() {
    setStatus({ state: "busy", msg: "Saving…" });
    try {
      await store.saveSettings({ title, wikiUrl: wiki });
      setStatus({ state: "ok", msg: wiki.trim() ? "Saved. The Wiki tab now opens this link." : "Saved. The Wiki tab has no link now." });
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }

  const field = "w-full bg-[#0b0d0e] border px-2.5 py-1.5 text-[13px] outline-none focus:border-[#5ec8d8]";
  const btn = "text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors disabled:opacity-40";
  return (
    <div className="border p-4 mb-5" style={{ borderColor: "#3a3f42", background: "#101315" }}>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-1" style={{ color: "#5ec8d8" }}>Campaign settings</div>
      <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8a8f93" }}>
        The campaign's name, and the wiki link players get on the Wiki tab (for example your GitHub Pages address).
      </p>
      <label className="block text-[10px] tracking-[0.15em] uppercase mb-1" style={{ color: "#8a8f93" }}>Campaign name</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className={`${field} mb-3`} style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} placeholder="Campaign name" />
      <label className="block text-[10px] tracking-[0.15em] uppercase mb-1" style={{ color: "#8a8f93" }}>Wiki link</label>
      <input value={wiki} onChange={(e) => setWiki(e.target.value)} maxLength={500} className={`${field} mb-3`} style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} placeholder="https://your-name.github.io/your-repo/" inputMode="url" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={!dirty || status.state === "busy"} className={btn} style={{ color: "#101315", background: "#5ec8d8", borderColor: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          Save
        </button>
        {savedWiki && (
          <a href={savedWiki} target="_blank" rel="noopener noreferrer" className="text-[11px] underline" style={{ color: "#8fd3f4" }}>Open wiki</a>
        )}
        {status.msg && <span className="text-[12px]" style={{ color: status.state === "error" ? "#c23b3b" : status.state === "busy" ? "#8a8f93" : "#6fae60" }}>{status.msg}</span>}
      </div>
    </div>
  );
}

// Static lists the vehicle editor picks from: every starship (Genesys
// conversions, from reference/starships.json via
// reference/scripts/build_starship_index.py), the vehicle weapon table, and
// the generic crew positions with their manoeuvres and actions.
function useVehicleReference() {
  const [ref, setRef] = useState({ ships: [], weapons: [], positions: [], status: "loading" });
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch("/data/starship-index.json").then((r) => r.json()).catch(() => []),
      apiFetch("/data/vehicle-weapons.json").then((r) => r.json()).catch(() => ({})),
      apiFetch("/data/vehicle-template.json").then((r) => r.json()).catch(() => ({})),
    ]).then(([ships, weapons, template]) => {
      if (cancelled) return;
      setRef({
        ships: Array.isArray(ships) ? ships : [],
        weapons: Array.isArray(weapons?.weapons) ? weapons.weapons : [],
        positions: Array.isArray(template?.crewPositions) ? template.crewPositions : [],
        status: "ok",
      });
    });
    return () => { cancelled = true; };
  }, []);
  return ref;
}

const BLANK_VEHICLE_WEAPON = { name: "", fireArc: "Forward", range: "Long", damage: 0, crit: 0, qualities: "" };

function vehicleFromShip(ship, positions) {
  // A one-seat starfighter gets just a pilot; anything bigger gets the full crew.
  const smallCraft = (ship.silhouette || 0) <= 3 && /^1\b/.test(ship.crew || "");
  const crewPositions = positions
    .filter((p) => !smallCraft || p.id === "pilot")
    .map((p) => ({ ...p, ...(p.weaponIndex != null ? { weaponIndex: ship.weapons?.length ? 0 : null } : {}) }));
  return {
    name: ship.name,
    class: [ship.model, ship.manufacturer].filter(Boolean).join(" · ") || ship.category,
    silhouette: ship.silhouette, speed: ship.speed, handling: ship.handling, defense: ship.defense, armor: ship.armor,
    hullTrauma: { threshold: ship.hullTrauma },
    systemStrain: { threshold: ship.systemStrain },
    sensors: ship.sensors || "",
    specialFeatures: [ship.hyperdrive && `Hyperdrive: ${ship.hyperdrive}`, ship.crew && `Crew: ${ship.crew}`, ship.passengers ? `Passengers: ${ship.passengers}` : null, ship.encumbrance != null ? `Encumbrance capacity: ${ship.encumbrance}` : null, ship.notes || null].filter(Boolean),
    weapons: (ship.weapons || []).map((w) => ({ ...w })),
    crewPositions,
    hidden: false,
  };
}

// GM page: the campaign's vehicles. Collapsed to a one-line summary by
// default; each vehicle gets its own tab on the dashboard, named after it.
function GmVehicleSection({ store }) {
  const vehicles = campaignVehicles(store.campaign);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // vehicle id, or "new"
  const btn = "text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors disabled:opacity-40";
  return (
    <div className="border mb-5" style={{ borderColor: "#3a3f42", background: "#101315" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#5ec8d8" }}>
          Vehicles <span style={{ color: "#8a8f93" }}>({vehicles.length})</span>
        </span>
        <span className="text-[11px] truncate" style={{ color: "#8a8f93" }}>
          {vehicles.length ? vehicles.map((v) => v.name).join(" · ") : "None yet"} <span className="ml-2" style={{ color: "#5ec8d8" }}>{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8a8f93" }}>
            Each vehicle gets its own tab on the dashboard, named after it. Hull Trauma, System Strain and Critical Hits are
            tracked live on that tab and in the Session Tracker.
          </p>
          <div className="space-y-2 mb-3">
            {vehicles.map((v) => (
              <div key={v.id}>
                <div className="flex items-center justify-between gap-2 border px-3 py-2" style={{ borderColor: editing === v.id ? "#5ec8d8" : "#2a2e31", background: "#131719" }}>
                  <div className="min-w-0">
                    <div className="text-[14px] truncate" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
                      {v.name}{v.hidden && <span className="text-[10px] ml-2 uppercase tracking-[0.1em]" style={{ color: "#c9a15a" }}>hidden</span>}
                    </div>
                    <div className="text-[11px] truncate" style={{ color: "#8a8f93" }}>
                      {[v.class, `Sil ${v.silhouette ?? "—"}`, `HT ${v.hullTrauma?.threshold ?? "—"}`, `SS ${v.systemStrain?.threshold ?? "—"}`, `${(v.weapons || []).length} weapon${(v.weapons || []).length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <button type="button" onClick={() => setEditing(editing === v.id ? null : v.id)} className={btn} style={{ color: "#e7e2d2", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}>
                    {editing === v.id ? "Close" : "Edit"}
                  </button>
                </div>
                {editing === v.id && <GmVehicleEditor store={store} saved={v} onClose={() => setEditing(null)} />}
              </div>
            ))}
          </div>
          {editing === "new" ? (
            <GmVehicleEditor store={store} saved={null} onClose={() => setEditing(null)} />
          ) : (
            <button type="button" onClick={() => setEditing("new")} className={btn} style={{ color: "#101315", background: "#5ec8d8", borderColor: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
              + Add vehicle
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function GmVehicleEditor({ store, saved, onClose }) {
  const ref = useVehicleReference();
  const [draft, setDraft] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState({ state: "idle", msg: "" });
  const savedJson = JSON.stringify(saved);

  useEffect(() => {
    if (!dirty) setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedJson]);

  function edit(fn) {
    setDraft((d) => fn(JSON.parse(JSON.stringify(d))));
    setDirty(true);
    setStatus({ state: "idle", msg: "" });
  }
  const setField = (k, v) => edit((d) => { d[k] = v; return d; });
  const setNum = (k, v) => setField(k, v === "" ? "" : Number(v));

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return ref.ships.filter((s) => `${s.name} ${s.model} ${s.category} ${s.manufacturer}`.toLowerCase().includes(q)).slice(0, 25);
  }, [query, ref.ships]);

  function startFrom(ship) {
    setDraft(ship ? vehicleFromShip(ship, ref.positions) : {
      name: "", class: "", silhouette: 3, speed: 3, handling: 0, defense: 0, armor: 0,
      hullTrauma: { threshold: 10 }, systemStrain: { threshold: 10 }, sensors: "", specialFeatures: [],
      weapons: [], crewPositions: ref.positions.map((p) => ({ ...p })), hidden: false,
    });
    setDirty(true);
    setQuery("");
    setStatus({ state: "idle", msg: ship ? `Loaded ${ship.name}. Rename it and check the numbers, then Save.` : "" });
  }

  async function save() {
    setStatus({ state: "busy", msg: "Saving…" });
    try {
      await store.saveVehicle(saved ? { ...draft, id: saved.id } : draft);
      setDirty(false);
      if (!saved) { onClose?.(); return; }
      setStatus({ state: "ok", msg: "Saved. Its dashboard tab shows the change now." });
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${saved?.name || "the vehicle"} from the campaign? Export first if you might want it back.`)) return;
    setStatus({ state: "busy", msg: "Removing…" });
    try {
      await store.removeVehicle(saved.id);
      setDirty(false);
      onClose?.();
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }

  function cancel() {
    if (!saved) { onClose?.(); return; }
    setDraft(saved);
    setDirty(false);
    setStatus({ state: "idle", msg: "" });
  }

  const field = "w-full bg-[#0b0d0e] border px-2 py-1 text-[13px] outline-none focus:border-[#5ec8d8]";
  const fs = { borderColor: "#3a3f42", color: "#e7e2d2" };
  const lbl = "block text-[10px] tracking-[0.15em] uppercase mb-1";
  const btn = "text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors disabled:opacity-40";
  const ghost = { color: "#e7e2d2", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" };

  const picker = (
    <div className="mb-3">
      <label className={lbl} style={{ color: "#8a8f93" }}>{draft ? "Replace with a stock ship" : "Find a stock ship"}</label>
      <input value={query} onChange={(e) => setQuery(e.target.value)} className={field} style={fs} placeholder={ref.status === "loading" ? "Loading ships…" : "Type a ship name, e.g. YT-1300, X-wing, Lambda"} />
      {matches.length > 0 && (
        <div className="mt-1 border max-h-64 overflow-y-auto" style={{ borderColor: "#3a3f42" }}>
          {matches.map((s, i) => (
            <button key={i} type="button" onClick={() => startFrom(s)} className="w-full text-left px-2.5 py-1.5 border-b hover:bg-[#1c2023]" style={{ borderColor: "#2a2e31" }}>
              <span className="text-[13px]" style={{ color: "#e7e2d2" }}>{s.name}</span>
              <span className="text-[11px] ml-2" style={{ color: "#8a8f93" }}>{s.category} · Sil {s.silhouette} · Spd {s.speed} · HT {s.hullTrauma}</span>
            </button>
          ))}
        </div>
      )}
      {query.trim().length >= 2 && matches.length === 0 && ref.status === "ok" && (
        <p className="text-[11px] mt-1" style={{ color: "#8a8f93" }}>No ship matches that.</p>
      )}
    </div>
  );

  return (
    <div className="border p-3 mt-1 mb-2" style={{ borderColor: "#5ec8d866", background: "#0e1113" }}>
      {!saved && (
        <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8a8f93" }}>
          Start from a stock ship (Genesys-converted stats) or a blank one, then adjust it.
        </p>
      )}

      {!draft && (
        <>
          {picker}
          <div className="flex gap-2">
            <button type="button" onClick={() => startFrom(null)} className={btn} style={ghost}>Start a blank vehicle</button>
            <button type="button" onClick={() => onClose?.()} className={btn} style={{ color: "#8a8f93", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}>Cancel</button>
          </div>
        </>
      )}

      {draft && (
        <>
          {picker}
          <div className="grid gap-3 sm:grid-cols-2 mb-3">
            <div>
              <label className={lbl} style={{ color: "#8a8f93" }}>Name</label>
              <input value={draft.name || ""} onChange={(e) => setField("name", e.target.value)} className={field} style={fs} placeholder="e.g. Rusty Mynock" />
            </div>
            <div>
              <label className={lbl} style={{ color: "#8a8f93" }}>Class / description</label>
              <input value={draft.class || ""} onChange={(e) => setField("class", e.target.value)} className={field} style={fs} />
            </div>
          </div>
          <div className="grid grid-cols-4 sm:grid-cols-7 gap-2 mb-3">
            {[["silhouette", "Silhouette"], ["speed", "Speed"], ["handling", "Handling"], ["defense", "Defense"], ["armor", "Armor"]].map(([k, l]) => (
              <div key={k}>
                <label className={lbl} style={{ color: "#8a8f93" }}>{l}</label>
                <input type="number" value={draft[k] ?? ""} onChange={(e) => setNum(k, e.target.value)} className={field} style={fs} />
              </div>
            ))}
            <div>
              <label className={lbl} style={{ color: "#8a8f93" }}>Hull Trauma</label>
              <input type="number" min={0} value={draft.hullTrauma?.threshold ?? ""} onChange={(e) => edit((d) => { d.hullTrauma = { threshold: e.target.value === "" ? "" : Number(e.target.value) }; return d; })} className={field} style={fs} />
            </div>
            <div>
              <label className={lbl} style={{ color: "#8a8f93" }}>System Strain</label>
              <input type="number" min={0} value={draft.systemStrain?.threshold ?? ""} onChange={(e) => edit((d) => { d.systemStrain = { threshold: e.target.value === "" ? "" : Number(e.target.value) }; return d; })} className={field} style={fs} />
            </div>
          </div>
          <div className="mb-3">
            <label className={lbl} style={{ color: "#8a8f93" }}>Sensors</label>
            <input value={draft.sensors || ""} onChange={(e) => setField("sensors", e.target.value)} className={field} style={fs} />
          </div>

          <div className="mb-3">
            <div className={lbl} style={{ color: "#8a8f93" }}>Weapons</div>
            {(draft.weapons || []).map((w, i) => (
              <div key={i} className="grid grid-cols-12 gap-1.5 mb-1.5 items-center">
                <input value={w.name} onChange={(e) => edit((d) => { d.weapons[i].name = e.target.value; return d; })} className={`${field} col-span-12 sm:col-span-4`} style={fs} placeholder="Weapon name" />
                <input value={w.fireArc || ""} onChange={(e) => edit((d) => { d.weapons[i].fireArc = e.target.value; return d; })} className={`${field} col-span-3 sm:col-span-2`} style={fs} placeholder="Arc" title="Fire arc" />
                <input value={w.range || ""} onChange={(e) => edit((d) => { d.weapons[i].range = e.target.value; return d; })} className={`${field} col-span-3 sm:col-span-1`} style={fs} placeholder="Range" title="Range" />
                <input type="number" value={w.damage ?? 0} onChange={(e) => edit((d) => { d.weapons[i].damage = Number(e.target.value); return d; })} className={`${field} col-span-2 sm:col-span-1`} style={fs} title="Damage" />
                <input type="number" value={w.crit ?? 0} onChange={(e) => edit((d) => { d.weapons[i].crit = Number(e.target.value); return d; })} className={`${field} col-span-2 sm:col-span-1`} style={fs} title="Critical" />
                <input value={w.qualities || ""} onChange={(e) => edit((d) => { d.weapons[i].qualities = e.target.value; return d; })} className={`${field} col-span-10 sm:col-span-2`} style={fs} placeholder="Qualities" title="Qualities, comma separated" />
                <button type="button" onClick={() => edit((d) => {
                  d.weapons.splice(i, 1);
                  for (const p of d.crewPositions || []) {
                    if (p.weaponIndex == null) continue;
                    if (p.weaponIndex === i) p.weaponIndex = d.weapons.length ? 0 : null;
                    else if (p.weaponIndex > i) p.weaponIndex -= 1;
                  }
                  return d;
                })} className="col-span-2 sm:col-span-1 text-[12px]" style={{ color: "#c23b3b" }} title="Remove weapon">✕</button>
              </div>
            ))}
            <div className="text-[10px] mb-1.5" style={{ color: "#5a5f62" }}>Columns: name · fire arc · range · damage · critical · qualities</div>
            <div className="flex flex-wrap gap-2 items-center">
              <button type="button" onClick={() => edit((d) => { d.weapons = [...(d.weapons || []), { ...BLANK_VEHICLE_WEAPON }]; return d; })} className={btn} style={ghost}>+ Blank weapon</button>
              {ref.weapons.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    const w = ref.weapons[Number(e.target.value)];
                    if (w) edit((d) => { d.weapons = [...(d.weapons || []), { fireArc: "Forward", ...w }]; return d; });
                  }}
                  className="bg-[#0b0d0e] border px-2 py-1 text-[12px]"
                  style={fs}
                >
                  <option value="">+ From the weapon table…</option>
                  {ref.weapons.map((w, i) => <option key={i} value={i}>{w.name} (Dam {w.damage}, Crit {w.crit}, {w.range})</option>)}
                </select>
              )}
            </div>
          </div>

          <div className="mb-3">
            <label className={lbl} style={{ color: "#8a8f93" }}>Special features (one per line)</label>
            <textarea
              rows={3}
              value={(draft.specialFeatures || []).join("\n")}
              onChange={(e) => setField("specialFeatures", e.target.value.split("\n"))}
              className={field}
              style={fs}
            />
          </div>

          <div className="mb-3">
            <div className={lbl} style={{ color: "#8a8f93" }}>Crew positions</div>
            <div className="space-y-1.5">
              {ref.positions.map((tp) => {
                const idx = (draft.crewPositions || []).findIndex((p) => p.id === tp.id);
                const on = idx !== -1;
                const pos = on ? draft.crewPositions[idx] : null;
                return (
                  <div key={tp.id} className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: "#e7e2d2" }}>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => edit((d) => {
                          const list = d.crewPositions || [];
                          if (on) d.crewPositions = list.filter((p) => p.id !== tp.id);
                          else {
                            const order = ref.positions.map((p) => p.id);
                            const added = { ...tp, ...(tp.weaponIndex != null ? { weaponIndex: (d.weapons || []).length ? 0 : null } : {}) };
                            d.crewPositions = [...list, added].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
                          }
                          return d;
                        })}
                      />
                      {tp.name}
                    </label>
                    {on && tp.weaponIndex !== undefined && (
                      <select
                        value={pos.weaponIndex ?? ""}
                        onChange={(e) => edit((d) => { d.crewPositions[idx].weaponIndex = e.target.value === "" ? null : Number(e.target.value); return d; })}
                        className="bg-[#0b0d0e] border px-1.5 py-0.5 text-[11px]"
                        style={fs}
                        title="The weapon this seat fires"
                      >
                        <option value="">No weapon</option>
                        {(draft.weapons || []).map((w, i) => <option key={i} value={i}>{w.name || `Weapon ${i + 1}`}</option>)}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <label className="flex items-center gap-2 text-[12px] mb-3 cursor-pointer" style={{ color: "#e7e2d2" }}>
            <input type="checkbox" checked={!!draft.hidden} onChange={(e) => setField("hidden", e.target.checked)} />
            Hidden from players (they won't see the Vehicle tab)
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={save} disabled={!dirty || status.state === "busy" || !String(draft.name || "").trim()} className={btn} style={{ color: "#101315", background: "#5ec8d8", borderColor: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
              {saved ? "Save changes" : "Add vehicle"}
            </button>
            {dirty && <button type="button" onClick={cancel} className={btn} style={ghost}>Cancel</button>}
            {saved && !dirty && <button type="button" onClick={remove} disabled={status.state === "busy"} className={btn} style={{ color: "#c23b3b", borderColor: "#c23b3b66", fontFamily: "'Rajdhani', sans-serif" }}>Remove vehicle</button>}
          </div>
        </>
      )}
      {status.msg && <p className="mt-2 text-[12px]" style={{ color: status.state === "error" ? "#c23b3b" : status.state === "busy" ? "#8a8f93" : "#6fae60" }}>{status.msg}</p>}
    </div>
  );
}

// GM page: fix a character sheet by hand (a wrong skill rank, a missing or
// extra talent, thresholds, XP). Saves the whole sheet; the worker keeps the
// previous version so the last fix can be undone.
function GmCharacterEditorSection({ store, initialId = "", onConsumed }) {
  const characters = store.campaign?.characters || [];
  const idOf = (c) => c.liveId || c.name;
  const [selectedId, setSelectedId] = useState(initialId);
  const [open, setOpen] = useState(!!initialId);
  const saved = characters.find((c) => idOf(c) === selectedId) || null;
  const savedJson = JSON.stringify(saved);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState("");
  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState("");
  const [addTier, setAddTier] = useState(1);
  const [addPick, setAddPick] = useState(null);
  const [addKey, setAddKey] = useState(0);
  const [status, setStatus] = useState({ state: "idle", msg: "" });
  const talentLibrary = useTalentLibrary();
  const undo = store.editUndo?.[selectedId];

  const boxRef = useRef(null);
  useEffect(() => {
    if (!initialId) return;
    setSelectedId(initialId);
    setOpen(true);
    // Used once: the next visit to the GM page starts on "Choose a character…".
    onConsumed?.();
    setTimeout(() => { try { boxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { /* old browsers */ } }, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId]);
  useEffect(() => {
    if (!dirty) {
      setDraft(saved ? JSON.parse(savedJson) : null);
      setRawText(saved ? JSON.stringify(saved, null, 2) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedJson, selectedId]);

  function choose(id) {
    if (dirty && !window.confirm("Discard your unsaved changes to this character?")) return;
    setDirty(false);
    setSelectedId(id);
    setStatus({ state: "idle", msg: "" });
    setRawOpen(false);
    setRawError("");
    setNote("");
  }

  function edit(fn) {
    setDraft((d) => {
      const next = fn(JSON.parse(JSON.stringify(d)));
      setRawText(JSON.stringify(next, null, 2));
      return next;
    });
    setDirty(true);
    setStatus({ state: "idle", msg: "" });
  }

  function setSkill(name, patch) {
    edit((d) => {
      d.skills = Array.isArray(d.skills) ? d.skills : [];
      const i = d.skills.findIndex((s) => normalizeSkillName(s.name) === normalizeSkillName(name));
      if (i === -1) d.skills.push({ name, rank: 0, career: false, ...patch });
      else d.skills[i] = { ...d.skills[i], ...patch };
      return d;
    });
  }

  function addTalent() {
    if (!addPick) return;
    edit((d) => {
      d.talents = Array.isArray(d.talents) ? d.talents : [];
      const same = d.talents.find((t) => String(t.name).toLowerCase() === addPick.name.toLowerCase() && Number(t.tier) === Number(addPick.tier));
      if (same) same.rank = (Number(same.rank) || 1) + 1;
      else d.talents.push({ name: addPick.name, tier: Number(addPick.tier), rank: 1, ranked: /^yes$/i.test(String(addPick.ranked || "")), activation: addPick.activation || "", description: addPick.text_swrpg || "" });
      return d;
    });
    const fx = TALENT_EFFECTS[addPick.name.toLowerCase()];
    setStatus({ state: "idle", msg: fx ? `Added ${addPick.name}. Its threshold bonus isn't applied automatically here, so adjust Wounds/Strain below if needed.` : `Added ${addPick.name}.` });
    setAddPick(null);
    setAddKey((k) => k + 1);
  }

  function applyRaw(text) {
    setRawText(text);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected one character object");
      setDraft(parsed);
      setDirty(true);
      setRawError("");
    } catch (err) {
      setRawError(`Not valid yet: ${err.message}`);
    }
  }

  async function save() {
    setStatus({ state: "busy", msg: "Saving…" });
    try {
      await store.saveCharacter(selectedId, draft, note);
      setDirty(false);
      setNote("");
      setStatus({ state: "ok", msg: `Saved ${draft.name}. Players see the change within a few seconds.` });
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }

  async function revert() {
    if (!window.confirm(`Put ${saved?.name} back to how they were before the last GM edit?`)) return;
    setStatus({ state: "busy", msg: "Undoing…" });
    try {
      await store.undoCharacter(selectedId);
      setDirty(false);
      setStatus({ state: "ok", msg: "Restored the earlier version." });
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }

  const field = "bg-[#0b0d0e] border px-2 py-1 text-[13px] outline-none focus:border-[#5ec8d8]";
  const fs = { borderColor: "#3a3f42", color: "#e7e2d2" };
  const lbl = "block text-[10px] tracking-[0.15em] uppercase mb-1";
  const btn = "text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors disabled:opacity-40";
  const ghost = { color: "#e7e2d2", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" };
  const numVal = (v) => (v === "" || v == null ? "" : v);
  const toNum = (v) => (v === "" ? "" : Number(v));

  const skillRows = draft ? (() => {
    const own = Array.isArray(draft.skills) ? draft.skills : [];
    const canon = FULL_SKILL_LIST.map((s) => {
      const m = own.find((x) => normalizeSkillName(x.name) === normalizeSkillName(s.name));
      return { name: s.name, group: s.group, char: s.char, rank: m?.rank ?? 0, career: !!m?.career };
    });
    const extra = own.filter((x) => !FULL_SKILL_LIST.some((s) => normalizeSkillName(s.name) === normalizeSkillName(x.name)))
      .map((x) => ({ name: x.name, group: "Other", char: "", rank: x.rank ?? 0, career: !!x.career }));
    return [...canon, ...extra];
  })() : [];
  const groups = [...new Set(skillRows.map((s) => s.group))];
  const tierCounts = draft ? talentRankCounts(draft.talents || []) : {};

  return (
    <div ref={boxRef} className="border mb-5" style={{ borderColor: "#3a3f42", background: "#101315" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#5ec8d8" }}>Edit a character</span>
        <span className="text-[11px]" style={{ color: "#8a8f93" }}>
          {saved && open ? saved.name : "Fix skills, talents, thresholds, XP"} <span className="ml-2" style={{ color: "#5ec8d8" }}>{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && <div className="px-4 pb-4">
      <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8a8f93" }}>
        Fix a sheet by hand: skill ranks, career skills, talents, characteristics, thresholds, XP and credits. Nothing here
        costs or refunds XP, so adjust XP yourself if the fix should. The previous version is kept, so you can undo the last edit.
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={selectedId} onChange={(e) => choose(e.target.value)} className={field} style={fs}>
          <option value="">Choose a character…</option>
          {characters.map((c) => <option key={idOf(c)} value={idOf(c)}>{c.name}{c.hidden ? " (hidden)" : ""}</option>)}
        </select>
        {undo && !dirty && (
          <button type="button" onClick={revert} disabled={status.state === "busy"} className={btn} style={{ color: "#c9a15a", borderColor: "#c9a15a66", fontFamily: "'Rajdhani', sans-serif" }} title={`Last edited ${new Date(undo.savedAt).toLocaleString()}${undo.note ? `: ${undo.note}` : ""}`}>
            Undo last edit
          </button>
        )}
      </div>

      {draft && (
        <>
          <div className="grid gap-2 sm:grid-cols-3 mb-3">
            {[["name", "Name"], ["species", "Species"], ["career", "Career — specialisation"]].map(([k, l]) => (
              <div key={k}>
                <label className={lbl} style={{ color: "#8a8f93" }}>{l}</label>
                <input value={draft[k] || ""} onChange={(e) => edit((d) => { d[k] = e.target.value; return d; })} className={`${field} w-full`} style={fs} />
              </div>
            ))}
          </div>

          <div className={lbl} style={{ color: "#8a8f93" }}>Characteristics</div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
            {CHARACTERISTICS.map((k) => (
              <div key={k}>
                <label className="block text-[10px] mb-0.5" style={{ color: "#5a5f62" }}>{CHAR_LABEL[k]}</label>
                <input type="number" min={1} max={7} value={numVal(draft.characteristics?.[k])} onChange={(e) => edit((d) => { d.characteristics = { ...(d.characteristics || {}), [k]: toNum(e.target.value) }; return d; })} className={`${field} w-full`} style={fs} />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
            {[
              ["Wounds", draft.vitals?.wounds?.threshold, (d, v) => { d.vitals = d.vitals || {}; d.vitals.wounds = { ...(d.vitals.wounds || {}), threshold: v }; }],
              ["Strain", draft.vitals?.strain?.threshold, (d, v) => { d.vitals = d.vitals || {}; d.vitals.strain = { ...(d.vitals.strain || {}), threshold: v }; }],
              ["Soak", draft.vitals?.soak, (d, v) => { d.vitals = d.vitals || {}; d.vitals.soak = v; }],
              ["XP unspent", draft.xp?.available, (d, v) => { d.xp = { ...(d.xp || {}), available: v }; }],
              ["XP total", draft.xp?.total, (d, v) => { d.xp = { ...(d.xp || {}), total: v }; }],
              ["Credits", draft.credits, (d, v) => { d.credits = v; }],
            ].map(([l, v, set]) => (
              <div key={l}>
                <label className="block text-[10px] mb-0.5" style={{ color: "#5a5f62" }}>{l}</label>
                <input type="number" min={0} value={numVal(v)} onChange={(e) => edit((d) => { set(d, toNum(e.target.value)); return d; })} className={`${field} w-full`} style={fs} />
              </div>
            ))}
          </div>

          <div className={lbl} style={{ color: "#8a8f93" }}>Skills (rank · career)</div>
          <div className="grid gap-x-4 sm:grid-cols-2 mb-3">
            {groups.map((g) => (
              <div key={g} className="mb-2">
                <div className="text-[10px] uppercase tracking-[0.15em] mb-1" style={{ color: "#5a5f62" }}>{g}</div>
                {skillRows.filter((s) => s.group === g).map((s) => (
                  <div key={s.name} className="flex items-center gap-2 py-0.5 text-[12px]" style={{ color: s.rank > 0 ? "#e7e2d2" : "#8a8f93" }}>
                    <span className="flex-1 truncate">{s.name}{s.char ? <span style={{ color: "#5a5f62" }}> ({CHAR_LABEL[s.char]?.slice(0, 2).toUpperCase()})</span> : null}</span>
                    <button type="button" onClick={() => setSkill(s.name, { rank: Math.max(0, s.rank - 1) })} disabled={s.rank <= 0} className="w-6 h-6 border disabled:opacity-30" style={fs}>−</button>
                    <span className="w-4 text-center mono-num">{s.rank}</span>
                    <button type="button" onClick={() => setSkill(s.name, { rank: Math.min(5, s.rank + 1) })} disabled={s.rank >= 5} className="w-6 h-6 border disabled:opacity-30" style={fs}>+</button>
                    <label className="flex items-center gap-1 text-[10px] cursor-pointer" style={{ color: s.career ? "#6fae60" : "#5a5f62" }} title="Career skill">
                      <input type="checkbox" checked={s.career} onChange={(e) => setSkill(s.name, { career: e.target.checked })} />C
                    </label>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className={lbl} style={{ color: "#8a8f93" }}>
            Talents <span style={{ color: "#5a5f62" }}>· ranks per tier: {[1, 2, 3, 4, 5].map((t) => `T${t} ${tierCounts[t] || 0}`).join(" · ")}</span>
          </div>
          <div className="mb-2">
            {(draft.talents || []).length === 0 && <div className="text-[12px]" style={{ color: "#5a5f62" }}>No talents.</div>}
            {(draft.talents || []).map((t, i) => (
              <div key={i} className="flex items-center gap-2 py-0.5 text-[12px]" style={{ color: "#e7e2d2" }}>
                <span className="flex-1 truncate">{t.name}</span>
                <label className="text-[10px]" style={{ color: "#5a5f62" }}>Tier</label>
                <input type="number" min={1} max={5} value={numVal(t.tier)} onChange={(e) => edit((d) => { d.talents[i].tier = toNum(e.target.value); return d; })} className={`${field} w-14`} style={fs} />
                <label className="text-[10px]" style={{ color: "#5a5f62" }}>Rank</label>
                <input type="number" min={1} max={10} value={numVal(t.rank ?? 1)} onChange={(e) => edit((d) => { d.talents[i].rank = toNum(e.target.value); return d; })} className={`${field} w-14`} style={fs} />
                <button type="button" onClick={() => edit((d) => { d.talents.splice(i, 1); return d; })} className="text-[12px] px-1" style={{ color: "#c23b3b" }} title="Remove talent">✕</button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-start gap-2 mb-3">
            <select value={addTier} onChange={(e) => { setAddTier(Number(e.target.value)); setAddPick(null); setAddKey((k) => k + 1); }} className={field} style={fs}>
              {[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>Tier {t}</option>)}
            </select>
            <div className="flex-1 min-w-[220px]">
              <TalentTierSearch key={`${addTier}-${addKey}`} tier={addTier} value={addPick} onSelect={setAddPick} library={talentLibrary} forceSensitive />
            </div>
            <button type="button" onClick={addTalent} disabled={!addPick} className={btn} style={ghost}>+ Add talent</button>
          </div>

          <div className="mb-3">
            <button type="button" onClick={() => setRawOpen((o) => !o)} className="text-[11px] underline" style={{ color: "#8fd3f4" }}>
              {rawOpen ? "Hide" : "Show"} the full sheet as JSON (weapons, armour, gear, Motivation, anything else)
            </button>
            {rawOpen && (
              <>
                <textarea rows={14} value={rawText} onChange={(e) => applyRaw(e.target.value)} spellCheck={false} className={`${field} w-full mt-2 font-mono text-[11px]`} style={fs} />
                {rawError && <p className="text-[11px]" style={{ color: "#c23b3b" }}>{rawError}</p>}
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Reason (optional, kept in the edit log)" className={`${field} flex-1 min-w-[200px]`} style={fs} />
            <button type="button" onClick={save} disabled={!dirty || !!rawError || status.state === "busy"} className={btn} style={{ color: "#101315", background: "#5ec8d8", borderColor: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
              Save character
            </button>
            {dirty && (
              <button type="button" onClick={() => { setDirty(false); setDraft(saved ? JSON.parse(savedJson) : null); setRawText(saved ? JSON.stringify(saved, null, 2) : ""); setRawError(""); setStatus({ state: "idle", msg: "" }); }} className={btn} style={ghost}>
                Discard changes
              </button>
            )}
          </div>
        </>
      )}
      {status.msg && <p className="mt-2 text-[12px]" style={{ color: status.state === "error" ? "#c23b3b" : status.state === "busy" ? "#8a8f93" : "#6fae60" }}>{status.msg}</p>}
      </div>}
    </div>
  );
}

// Shown in place of every tab until a campaign has been imported.
function EmptyCampaignPanel({ status, error, isGm, onOpenGm }) {
  return (
    <div className="border p-6 sm:p-8" style={{ borderColor: "#3a3f42", background: "#16191b" }}>
      <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#5ec8d8" }}>NO CAMPAIGN LOADED</div>
      {status === "loading" ? (
        <p className="text-[13px]" style={{ color: "#8a8f93" }}>Loading the campaign…</p>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed mb-2" style={{ color: "#e7e2d2" }}>
            There's no campaign on this site yet.
          </p>
          <p className="text-[12px] leading-relaxed" style={{ color: "#8a8f93" }}>
            GM: open the GM page (click the campaign name five times), sign in, and use <strong>Import</strong> under Campaign
            data to load a campaign file such as an existing <code>ledger.json</code>.
          </p>
          {isGm && (
            <button type="button" onClick={onOpenGm} className="mt-3 text-[11px] tracking-[0.15em] uppercase px-3 py-1.5" style={{ background: "#e0763a", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
              Go to the GM page
            </button>
          )}
          {error && <p className="mt-3 text-[12px]" style={{ color: "#c23b3b" }}>{error}</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Character creation. The GM starts it from the GM page ("New character"),
// which makes a private link (/?create=<code>). A new player opens that link
// and steps through the wizard below; their choices save to the Worker as
// they go, so they can close the page and come back. Submit runs the
// creation rules (src/chargen.js); the GM then reviews and approves, and the
// Worker re-runs the same rules before adding the character to the campaign.
// Species, careers and specialisations come from public/data/chargen.json,
// built from the FFG wiki's Category:Species and Category:Specialization.
// ---------------------------------------------------------------------------
function useChargenData() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch("/data/chargen.json")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);
  return { data, error };
}

const WIZARD_STEPS = [
  { key: "concept", label: "You" },
  { key: "species", label: "Species" },
  { key: "career", label: "Career" },
  { key: "characteristics", label: "Characteristics" },
  { key: "skills", label: "Skills" },
  { key: "talents", label: "Talents" },
  { key: "story", label: "Motivation & Obligation" },
  { key: "review", label: "Review" },
];

const wz = {
  card: { borderColor: "#3a3f42", background: "#16191b" },
  label: "text-[11px] tracking-[0.2em] uppercase mb-1.5 block",
  input: "w-full bg-transparent border px-2.5 py-2 text-[13px]",
  inputStyle: { borderColor: "#3a3f42", color: "#e7e2d2", background: "#101315" },
  h: { color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 },
  muted: { color: "#8a8f93" },
  dim: { color: "#5a5f62" },
};

function WizardField({ label, children, hint }) {
  return (
    <label className="block mb-4">
      <span className={wz.label} style={wz.muted}>{label}</span>
      {children}
      {hint && <span className="block text-[11px] mt-1" style={wz.dim}>{hint}</span>}
    </label>
  );
}

function SkillChip({ skill, active, disabled, onClick, sub }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-left px-2.5 py-1.5 border text-[12px] disabled:opacity-35"
      style={{ borderColor: active ? "#6fae60" : "#3a3f42", background: active ? "#6fae601f" : "#101315", color: active ? "#e7e2d2" : "#c7c2b2" }}
    >
      {active ? "✔ " : ""}{skill}{sub && <span className="block text-[10px]" style={wz.dim}>{sub}</span>}
    </button>
  );
}

function CharStatBlock({ chars, size = 20 }) {
  return (
    <div className="grid grid-cols-6 gap-1.5">
      {CHARACTERISTICS.map((c) => (
        <div key={c} className="border text-center py-1.5" style={{ borderColor: "#2a2e31", background: "#101315" }}>
          <div className="mono-num" style={{ color: "#e7e2d2", fontSize: size, fontWeight: 700 }}>{chars?.[c] ?? "–"}</div>
          <div className="text-[9px] tracking-[0.12em] uppercase" style={wz.muted}>{CHAR_ABBR[c]}</div>
        </div>
      ))}
    </div>
  );
}

function CreationWizardPage({ code }) {
  const { data, error: dataError } = useChargenData();
  const [entry, setEntry] = useState(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [loadError, setLoadError] = useState(null);
  const [step, setStep] = useState(0);
  const [save, setSave] = useState({ state: "idle" });
  const [submitState, setSubmitState] = useState({ state: "idle" });
  const [speciesQuery, setSpeciesQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [addTier, setAddTier] = useState(1);
  const talentLibrary = useTalentLibrary();
  const saveTimer = useRef(null);
  const dirty = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/creation/${encodeURIComponent(code)}?_=${Date.now()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The Worker said ${res.status}`);
      setEntry(body.entry);
      if (!dirty.current) setDraft({ ...emptyDraft(), ...(body.entry.draft || {}) });
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    }
  }, [code]);

  useEffect(() => { load(); }, [load]);
  // While waiting for the GM, check now and then so the page updates itself
  // when the character is approved or sent back.
  useEffect(() => {
    if (!entry || entry.status === "open") return undefined;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [entry, load]);

  const editable = entry?.status === "open";

  function update(patch) {
    if (!editable) return;
    dirty.current = true;
    setDraft((prev) => {
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => persist(next), 800);
      return next;
    });
  }

  async function persist(next) {
    setSave({ state: "saving" });
    try {
      const res = await apiFetch(`/creation/${encodeURIComponent(code)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The Worker said ${res.status}`);
      dirty.current = false;
      setSave({ state: "saved", at: Date.now() });
    } catch (err) {
      setSave({ state: "error", msg: err.message });
    }
  }

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  async function submit() {
    clearTimeout(saveTimer.current);
    setSubmitState({ state: "busy" });
    try {
      const res = await apiFetch(`/creation/${encodeURIComponent(code)}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.errors?.length ? body.errors.map((e) => e.msg).join(" ") : body.error || `The Worker said ${res.status}`);
      dirty.current = false;
      setEntry(body.entry);
      setSubmitState({ state: "done" });
    } catch (err) {
      setSubmitState({ state: "error", msg: err.message });
    }
  }

  const build = useMemo(() => (data ? computeBuild(draft, data) : null), [draft, data]);
  const species = build?.species;
  const career = build?.career;
  const spec = build?.spec;
  const stepErrors = (key) => (build?.errors || []).filter((e) => e.step === key);
  const xpLeft = build ? build.xpLeft : 0;

  const shell = (children) => (
    <div className="min-h-screen w-full flex items-start justify-center p-4 sm:p-8" style={{ background: "radial-gradient(circle at 50% 0%, #1b1f22 0%, #101315 70%)", fontFamily: "'JetBrains Mono', monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap'); .mono-num { font-variant-numeric: tabular-nums; }`}</style>
      <div className="w-full max-w-5xl">{children}</div>
    </div>
  );

  if (loadError && !entry) {
    return shell(
      <div className="border p-6" style={wz.card}>
        <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#c23b3b" }}>CHARACTER CREATION</div>
        <p className="text-[13px]" style={{ color: "#e7e2d2" }}>{loadError}</p>
        <a href={campaignBase()} className="inline-block mt-3 text-[12px] underline" style={{ color: "#5ec8d8" }}>Go to the dashboard</a>
      </div>
    );
  }
  if (!entry || !data) {
    return shell(<div className="border p-6 text-[13px]" style={{ ...wz.card, ...wz.muted }}>{dataError ? `Couldn't load the species and career list: ${dataError}` : "Loading…"}</div>);
  }

  if (entry.status === "approved") {
    return shell(
      <div className="border p-6" style={wz.card}>
        <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#6fae60" }}>CHARACTER CREATION</div>
        <h1 className="text-3xl uppercase mb-2" style={wz.h}>{entry.characterName || draft.name} is ready</h1>
        <p className="text-[13px] mb-4" style={wz.muted}>The GM has added your character to the campaign.</p>
        <a href={campaignBase()} className="inline-block px-4 py-2 text-[12px] uppercase tracking-[0.15em]" style={{ background: "#5ec8d8", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>Open the dashboard</a>
      </div>
    );
  }

  const stepKey = WIZARD_STEPS[step].key;
  const careerFreeLeft = build ? build.counts.careerCount - (draft.freeCareer || []).filter((s) => career?.careerSkills.includes(s)).length : 0;
  const specFreeLeft = build ? build.counts.specCount - (draft.freeSpec || []).filter((s) => spec?.bonusSkills.includes(s)).length : 0;
  const toggleIn = (key, skill, max) => update((prev) => {
    const list = prev[key] || [];
    if (list.includes(skill)) return { ...prev, [key]: list.filter((s) => s !== skill) };
    if (list.length >= max) return prev;
    return { ...prev, [key]: [...list, skill] };
  });

  const filteredSpecies = (data.species || []).filter((s) => !speciesQuery.trim() || fuzzyMatch(speciesQuery, s.name) !== null);
  const specOptions = career ? specializationsFor(data, career.name) : [];

  return shell(
    <>
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div>
          <div className="text-[11px] tracking-[0.25em] uppercase" style={{ color: "#5ec8d8" }}>CHARACTER CREATION</div>
          <h1 className="text-3xl uppercase tracking-wide" style={wz.h}>{draft.name || "New character"}</h1>
          <div className="text-[12px]" style={wz.muted}>
            {[species?.name, career?.name, spec?.name].filter(Boolean).join(" · ") || "Step through each section; your choices save as you go."}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] tracking-[0.2em] uppercase" style={wz.muted}>XP left</div>
          <div className="text-3xl mono-num" style={{ color: xpLeft < 0 ? "#c23b3b" : "#ffb000", fontWeight: 700 }}>{species ? xpLeft : "–"}</div>
          <div className="text-[10px]" style={wz.dim}>
            {save.state === "saving" ? "Saving…" : save.state === "error" ? <span style={{ color: "#c23b3b" }}>Not saved: {save.msg}</span> : save.state === "saved" ? "Saved" : ""}
          </div>
        </div>
      </div>

      {entry.status === "submitted" && (
        <div className="border p-3 mb-4 text-[12px]" style={{ borderColor: "#ffb00066", background: "#ffb0000d", color: "#e7e2d2" }}>
          Sent to the GM. You'll see your character here once it's approved. If the GM sends it back, you can change it again.
        </div>
      )}
      {entry.status === "open" && entry.note && (
        <div className="border p-3 mb-4 text-[12px]" style={{ borderColor: "#c9a15a66", background: "#c9a15a12", color: "#e7e2d2" }}>
          <strong style={{ color: "#c9a15a" }}>From the GM:</strong> {entry.note}
        </div>
      )}

      <div className="flex gap-1.5 flex-wrap mb-4">
        {WIZARD_STEPS.map((s, i) => {
          const bad = stepErrors(s.key).length > 0;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setStep(i)}
              className="text-[11px] tracking-wide px-3 py-1.5 border"
              style={{
                fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                color: i === step ? "#101315" : "#e7e2d2",
                background: i === step ? "#5ec8d8" : "transparent",
                borderColor: i === step ? "#5ec8d8" : bad ? "#c9a15a88" : "#3a3f42",
              }}
            >
              {i + 1}. {s.label}{bad && i !== step ? " •" : ""}
            </button>
          );
        })}
      </div>

      <div className="border p-5 sm:p-6 mb-4" style={wz.card}>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
          {stepKey === "concept" && (
            <div className="grid sm:grid-cols-2 gap-x-5">
              <WizardField label="Character name"><input className={wz.input} style={wz.inputStyle} value={draft.name} maxLength={60} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Kessa Varyn" /></WizardField>
              <WizardField label="Your name (the player)"><input className={wz.input} style={wz.inputStyle} value={draft.playerName} maxLength={60} onChange={(e) => update({ playerName: e.target.value })} /></WizardField>
              <WizardField label="Gender"><input className={wz.input} style={wz.inputStyle} value={draft.gender} maxLength={40} onChange={(e) => update({ gender: e.target.value })} /></WizardField>
              <WizardField label="Age"><input className={wz.input} style={wz.inputStyle} value={draft.age} maxLength={40} onChange={(e) => update({ age: e.target.value })} /></WizardField>
              <div className="sm:col-span-2">
                <WizardField label="Appearance and description" hint="Shown in the Description box on your character sheet. You can change it there later.">
                  <textarea className={wz.input} style={{ ...wz.inputStyle, minHeight: 110 }} value={draft.description} maxLength={500} onChange={(e) => update({ description: e.target.value })} placeholder="Size, colour, clothing, how they carry themselves…" />
                </WizardField>
              </div>
            </div>
          )}

          {stepKey === "species" && (
            <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-5">
              <div>
                <input className={`${wz.input} mb-2`} style={wz.inputStyle} value={speciesQuery} onChange={(e) => setSpeciesQuery(e.target.value)} placeholder={`Search ${data.species.length} species…`} />
                <div className="max-h-[28rem] overflow-y-auto border" style={{ borderColor: "#2a2e31" }}>
                  {filteredSpecies.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => update((prev) => ({ ...prev, species: s.name, speciesChoices: [], speciesFree: [], subspeciesNote: "", characteristics: { ...s.characteristics } }))}
                      className="w-full text-left px-3 py-2 border-b flex items-center justify-between gap-2"
                      style={{ borderColor: "#2a2e31", background: draft.species === s.name ? "#5ec8d81a" : "transparent", color: "#e7e2d2" }}
                    >
                      <span className="text-[13px]" style={{ fontWeight: draft.species === s.name ? 700 : 400 }}>{s.name}</span>
                      <span className="text-[10px] mono-num" style={wz.muted}>{CHARACTERISTICS.map((c) => s.characteristics[c]).join(" ")} · {s.startingXp} XP</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                {!species ? <p className="text-[13px]" style={wz.muted}>Pick a species from the list.</p> : (
                  <>
                    <h2 className="text-2xl uppercase mb-2" style={wz.h}>{species.name}</h2>
                    <CharStatBlock chars={species.characteristics} />
                    <div className="grid grid-cols-3 gap-2 mt-3 text-[12px]" style={{ color: "#e7e2d2" }}>
                      <div className="border p-2" style={{ borderColor: "#2a2e31" }}><div style={wz.muted} className="text-[10px] uppercase tracking-[0.15em]">Wounds</div>{species.woundBase} + Brawn</div>
                      <div className="border p-2" style={{ borderColor: "#2a2e31" }}><div style={wz.muted} className="text-[10px] uppercase tracking-[0.15em]">Strain</div>{species.strainBase} + Willpower</div>
                      <div className="border p-2" style={{ borderColor: "#2a2e31" }}><div style={wz.muted} className="text-[10px] uppercase tracking-[0.15em]">Starting XP</div>{species.startingXp}</div>
                    </div>
                    <div className="mt-3 text-[12px] leading-relaxed" style={{ color: "#c7c2b2" }}>
                      {species.skillRanks?.length > 0 && <div>Free skill rank{species.skillRanks.length > 1 ? "s" : ""}: <strong style={{ color: "#e7e2d2" }}>{species.skillRanks.join(", ")}</strong></div>}
                      {species.talents?.length > 0 && <div>Free talent{species.talents.length > 1 ? "s" : ""}: <strong style={{ color: "#e7e2d2" }}>{species.talents.join(", ")}</strong></div>}
                      {species.freeSkillChoice && <div>{species.freeSkillChoice.note} You'll pick {species.freeSkillChoice.count === 1 ? "it" : "them"} on the Skills step.</div>}
                    </div>
                    {(species.skillChoices || []).map((options, i) => (
                      <div key={i} className="mt-3">
                        <div className={wz.label} style={wz.muted}>Choose a free rank</div>
                        <div className="flex flex-wrap gap-1.5">
                          {options.map((o) => (
                            <SkillChip key={o} skill={o} active={draft.speciesChoices?.[i] === o} onClick={() => update((prev) => { const next = [...(prev.speciesChoices || [])]; next[i] = o; return { ...prev, speciesChoices: next }; })} />
                          ))}
                        </div>
                      </div>
                    ))}
                    {species.subspecies && (
                      <div className="mt-3">
                        <WizardField label="Subspecies" hint="This species has subspecies with different abilities. Read them on the wiki and name yours; the GM applies its extras.">
                          <input className={wz.input} style={wz.inputStyle} value={draft.subspeciesNote} maxLength={80} onChange={(e) => update({ subspeciesNote: e.target.value })} />
                        </WizardField>
                      </div>
                    )}
                    {species.droid && <p className="mt-3 text-[12px]" style={{ color: "#c9a15a" }}>Droids get 2 extra free career-skill ranks and 1 extra specialisation rank.</p>}
                    <a href={species.wiki} target="_blank" rel="noreferrer" className="inline-block mt-3 text-[12px] underline" style={{ color: "#5ec8d8" }}>Read the full species abilities on the wiki ↗</a>
                  </>
                )}
              </div>
            </div>
          )}

          {stepKey === "career" && (
            <div className="grid lg:grid-cols-2 gap-5">
              <div>
                <WizardField label="Career" hint="Your career never changes. It sets most of your career skills.">
                  <select className={wz.input} style={wz.inputStyle} value={draft.career} onChange={(e) => update((prev) => ({ ...prev, career: e.target.value, specialization: "", freeCareer: [], freeSpec: [] }))}>
                    <option value="">Choose a career…</option>
                    {data.careers.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                </WizardField>
                {career && (
                  <div className="text-[12px] mb-4" style={{ color: "#c7c2b2" }}>
                    <div className={wz.label} style={wz.muted}>{career.name} career skills</div>
                    <div className="flex flex-wrap gap-1.5">{career.careerSkills.map((s) => <span key={s} className="px-2 py-1 border text-[11px]" style={{ borderColor: "#2a2e31" }}>{s}</span>)}</div>
                    <div className="mt-2" style={wz.dim}>You get {build.counts.careerCount} free ranks among these.</div>
                    <a href={career.wiki} target="_blank" rel="noreferrer" className="inline-block mt-2 underline" style={{ color: "#5ec8d8" }}>{career.name} on the wiki ↗</a>
                  </div>
                )}
              </div>
              <div>
                <WizardField label="Specialisation" hint={career ? "Adds four more career skills. Universal specialisations work with any career." : "Pick a career first."}>
                  <select className={wz.input} style={wz.inputStyle} value={draft.specialization} disabled={!career} onChange={(e) => update((prev) => ({ ...prev, specialization: e.target.value, freeSpec: [] }))}>
                    <option value="">Choose a specialisation…</option>
                    {specOptions.filter((s) => s.careers?.length).length > 0 && (
                      <optgroup label={career?.name}>
                        {specOptions.filter((s) => s.careers?.length).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                      </optgroup>
                    )}
                    <optgroup label="Universal">
                      {specOptions.filter((s) => !s.careers?.length).map((s) => <option key={s.name} value={s.name}>{s.name}{s.forceSensitive ? " (Force)" : ""}</option>)}
                    </optgroup>
                  </select>
                </WizardField>
                {spec && (
                  <div className="text-[12px]" style={{ color: "#c7c2b2" }}>
                    <div className={wz.label} style={wz.muted}>{spec.name} bonus career skills</div>
                    {spec.bonusSkills.length ? <div className="flex flex-wrap gap-1.5">{spec.bonusSkills.map((s) => <span key={s} className="px-2 py-1 border text-[11px]" style={{ borderColor: "#2a2e31" }}>{s}</span>)}</div> : <div style={wz.dim}>None.</div>}
                    {spec.forceSensitive && <div className="mt-2" style={{ color: "#8fd3f4" }}>Grants Force Rating 1 and makes the character Force sensitive.</div>}
                    {spec.source && <div className="mt-2" style={wz.dim}>From {spec.source}.</div>}
                    <a href={spec.wiki} target="_blank" rel="noreferrer" className="inline-block mt-2 underline" style={{ color: "#5ec8d8" }}>{spec.name} on the wiki ↗</a>
                  </div>
                )}
              </div>
            </div>
          )}

          {stepKey === "characteristics" && (
            !species ? <p className="text-[13px]" style={wz.muted}>Choose a species first.</p> : (
              <>
                <p className="text-[12px] mb-4" style={wz.muted}>
                  Raising a characteristic costs 10 × the new value (from 2 to 3 costs 30). Characteristics are hard to raise after
                  creation, so this is the best time. Maximum {CREATION_MAX_CHARACTERISTIC}.
                </p>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {CHARACTERISTICS.map((c) => {
                    const base = species.characteristics[c];
                    const val = draft.characteristics?.[c] ?? base;
                    const next = val + 1;
                    return (
                      <div key={c} className="border p-3 flex items-center justify-between gap-3" style={{ borderColor: "#2a2e31", background: "#101315" }}>
                        <div>
                          <div className="text-[12px] uppercase tracking-[0.12em]" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>{CHAR_LABEL[c]}</div>
                          <div className="text-[10px]" style={wz.dim}>Species {base}{val > base ? ` · spent ${characteristicCost(base, val)} XP` : ""}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button type="button" disabled={val <= base} onClick={() => update((prev) => ({ ...prev, characteristics: { ...prev.characteristics, [c]: val - 1 } }))} className="w-8 h-8 border disabled:opacity-30" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}>−</button>
                          <span className="text-2xl mono-num w-6 text-center" style={{ color: "#e7e2d2", fontWeight: 700 }}>{val}</span>
                          <button type="button" disabled={val >= CREATION_MAX_CHARACTERISTIC} onClick={() => update((prev) => ({ ...prev, characteristics: { ...prev.characteristics, [c]: val + 1 } }))} className="w-8 h-8 border disabled:opacity-30" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} title={val < CREATION_MAX_CHARACTERISTIC ? `${10 * next} XP` : "Maximum"}>+</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 text-[12px]" style={{ color: "#c7c2b2" }}>
                  Wound threshold {species.woundBase + (draft.characteristics?.brawn ?? species.characteristics.brawn)} · Strain threshold {species.strainBase + (draft.characteristics?.willpower ?? species.characteristics.willpower)} · Soak {draft.characteristics?.brawn ?? species.characteristics.brawn}
                </div>
              </>
            )
          )}

          {stepKey === "skills" && (
            !species || !career || !spec ? <p className="text-[13px]" style={wz.muted}>Choose a species, career and specialisation first.</p> : (
              <>
                <div className="grid lg:grid-cols-2 gap-5 mb-5">
                  <div>
                    <div className={wz.label} style={wz.muted}>Free {career.name} ranks · {Math.max(0, careerFreeLeft)} left</div>
                    <div className="flex flex-wrap gap-1.5">
                      {career.careerSkills.map((s) => {
                        const on = (draft.freeCareer || []).includes(s);
                        return <SkillChip key={s} skill={s} active={on} disabled={!on && careerFreeLeft <= 0} onClick={() => toggleIn("freeCareer", s, build.counts.careerCount)} />;
                      })}
                    </div>
                  </div>
                  <div>
                    <div className={wz.label} style={wz.muted}>Free {spec.name} ranks · {Math.max(0, specFreeLeft)} left</div>
                    {spec.bonusSkills.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {spec.bonusSkills.map((s) => {
                          const on = (draft.freeSpec || []).includes(s);
                          return <SkillChip key={s} skill={s} active={on} disabled={!on && specFreeLeft <= 0} onClick={() => toggleIn("freeSpec", s, build.counts.specCount)} />;
                        })}
                      </div>
                    ) : <div className="text-[12px]" style={wz.dim}>This specialisation has no bonus skills.</div>}
                  </div>
                  {species.freeSkillChoice && (
                    <div className="lg:col-span-2">
                      <div className={wz.label} style={wz.muted}>Free {species.name} ranks · {Math.max(0, species.freeSkillChoice.count - (draft.speciesFree || []).length)} left</div>
                      <p className="text-[11px] mb-2" style={wz.dim}>{species.freeSkillChoice.note}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {ALL_SKILLS.filter((s) => species.freeSkillChoice.rule !== "non-career" || !build.careerSkills.includes(s)).map((s) => {
                          const on = (draft.speciesFree || []).includes(s);
                          return <SkillChip key={s} skill={s} active={on} disabled={!on && (draft.speciesFree || []).length >= species.freeSkillChoice.count} onClick={() => toggleIn("speciesFree", s, species.freeSkillChoice.count)} />;
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                  <div className={wz.label} style={{ ...wz.muted, marginBottom: 0 }}>Buy more ranks with XP (max rank {CREATION_MAX_RANK} at creation)</div>
                  <input className="bg-transparent border px-2 py-1 text-[12px] w-48" style={wz.inputStyle} value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} placeholder="Filter skills…" />
                </div>
                <div className="grid sm:grid-cols-2 gap-x-5">
                  {ALL_SKILLS.filter((s) => !skillQuery.trim() || s.toLowerCase().includes(skillQuery.trim().toLowerCase())).map((s) => {
                    const r = build.ranks[s] || { species: 0, career: 0, spec: 0, bought: 0 };
                    const free = r.species + r.career + r.spec;
                    const bought = Number(draft.bought?.[s]) || 0;
                    const total = free + bought;
                    const isCar = build.careerSkills.includes(s);
                    const nextCost = creationSkillRankCost(total + 1, isCar);
                    return (
                      <div key={s} className="flex items-center justify-between gap-2 py-1.5 border-b" style={{ borderColor: "#2a2e3166" }}>
                        <span className="text-[12px]" style={{ color: isCar ? "#5ec8d8" : "#e7e2d2" }}>
                          {s}{isCar ? " ★" : ""}
                          {free > 0 && <span className="text-[10px] ml-1.5" style={wz.dim}>{free} free</span>}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <button type="button" disabled={bought <= 0} onClick={() => update((prev) => ({ ...prev, bought: { ...prev.bought, [s]: bought - 1 } }))} className="w-6 h-6 border text-[12px] disabled:opacity-30" style={{ borderColor: "#3a3f42", color: "#8a8f93" }}>−</button>
                          <span className="mono-num w-4 text-center text-[13px]" style={{ color: "#e7e2d2", fontWeight: 700 }}>{total}</span>
                          <button type="button" disabled={total >= CREATION_MAX_RANK} onClick={() => update((prev) => ({ ...prev, bought: { ...prev.bought, [s]: bought + 1 } }))} title={total < CREATION_MAX_RANK ? `${nextCost} XP` : "Maximum at creation"} className="w-6 h-6 border text-[12px] disabled:opacity-30" style={{ borderColor: "#3a3f42", color: "#8a8f93" }}>+</button>
                          <span className="text-[10px] w-12 text-right mono-num" style={wz.dim}>{total < CREATION_MAX_RANK ? `${nextCost} XP` : ""}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[11px] mt-2" style={wz.dim}>★ career skill: ranks cost 5 × the new rank. Other skills cost 5 more.</p>
              </>
            )
          )}

          {stepKey === "talents" && (
            <>
              <p className="text-[12px] mb-3" style={wz.muted}>
                Optional. Talents cost tier × 5 XP. Each tier needs fewer talents than the tier below it, so start with Tier 1.
                {species?.talents?.length ? ` Your species already gives you ${species.talents.join(", ")}.` : ""}
              </p>
              {(draft.talents || []).length > 0 && (
                <div className="space-y-1.5 mb-4">
                  {draft.talents.map((t, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 border px-3 py-2" style={{ borderColor: "#2a2e31", background: "#101315" }}>
                      <span className="text-[12px]" style={{ color: "#e7e2d2" }}><strong>{t.name}</strong> <span style={wz.muted}>· Tier {t.tier} · {talentCost(t.tier)} XP{t.activation ? ` · ${t.activation}` : ""}</span></span>
                      <button type="button" onClick={() => update((prev) => ({ ...prev, talents: prev.talents.filter((_, k) => k !== i) }))} className="text-[11px] px-2" style={wz.muted}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className={wz.label} style={{ ...wz.muted, marginBottom: 0 }}>Add a talent from</span>
                {[1, 2, 3, 4, 5].map((t) => (
                  <button key={t} type="button" onClick={() => setAddTier(t)} className="text-[11px] px-2.5 py-1 border" style={{ borderColor: addTier === t ? "#8fd3f4" : "#3a3f42", color: addTier === t ? "#8fd3f4" : "#8a8f93" }}>Tier {t}</button>
                ))}
              </div>
              <TalentTierSearch
                key={`${addTier}-${(draft.talents || []).length}`}
                tier={addTier}
                value={null}
                library={talentLibrary}
                forceSensitive={!!spec?.forceSensitive}
                onSelect={(talent) => { if (talent) update((prev) => ({ ...prev, talents: [...(prev.talents || []), { name: talent.name, tier: Number(talent.tier), ranked: talent.ranked, activation: talent.activation || "", force: talent.force || "No", text_swrpg: talent.text_swrpg || "" }] })); }}
              />
            </>
          )}

          {stepKey === "story" && (
            <div className="grid lg:grid-cols-2 gap-5">
              <div>
                <WizardField label="Motivation" hint="What drives your character: Ambition, Cause, Relationship, Faith…">
                  <input className={wz.input} style={wz.inputStyle} value={draft.motivation?.type || ""} maxLength={60} onChange={(e) => update((prev) => ({ ...prev, motivation: { ...prev.motivation, type: e.target.value } }))} />
                </WizardField>
                <WizardField label="Motivation in more detail">
                  <textarea className={wz.input} style={{ ...wz.inputStyle, minHeight: 90 }} value={draft.motivation?.note || ""} maxLength={500} onChange={(e) => update((prev) => ({ ...prev, motivation: { ...prev.motivation, note: e.target.value } }))} />
                </WizardField>
              </div>
              <div>
                <WizardField label="Obligation" hint="What your character owes, or what hangs over them: Debt, Bounty, Obsession, Family, Blackmail…">
                  <input className={wz.input} style={wz.inputStyle} value={draft.obligation?.type || ""} maxLength={60} onChange={(e) => update((prev) => ({ ...prev, obligation: { ...prev.obligation, type: e.target.value } }))} />
                </WizardField>
                <WizardField label="The story behind it">
                  <textarea className={wz.input} style={{ ...wz.inputStyle, minHeight: 90 }} value={draft.obligation?.note || ""} maxLength={1500} onChange={(e) => update((prev) => ({ ...prev, obligation: { ...prev.obligation, note: e.target.value } }))} />
                </WizardField>
                <WizardField label="Take on extra Obligation?" hint={`Everyone starts with ${BASE_OBLIGATION} Obligation (the GM may change this). Taking more gives you XP or credits now.`}>
                  <select className={wz.input} style={wz.inputStyle} value={draft.obligationBonus || "none"} onChange={(e) => update({ obligationBonus: e.target.value })}>
                    {OBLIGATION_BONUSES.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                  </select>
                </WizardField>
              </div>
            </div>
          )}

          {stepKey === "review" && build && (
            <CreationReview build={build} draft={draft} />
          )}
        </fieldset>

        {stepErrors(stepKey).length > 0 && stepKey !== "review" && (
          <div className="mt-4 text-[12px] space-y-1" style={{ color: "#c9a15a" }}>
            {stepErrors(stepKey).map((e, i) => <div key={i}>• {e.msg}</div>)}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button type="button" disabled={step === 0} onClick={() => setStep((s) => s - 1)} className="text-[12px] uppercase tracking-[0.15em] px-4 py-2 border disabled:opacity-30" style={{ borderColor: "#3a3f42", color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>← Back</button>
        {step < WIZARD_STEPS.length - 1 ? (
          <button type="button" onClick={() => setStep((s) => s + 1)} className="text-[12px] uppercase tracking-[0.15em] px-4 py-2" style={{ background: "#5ec8d8", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>Next →</button>
        ) : editable ? (
          <div className="flex items-center gap-3 flex-wrap justify-end">
            {submitState.state === "error" && <span className="text-[12px] max-w-md" style={{ color: "#c23b3b" }}>{submitState.msg}</span>}
            <button type="button" disabled={!build?.ok || submitState.state === "busy"} onClick={submit} className="text-[12px] uppercase tracking-[0.15em] px-4 py-2 disabled:opacity-40" style={{ background: "#ffb000", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
              {submitState.state === "busy" ? "Sending…" : "Send to the GM"}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

// Summary of a build, used by both the player's Review step and the GM's
// approval view.
function CreationReview({ build, draft }) {
  const c = build.character;
  return (
    <div>
      {build.errors.length > 0 ? (
        <div className="border p-3 mb-4 text-[12px] space-y-1" style={{ borderColor: "#c9a15a66", background: "#c9a15a12", color: "#e7e2d2" }}>
          <div style={{ color: "#c9a15a", fontWeight: 700 }}>Still to do</div>
          {build.errors.map((e, i) => <div key={i}>• {e.msg}</div>)}
        </div>
      ) : (
        <div className="border p-3 mb-4 text-[12px]" style={{ borderColor: "#6fae6066", background: "#6fae6012", color: "#e7e2d2" }}>Everything checks out.</div>
      )}
      {c && (
        <div className="grid lg:grid-cols-2 gap-5 text-[12px]" style={{ color: "#c7c2b2" }}>
          <div>
            <div className="text-xl uppercase" style={wz.h}>{c.name}</div>
            <div className="mb-3" style={wz.muted}>{c.species} · {c.career}{c.forceSensitive ? " · Force sensitive" : ""}</div>
            <CharStatBlock chars={c.characteristics} size={18} />
            <div className="mt-3">Wounds {c.vitals.wounds.threshold} · Strain {c.vitals.strain.threshold} · Soak {c.vitals.soak}</div>
            <div className="mt-1">XP: {build.xpStart} to start · spent {build.cost.total} (characteristics {build.cost.characteristics}, skills {build.cost.skills}, talents {build.cost.talents}) · <strong style={{ color: build.xpLeft < 0 ? "#c23b3b" : "#ffb000" }}>{build.xpLeft} left</strong></div>
            <div className="mt-1">Credits {c.credits.toLocaleString()} · Obligation {c.motivationObligation.obligation.type || "—"} {c.motivationObligation.obligation.value}</div>
            <div className="mt-1">Motivation: {c.motivationObligation.motivation || "—"}</div>
          </div>
          <div>
            <div className={wz.label} style={wz.muted}>Skills with ranks</div>
            <div className="mb-3">{c.skills.filter((s) => s.rank > 0).map((s) => `${s.name} ${s.rank}`).join(" · ") || "None"}</div>
            <div className={wz.label} style={wz.muted}>Career skills</div>
            <div className="mb-3">{c.skills.filter((s) => s.career).map((s) => s.name).join(", ")}</div>
            <div className={wz.label} style={wz.muted}>Talents</div>
            <div>{c.talents.map((t) => `${t.name}${t.tier ? ` (T${t.tier})` : " (species)"}${t.rank > 1 ? ` ×${t.rank}` : ""}`).join(" · ") || "None"}</div>
            {draft?.description && <><div className={`${wz.label} mt-3`} style={wz.muted}>Description</div><div>{draft.description}</div></>}
          </div>
        </div>
      )}
    </div>
  );
}

// GM page: start a creation, share its link, review and approve.
function GmCharacterCreationSection({ gmKey, onAdded }) {
  const { data } = useChargenData();
  const [list, setList] = useState([]);
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState({ state: "idle", msg: "" });
  const [openCode, setOpenCode] = useState(null);
  const [visible, setVisible] = useState(true);
  const [baseObligation, setBaseObligation] = useState(BASE_OBLIGATION);
  const [copied, setCopied] = useState(null);

  const call = useCallback(async (path, method = "GET", body) => {
    const res = await apiFetch(path, {
      method,
      headers: { "content-type": "application/json", "x-gm-key": gmKey || "" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.errors?.length ? out.errors.map((e) => e.msg).join(" ") : out.error || `The Worker said ${res.status}`);
    return out;
  }, [gmKey]);

  const refresh = useCallback(async () => {
    try { setList((await call("/gm/creation")).drafts || []); } catch { /* keep the last list */ }
  }, [call]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const linkFor = (code) => `${window.location.origin}${campaignBase()}?create=${code}`;
  async function copyLink(code) {
    try { await navigator.clipboard.writeText(linkFor(code)); setCopied(code); setTimeout(() => setCopied(null), 1500); } catch { /* the link is shown anyway */ }
  }
  async function run(fn, done) {
    setStatus({ state: "busy", msg: "" });
    try { const r = await fn(); setStatus({ state: "ok", msg: done(r) }); await refresh(); } catch (err) { setStatus({ state: "error", msg: err.message }); }
  }

  const statusStyle = { open: ["In progress", "#8a8f93"], submitted: ["Ready for review", "#ffb000"], approved: ["Added", "#6fae60"] };
  const btn = "text-[10px] tracking-[0.12em] uppercase px-2.5 py-1 border";
  return (
    <div className="border p-4 mb-5" style={{ borderColor: "#8fd3f466", background: "#101315" }}>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-1" style={{ color: "#8fd3f4" }}>Character creation</div>
      <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8a8f93" }}>
        Start a new character and send the player the link. They step through species, career and specialisation, characteristics,
        skills, talents and their story; their choices save as they go. When they send it to you, review it here and add it to the campaign
        (or send it back with a note).
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Player's name (optional)" className="bg-transparent border px-2 py-1.5 text-[12px] w-56" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
        <button
          type="button"
          disabled={status.state === "busy"}
          onClick={() => run(async () => { const r = await call("/gm/creation", "POST", { label: label.trim() }); setLabel(""); setOpenCode(r.entry.code); return r; }, (r) => `Link ready: ${linkFor(r.entry.code)}`)}
          className="text-[11px] tracking-[0.15em] uppercase px-3 py-1.5"
          style={{ background: "#8fd3f4", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
        >
          New character
        </button>
      </div>

      {list.length === 0 ? <div className="text-[12px]" style={{ color: "#5a5f62" }}>No characters being created.</div> : (
        <div className="space-y-2">
          {list.map((e) => {
            const [statusLabel, statusColor] = statusStyle[e.status] || [e.status, "#8a8f93"];
            const build = data && openCode === e.code ? computeBuild(e.draft, data, { baseObligation }) : null;
            return (
              <div key={e.code} className="border p-3" style={{ borderColor: e.status === "submitted" ? "#ffb00066" : "#2a2e31", background: "#16191b" }}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-[12px]" style={{ color: "#e7e2d2" }}>
                    <strong>{e.characterName || e.draft?.name || "Unnamed"}</strong>
                    <span style={{ color: "#8a8f93" }}>{e.label || e.draft?.playerName ? ` · ${e.label || e.draft?.playerName}` : ""}</span>
                    <span className="ml-2 text-[10px] uppercase tracking-[0.12em]" style={{ color: statusColor }}>{statusLabel}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {e.status !== "approved" && <button type="button" className={btn} style={{ borderColor: "#3a3f42", color: "#8fd3f4" }} onClick={() => copyLink(e.code)}>{copied === e.code ? "Copied!" : "Copy link"}</button>}
                    <button type="button" className={btn} style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} onClick={() => setOpenCode(openCode === e.code ? null : e.code)}>{openCode === e.code ? "Close" : "Review"}</button>
                    <button type="button" className={btn} style={{ borderColor: "#c23b3b44", color: "#c23b3b" }} onClick={() => { if (window.confirm(`Delete ${e.characterName || e.draft?.name || "this character"}'s creation${e.status === "approved" ? " record (the character stays in the campaign)" : " and its link"}?`)) run(() => call(`/gm/creation/${e.code}`, "DELETE"), () => "Deleted."); }}>Delete</button>
                  </div>
                </div>
                {e.status !== "approved" && <div className="text-[10px] mt-1 break-all" style={{ color: "#5a5f62" }}>{linkFor(e.code)}</div>}
                {openCode === e.code && (
                  <div className="mt-3 pt-3 border-t" style={{ borderColor: "#2a2e31" }}>
                    {!data ? <div className="text-[12px]" style={{ color: "#8a8f93" }}>Loading…</div> : <CreationReview build={build} draft={e.draft} />}
                    {e.status !== "approved" && (
                      <div className="flex flex-wrap items-center gap-3 mt-3">
                        <label className="text-[11px] flex items-center gap-1.5" style={{ color: "#8a8f93" }}>
                          Starting Obligation
                          <input type="number" min={0} max={100} value={baseObligation} onChange={(ev) => setBaseObligation(Math.max(0, Math.min(100, Number(ev.target.value) || 0)))} className="w-16 bg-transparent border px-2 py-1 text-[12px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
                        </label>
                        <label className="text-[11px] flex items-center gap-1.5" style={{ color: "#8a8f93" }}>
                          <input type="checkbox" checked={visible} onChange={(ev) => setVisible(ev.target.checked)} /> Show to players straight away
                        </label>
                        <button
                          type="button"
                          disabled={!build?.ok || status.state === "busy"}
                          onClick={() => run(async () => { const r = await call(`/gm/creation/${e.code}/approve`, "POST", { visible, baseObligation }); onAdded?.(); return r; }, (r) => `${r.name} added to the campaign${visible ? "" : " (hidden)"}.`)}
                          className="text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 disabled:opacity-40"
                          style={{ background: "#6fae60", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
                        >
                          Add to campaign
                        </button>
                        {e.status === "submitted" && (
                          <button
                            type="button"
                            disabled={status.state === "busy"}
                            onClick={() => { const note = window.prompt("What should the player change? (shown to them)") ?? null; if (note !== null) run(() => call(`/gm/creation/${e.code}/reopen`, "POST", { note }), () => "Sent back to the player."); }}
                            className="text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border"
                            style={{ borderColor: "#c9a15a66", color: "#c9a15a", fontFamily: "'Rajdhani', sans-serif" }}
                          >
                            Send back
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {status.msg && <p className="mt-2 text-[12px] break-all" style={{ color: status.state === "error" ? "#c23b3b" : "#6fae60" }}>{status.msg}</p>}
    </div>
  );
}

function useGearStore(gmKey) {
  const [gear, setGear] = useState([]);
  const [loadState, setLoadState] = useState({ state: "loading" });
  const dirtyUntil = useRef(0);
  const pendingRef = useRef(null);
  const saveTimer = useRef(null);
  const pollTimer = useRef(null);
  const keyRef = useRef(gmKey);
  useEffect(() => { keyRef.current = gmKey; }, [gmKey]);

  const flush = useCallback(async () => {
    const next = pendingRef.current;
    if (!next || !keyRef.current) return;
    pendingRef.current = null;
    try {
      await apiFetch("/gm/gear", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gm-key": keyRef.current },
        body: JSON.stringify({ gear: next }),
      });
    } catch {
      /* best-effort; the next poll after the dirty window reconciles */
    }
  }, []);

  const save = useCallback((next) => {
    if (!keyRef.current) return;
    setGear(next);
    pendingRef.current = next;
    dirtyUntil.current = Date.now() + GEAR_DIRTY_MS;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, GEAR_SAVE_DEBOUNCE_MS);
  }, [flush]);

  const fetchGear = useCallback(async () => {
    const key = keyRef.current;
    try {
      const res = await apiFetch(`${key ? "/gm/gear" : "/gear"}?_=${Date.now()}`, {
        cache: "no-store",
        headers: key ? { "x-gm-key": key } : {},
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (Date.now() < dirtyUntil.current) return;
      setGear(Array.isArray(data.gear) ? data.gear : []);
      setLoadState({ state: "ok" });
    } catch (err) {
      setLoadState({ state: "error", msg: err.message });
    }
  }, []);

  useEffect(() => {
    fetchGear();
    pollTimer.current = setInterval(fetchGear, GEAR_POLL_MS);
    return () => {
      clearInterval(pollTimer.current);
      clearTimeout(saveTimer.current);
    };
  }, [fetchGear, gmKey]);

  return { gear, save, loadState, canEdit: !!gmKey };
}

// A wound bar with numbered pips, same visual language as PipRow. Soak is
// deliberately never drawn here — it only ever factors into the Apply
// Damage math, never into what's on-screen.
// `scale` sizes the whole bar up (the GM page passes 1.5 so enemy tracks
// read easier at a glance — see GmEnemyRow). Same hover-preview behavior as
// PipRow: hovering a pip previews the exact result of clicking it before
// it's committed. `onAdjust`, when passed, draws +/- buttons alongside,
// matching the player-facing pip rows.
function EnemyWoundBar({ current, threshold, colorClass = "#c23b3b", onSet, onAdjust, scale = 1, groupSize, overLabel }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  // The bar always tops out at exactly `threshold` boxes — see PipRow's
  // comment. Going past threshold (a Rival/Nemesis is only taken down once
  // wounds EXCEED it — see enemyStatus) is tracked by the numeric tally the
  // caller already prints above this bar (e.g. "14 of 12 wounds"), not by
  // growing the box row.
  const pips = Array.from({ length: threshold }, (_, i) => i < current);
  const size = Math.round(16 * scale);
  const fontSize = Math.round(7 * scale);
  const previewCount = hoverIndex == null ? null : (current === hoverIndex + 1 ? hoverIndex : hoverIndex + 1);
  // groupSize marks off one minion's worth of pips at a time with a wider
  // gap, so a group's bar reads as "N minions' worth of boxes" rather than
  // one long undifferentiated strip.
  const gap = Math.round(4 * scale);
  const groupGap = Math.round(12 * scale);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex flex-wrap items-center" onMouseLeave={() => setHoverIndex(null)}>
        {pips.map((filled, i) => {
          const previewing = !!onSet && previewCount != null;
          const previewFilled = previewing ? i < previewCount : filled;
          const changing = previewing && previewFilled !== filled;
          const startsNewGroup = groupSize && i > 0 && i % groupSize === 0;
          const common = {
            className: "border relative flex items-center justify-center",
            style: {
              width: size, height: size,
              marginLeft: startsNewGroup ? groupGap : (i === 0 ? 0 : gap),
              marginBottom: gap,
              borderColor: previewFilled ? colorClass : "#3a3f42",
              background: previewFilled ? colorClass : "transparent",
              opacity: changing ? 0.45 : 1,
              cursor: onSet ? "pointer" : "default",
              transition: previewing ? "none" : "background 0.3s ease-out, border-color 0.3s ease-out",
            },
          };
          const label = (
            <span className="leading-none pointer-events-none select-none" style={{ fontSize, color: previewFilled ? "#101315" : "#5a5f62", fontWeight: 700 }}>{i + 1}</span>
          );
          return onSet ? (
            <button key={i} type="button" onClick={() => onSet(current === i + 1 ? i : i + 1)} onMouseEnter={() => setHoverIndex(i)} title={`Set to ${i + 1} of ${threshold}`} {...common}>{label}</button>
          ) : (
            <span key={i} {...common}>{label}</span>
          );
        })}
      </div>
      {current > threshold && overLabel && (
        <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: "#c23b3b", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          {overLabel}
        </span>
      )}
      {onAdjust && (
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onAdjust(-1)} className="flex items-center justify-center border leading-none" style={{ width: Math.round(20 * scale), height: Math.round(20 * scale), fontSize: Math.round(12 * scale), borderColor: "#3a3f42", color: "#e7e2d2" }} title="Decrease by 1">−</button>
          <button type="button" onClick={() => onAdjust(1)} className="flex items-center justify-center border leading-none" style={{ width: Math.round(20 * scale), height: Math.round(20 * scale), fontSize: Math.round(12 * scale), borderColor: "#3a3f42", color: "#e7e2d2" }} title="Increase by 1">+</button>
        </div>
      )}
    </div>
  );
}

// Player-facing tab: name, type, and a wound bar — nothing GM-only leaks in
// here for players, who receive the redacted public payload. Signed-in GMs
// also see hidden enemies and can toggle visibility using the protected save path.
function EnemyPanel({ enemies, loadState, isGm, onSave }) {
  const canToggleVisibility = isGm && typeof onSave === "function";
  const toggleVisibility = (id) => {
    if (!canToggleVisibility) return;
    onSave(enemies.map((enemy) => enemy.id === id ? { ...enemy, hidden: !enemy.hidden } : enemy));
  };
  const standing = enemies.filter((e) => enemyStatus(e) !== "defeated").length;
  return (
    <div className="relative overflow-hidden border" style={{ borderColor: "#3a3f42", background: "#16191b", boxShadow: "0 0 30px rgba(194,59,59,0.06)" }}>
      <div className="p-5 sm:p-7">
        <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#c23b3b" }}>SHARED SESSION TOOL</div>
        <h1 className="text-2xl sm:text-3xl uppercase tracking-wide mb-2" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          Enemies
        </h1>
        <p className="text-[11px] leading-relaxed mb-5" style={{ color: "#5a5f62" }}>
          What you're up against, and how much fight is left in it — a general read, not the GM's exact numbers.
          {canToggleVisibility && <span className="block mt-1" style={{ color: "#8a8f93" }}>GM: click an enemy tile to hide or reveal it to players.</span>}
        </p>

        {loadState.state === "error" && (
          <p className="text-[12px] mb-3" style={{ color: "#c23b3b" }}>Couldn't reach the enemy board: {loadState.msg}</p>
        )}

        {enemies.length === 0 ? (
          <span className="text-[13px]" style={{ color: "#5a5f62" }}>Nothing on the board.</span>
        ) : (
          <>
            <div className="text-[11px] mb-3" style={{ color: "#8a8f93" }}>{standing} of {enemies.length} still standing</div>
            <div className="grid grid-cols-1 gap-3">
            {enemies.map((e) => {
              const status = enemyStatus(e);
              const defeated = status === "defeated";
              const isMinion = e.type === "minion";
              const meta = ENEMY_STATUS_META[status];
              const abbr = tokenInitials(e.name);
              // The card border only speaks up in the adversary's own status
              // color once it's actually defeated — a minion group's
              // in-between health is read off its per-minion circles below,
              // not the card frame, so an individually wounded minion
              // doesn't make the whole group's border look hurt.
              const borderIsStatus = !isMinion || defeated;
              // The GM's own browser gets the full (unredacted) enemy list,
              // hidden ones included — this is the same "Enemies" tab
              // players see, so without a visual clue the GM can't tell at
              // a glance which cards are actually invisible to the table.
              // Players themselves never receive hidden entries at all (see
              // useEnemyStore's redacted payload with no gmKey), so this
              // only ever shows for a signed-in GM.
              const hiddenFromPlayers = isGm && !!e.hidden;
              return (
                <div
                  key={e.id}
                  className={canToggleVisibility ? "p-3 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9a15a]" : "p-3"}
                  role={canToggleVisibility ? "button" : undefined}
                  tabIndex={canToggleVisibility ? 0 : undefined}
                  aria-label={canToggleVisibility ? (e.name || "Unnamed") + ": visible to players" : undefined}
                  aria-pressed={canToggleVisibility ? !e.hidden : undefined}
                  title={canToggleVisibility ? (e.hidden ? "Click to reveal to players" : "Click to hide from players") : undefined}
                  onClick={canToggleVisibility ? () => toggleVisibility(e.id) : undefined}
                  onKeyDown={canToggleVisibility ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (!event.repeat) toggleVisibility(e.id);
                    }
                  } : undefined}
                  style={{ border: `1px ${hiddenFromPlayers ? "dashed" : "solid"} ${hiddenFromPlayers ? "#c9a15a" : defeated ? "#3a3f42" : borderIsStatus ? meta.color + "66" : "#3a3f42"}`, background: hiddenFromPlayers ? "#1a1710" : "#101315", opacity: defeated ? 0.6 : 1 }}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span className="text-[15px] flex items-center gap-2" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
                      <span
                        className="inline-flex items-center justify-center flex-shrink-0"
                        style={{ width: 20, height: 20, borderRadius: 3, background: "#c23b3b", color: "#101315", fontSize: 9, fontWeight: 700 }}
                        title="Abbreviation shown on the Battle Map"
                      >
                        {abbr}
                      </span>
                      {e.name || "Unnamed"}
                      <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>{e.type}</span>
                    </span>
                  </div>
                  {canToggleVisibility && (
                    <div className="mt-1 text-[10px] uppercase tracking-[0.1em]" style={{ color: hiddenFromPlayers ? "#c9a15a" : "#8a8f93" }}>
                      {hiddenFromPlayers ? "Hidden from players" : "Visible to players"}
                    </div>
                  )}
                  {/* Status lives in one consistent spot below the name for
                      every adversary type, using the same white/yellow/
                      orange/red scale either way: a minion group shows it as
                      one colored circle per minion (with a bold red X once that
                      minion is defeated), a Rival/Nemesis — with no
                      individual minions to show — shows it as a single
                      status word instead. */}
                  {isMinion ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {minionCircleStates(e).map((s, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center justify-center rounded-full flex-shrink-0"
                          style={{
                            width: 16, height: 16, position: "relative", overflow: "visible",
                            background: s === "defeated" ? "#241414" : MINION_CIRCLE_COLORS[s],
                            border: `1px solid ${s === "defeated" ? "#c23b3b" : "#00000033"}`,
                          }}
                          title={s === "defeated" ? "Defeated" : s === "wounded" ? "Wounded" : s === "mostlyFine" ? "Mostly fine" : "Unharmed"}
                        >
                          {s === "defeated" && (
                            <span aria-hidden="true" style={{ pointerEvents: "none" }}>
                              {[45, -45].map((angle) => (
                                <span key={angle} style={{
                                  position: "absolute", left: "50%", top: "50%",
                                  width: 22, height: 3, borderRadius: 2,
                                  background: "#c23b3b",
                                  transform: `translate(-50%, -50%) rotate(${angle}deg)`,
                                }} />
                              ))}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2">
                      <span className="text-[11px] uppercase tracking-[0.15em]" style={{ color: meta.color }}>{meta.label}</span>
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// GM's editable row: type/threshold/soak setup, Apply Damage (soak
// subtracted automatically), and a wound/strain bar that can also be
// clicked directly. Changing type or a threshold reflows the bar's max
// without ever letting current exceed it.
// A minion group's total wound pool is Wound Threshold × how many minions
// are left in it — one minion's worth of damage knocks one minion out.
// Rival/Nemesis are always a single actor, so this is just woundThreshold.
function enemyWoundCapacity(enemy) {
  return enemy.type === "minion" ? enemy.woundThreshold * Math.max(1, enemy.minionCount || 1) : enemy.woundThreshold;
}
function minionsRemaining(enemy) {
  if (enemy.type !== "minion") return null;
  return minionCircleStates(enemy).filter((s) => s !== "defeated").length;
}
// A Nemesis knocked unconscious by strain (strain EXCEEDING its threshold —
// see the GM tab's "Unconscious" label) is out of the fight exactly like one
// taken down by wounds, so anywhere "defeated" is decided, both conditions
// count. Wounds alone still apply to every other adversary type.
function enemyDefeated(enemy) {
  if (enemy.wounds > enemyWoundCapacity(enemy)) return true;
  if (enemy.type === "nemesis" && enemy.strain > (enemy.strainThreshold || 0)) return true;
  return false;
}

// Player-facing health is a coarse band, not an exact number — see
// EnemyPanel. 100% remaining = unharmed, a dip below that but still over
// half = mostly fine, half or under (but not zero) = wounded, zero = defeated.
// One shared color scale for every adversary type and both display forms —
// a minion's colored circle and a Rival/Nemesis's status word underneath
// its name always mean the same thing at a glance: white = unharmed,
// yellow = mostly fine, orange = wounded, red = defeated.
const ENEMY_STATUS_COLORS = {
  unharmed: "#f5f3ea",
  mostlyFine: "#e8c94a",
  wounded: "#e0763a",
  defeated: "#c23b3b",
};
const ENEMY_STATUS_META = {
  unharmed: { label: "Unharmed", color: ENEMY_STATUS_COLORS.unharmed },
  mostlyFine: { label: "Mostly Fine", color: ENEMY_STATUS_COLORS.mostlyFine },
  wounded: { label: "Wounded", color: ENEMY_STATUS_COLORS.wounded },
  defeated: { label: "Defeated", color: ENEMY_STATUS_COLORS.defeated },
};
function enemyStatus(enemy) {
  const capacity = enemyWoundCapacity(enemy);
  if (capacity <= 0) return "unharmed";
  // Uniform rule across every adversary type: up and fighting at exactly
  // its wound capacity, defeated only once wounds EXCEED it. For a minion
  // group this falls naturally out of minionCircleStates, where standard
  // minions drop at their own threshold but the last one standing is run
  // like a Rival and only falls once wounds exceed its share. A Nemesis
  // knocked "Unconscious" by strain (see enemyDefeated) reads as defeated
  // here too — the player-facing Enemy tab keeps a single simple label
  // rather than distinguishing wounds-out from strain-out.
  if (enemyDefeated(enemy)) return "defeated";
  const remainingPct = ((capacity - enemy.wounds) / capacity) * 100;
  if (remainingPct <= 50) return "wounded";
  if (remainingPct < 100) return "mostlyFine";
  return "unharmed";
}

// Per-minion breakdown for the player-facing circle row (see EnemyPanel):
// damage is assumed to land on the "frontmost" minion first, so this reads
// off each individual minion's own wound threshold rather than the group's
// aggregate pool. Order is arbitrary — minions are interchangeable — it's
// just a way to render "this many are down, this many are hurting, this
// many are fine" without inventing per-minion identity.
function minionCircleStates(enemy) {
  const total = Math.max(1, enemy.minionCount || 1);
  const per = Math.max(1, enemy.woundThreshold);
  const wounds = Math.max(0, enemy.wounds || 0);
  const states = [];
  for (let i = 0; i < total; i++) {
    const raw = wounds - i * per; // wounds allocated to this minion's slot, uncapped
    // Every minion — same rule as enemyStatus/enemyDefeated apply to the
    // group as a whole and to a Rival/Nemesis — only goes down once wounds
    // EXCEED its own threshold, not merely reach it. A minion with a
    // threshold of 5 needs 6 wounds before it's defeated.
    const defeated = raw > per;
    if (defeated) {
      states.push("defeated");
      continue;
    }
    const taken = Math.max(0, Math.min(per, raw));
    const remainingPct = ((per - taken) / per) * 100;
    if (remainingPct <= 50) states.push("wounded");
    else if (remainingPct < 100) states.push("mostlyFine");
    else states.push("unharmed");
  }
  return states;
}

// Minion circles use the same shared color scale as the Rival/Nemesis status
// word (see ENEMY_STATUS_COLORS) — kept as its own name here since it reads
// clearer at each call site than the more general constant.
const MINION_CIRCLE_COLORS = ENEMY_STATUS_COLORS;

function GmEnemyRow({ enemy, onChange, onRemove, onDuplicate }) {
  const [damageDraft, setDamageDraft] = useState("");
  const capacity = enemyWoundCapacity(enemy);
  // See enemyDefeated: every adversary type, minion group included, is only
  // taken down once wounds EXCEED capacity — and a Nemesis knocked
  // "Unconscious" by strain (see the strain bar's overLabel below) counts as
  // down here too, same as the player-facing Enemy tab.
  const down = enemyDefeated(enemy);

  function setType(type) {
    const strainThreshold = type === "nemesis" ? (enemy.strainThreshold || 10) : 0;
    onChange({ ...enemy, type, minionCount: type === "minion" ? (enemy.minionCount || 1) : 1, strainThreshold, strain: type === "nemesis" ? Math.min(enemy.strain || 0, strainThreshold) : 0 });
  }
  function setWoundThreshold(n) {
    const woundThreshold = Math.max(1, n);
    const nextCapacity = enemy.type === "minion" ? woundThreshold * (enemy.minionCount || 1) : woundThreshold;
    onChange({ ...enemy, woundThreshold, wounds: Math.min(enemy.wounds, nextCapacity) });
  }
  function setMinionCount(n) {
    const minionCount = Math.max(1, Math.min(20, n));
    const nextCapacity = enemy.woundThreshold * minionCount;
    onChange({ ...enemy, minionCount, wounds: Math.min(enemy.wounds, nextCapacity) });
  }
  function setStrainThreshold(n) {
    const strainThreshold = Math.max(1, n);
    onChange({ ...enemy, strainThreshold, strain: Math.min(enemy.strain || 0, strainThreshold) });
  }
  function setWounds(n) {
    // No upper clamp — a Rival/Nemesis needs to be settable past its own
    // wound threshold, since it isn't taken down until it's exceeded (see
    // enemyStatus). Minions are naturally bounded by their own per-minion
    // math elsewhere, so this is safe to leave open for both.
    onChange({ ...enemy, wounds: Math.max(0, n) });
  }
  function setStrain(n) {
    // No upper clamp — matches setWounds: a Nemesis's strain needs to be
    // settable past its own threshold, since (like the player tab) it only
    // reads as unconscious once strain actually EXCEEDS the threshold, not
    // merely reaches it.
    onChange({ ...enemy, strain: Math.max(0, n) });
  }
  function applyDamage() {
    const raw = Math.max(0, Math.round(Number(damageDraft)) || 0);
    const net = Math.max(0, raw - (enemy.soak || 0));
    setWounds(enemy.wounds + net);
    setDamageDraft("");
  }

  return (
    <div className="p-3 mb-3" style={{ border: `1px solid ${enemy.hidden ? "#c9a15a55" : down ? "#3a3f42" : "#c23b3b66"}`, background: enemy.hidden ? "#1a1710" : "#101315" }}>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <input
          type="text"
          value={enemy.name}
          onChange={(e) => onChange({ ...enemy, name: e.target.value })}
          placeholder="Enemy name"
          maxLength={60}
          className="flex-1 min-w-[140px] bg-transparent border px-2 py-1 text-[13px]"
          style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
        />
        {ENEMY_TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setType(t.key)}
            className="text-[10px] tracking-[0.1em] uppercase px-2 py-1 border"
            style={{
              borderColor: enemy.type === t.key ? "#c23b3b" : "#3a3f42",
              color: enemy.type === t.key ? "#c23b3b" : "#8a8f93",
              fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
            }}
          >
            {t.label}
          </button>
        ))}
        <label
          className="flex items-center gap-1.5 text-[11px] px-2 py-1 border"
          style={{ borderColor: enemy.hidden ? "#c9a15a" : "#3a3f42" }}
          title={enemy.hidden ? "Hidden from players — untick to reveal" : "Visible to players"}
        >
          <input type="checkbox" checked={!!enemy.hidden} onChange={(e) => onChange({ ...enemy, hidden: e.target.checked })} />
          <span style={{ color: enemy.hidden ? "#c9a15a" : "#8a8f93" }}>Hidden</span>
        </label>
        <button type="button" onClick={onDuplicate} className="text-[11px] px-2 py-1" style={{ color: "#5ec8d8" }} title="Add another identical enemy below this one">⧉</button>
        <button type="button" onClick={onRemove} className="text-[11px] px-1.5" style={{ color: "#8a8f93" }} title="Remove this enemy">✕</button>
      </div>

      <div className="flex flex-wrap items-end gap-4 mb-2">
        {/* Order: Soak, Minions (group only), Wound Threshold, Strain Threshold (nemesis only). */}
        <label className="flex flex-col gap-1">
          <span className="text-[9px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>Soak</span>
          <input type="number" min={0} max={60} value={enemy.soak} onChange={(e) => onChange({ ...enemy, soak: Math.max(0, Number(e.target.value)) })} className="w-20 bg-transparent border px-2 py-1 text-[12px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
        </label>
        {enemy.type === "minion" && (
          <label className="flex flex-col gap-1">
            <span className="text-[9px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>Minions in group</span>
            <input type="number" min={1} max={20} value={enemy.minionCount || 1} onChange={(e) => setMinionCount(Number(e.target.value))} className="w-20 bg-transparent border px-2 py-1 text-[12px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[9px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>Wound Threshold</span>
          <input type="number" min={1} max={60} value={enemy.woundThreshold} onChange={(e) => setWoundThreshold(Number(e.target.value))} className="w-20 bg-transparent border px-2 py-1 text-[12px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
        </label>
        {enemy.type === "nemesis" && (
          <label className="flex flex-col gap-1">
            <span className="text-[9px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>Strain Threshold</span>
            <input type="number" min={1} max={60} value={enemy.strainThreshold} onChange={(e) => setStrainThreshold(Number(e.target.value))} className="w-20 bg-transparent border px-2 py-1 text-[12px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[9px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>Damage taken</span>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              value={damageDraft}
              onChange={(e) => setDamageDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyDamage()}
              placeholder="0"
              className="w-20 bg-transparent border px-2 py-1 text-[12px] mono-num"
              style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
            />
            <button type="button" onClick={applyDamage} disabled={!damageDraft} className="text-[10px] tracking-wide uppercase px-2 py-1.5 disabled:opacity-40" style={{ background: "#c23b3b", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
              Apply (−{enemy.soak || 0} soak)
            </button>
          </div>
        </label>
      </div>

      <div className="text-[10px] mb-1" style={{ color: down ? "#c23b3b" : "#8a8f93" }}>
        {enemy.type === "minion"
          ? `${enemy.wounds} of ${capacity} wounds · ${minionsRemaining(enemy)} of ${enemy.minionCount || 1} minions left`
          : `${enemy.wounds} of ${capacity} wounds${down ? " — Down" : ""}`}
      </div>
      <EnemyWoundBar current={enemy.wounds} threshold={capacity} groupSize={enemy.type === "minion" ? enemy.woundThreshold : undefined} onSet={setWounds} onAdjust={(d) => setWounds(enemy.wounds + d)} scale={1.5} />
      {enemy.type === "nemesis" && (
        <div className="mt-2">
          <div className="text-[10px] mb-1" style={{ color: enemy.strain > enemy.strainThreshold ? "#c23b3b" : "#8a8f93" }}>{enemy.strain} of {enemy.strainThreshold} strain</div>
          <EnemyWoundBar current={enemy.strain} threshold={enemy.strainThreshold} colorClass="#ffb000" onSet={setStrain} onAdjust={(d) => setStrain(enemy.strain + d)} scale={1.5} overLabel="Unconscious" />
        </div>
      )}
    </div>
  );
}

function newEnemy() {
  // Defaults hidden — a freshly added enemy hasn't been introduced to the
  // scene yet, so it shouldn't show up on the player-facing Enemies tab
  // until the GM reveals it.
  return { id: crypto.randomUUID(), name: "", type: "minion", soak: 0, woundThreshold: 5, minionCount: 1, wounds: 0, strainThreshold: 0, strain: 0, hidden: true };
}

// ---------------------------------------------------------------------------
// Adversary lookup — a lightweight local typeahead over the trimmed
// reference/adversaries.json index (see dashboard/public/data/adversary-
// index.json, built as {name, type, soak, wounds, strain} per entry — the
// full stat block lives in the repo's reference/ folder for the GM to pull
// up manually; this is just enough to seed a new enemy row instantly). No
// dependency added — this is a small subsequence fuzzy matcher, same
// zero-extra-dependency style as the rest of the file.
// ---------------------------------------------------------------------------

// Scores how well `query` fuzzy-matches `target` as a subsequence of its
// characters (case-insensitive) — every query character must appear in
// target, in order, but not necessarily contiguous. Returns null on no
// match, otherwise a score where longer consecutive runs and earlier/
// closer-to-target-length matches score higher, so "ack" ranks "Admiral
// Ackbar" above some coincidental scattered match in a longer name.
function fuzzyMatch(query, target) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let runLength = 0;
  let firstMatchIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatchIdx === -1) firstMatchIdx = ti;
      runLength += 1;
      score += 1 + runLength; // consecutive runs score progressively higher
      qi += 1;
    } else {
      runLength = 0;
    }
  }
  if (qi < q.length) return null; // not every query character was found in order
  score -= firstMatchIdx * 0.5; // small bonus for matching earlier in the name
  score -= (t.length - q.length) * 0.05; // small bonus for a tighter overall match
  return score;
}

function useAdversaryIndex() {
  const [index, setIndex] = useState(null); // null = not yet loaded
  const [loadState, setLoadState] = useState({ state: "idle" });
  const load = useCallback(() => {
    if (index || loadState.state === "loading") return;
    setLoadState({ state: "loading" });
    apiFetch("/data/adversary-index.json")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then((data) => {
        setIndex(Array.isArray(data) ? data : []);
        setLoadState({ state: "ok" });
      })
      .catch((err) => setLoadState({ state: "error", msg: err.message }));
  }, [index, loadState.state]);
  return { index, loadState, load };
}

// Maps one adversary-index entry onto a fresh enemy-board row. `wounds` and
// `strain` in the index are the adversary's printed thresholds (capacity),
// not current damage taken — a newly-added enemy always starts undamaged.
function enemyFromAdversary(entry) {
  const type = (entry.type || "minion").toLowerCase();
  return {
    id: crypto.randomUUID(),
    name: entry.name,
    type,
    soak: entry.soak || 0,
    woundThreshold: Math.max(1, entry.wounds || 1),
    minionCount: 1,
    wounds: 0,
    strainThreshold: type === "nemesis" ? Math.max(1, entry.strain || 10) : 0,
    strain: 0,
    hidden: true,
  };
}

// Same lazy-loaded index pattern as useAdversaryIndex, generalized: every
// gear-board lookup (weapon/armor/equipment) is a trimmed reference index
// checked into dashboard/public/data/ (see reference/README.md's "Dashboard
// GM-page lookups" section), fetched once on first focus and fuzzy-matched
// the same way.
function useReferenceIndex(url) {
  const [index, setIndex] = useState(null);
  const [loadState, setLoadState] = useState({ state: "idle" });
  const load = useCallback(() => {
    if (index || loadState.state === "loading") return;
    setLoadState({ state: "loading" });
    apiFetch(url)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then((data) => {
        setIndex(Array.isArray(data) ? data : []);
        setLoadState({ state: "ok" });
      })
      .catch((err) => setLoadState({ state: "error", msg: err.message }));
  }, [index, loadState.state, url]);
  return { index, loadState, load };
}

// Maps one weapon-index entry onto a fresh gear-board row for a specific
// character, in the same shape the PC sheet's own `weapons` array already
// uses (name/skill/damage/crit/range/special) — see WeaponCard. Hidden by
// default, same as a fresh enemy: the GM adds it the moment it's picked up,
// then reveals it once the party actually identifies or claims it.
function gearFromWeapon(entry, characterId) {
  return {
    id: crypto.randomUUID(),
    characterId,
    category: "weapon",
    name: entry.name,
    skill: entry.skill || "",
    damage: entry.damage || 0,
    crit: entry.crit || 0,
    range: entry.range || "",
    special: entry.special || "—",
    hidden: true,
    addedAt: Date.now(),
  };
}

// Maps one armor-index entry the same way — soak/defence become the gear
// row's soakBonus/defenseBonus, and the printed ability text becomes its
// note (already trimmed short when the index was built).
function gearFromArmor(entry, characterId) {
  return {
    id: crypto.randomUUID(),
    characterId,
    category: "armor",
    name: entry.name,
    soakBonus: entry.soak || 0,
    defenseBonus: entry.defence || 0,
    note: entry.note || "",
    hidden: true,
    addedAt: Date.now(),
  };
}

// Maps one equipment-index entry — general gear has no combat stats, just a
// name and its printed ability text as the note.
function gearFromEquipment(entry, characterId) {
  return {
    id: crypto.randomUUID(),
    characterId,
    category: "equipment",
    name: entry.name,
    note: entry.note || "",
    hidden: true,
    addedAt: Date.now(),
  };
}

// Typeahead search box over one reference index, scoped to one character —
// same interaction as EnemyLookup below (fuzzy-match as you type, arrow
// keys + Enter or a click to pick). `mapEntry` turns the picked index entry
// into a gear-board row; `renderMeta` draws the small stat line shown next
// to each result.
function GearReferenceLookup({ url, characterId, onPick, mapEntry, placeholder, loadingPlaceholder, title, renderMeta }) {
  const { index, loadState, load } = useReferenceIndex(url);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const boxRef = useRef(null);

  const results = useMemo(() => {
    if (!index || !query.trim()) return [];
    const scored = [];
    for (const entry of index) {
      const score = fuzzyMatch(query, entry.name);
      if (score !== null) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 12).map((s) => s.entry);
  }, [index, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    function onOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  function pick(entry) {
    onPick(mapEntry(entry, characterId));
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e) {
    if (!open || !results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(results[activeIdx]); }
    else if (e.key === "Escape") { setOpen(false); }
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        value={query}
        onFocus={load}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
        placeholder={loadState.state === "loading" ? loadingPlaceholder : placeholder}
        className="w-72 max-w-full bg-transparent border px-2 py-1.5 text-[12px]"
        style={{ borderColor: "#5ec8d866", color: "#e7e2d2" }}
        title={title}
      />
      {loadState.state === "error" && (
        <div className="absolute z-10 mt-1 text-[10px] px-2 py-1" style={{ color: "#c23b3b", background: "#101315", border: "1px solid #3a3f42" }}>
          Couldn't load the reference index: {loadState.msg}
        </div>
      )}
      {open && query.trim() && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-[min(38rem,calc(100vw-2rem))] max-h-96 overflow-y-auto" style={{ background: "#101315", border: "1px solid #3a3f42" }}>
          {results.map((entry, i) => (
            <button
              key={entry.name}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(entry)}
              className="w-full text-left px-3 py-2 flex items-start justify-between gap-3 text-[11px]"
              style={{ background: i === activeIdx ? "#1a1f22" : "transparent", color: "#e7e2d2" }}
            >
              <span className="whitespace-normal break-words leading-snug">{entry.name}</span>
              <span className="text-[9px] uppercase tracking-[0.1em] shrink-0 ml-2 whitespace-normal text-right max-w-[45%] leading-snug" style={{ color: "#8a8f93" }}>
                {renderMeta(entry)}
              </span>
            </button>
          ))}
        </div>
      )}
      {open && query.trim() && index && results.length === 0 && (
        <div className="absolute z-10 mt-1 w-72 px-2.5 py-1.5 text-[11px]" style={{ background: "#101315", border: "1px solid #3a3f42", color: "#5a5f62" }}>
          No matches in the reference index.
        </div>
      )}
    </div>
  );
}

function GearWeaponLookup({ characterId, onPick }) {
  return (
    <GearReferenceLookup
      url="/data/weapon-index.json"
      characterId={characterId}
      onPick={onPick}
      mapEntry={gearFromWeapon}
      placeholder="Look up a weapon…"
      loadingPlaceholder="Loading weapons…"
      title="Fuzzy-search the reference weapon index (398 entries) and add one to this character, hidden until revealed"
      renderMeta={(entry) => `${typeof entry.damage === "string" ? `${entry.damage} Brawn` : `${entry.damage}dmg`} · ${entry.range}`}
    />
  );
}

function GearArmorLookup({ characterId, onPick }) {
  return (
    <GearReferenceLookup
      url="/data/armor-index.json"
      characterId={characterId}
      onPick={onPick}
      mapEntry={gearFromArmor}
      placeholder="Look up armor…"
      loadingPlaceholder="Loading armor…"
      title="Fuzzy-search the reference armor index (113 entries) and add one to this character, hidden until revealed"
      renderMeta={(entry) => `+${entry.soak} Soak · +${entry.defence} Def`}
    />
  );
}

function GearEquipmentLookup({ characterId, onPick }) {
  return (
    <GearReferenceLookup
      url="/data/equipment-index.json"
      characterId={characterId}
      onPick={onPick}
      mapEntry={gearFromEquipment}
      placeholder="Look up equipment…"
      loadingPlaceholder="Loading equipment…"
      title="Fuzzy-search the reference equipment index (472 entries) and add one to this character, hidden until revealed"
      renderMeta={(entry) => entry.category}
    />
  );
}

const GEAR_LOOKUPS = { weapon: GearWeaponLookup, armor: GearArmorLookup, equipment: GearEquipmentLookup };

// One character's row in the GM page's gear board — a category switcher
// (Weapon/Armor/Equipment) crossed with a Search/Manual switcher: Search
// fuzzy-looks-up the matching reference index above, Manual is a hand-
// entered form for anything not in that index (homebrew items, a printed
// item with a typo, etc.) — every category supports both. Below this sits
// the list of gear already added for this character, each with its own
// hidden/reveal toggle and a remove button, same UX as the enemy board's
// hidden checkbox.
function GmGearAddForm({ characterId, onAdd }) {
  const [category, setCategory] = useState("weapon");
  const [mode, setMode] = useState("search");
  const [name, setName] = useState("");
  const [skill, setSkill] = useState("");
  const [damage, setDamage] = useState("");
  const [crit, setCrit] = useState("");
  const [range, setRange] = useState("");
  const [qualities, setQualities] = useState([]);
  const [soakBonus, setSoakBonus] = useState("");
  const [rangedDefense, setRangedDefense] = useState("");
  const [meleeDefense, setMeleeDefense] = useState("");
  const [note, setNote] = useState("");

  function reset() {
    setName(""); setSkill(""); setDamage(""); setCrit(""); setRange(""); setQualities([]);
    setSoakBonus(""); setRangedDefense(""); setMeleeDefense(""); setNote("");
  }

  function selectCategory(next) {
    setCategory(next);
    reset();
  }

  function addManual() {
    if (!name.trim()) return;
    const base = { id: crypto.randomUUID(), characterId, category, name: name.trim(), hidden: true, addedAt: Date.now() };
    const item =
      category === "weapon" ? { ...base, skill: skill.trim(), damage: Math.max(0, Number(damage) || 0), crit: Math.max(0, Number(crit) || 0), range: range.trim(), special: qualities.join(", ") || "—" } :
      category === "armor" ? (() => {
        const ranged = Math.max(0, Number(rangedDefense) || 0);
        const melee = Math.max(0, Number(meleeDefense) || 0);
        return { ...base, soakBonus: Math.max(0, Number(soakBonus) || 0), rangedDefense: ranged, meleeDefense: melee, defenseBonus: Math.max(ranged, melee), special: qualities.join(", "), note: note.trim() };
      })() :
      { ...base, note: note.trim() };
    onAdd(item);
    reset();
  }

  const Lookup = GEAR_LOOKUPS[category];

  return (
    <div className="mb-2">
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        {[
          { key: "weapon", label: "Weapon" },
          { key: "armor", label: "Armor" },
          { key: "equipment", label: "Equipment" },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => selectCategory(t.key)}
            className="text-[10px] tracking-[0.1em] uppercase px-2 py-1 border"
            style={{
              borderColor: category === t.key ? "#5ec8d8" : "#3a3f42",
              color: category === t.key ? "#5ec8d8" : "#8a8f93",
              fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
            }}
          >
            {t.label}
          </button>
        ))}
        <span style={{ color: "#3a3f42" }}>|</span>
        {[
          { key: "search", label: "Search" },
          { key: "manual", label: "Manual" },
        ].map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMode(m.key)}
            className="text-[10px] tracking-[0.1em] uppercase px-2 py-1 border"
            style={{
              borderColor: mode === m.key ? "#c9a15a" : "#3a3f42",
              color: mode === m.key ? "#c9a15a" : "#8a8f93",
              fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
            }}
            title={m.key === "manual" ? "Type in an item that isn't in the reference index — a homebrew piece, a variant, anything" : undefined}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === "search" ? (
        <Lookup characterId={characterId} onPick={onAdd} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${category === "weapon" ? "Weapon" : category === "armor" ? "Armor" : "Equipment"} name…`}
            className="w-44 bg-transparent border px-2 py-1 text-[11px]"
            style={{ borderColor: "#5ec8d866", color: "#e7e2d2" }}
          />
          {category === "weapon" && (
            <>
              <select value={skill} onChange={(e) => setSkill(e.target.value)} className="w-40 bg-transparent border px-1.5 py-1 text-[11px]" style={{ borderColor: "#3a3f42", color: skill ? "#e7e2d2" : "#8a8f93", background: "#101315" }} title="Skill used to attack with this weapon">
                <option value="">Skill…</option>
                {["Combat", "General", "Knowledge"].map((group) => (
                  <optgroup key={group} label={group}>
                    {FULL_SKILL_LIST.filter((s) => s.group === group).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                  </optgroup>
                ))}
              </select>
              <input type="number" min={0} value={damage} onChange={(e) => setDamage(e.target.value)} placeholder="Dmg" className="w-16 bg-transparent border px-2 py-1 text-[11px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
              <input type="number" min={0} value={crit} onChange={(e) => setCrit(e.target.value)} placeholder="Crit" className="w-16 bg-transparent border px-2 py-1 text-[11px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
              <input type="text" value={range} onChange={(e) => setRange(e.target.value)} placeholder="Range" className="w-24 bg-transparent border px-2 py-1 text-[11px]" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
              <QualityPicker value={qualities} onChange={setQualities} />
            </>
          )}
          {category === "armor" && (
            <>
              <input type="number" min={0} value={soakBonus} onChange={(e) => setSoakBonus(e.target.value)} placeholder="Soak" className="w-16 bg-transparent border px-2 py-1 text-[11px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
              <input type="number" min={0} value={rangedDefense} onChange={(e) => setRangedDefense(e.target.value)} placeholder="Ranged def" title="Ranged defence" className="w-24 bg-transparent border px-2 py-1 text-[11px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
              <input type="number" min={0} value={meleeDefense} onChange={(e) => setMeleeDefense(e.target.value)} placeholder="Melee def" title="Melee defence" className="w-24 bg-transparent border px-2 py-1 text-[11px] mono-num" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
              <QualityPicker value={qualities} onChange={setQualities} />
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-36 bg-transparent border px-2 py-1 text-[11px]" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
            </>
          )}
          {category === "equipment" && (
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-44 bg-transparent border px-2 py-1 text-[11px]" style={{ borderColor: "#3a3f42", color: "#e7e2d2" }} />
          )}
          <button
            type="button"
            onClick={addManual}
            disabled={!name.trim()}
            className="text-[10px] tracking-wide uppercase px-2 py-1.5 disabled:opacity-40"
            style={{ background: "#5ec8d8", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

// Small +/- counter used anywhere an item's carried quantity needs to move
// up or down a click at a time — the GM's Field-Acquired Gear board and the
// player-facing Weapons/Inventory/Armor lists all share this same control
// (and, via itemQtyKey, the same underlying counter) so a player using up a
// grenade updates what the GM sees and vice versa.
function QtyStepper({ value, onAdjust, title }) {
  return (
    <span className="inline-flex items-center gap-1 shrink-0" title={title || "How many you're currently carrying"}>
      <button
        type="button"
        onClick={() => onAdjust(-1)}
        disabled={value <= 0}
        className="w-5 h-5 flex items-center justify-center text-[12px] border disabled:opacity-30"
        style={{ borderColor: "#3a3f42", color: "#8a8f93" }}
      >
        −
      </button>
      <span className="text-[12px] mono-num w-4 text-center" style={{ color: "#e7e2d2" }}>{value}</span>
      <button
        type="button"
        onClick={() => onAdjust(1)}
        className="w-5 h-5 flex items-center justify-center text-[12px] border"
        style={{ borderColor: "#3a3f42", color: "#8a8f93" }}
      >
        +
      </button>
    </span>
  );
}

// A long piece of reference text (an item's full "ability" description, easily
// several sentences) collapses to a short lead-in with a twisty to expand it,
// rather than either getting clipped with no way to see the rest or blowing
// out every list it appears in by default. Starts collapsed, per request.
function ExpandableText({ text, collapsedLength = 180, className, style }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const isLong = text.length > collapsedLength;
  return (
    <span className={className} style={style}>
      {open || !isLong ? text : `${text.slice(0, collapsedLength).trim()}…`}
      {isLong && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          className="ml-1.5 text-[10px] uppercase tracking-[0.08em] align-middle"
          style={{ color: "#5ec8d8" }}
        >
          {open ? "▲ Less" : "▼ More"}
        </button>
      )}
    </span>
  );
}

function GmGearRow({ item, onChange, onRemove, qty, onAdjustQty, brawn }) {
  const summary =
    item.category === "weapon" ? `${item.skill || "—"} · ${weaponDamageTotal(item.damage, brawn)}dmg · Crit ${item.crit} · ${item.range}${item.special && item.special !== "—" ? ` · ${item.special}` : ""}` :
    item.category === "armor" ? (() => {
      const def = armorDefense(item);
      return `+${item.soakBonus || 0} Soak · ${def.ranged} Ranged / ${def.melee} Melee Def${item.special ? ` · ${item.special}` : ""}`;
    })() :
    null;
  // Only weapons with Limited Ammo actually get used up one at a time — a
  // rifle or a suit of armor isn't tracked "how many", so the qty stepper
  // only shows where it's meaningful (see also the character-tab lists,
  // which apply the same rule).
  const showQty = item.category === "weapon" ? /limited ammo/i.test(item.special || "") : item.category === "equipment";
  const outOfStock = showQty && qty <= 0;
  return (
    <div className="py-1.5" style={{ borderBottom: "1px solid #2a2e3166", opacity: outOfStock ? 0.5 : 1 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[9px] uppercase tracking-[0.1em] px-1.5 py-0.5 border shrink-0" style={{ borderColor: "#3a3f42", color: "#8a8f93" }}>
          {item.category}
        </span>
        <span className="text-[12px] shrink-0" style={{ color: "#e7e2d2" }}>{item.name}</span>
        {summary && <span className="text-[10px] flex-1 min-w-[120px]" style={{ color: "#5a5f62" }}>{summary}</span>}
        {!summary && <span className="flex-1" />}
        {showQty && <QtyStepper value={qty} onAdjust={onAdjustQty} title="How many the party has picked up" />}
        <label className="flex items-center gap-1.5 text-[10px] px-2 py-1 border shrink-0" style={{ borderColor: item.hidden ? "#c9a15a" : "#3a3f42" }} title={item.hidden ? "Hidden from players — untick to reveal" : "Visible to players"}>
          <input type="checkbox" checked={!item.hidden} onChange={(e) => onChange({ ...item, hidden: !e.target.checked })} />
          <span style={{ color: item.hidden ? "#c9a15a" : "#8a8f93" }}>{item.hidden ? "Hidden" : "Revealed"}</span>
        </label>
        <button type="button" onClick={onRemove} className="text-[11px] px-1.5 shrink-0" style={{ color: "#8a8f93" }} title="Remove this item">✕</button>
      </div>
      {item.note && (
        <ExpandableText text={item.note} className="text-[11px] block mt-1" style={{ color: "#5a5f62" }} />
      )}
    </div>
  );
}

// GM page's field-acquired-gear board — one add-form + item list per
// character. Kept separate from the per-item Visibility rows further down
// (those toggle ledger.json's own starting gear); this is for things that
// were never in the ledger to begin with, so it needs its own hidden flag
// rather than the visibilityOverrides system. Quantity is separate again —
// see itemQtyKey/manual.itemQty — it's an open-write counter shared with
// whatever the character's own tab shows, so a player using up a grenade is
// reflected here too, without needing the GM key.
function GmGearBoard({ party, gearStore, manual }) {
  const { gear, save, loadState } = gearStore;
  return (
    <div className="border p-4" style={{ borderColor: "#5ec8d866", background: "#101315" }}>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-1" style={{ color: "#5ec8d8" }}>Field-Acquired Gear</div>
      <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#5a5f62" }}>
        Look up a weapon by name (fuzzy search over the reference index) or enter armor/equipment by hand — everything
        starts Hidden, so you can stage a pickup before the party's identified it, then tick Revealed when it's time.
        Revealed weapons show up on that character's Weapons list; armor shows up in their Armor section alongside
        anything from the ledger; equipment shows up in their Inventory. The count next to each item is shared live
        with the character's own tab, so players can use up their own consumables without needing the GM key.
      </p>
      {loadState.state === "error" && <p className="text-[12px] mb-3" style={{ color: "#c23b3b" }}>Couldn't reach the gear board: {loadState.msg}</p>}
      {party.map((c) => {
        const cid = c.liveId || c.name;
        const items = gear.filter((g) => g.characterId === cid);
        return (
          <div key={cid} className="mb-4 pb-4 border-b" style={{ borderColor: "#2a2e31" }}>
            <div className="text-[13px] mb-2" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>{c.name}</div>
            <GmGearAddForm characterId={cid} onAdd={(item) => save([...gear, item])} />
            {items.length === 0 ? (
              <span className="text-[11px]" style={{ color: "#5a5f62" }}>Nothing added yet.</span>
            ) : (
              items.map((item) => (
                <GmGearRow
                  key={item.id}
                  item={item}
                  qty={manual.qtyOf(itemQtyKey(cid, item, item.category))}
                  onAdjustQty={(d) => manual.adjustQty(itemQtyKey(cid, item, item.category), d)}
                  onChange={(next) => save(gear.map((g) => (g.id === item.id ? next : g)))}
                  onRemove={() => save(gear.filter((g) => g.id !== item.id))}
                  brawn={c.characteristics?.brawn}
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

// Typeahead search box for the adversary index — starts typing, shows the
// best fuzzy matches, Enter or click adds the picked adversary straight
// onto the enemy board. Loads the (fairly large, ~120KB) index lazily on
// first focus rather than on every GM-page load.
function EnemyLookup({ onPick }) {
  const { index, loadState, load } = useAdversaryIndex();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const boxRef = useRef(null);

  const results = useMemo(() => {
    if (!index || !query.trim()) return [];
    const scored = [];
    for (const entry of index) {
      const score = fuzzyMatch(query, entry.name);
      if (score !== null) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 12).map((s) => s.entry);
  }, [index, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    function onOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  function pick(entry) {
    onPick(enemyFromAdversary(entry));
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e) {
    if (!open || !results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(results[activeIdx]); }
    else if (e.key === "Escape") { setOpen(false); }
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        value={query}
        onFocus={load}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
        placeholder={loadState.state === "loading" ? "Loading adversaries…" : "Look up an adversary…"}
        className="w-72 max-w-full bg-transparent border px-2 py-1.5 text-[12px]"
        style={{ borderColor: "#5ec8d866", color: "#e7e2d2" }}
        title="Fuzzy-search the reference adversary index (1,431 stat blocks) and add one as a new enemy"
      />
      {loadState.state === "error" && (
        <div className="absolute z-10 mt-1 text-[10px] px-2 py-1" style={{ color: "#c23b3b", background: "#101315", border: "1px solid #3a3f42" }}>
          Couldn't load the adversary index: {loadState.msg}
        </div>
      )}
      {open && query.trim() && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-[min(38rem,calc(100vw-2rem))] max-h-96 overflow-y-auto" style={{ background: "#101315", border: "1px solid #3a3f42" }}>
          {results.map((entry, i) => (
            <button
              key={entry.name}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(entry)}
              className="w-full text-left px-3 py-2 flex items-start justify-between gap-3 text-[11px]"
              style={{ background: i === activeIdx ? "#1a1f22" : "transparent", color: "#e7e2d2" }}
            >
              <span className="whitespace-normal break-words leading-snug">{entry.name}</span>
              <span className="text-[9px] uppercase tracking-[0.1em] shrink-0 whitespace-normal text-right max-w-[45%] leading-snug" style={{ color: "#8a8f93" }}>
                {entry.type} · {entry.wounds}w · {entry.soak}s
              </span>
            </button>
          ))}
        </div>
      )}
      {open && query.trim() && index && results.length === 0 && (
        <div className="absolute z-10 mt-1 w-72 px-2.5 py-1.5 text-[11px]" style={{ background: "#101315", border: "1px solid #3a3f42", color: "#5a5f62" }}>
          No matches in the reference index.
        </div>
      )}
    </div>
  );
}

// GM page's enemy board editor — "Only GM can manipulate enemies" is
// enforced server-side (see /gm/enemies requiring the GM key), not just by
// this component only being reachable from the signed-in GM page.
function GmEnemyBoard({ enemyStore }) {
  const { enemies, save, loadState } = enemyStore;
  return (
    <div className="border p-4" style={{ borderColor: "#3a3f4266", background: "#101315" }}>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#e0763a" }}>Enemy Board</div>
        <div className="flex items-center gap-2 flex-wrap">
          <EnemyLookup onPick={(enemy) => save([...enemies, enemy])} />
          <button
            type="button"
            onClick={() => save(enemies.map((e) => ({ ...e, hidden: false })))}
            className="text-[10px] tracking-[0.1em] uppercase px-2.5 py-1 border"
            style={{ borderColor: "#c9a15a66", color: "#c9a15a", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
            title="Reveal every hidden enemy at once"
          >
            Reveal all
          </button>
          <button
            type="button"
            onClick={() => save([...enemies, newEnemy()])}
            className="text-[11px] tracking-wide uppercase px-3 py-1.5"
            style={{ background: "#e0763a", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
          >
            + Add enemy
          </button>
        </div>
      </div>
      {loadState.state === "error" && <p className="text-[12px] mb-3" style={{ color: "#c23b3b" }}>Couldn't reach the enemy board: {loadState.msg}</p>}
      {enemies.length === 0 ? (
        <span className="text-[12px]" style={{ color: "#5a5f62" }}>No enemies on the board yet.</span>
      ) : (
        enemies.map((e, i) => (
          <GmEnemyRow
            key={e.id}
            enemy={e}
            onChange={(next) => save(enemies.map((x, idx) => (idx === i ? next : x)))}
            onRemove={() => save(enemies.filter((_, idx) => idx !== i))}
            onDuplicate={() => save([...enemies.slice(0, i + 1), { ...e, id: crypto.randomUUID() }, ...enemies.slice(i + 1)])}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Battle map — zone-based rather than a fixed grid. The GM builds whatever
// shape a scene needs by adding/removing zone cells one at a time; each zone
// carries its own faint 4x4 sub-grid for placing tokens precisely within it.
// Backed by /map + /gm/map (see worker/index.js's ZoneMapLog) — enemy tokens
// and zone add/remove require the GM key server-side; PC tokens are open to
// anyone at the table.
// ---------------------------------------------------------------------------
const MAP_POLL_MS = 2000;
const MAP_DIRTY_MS = 2000;
// A zone cell's footprint (matches the 4x4 sub-grid box drawn in ZoneCell) —
// pulled out to a constant so the Distant ring below can size and
// position themselves against exactly the same unit.
const ZONE_SIZE = 165;
// The "add a zone here" button's diameter — small and docked right on the
// seam between an empty cell and whichever existing zone it borders, rather
// than a large button floating in the middle of unused space.
const EDGE_BTN = 26;

// "Distant" ring — one continuous band enclosing the whole battle map, for
// tokens that are "out there, too far away to matter yet" (a raider closing
// from the east, reinforcements inbound from the north) rather than sitting
// in an actual zone. It lives in board coordinate space alongside the zones,
// so it pans/zooms with the map and grows outward the moment a zone is added.
// The band has no squares of its own: clicking (or dropping a dragged token)
// anywhere on it parks the token at the nearest of DISTANT_SLOTS evenly
// spaced points along that side. Storage is unchanged from the old compass
// boxes — a parked token carries `compass` (N/E/S/W) + `cs` (0-4), handled
// server-side in worker/index.js's ZoneMapLog — so existing maps keep
// working; a token still parked in a retired corner box (NE/SE/SW/NW) is
// shown at the nearer end of the top or bottom side.
const DISTANT_GAP_PX = 30; // clear space between the zones and the band's inner edge
const DISTANT_BAND_PX = 24; // matches the shaded Distant label so the band reads as one clean strip
const DISTANT_SLOTS = 5; // snap points per side (the worker accepts cs 0-4)
const DISTANT_TOKEN_PX = 34;
// Dark ochre/black hazard stripes for the band (muted so it isn't glaring).
const DISTANT_STRIPES = "repeating-linear-gradient(45deg, #6e5d1c 0px, #6e5d1c 12px, #15181a 12px, #15181a 24px)";
const DISTANT_LEGACY_CORNER = { NW: ["N", 0], NE: ["N", DISTANT_SLOTS - 1], SW: ["S", 0], SE: ["S", DISTANT_SLOTS - 1] };

// Default/reset shape: a 3x3 block of zones rather than a single square, so
// there's room to place the whole party plus several enemies without the
// GM having to add zones before a scene even starts.
const DEFAULT_ZONES = Array.from({ length: 3 }, (_, y) => Array.from({ length: 3 }, (_, x) => ({ x, y }))).flat();

function useZoneMapStore(gmKey) {
  const [zones, setZones] = useState(DEFAULT_ZONES);
  const [tokens, setTokens] = useState({});
  const [loadState, setLoadState] = useState({ state: "loading" });
  const dirtyUntil = useRef(0);
  const pollTimer = useRef(null);
  const keyRef = useRef(gmKey);
  useEffect(() => { keyRef.current = gmKey; }, [gmKey]);

  const fetchMap = useCallback(async () => {
    const key = keyRef.current;
    try {
      const res = await apiFetch(`${key ? "/gm/map" : "/map"}?_=${Date.now()}`, { cache: "no-store", headers: key ? { "x-gm-key": key } : {} });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (Date.now() < dirtyUntil.current) return;
      setZones(Array.isArray(data.zones) && data.zones.length ? data.zones : DEFAULT_ZONES);
      setTokens(data.tokens || {});
      setLoadState({ state: "ok" });
    } catch (err) {
      setLoadState({ state: "error", msg: err.message });
    }
  }, []);

  useEffect(() => {
    fetchMap();
    pollTimer.current = setInterval(fetchMap, MAP_POLL_MS);
    return () => clearInterval(pollTimer.current);
  }, [fetchMap, gmKey]);

  const post = useCallback(async (body) => {
    const key = keyRef.current;
    dirtyUntil.current = Date.now() + MAP_DIRTY_MS;
    try {
      const res = await apiFetch(key ? "/gm/map" : "/map", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "x-gm-key": key } : {}) },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (data?.zones) setZones(data.zones);
      if (data?.tokens) setTokens(data.tokens);
    } catch {
      /* best-effort; the next poll after the dirty window reconciles */
    }
  }, []);

  const moveToken = useCallback((id, zx, zy, sx, sy) => {
    setTokens((prev) => ({ ...prev, [id]: { zx, zy, sx, sy } }));
    post({ id, zx, zy, sx, sy });
  }, [post]);

  // Parks a token on one side of the Distant ring around the zone grid —
  // "out there, that direction, too distant to matter right now" — rather
  // than in an actual zone. `slot` (0-4) picks which of that side's 5 snap
  // points it lands on. See DISTANT_SLOTS and the compass handling in
  // worker/index.js.
  const setCompass = useCallback((id, dir, slot) => {
    setTokens((prev) => ({ ...prev, [id]: { compass: dir, cs: slot } }));
    post({ id, compass: dir, cs: slot });
  }, [post]);

  const removeToken = useCallback((id) => {
    setTokens((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    post({ id, off: true });
  }, [post]);

  const addZone = useCallback((x, y) => {
    setZones((prev) => (prev.some((z) => z.x === x && z.y === y) ? prev : [...prev, { x, y }]));
    post({ addZone: { x, y } });
  }, [post]);

  const removeZone = useCallback((x, y) => {
    setZones((prev) => (prev.length > 1 ? prev.filter((z) => !(z.x === x && z.y === y)) : prev));
    post({ removeZone: { x, y } });
  }, [post]);

  // Wipes every token and every zone back to the starting 3x3 block — GM-only,
  // enforced server-side.
  const resetMap = useCallback(() => {
    setZones(DEFAULT_ZONES);
    setTokens({});
    post({ reset: true });
  }, [post]);

  return { zones, tokens, moveToken, setCompass, removeToken, addZone, removeZone, resetMap, loadState };
}

// The open cells around the whole occupied shape where a GM's "+" button can
// add the next zone, deduped, each carrying which of ITS OWN borders
// actually touch an existing zone (there can be more than one at a concave
// corner). That lets the button hug the real seam between the two cells
// instead of floating in the middle of empty space. Diagonals don't count as
// adjacency; only up/down/left/right, same as every other zone-based range
// convention this ruleset uses.
const EDGE_NEIGHBORS = [
  { dx: 0, dy: -1, edge: "bottom" }, // candidate sits above an existing zone -> shares its own bottom edge
  { dx: 0, dy: 1, edge: "top" },     // candidate sits below an existing zone -> shares its own top edge
  { dx: -1, dy: 0, edge: "right" },  // candidate sits left of an existing zone -> shares its own right edge
  { dx: 1, dy: 0, edge: "left" },    // candidate sits right of an existing zone -> shares its own left edge
];
function openEdgeCells(zones) {
  const occupied = new Set(zones.map((z) => `${z.x},${z.y}`));
  const byKey = new Map();
  zones.forEach((z) => {
    EDGE_NEIGHBORS.forEach(({ dx, dy, edge }) => {
      const x = z.x + dx, y = z.y + dy;
      const key = `${x},${y}`;
      if (occupied.has(key)) return;
      if (!byKey.has(key)) byKey.set(key, { x, y, edges: [] });
      const entry = byKey.get(key);
      if (!entry.edges.includes(edge)) entry.edges.push(edge);
    });
  });
  return [...byKey.values()];
}

function ZoneCell({ zone, tokensHere, selected, onSelectSubcell, onSelectToken, onPressToken, onContextToken, canDrag, draggingId, dropTarget, canEditZones, onRemoveZone, onHoverToken }) {
  return (
    <div
      className="relative"
      style={{ border: "3px solid #5ec8d8", background: "#0d1012", width: ZONE_SIZE, height: ZONE_SIZE }}
      title={`Zone ${zone.x},${zone.y}`}
    >
      {canEditZones && (
        <button
          type="button"
          onClick={() => onRemoveZone(zone.x, zone.y)}
          className="absolute -top-2.5 -right-2.5 w-5 h-5 flex items-center justify-center text-[11px] z-10"
          style={{ background: "#c23b3b", color: "#101315", borderRadius: "50%" }}
          title="Remove this zone"
        >
          ✕
        </button>
      )}
      <div className="grid absolute inset-1" style={{ gridTemplateColumns: "repeat(4, 1fr)", gridTemplateRows: "repeat(4, 1fr)" }}>
        {Array.from({ length: 16 }, (_, i) => {
          const sx = i % 4, sy = Math.floor(i / 4);
          const here = tokensHere.filter((t) => t.sx === sx && t.sy === sy);
          // Drop preview: the square a dragged token will land on if released.
          const dropHere = dropTarget?.type === "zone" && dropTarget.zx === zone.x && dropTarget.zy === zone.y && dropTarget.sx === sx && dropTarget.sy === sy;
          return (
            <button
              key={i}
              type="button"
              data-drop-zone={`${zone.x},${zone.y},${sx},${sy}`}
              onClick={() => onSelectSubcell(zone.x, zone.y, sx, sy)}
              className="relative"
              style={{
                border: `1px solid ${dropHere ? "#ffb000" : "#23282b"}`,
                background: dropHere ? "#ffb00033" : "transparent",
                boxShadow: dropHere ? "inset 0 0 8px #ffb00066" : "none",
                padding: 0, margin: 0, appearance: "none", WebkitAppearance: "none",
              }}
              title={`${zone.x},${zone.y} · ${sx + 1},${sy + 1}`}
            >
              {here.map((t, hi) => (
                <MapToken
                  key={t.id}
                  token={t}
                  selected={selected === t.id}
                  onClick={() => onSelectToken(t.id)}
                  onContextMenu={(event) => onContextToken && onContextToken(t, event)}
                  draggable={canDrag ? canDrag(t.id) : false}
                  onPointerDown={onPressToken && onPressToken(t.id)}
                  dragging={draggingId === t.id}
                  onHoverStart={() => onHoverToken && onHoverToken(t)}
                  onHoverEnd={() => onHoverToken && onHoverToken(null)}
                  stackOffset={hi}
                />
              ))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// How far the pointer has to travel before a press on a token becomes a drag
// rather than a click. Small enough that a drag feels immediate, big enough
// that a slightly shaky click still just picks the token up.
const DRAG_THRESHOLD_PX = 5;

// One token on the battle map. Dragging is pointer-driven (see BattleMapPanel)
// rather than the browser's native drag-and-drop, so the board can show a
// token following the pointer and a highlight on exactly where it'll land.
// Hovering shows the token's full name straight away in a small label — the
// native title tooltip takes a second to appear, which is too slow when
// you're scanning a board.
function MapToken({ token, selected, onClick, onContextMenu, draggable = false, onPointerDown, dragging = false, onHoverStart, onHoverEnd, size = "full", stackOffset = 0, labelBelow = false }) {
  const [hover, setHover] = useState(false);
  const full = size === "full";
  const aliveMinions = Math.max(0, Number(token.aliveMinions) || 0);
  const pipSize = full ? (aliveMinions > 10 ? 4 : 6) : (aliveMinions > 10 ? 2 : 3);
  const pipColumns = full && aliveMinions > 10 ? Math.min(7, aliveMinions) : Math.min(5, aliveMinions);
  const pipRows = pipColumns ? Math.ceil(aliveMinions / pipColumns) : 0;
  const pipBlockHeight = pipRows ? pipRows * pipSize + (pipRows - 1) : 0;
  const color = token.kind === "pc" ? "#3b82c2" : "#c23b3b";
  return (
    <button
      type="button"
      onPointerDown={draggable ? onPointerDown : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e); } : undefined}
      onMouseEnter={() => { setHover(true); onHoverStart && onHoverStart(); }}
      onMouseLeave={() => { setHover(false); onHoverEnd && onHoverEnd(); }}
      aria-label={`${token.label}${token.aliveMinions != null ? ` — ${token.aliveMinions} minions alive` : ""}${token.down ? " (down)" : ""}${token.hidden ? " — hidden from players" : ""}`}
      className={`${full ? "absolute inset-0.5" : "px-2 py-1 relative whitespace-nowrap"} flex items-center justify-center`}
      style={{
        background: token.down ? `${color}66` : color,
        color: "#101315",
        opacity: dragging ? 0.3 : 1,
        border: selected ? "2px solid #ffb000" : token.hidden ? "2px dashed #ffb000" : "2px solid transparent",
        boxShadow: selected ? "0 0 12px #ffb00088" : hover ? `0 0 10px ${color}aa` : "none",
        fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
        fontSize: full ? 18 : 12,
        borderRadius: full && token.kind === "pc" ? "50%" : 3,
        zIndex: hover ? 20 : 5 + stackOffset,
        transform: stackOffset ? `translate(${stackOffset * 2}px, ${stackOffset * 2}px)` : undefined,
        cursor: draggable ? "grab" : undefined,
        touchAction: draggable ? "none" : undefined,
        transition: "box-shadow 0.15s, opacity 0.15s, background 0.15s",
      }}
    >
      <span style={{ ...(full ? { position: "absolute", left: 2, right: 2, top: 2, bottom: aliveMinions > 0 ? pipBlockHeight + 3 : 2, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 } : { paddingBottom: aliveMinions > 0 ? pipBlockHeight + 1 : 0 }), opacity: token.down ? 0.4 : 1 }}>{full ? tokenInitials(token.label, token.kind) : token.label || "Unnamed"}</span>
      {aliveMinions > 0 && (
        <span className="absolute pointer-events-none grid justify-center" aria-hidden="true" style={{ bottom: 1, left: 0, right: 0, gap: 1, gridTemplateColumns: "repeat(" + pipColumns + ", max-content)", opacity: token.down ? 0.4 : 1 }}>
          {Array.from({ length: aliveMinions }, (_, index) => <span key={index} data-minion-dot="" style={{ width: pipSize, height: pipSize, borderRadius: "50%", background: "#f5f3ea", boxShadow: "0 0 1px #101315" }} />)}
        </span>
      )}
      {full && hover && !dragging && (
        <span
          className="absolute pointer-events-none whitespace-nowrap text-[12px] px-2 py-0.5"
          style={{
            left: "50%",
            transform: "translateX(-50%)",
            ...(labelBelow ? { top: "calc(100% + 6px)" } : { bottom: "calc(100% + 6px)" }),
            background: "#101315",
            color: "#e7e2d2",
            border: `1px solid ${color}88`,
            borderRadius: 0,
            boxShadow: "0 6px 16px rgba(0,0,0,0.6)",
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 600,
            zIndex: 30,
          }}
        >
          {token.aliveMinions != null ? `${token.aliveMinions} x ${token.label || "Unnamed"}` : token.label || "Unnamed"}
          {token.down && <span style={{ color: "#5a5f62" }}> · down</span>}
          {token.hidden && <span style={{ color: "#ffb000" }}> · hidden</span>}
        </span>
      )}
    </button>
  );
}

// Map-token abbreviation. Enemies: first initial + the final number in the
// name, ignoring a leading "The" ("BX-7 Security Droid 42" -> "B42"); with
// no number, the first two initials instead ("Imperial Scout" -> "IS").
// Friendly (PC) tokens: first initial + last initial, skipping
// a quoted nickname ('Kennaud "Kenno" Thorn' -> "KT"; one-word names -> "V").
function tokenInitials(name, kind = "enemy") {
  const raw = String(name || "").trim();
  let words = raw.split(/\s+/).filter((w) => w && !/^["“'‘].*["”'’]$/.test(w));
  const letter = (w) => ((w.match(/[A-Za-z0-9]/) || ["?"])[0]).toUpperCase();
  if (kind !== "pc" && words.length > 1 && /^the$/i.test(words[0])) words = words.slice(1);
  if (!words.length) return "??";
  if (kind === "pc") return words.length === 1 ? letter(words[0]) : letter(words[0]) + letter(words[words.length - 1]);
  const numbers = raw.match(/\d+/g);
  if (numbers?.length) return letter(words[0]) + numbers[numbers.length - 1];
  return words.length > 1 ? letter(words[0]) + letter(words[1]) : letter(words[0]);
}

// Canvas zoom range for the battle map — a plain CSS transform: scale() on
// the whole absolutely-positioned board, rather than touching the pixel
// math that lays out zones/sub-cells/edge buttons. Kept local to each
// browser (not synced through the map store) since it's a personal viewing
// preference, not shared session state.
const MAP_ZOOM_MIN = 0.5;
const MAP_ZOOM_MAX = 1.75;
const MAP_ZOOM_STEP = 0.05;

function BattleSession({ roster, enemyStore, mapStore, isGm, gmKey, manual, initiative, partyDestiny }) {
  const rollState = useRollLog();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-stretch">
        <div className="min-w-0">
          {isGm ? <GmInitiativeEditor initiative={initiative} onChange={manual.setInitiative} playerNames={roster.map((member) => member.name)} fill hideEmptyMessage /> : (
            initiative?.order?.length ? <InitiativeTracker initiative={initiative} fill /> : <div className="border p-4 text-[12px] h-full" style={{ borderColor: "#3a3f42", color: "#8a8f93" }}>Initiative has not been set.</div>
          )}
        </div>
        <div className="border p-4 h-full" style={{ borderColor: "#ffb00055", background: "#16191b" }}>
          <div className="text-[11px] tracking-[0.2em] uppercase mb-3" style={{ color: "#ffb000" }}><DestinyRulesTip>Party Destiny Pool</DestinyRulesTip></div>
          {partyDestiny ? (
            <div className="flex items-end gap-5 flex-wrap">
              <div className="grid grid-cols-2 flex-1 min-w-[220px] max-w-[420px]" data-centred-destiny-pool="1">
                <div className="pr-2 text-right border-r" style={{ borderColor: "#3a3f42" }}>
                  <DestinyTokens count={partyDestiny.light} src={BLUE_TOKEN} alt="Light Side Destiny Point" onFlip={() => manual.flipDestiny("light")} />
                  <span className="block text-[11px] leading-none mt-1" style={{ color: "#8a8f93" }}>Light</span>
                </div>
                <div className="pl-2 text-left">
                  <DestinyTokens count={partyDestiny.dark} src={RED_TOKEN} alt="Dark Side Destiny Point" onFlip={() => manual.flipDestiny("dark")} />
                  <span className="block text-[11px] leading-none mt-1" style={{ color: "#8a8f93" }}>Dark</span>
                </div>
              </div>
              {isGm && <GmDestinyCountControls destiny={partyDestiny} onSet={manual.setDestiny} />}
            </div>
          ) : <span className="text-[12px]" style={{ color: "#8a8f93" }}>Destiny pool unavailable.</span>}
        </div>
      </div>
      <SharedDicePoolTray pools={rollState.sharedPools} logStatus={rollState.logStatus} onRefresh={rollState.fetchLog} />
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(300px,420px)] gap-4 items-start">
        <div className="min-w-0 space-y-4">
          <BattleMapPanel roster={roster} enemies={enemyStore.enemies} party={roster} isGm={isGm} mapStore={mapStore} onSaveEnemies={enemyStore.save} />
          {isGm && <GmEnemyBoard enemyStore={enemyStore} />}
        </div>
        <div className="min-w-0 space-y-4">
          <BattleRollLog rollState={rollState} />
          <EnemyPanel enemies={enemyStore.enemies} loadState={enemyStore.loadState} isGm={isGm} onSave={isGm ? enemyStore.save : undefined} />
        </div>
      </div>
      {isGm && <EnemyBulkEntry enemyStore={enemyStore} />}
    </div>
  );
}

function BattleRollLog({ rollState }) {
  return <div className="border p-4" style={{ borderColor: "#3a3f42", background: "#16191b" }}><SharedRollLog {...rollState} allowClear={false} maxEntries={3} /></div>;
}


function BattleMapPanel({ roster, enemies, party, isGm, mapStore, onSaveEnemies }) {
  const { zones, tokens, moveToken, setCompass, removeToken, addZone, removeZone, resetMap, loadState } = mapStore;
  const [selected, setSelected] = useState(null);
  // The token currently under the pointer (zone subcell or Distant ring),
  // shown in the status line below as "Hovering X" — see MapToken's
  // onHoverStart/onHoverEnd. Cleared on mouse-leave, not sticky like
  // `selected`.
  const [hoveredToken, setHoveredToken] = useState(null);
  const [damagePrompt, setDamagePrompt] = useState(null);
  const [damageDraft, setDamageDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const damageEnemy = damagePrompt ? enemies.find((enemy) => enemy.id === damagePrompt.enemyId) : null;
  const damageRaw = Math.max(0, Math.round(Number(damageDraft)) || 0);
  const damagePreview = damageEnemy ? Math.max(0, damageRaw - (damageEnemy.soak || 0)) : 0;
  const [mapZoom, setMapZoom] = useState(1);
  const scrollRef = useRef(null);
  // Auto-centering should set the DEFAULT view, not fight the GM's own
  // scrolling — see the effect below. This latches true after that first
  // centering so later token movement never snaps the view back; a map
  // reset clears it so the fresh 3x3 board gets its own default center.
  const hasCenteredRef = useRef(false);

  function openEnemyDamage(token, event) {
    if (!isGm || token.kind !== "enemy") return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(null);
    setDamageDraft("");
    const enemy = enemies.find((e) => e.id === token.id);
    setNameDraft(enemy?.name || "");
    setDamagePrompt({
      enemyId: token.id,
      x: Math.max(12, Math.min(event.clientX + 8, window.innerWidth - 262)),
      y: Math.max(12, Math.min(event.clientY + 8, window.innerHeight - 340)),
    });
  }

  function closeEnemyDamage() {
    setDamagePrompt(null);
    setDamageDraft("");
    setNameDraft("");
  }

  // Right-click menu on an enemy token: rename it, reveal/hide it, and/or
  // apply damage. Renaming edits the enemy itself, so the new name shows on
  // the token, the enemy board and the Enemies panel alike.
  function applyEnemyDamage(event) {
    event.preventDefault();
    if (!damageEnemy || !onSaveEnemies) return;
    const name = nameDraft.trim().slice(0, 60);
    onSaveEnemies(enemies.map((enemy) => enemy.id === damageEnemy.id
      ? { ...enemy, name: name || enemy.name, wounds: Math.max(0, (enemy.wounds || 0) + damagePreview) }
      : enemy));
    closeEnemyDamage();
  }

  function toggleEnemyHidden() {
    if (!damageEnemy || !onSaveEnemies) return;
    onSaveEnemies(enemies.map((enemy) => enemy.id === damageEnemy.id ? { ...enemy, hidden: !enemy.hidden } : enemy));
  }

  function handleResetMap() {
    if (!window.confirm("Reset the battle map? This removes every token and every zone, leaving a starting 3x3 block. This can't be undone.")) return;
    setSelected(null);
    hasCenteredRef.current = false;
    resetMap();
  }

  const cast = useMemo(() => {
    const pcs = roster.map((r) => ({ id: r.liveId || r.name, kind: "pc", label: r.name || r.liveId, down: false, hidden: false }));
    const foes = enemies
      .filter((e) => isGm || !e.hidden)
      .map((e) => ({ id: e.id, kind: "enemy", label: e.name || "Unnamed", down: enemyDefeated(e), hidden: !!e.hidden, aliveMinions: e.type === "minion" ? minionsRemaining(e) : null }));
    return [...pcs, ...foes];
  }, [roster, enemies, isGm]);

  const byId = useMemo(() => Object.fromEntries(cast.map((t) => [t.id, t])), [cast]);
  const tokensByZone = useMemo(() => {
    const grid = {};
    Object.entries(tokens).forEach(([id, pos]) => {
      if (!byId[id] || pos.compass) return;
      const key = `${pos.zx},${pos.zy}`;
      (grid[key] ||= []).push({ ...byId[id], ...pos });
    });
    return grid;
  }, [tokens, byId]);
  // Tokens parked in the Distant ring (see DISTANT_SLOTS) rather than an actual
  // zone — grouped by direction; which of the box's 5 slots a token sits on
  // (its `cs` field) is filtered at render time.
  const tokensByCompass = useMemo(() => {
    const grid = {};
    Object.entries(tokens).forEach(([id, pos]) => {
      if (!byId[id] || !pos.compass) return;
      (grid[pos.compass] ||= []).push({ ...byId[id], ...pos });
    });
    return grid;
  }, [tokens, byId]);
  const offBoard = cast.filter((t) => !tokens[t.id]);

  const edges = useMemo(() => openEdgeCells(zones), [zones]);

  // The zone grid is positioned with absolute pixel offsets keyed off each
  // zone's own (x,y), which can run negative — that only works if the
  // wrapping div has an explicit size and an origin shifted to cover the
  // whole occupied + edge-cell area. Without this, a `position: relative`
  // parent whose only children are `position: absolute` collapses to zero
  // height, and the map effectively vanishes (reported as "all white").
  const CELL = 171;
  const bounds = useMemo(() => {
    const coords = [...zones, ...edges];
    if (coords.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    return {
      minX: Math.min(...coords.map((c) => c.x)),
      maxX: Math.max(...coords.map((c) => c.x)),
      minY: Math.min(...coords.map((c) => c.y)),
      maxY: Math.max(...coords.map((c) => c.y)),
    };
  }, [zones, edges]);
  // `bounds` extends a cell past the zones on every open side for the "add
  // a zone" ring — plenty of spare canvas for the compass groups to sit in
  // too, so the board canvas itself needs no extra margin for them.
  const originX = -bounds.minX * CELL + 20;
  const originY = -bounds.minY * CELL + 20;
  const boardWidth = (bounds.maxX - bounds.minX + 1) * CELL + 40;
  const boardHeight = (bounds.maxY - bounds.minY + 1) * CELL + 40;

  // Zones' own tight bounding box — no edge-ring padding included. The
  // compass groups' gap is measured from the zone grid's actual visual
  // border (this), not from the wider edges-inclusive `bounds` above, so it
  // reads as one small, uniform gap regardless of how the "add a zone" ring
  // happens to be shaped around the board.
  const zoneBounds = useMemo(() => {
    if (!zones.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    return {
      minX: Math.min(...zones.map((z) => z.x)),
      maxX: Math.max(...zones.map((z) => z.x)),
      minY: Math.min(...zones.map((z) => z.y)),
      maxY: Math.max(...zones.map((z) => z.y)),
    };
  }, [zones]);

  // The Distant ring's geometry: the zones' tight bounding box, pushed out
  // by DISTANT_GAP_PX (inner edge), then DISTANT_BAND_PX more (outer edge).
  // Top/bottom sides run the full outer width (corners included) and
  // left/right fill the height between them, so the band is one seamless
  // frame.
  const ring = useMemo(() => {
    const iL = zoneBounds.minX * CELL + originX - DISTANT_GAP_PX;
    const iR = zoneBounds.maxX * CELL + originX + ZONE_SIZE + DISTANT_GAP_PX;
    const iT = zoneBounds.minY * CELL + originY - DISTANT_GAP_PX;
    const iB = zoneBounds.maxY * CELL + originY + ZONE_SIZE + DISTANT_GAP_PX;
    const oL = iL - DISTANT_BAND_PX, oR = iR + DISTANT_BAND_PX;
    const oT = iT - DISTANT_BAND_PX, oB = iB + DISTANT_BAND_PX;
    return {
      inner: { left: iL, top: iT, width: iR - iL, height: iB - iT },
      outer: { left: oL, top: oT, width: oR - oL, height: oB - oT },
      sides: {
        N: { left: oL, top: oT, width: oR - oL, height: DISTANT_BAND_PX, horiz: true },
        S: { left: oL, top: iB, width: oR - oL, height: DISTANT_BAND_PX, horiz: true },
        W: { left: oL, top: iT, width: DISTANT_BAND_PX, height: iB - iT, horiz: false },
        E: { left: iR, top: iT, width: DISTANT_BAND_PX, height: iB - iT, horiz: false },
      },
    };
  }, [zoneBounds, originX, originY]);
  // Which snap point along a side a click/drop landed nearest to.
  function distantSlotAt(side, e) {
    const r = e.currentTarget.getBoundingClientRect();
    const f = side.horiz ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    return Math.max(0, Math.min(DISTANT_SLOTS - 1, Math.floor(f * DISTANT_SLOTS)));
  }
  // Parked tokens grouped by side and snap point (retired corner boxes
  // folded onto the nearest side end — see DISTANT_LEGACY_CORNER).
  const distantBySlot = useMemo(() => {
    const out = {};
    Object.values(tokensByCompass).flat().forEach((t) => {
      let dir = t.compass;
      let slot = Math.max(0, Math.min(DISTANT_SLOTS - 1, t.cs || 0));
      if (DISTANT_LEGACY_CORNER[dir]) [dir, slot] = DISTANT_LEGACY_CORNER[dir];
      (out[`${dir}:${slot}`] ||= []).push(t);
    });
    return out;
  }, [tokensByCompass]);

  function canMove(id) {
    const t = byId[id];
    return t?.kind === "pc" || isGm;
  }

  // Pointer-driven drag (ported from the DCC dashboard's battle map).
  // `pendingRef` is a press that hasn't moved far enough to count yet;
  // `drag` is a drag in progress: which token, where the pointer is, and
  // what it's over (a zone square, a spot on the Distant band, the
  // off-the-map tray, or nothing). Drop targets are found by hit-testing
  // the elements under the pointer for data-drop-* markers, so this works
  // unchanged at any zoom level.
  const [drag, setDrag] = useState(null);
  const pendingRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);

  function dropTargetAt(clientX, clientY) {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const d = el.dataset || {};
      if (d.dropZone) {
        const [zx, zy, sx, sy] = d.dropZone.split(",").map(Number);
        return { type: "zone", zx, zy, sx, sy };
      }
      if (d.dropDistant) {
        const side = ring.sides[d.dropDistant];
        const r = el.getBoundingClientRect();
        const f = side.horiz ? (clientX - r.left) / r.width : (clientY - r.top) / r.height;
        return { type: "distant", dir: d.dropDistant, slot: Math.max(0, Math.min(DISTANT_SLOTS - 1, Math.floor(f * DISTANT_SLOTS))) };
      }
      if (d.dropTray) return { type: "tray" };
    }
    return null;
  }

  // Window-level listeners, so a drag keeps tracking when the pointer
  // leaves the token it started on.
  useEffect(() => {
    function onMoveEvt(e) {
      const pnd = pendingRef.current;
      if (!pnd) return;
      if (!dragRef.current) {
        if (Math.hypot(e.clientX - pnd.startX, e.clientY - pnd.startY) < DRAG_THRESHOLD_PX) return;
        setSelected(null);
      }
      const next = { id: pnd.id, clientX: e.clientX, clientY: e.clientY, target: dropTargetAt(e.clientX, e.clientY) };
      dragRef.current = next;
      setDrag(next);
    }
    function onUp() {
      const pnd = pendingRef.current;
      const dr = dragRef.current;
      pendingRef.current = null;
      dragRef.current = null;
      if (!pnd || !dr) {
        setDrag(null);
        return;
      }
      // The release ends in a click on whatever is under the pointer; that
      // click mustn't also count as picking something up or placing it.
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
      const t = dr.target;
      if (t?.type === "zone") moveToken(dr.id, t.zx, t.zy, t.sx, t.sy);
      else if (t?.type === "distant") setCompass(dr.id, t.dir, t.slot);
      else if (t?.type === "tray" && tokens[dr.id]) removeToken(dr.id);
      setDrag(null);
    }
    window.addEventListener("pointermove", onMoveEvt);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMoveEvt);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  });

  const startPress = (id) => (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (!canMove(id)) return;
    pendingRef.current = { id, startX: e.clientX, startY: e.clientY };
  };
  const clickToken = (id) => {
    if (suppressClickRef.current) return;
    setSelected(id === selected ? null : id);
  };
  const dragToken = drag ? byId[drag.id] : null;

  function placeAt(zx, zy, sx, sy) {
    if (suppressClickRef.current) return;
    if (!selected) return;
    if (!canMove(selected)) return;
    moveToken(selected, zx, zy, sx, sy);
    setSelected(null);
  }

  function placeCompass(dir, slot) {
    if (suppressClickRef.current) return;
    if (!selected) return;
    if (!canMove(selected)) return;
    setCompass(selected, dir, slot);
    setSelected(null);
  }

  // Auto-centring: the map should default to showing wherever the tokens
  // actually are, rather than always the top-left corner of the zone grid —
  // that's where most of the action will be. Centres on the bounding box of
  // occupied zones (falling back to the whole board if nothing's placed yet)
  // — but only for the very first render (see hasCenteredRef below); it's
  // the default starting position, not a leash that keeps dragging the view
  // back every time a token moves.
  const occupiedCenter = useMemo(() => {
    const zoneKeys = Object.keys(tokensByZone);
    const coords = zoneKeys.length
      ? zoneKeys.map((k) => {
          const [x, y] = k.split(",").map(Number);
          return { x, y };
        })
      : zones;
    if (!coords.length) return null;
    const minX = Math.min(...coords.map((c) => c.x));
    const maxX = Math.max(...coords.map((c) => c.x));
    const minY = Math.min(...coords.map((c) => c.y));
    const maxY = Math.max(...coords.map((c) => c.y));
    return {
      x: ((minX + maxX + 1) / 2) * CELL + originX,
      y: ((minY + maxY + 1) / 2) * CELL + originY,
    };
  }, [tokensByZone, zones, originX, originY]);

  // Sets the map's starting scroll position once, then gets out of the way.
  // Re-running this on every token move (its old behavior) fought anyone
  // trying to scroll to look at a different part of the board — the moment
  // any token shifted zones, the view would snap back to "the action". Now
  // it only ever fires the first time a center is available (per mount, or
  // right after a reset — see handleResetMap), leaving all scrolling after
  // that entirely in the GM/player's own hands.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !occupiedCenter || hasCenteredRef.current) return;
    el.scrollLeft = Math.max(0, occupiedCenter.x * mapZoom - el.clientWidth / 2);
    el.scrollTop = Math.max(0, occupiedCenter.y * mapZoom - el.clientHeight / 2);
    hasCenteredRef.current = true;
  }, [occupiedCenter, mapZoom]);

  return (
    <div className="relative overflow-hidden border" style={{ borderColor: "#3a3f42", background: "#16191b", boxShadow: "0 0 30px rgba(94,200,216,0.06)" }}>
      <div className="p-5 sm:p-7">
        <div className="flex items-start justify-between gap-3 mb-1 flex-wrap">
          <div className="text-[11px] tracking-[0.25em] uppercase" style={{ color: "#5ec8d8" }}>SHARED SESSION TOOL</div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5" title="Zooms the map canvas in this browser only — doesn't change anyone else's view">
              <span className="text-[10px] tracking-[0.1em] uppercase" style={{ color: "#5a5f62" }}>Canvas size</span>
              <button
                type="button"
                onClick={() => setMapZoom((z) => Math.max(MAP_ZOOM_MIN, Math.round((z - MAP_ZOOM_STEP) * 100) / 100))}
                className="w-5 h-5 flex items-center justify-center text-[12px] border"
                style={{ borderColor: "#3a3f42", color: "#8a8f93" }}
                title="Decrease"
              >
                −
              </button>
              <input
                type="range"
                min={MAP_ZOOM_MIN}
                max={MAP_ZOOM_MAX}
                step={MAP_ZOOM_STEP}
                value={mapZoom}
                onChange={(e) => setMapZoom(Number(e.target.value))}
                className="w-24 align-middle"
              />
              <button
                type="button"
                onClick={() => setMapZoom((z) => Math.min(MAP_ZOOM_MAX, Math.round((z + MAP_ZOOM_STEP) * 100) / 100))}
                className="w-5 h-5 flex items-center justify-center text-[12px] border"
                style={{ borderColor: "#3a3f42", color: "#8a8f93" }}
                title="Increase"
              >
                +
              </button>
              <span className="text-[10px] mono-num w-9" style={{ color: "#8a8f93" }}>{Math.round(mapZoom * 100)}%</span>
              {mapZoom !== 1 && (
                <button
                  type="button"
                  onClick={() => setMapZoom(1)}
                  className="text-[10px] tracking-[0.1em] uppercase px-1.5 py-0.5 border"
                  style={{ borderColor: "#3a3f42", color: "#5ec8d8" }}
                >
                  Reset
                </button>
              )}
            </div>
            {/* Always laid out (just invisible until a token is held) so it
                appearing doesn't change the header's height and nudge the map. */}
            <button
              type="button"
              onClick={() => { if (selected) { removeToken(selected); setSelected(null); } }}
              disabled={!selected}
              aria-hidden={!selected}
              className="text-[11px] tracking-[0.1em] uppercase px-2.5 py-1 border"
              style={{ borderColor: "#3a3f42", color: "#8a8f93", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, visibility: selected ? "visible" : "hidden" }}
            >
              Take off map
            </button>
            {isGm && (
              <button
                type="button"
                onClick={handleResetMap}
                className="text-[11px] tracking-[0.1em] uppercase px-2.5 py-1 border"
                style={{ borderColor: "#c23b3b66", color: "#c23b3b", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
                title="Remove every token and every zone, leaving a starting 3x3 block"
              >
                Reset map
              </button>
            )}
          </div>
        </div>
        <h1 className="text-2xl sm:text-3xl uppercase tracking-wide mb-2" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>Battle Map</h1>
        {loadState.state === "error" && <p className="text-[12px] mb-3" style={{ color: "#c23b3b" }}>Couldn't reach the map: {loadState.msg}</p>}

        <div className="mb-4 pb-4 border-b" style={{ borderColor: "#2a2e31" }}>
          <div className="flex flex-wrap items-start gap-6">
            <div
              data-drop-tray="1"
              className="flex-1 min-w-[180px] p-2 -m-2"
              style={{
                border: `1px dashed ${drag?.target?.type === "tray" && tokens[drag.id] ? "#ffb000" : "transparent"}`,
                background: drag?.target?.type === "tray" && tokens[drag.id] ? "#ffb00011" : "transparent",
              }}
            >
              <div className="text-[10px] tracking-[0.15em] uppercase mb-2" style={{ color: "#8a8f93", fontFamily: "'Rajdhani', sans-serif", fontWeight: 600 }}>Off the map</div>
              {offBoard.length === 0 ? (
                <span className="text-[12px]" style={{ color: "#5a5f62" }}>{drag && tokens[drag.id] ? "Drop here to take it off the map." : "Everyone's on the map."}</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {offBoard.map((t) => (
                    <MapToken
                      key={t.id}
                      token={t}
                      size="chip"
                      selected={selected === t.id}
                      onClick={() => canMove(t.id) && clickToken(t.id)}
                      draggable={canMove(t.id)}
                      onPointerDown={startPress(t.id)}
                      dragging={drag?.id === t.id}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px]" style={{ color: "#5a5f62" }}>
              <div className="flex items-center gap-2"><span style={{ width: 14, height: 14, borderRadius: "50%", background: "#3b82c2", display: "inline-block" }} /> Player</div>
              <div className="flex items-center gap-2"><span style={{ width: 14, height: 14, borderRadius: 3, background: "#c23b3b", display: "inline-block" }} /> Enemy</div>
              <div className="flex items-center gap-2"><span style={{ width: 14, height: 14, borderRadius: 3, background: "#c23b3b", opacity: 0.4, display: "inline-block" }} /> Down</div>
              {isGm && (
                <div className="flex items-center gap-2">
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: "#c23b3b", border: "2px dashed #ffb000", display: "inline-block", boxSizing: "border-box" }} />
                  <span style={{ color: "#ffb000" }}>Hidden from players</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div ref={scrollRef} className="overflow-auto" style={{ height: "min(90vh, 1000px)", overscrollBehavior: "contain" }}>
          <div style={{ minWidth: "100%", minHeight: "100%", width: "max-content", height: "max-content", display: "grid", placeItems: "center", padding: 8, boxSizing: "border-box" }}>
          <div style={{ width: boardWidth * mapZoom, height: boardHeight * mapZoom, minWidth: Math.round(400 * mapZoom), flexShrink: 0 }}>
          <div className="relative" style={{ width: boardWidth, height: boardHeight, transform: `scale(${mapZoom})`, transformOrigin: "top left" }}>
            {zones.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-[12px] text-center px-6" style={{ color: "#5a5f62" }}>
                {isGm ? "No zones yet — click the + below to start the map." : "The GM hasn't placed any zones yet."}
              </div>
            )}
            {zones.map((z) => (
              <div key={`${z.x},${z.y}`} style={{ position: "absolute", left: z.x * CELL + originX, top: z.y * CELL + originY }}>
                <ZoneCell
                  zone={z}
                  tokensHere={tokensByZone[`${z.x},${z.y}`] || []}
                  selected={selected}
                  onSelectSubcell={placeAt}
                  onSelectToken={clickToken}
                  onPressToken={startPress}
                  onContextToken={openEnemyDamage}
                  canDrag={canMove}
                  draggingId={drag?.id}
                  dropTarget={drag?.target}
                  canEditZones={isGm}
                  onRemoveZone={removeZone}
                  onHoverToken={setHoveredToken}
                />
              </div>
            ))}
            {isGm && edges.flatMap((e) =>
              e.edges.map((edge) => {
                const left = e.x * CELL + originX, top = e.y * CELL + originY;
                const pos =
                  edge === "top" ? { left: left + (ZONE_SIZE - EDGE_BTN) / 2, top: top - EDGE_BTN / 2 } :
                  edge === "bottom" ? { left: left + (ZONE_SIZE - EDGE_BTN) / 2, top: top + ZONE_SIZE - EDGE_BTN / 2 } :
                  edge === "left" ? { left: left - EDGE_BTN / 2, top: top + (ZONE_SIZE - EDGE_BTN) / 2 } :
                  { left: left + ZONE_SIZE - EDGE_BTN / 2, top: top + (ZONE_SIZE - EDGE_BTN) / 2 };
                return (
                  <button
                    key={`edge-${e.x},${e.y}-${edge}`}
                    type="button"
                    onClick={() => addZone(e.x, e.y)}
                    className="absolute flex items-center justify-center text-[12px] z-10"
                    style={{
                      ...pos,
                      width: EDGE_BTN, height: EDGE_BTN,
                      border: "2px dashed #5ec8d8", color: "#5ec8d8", background: "#0d1012",
                      borderRadius: "50%",
                    }}
                    title="Add a zone here"
                  >
                    +
                  </button>
                );
              })
            )}
            {zones.length > 0 && (
              <>
                {Object.entries(ring.sides).map(([dir, side]) => (
                  <div
                    key={`distant-${dir}`}
                    className="absolute flex items-center justify-center overflow-hidden"
                    style={{ left: side.left, top: side.top, width: side.width, height: side.height, background: DISTANT_STRIPES,
                      // Each side paints the stripes as if it were the whole
                      // outer frame, so the pattern runs unbroken round corners.
                      backgroundSize: `${ring.outer.width}px ${ring.outer.height}px`,
                      backgroundPosition: `${ring.outer.left - side.left}px ${ring.outer.top - side.top}px`,
                      backgroundRepeat: "no-repeat",
                      cursor: selected ? "pointer" : "default" }}
                    data-drop-distant={dir}
                    onClick={(e) => placeCompass(dir, distantSlotAt(side, e))}
                    title="Distant — out there, too far away to matter yet"
                  >
                    <span
                      className="select-none pointer-events-none uppercase whitespace-nowrap"
                      style={{
                        color: "#b79a3a", background: "#0d0f10", padding: side.horiz ? "1px 6px 1px 12px" : "12px 1px 6px 1px",
                        fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                        fontSize: 15, lineHeight: "20px", letterSpacing: "0.6em", opacity: 0.9,
                        writingMode: side.horiz ? undefined : "vertical-rl",
                        transform: dir === "W" ? "rotate(180deg)" : undefined,
                      }}
                    >
                      Distant
                    </span>
                  </div>
                ))}
                <div className="absolute pointer-events-none" style={{ ...ring.outer, border: "2px solid #0d0f10", boxSizing: "border-box" }} />
                <div className="absolute pointer-events-none" style={{ ...ring.inner, border: "2px solid #0d0f10", boxSizing: "border-box" }} />
                {Object.entries(distantBySlot).flatMap(([key, list]) => {
                  const [dir, slotStr] = key.split(":");
                  const side = ring.sides[dir];
                  const length = side.horiz ? side.width : side.height;
                  return list.map((t, i) => {
                    // Several tokens on one snap point spread out along the band
                    // rather than stacking on top of each other.
                    const along = ((Number(slotStr) + 0.5) / DISTANT_SLOTS) * length + (i - (list.length - 1) / 2) * (DISTANT_TOKEN_PX + 4);
                    const cx = side.horiz ? side.left + along : side.left + side.width / 2;
                    const cy = side.horiz ? side.top + side.height / 2 : side.top + along;
                    return (
                      <div key={t.id} className="absolute" style={{ left: cx - DISTANT_TOKEN_PX / 2, top: cy - DISTANT_TOKEN_PX / 2, width: DISTANT_TOKEN_PX, height: DISTANT_TOKEN_PX, zIndex: 6 }}>
                        <MapToken
                          token={t}
                          selected={selected === t.id}
                          onClick={() => clickToken(t.id)}
                          onContextMenu={(event) => openEnemyDamage(t, event)}
                          draggable={canMove(t.id)}
                          onPointerDown={startPress(t.id)}
                          dragging={drag?.id === t.id}
                          onHoverStart={() => setHoveredToken(t)}
                          onHoverEnd={() => setHoveredToken(null)}
                          labelBelow={dir === "N"}
                        />
                      </div>
                    );
                  });
                })}
                {drag?.target?.type === "distant" && (() => {
                  // Drop preview on the band: an outline where the token will
                  // sit (the centre of the snap point it's nearest to).
                  const side = ring.sides[drag.target.dir];
                  const length = side.horiz ? side.width : side.height;
                  const along = ((drag.target.slot + 0.5) / DISTANT_SLOTS) * length;
                  const cx = side.horiz ? side.left + along : side.left + side.width / 2;
                  const cy = side.horiz ? side.top + side.height / 2 : side.top + along;
                  return (
                    <div
                      className="absolute pointer-events-none"
                      style={{
                        left: cx - DISTANT_TOKEN_PX / 2 - 3, top: cy - DISTANT_TOKEN_PX / 2 - 3,
                        width: DISTANT_TOKEN_PX + 6, height: DISTANT_TOKEN_PX + 6,
                        border: "2px solid #ffb000", background: "#ffb00033",
                        boxShadow: "0 0 12px #ffb00088", zIndex: 7,
                      }}
                    />
                  );
                })()}
              </>
            )}
          </div>
          </div>
          </div>
        </div>
      </div>


      {isGm && damageEnemy && damagePrompt && (
        <form
          role="dialog"
          aria-label={`Edit ${damageEnemy.name || "enemy"}`}
          onSubmit={applyEnemyDamage}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          className="fixed border p-3"
          style={{ left: damagePrompt.x, top: damagePrompt.y, width: 250, zIndex: 120, borderColor: "#c23b3b", background: "#101315", boxShadow: "0 10px 30px rgba(0,0,0,0.75)" }}
        >
          <label className="block text-[10px] tracking-[0.12em] uppercase mb-2.5" style={{ color: "#8a8f93" }}>
            Name
            <input
              type="text"
              value={nameDraft}
              maxLength={60}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") closeEnemyDamage(); }}
              placeholder="Unnamed enemy"
              className="block w-full mt-1 border bg-transparent px-2 py-1.5 text-[14px]"
              style={{ borderColor: "#3a3f42", color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
            />
          </label>
          <button
            type="button"
            onClick={toggleEnemyHidden}
            className="w-full mb-3 px-2 py-1.5 text-[11px] uppercase tracking-[0.1em] border"
            style={{ borderColor: damageEnemy.hidden ? "#c9a15a" : "#3a3f42", color: damageEnemy.hidden ? "#c9a15a" : "#8a8f93" }}
            title={damageEnemy.hidden ? "Players can't see this token. Click to reveal it." : "Players can see this token. Click to hide it."}
          >
            {damageEnemy.hidden ? "Hidden from players · Reveal" : "Visible to players · Hide"}
          </button>
          <label className="block text-[10px] tracking-[0.12em] uppercase" style={{ color: "#8a8f93" }}>
            Incoming damage
            <input
              autoFocus
              type="number"
              min="0"
              step="1"
              value={damageDraft}
              onChange={(event) => setDamageDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") closeEnemyDamage(); }}
              className="block w-full mt-1 border bg-transparent px-2 py-1.5 text-[15px] mono-num"
              style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
            />
          </label>
          <div className="text-[11px] mt-2" style={{ color: "#8a8f93" }}>
            Soak {damageEnemy.soak || 0} → <span style={{ color: "#ffb000" }}>{damagePreview} wound{damagePreview === 1 ? "" : "s"}</span>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button type="submit" className="px-3 py-1.5 text-[11px] uppercase tracking-[0.1em]" style={{ background: "#c23b3b", color: "#101315", fontWeight: 700 }}>Apply</button>
            <button type="button" onClick={closeEnemyDamage} className="px-2 py-1.5 text-[11px] uppercase tracking-[0.1em]" style={{ color: "#8a8f93" }}>Cancel</button>
          </div>
        </form>
      )}

      {/* The token being dragged, following the pointer. */}
      {dragToken && drag.clientX != null && (
        <div
          className="flex items-center justify-center pointer-events-none"
          style={{
            position: "fixed",
            left: drag.clientX - 16, top: drag.clientY - 16, width: 32, height: 32, zIndex: 100,
            background: dragToken.kind === "pc" ? "#3b82c2" : "#c23b3b",
            color: "#101315",
            borderRadius: dragToken.kind === "pc" ? "50%" : 3,
            border: "2px solid #ffb000",
            boxShadow: "0 6px 18px rgba(0,0,0,0.6), 0 0 12px #ffb00066",
            fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 11,
          }}
        >
          {tokenInitials(dragToken.label, dragToken.kind)}
        </div>
      )}
    </div>
  );
}

// GM page's character selector + Critical Injury entry. Assigns/removes
// directly against the shared /manual store's criticalInjuries map — live
// for every browser (see applyLiveOverlay).
function GmCriticalInjuryEditor({ party, manual }) {
  const [selected, setSelected] = useState(() => party[0]?.liveId || party[0]?.name || "");
  const [draft, setDraft] = useState("");
  const liveId = selected;
  const assigned = manual.criticalInjuries[liveId] || [];

  function assign() {
    const n = Math.max(1, Math.min(150, Math.round(Number(draft))));
    if (!Number.isFinite(n) || !liveId) return;
    manual.addCritInjury(liveId, n);
    setDraft("");
  }

  return (
    <div className="border p-4" style={{ borderColor: "#3a3f4266", background: "#101315" }}>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-3" style={{ color: "#e0763a" }}>Critical Injuries</div>
      <div className="flex items-end gap-2 flex-wrap mb-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>Character</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="bg-transparent border px-2 py-1.5 text-[13px]"
            style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
          >
            {party.map((c) => {
              const id = c.liveId || c.name;
              return <option key={id} value={id} style={{ background: "#16191b" }}>{c.name}</option>;
            })}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>Table 6-10 result (1-150)</span>
          <input
            type="number"
            min={1}
            max={150}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && assign()}
            className="w-32 bg-transparent border px-2 py-1.5 text-[13px] mono-num"
            style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
            placeholder="e.g. 66"
          />
        </label>
        <button
          type="button"
          onClick={assign}
          disabled={!draft || !liveId}
          className="text-[11px] tracking-wide uppercase px-3 py-2 disabled:opacity-40"
          style={{ background: "#e0763a", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
        >
          Assign
        </button>
      </div>
      {assigned.length === 0 ? (
        <span className="text-[12px]" style={{ color: "#5a5f62" }}>No critical injuries assigned to this character.</span>
      ) : (
        <div className="space-y-1.5">
          {assigned.map((n, i) => {
            const match = lookupCriticalInjury(criticalInjuryTextFromNumber(n));
            return (
              <div key={i} className="flex items-center justify-between gap-2 text-[12px]" style={{ color: "#e7e2d2" }}>
                <span>{n} — {match?.name || "Unknown result"}</span>
                <button
                  type="button"
                  onClick={() => manual.removeCritInjury(liveId, i)}
                  className="text-[11px] px-2 py-0.5 border"
                  style={{ borderColor: "#c23b3b66", color: "#c23b3b" }}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// GM page's vehicle selector + Critical Hit entry — same pattern as the
// Critical Injury editor above, keyed by vehicle rather than character.
// Only one vehicle exists in this campaign's ledger.json today, but the
// selector is built to take a list so a second ship needs no rework here.
function GmVehicleCritHitEditor({ vehicles, manual }) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [draft, setDraft] = useState("");
  const vehicle = vehicles[Math.min(selectedIdx, vehicles.length - 1)];
  const hits = vehicle ? vehicleLiveOf(manual, vehicle.id).criticalHits || [] : [];

  function assign() {
    const n = Math.max(1, Math.min(150, Math.round(Number(draft))));
    if (!Number.isFinite(n)) return;
    manual.addVehicleCritHit(vehicle.id, n);
    setDraft("");
  }

  if (!vehicle) return null;

  return (
    <div className="border p-4" style={{ borderColor: "#3a3f4266", background: "#101315" }}>
      <div className="text-[11px] tracking-[0.2em] uppercase mb-3" style={{ color: "#e0763a" }}>Vehicle Critical Hits</div>
      <div className="flex items-end gap-2 flex-wrap mb-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>Vehicle</span>
          <select
            value={selectedIdx}
            onChange={(e) => setSelectedIdx(Number(e.target.value))}
            className="bg-transparent border px-2 py-1.5 text-[13px]"
            style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
          >
            {vehicles.map((v, i) => (
              <option key={i} value={i} style={{ background: "#16191b" }}>{v.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93" }}>Table 7-9 result (1-150)</span>
          <input
            type="number"
            min={1}
            max={150}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && assign()}
            className="w-32 bg-transparent border px-2 py-1.5 text-[13px] mono-num"
            style={{ borderColor: "#3a3f42", color: "#e7e2d2" }}
            placeholder="e.g. 55"
          />
        </label>
        <button
          type="button"
          onClick={assign}
          disabled={!draft}
          className="text-[11px] tracking-wide uppercase px-3 py-2 disabled:opacity-40"
          style={{ background: "#e0763a", color: "#101315", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
        >
          Assign
        </button>
      </div>
      {hits.length === 0 ? (
        <span className="text-[12px]" style={{ color: "#5a5f62" }}>No critical hits assigned to this vehicle.</span>
      ) : (
        <div className="space-y-1.5">
          {hits.map((n, i) => {
            const match = lookupCriticalHitByRoll(n);
            return (
              <div key={i} className="flex items-center justify-between gap-2 text-[12px]" style={{ color: "#e7e2d2" }}>
                <span>{n} — {match?.name || "Unknown result"}</span>
                <button
                  type="button"
                  onClick={() => manual.removeVehicleCritHit(vehicle.id, i)}
                  className="text-[11px] px-2 py-0.5 border"
                  style={{ borderColor: "#c23b3b66", color: "#c23b3b" }}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// GM page's Session Tracker section: direct +/- editors for every party
// member's Wounds/Strain, the Vehicle, and the Destiny pool, all writing to
// the shared /manual store — one place to move numbers without hunting
// through each Character tab. The Character/Vehicle tabs' own pip rows (see
// PipRow) stay the primary, per-player way to do the same thing.
function GmManualModeSection({ manual, party, vehicles = [] }) {
  return (
    <>
      <div className="border p-4 mb-5" style={{ borderColor: "#3a3f42", background: "#101315" }}>
        <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#5ec8d8" }}>Session Tracker</div>
        {manual.obligationStrain?.active && (
          <div className="mt-3 border px-3 py-2 flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: "#ffb00066", background: "#ffb0000d" }}>
            <span className="text-[11px]" style={{ color: "#ffb000" }}>Obligation active: {manual.obligationStrain.triggeredName}{manual.obligationStrain.multiplier > 1 ? " · doubles effect" : ""}</span>
            <button type="button" onClick={() => manual.setObligationStrain({ active: false, triggeredId: "", triggeredName: "", multiplier: 1, roll: 0, penalties: {} })} className="text-[10px] uppercase tracking-wide border px-2 py-1" style={{ borderColor: "#ffb00066", color: "#ffb000" }}>Clear obligation effect</button>
          </div>
        )}

        <div className="overflow-x-auto mt-3">
          <table className="w-full min-w-[620px] border-collapse text-left">
            <thead>
              <tr style={{ borderBottom: "1px solid #3a3f42" }}>
                <th className="py-2 pr-4 text-[10px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93", width: "22%" }}>Name</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-[0.15em]" style={{ color: "#c23b3b", width: "39%" }}>Wounds</th>
                <th className="py-2 pl-3 text-[10px] uppercase tracking-[0.15em]" style={{ color: "#ffb000", width: "39%" }}>Strain</th>
              </tr>
            </thead>
            <tbody>
              {party.map((character) => {
                const liveId = character.liveId;
                if (!liveId) return null;
                const woundsThreshold = character.vitals?.wounds?.threshold ?? 0;
                const baseStrainThreshold = character.vitals?.strain?.threshold ?? 0;
                const obligationPenalty = manual.obligationStrain?.penalties?.[liveId] || 0;
                const strainThreshold = Math.max(1, baseStrainThreshold - obligationPenalty);
                return (
                  <tr key={liveId} style={{ borderBottom: "1px solid #2a2e31" }}>
                    <th className="py-2.5 pr-4 text-[13px] whitespace-nowrap" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>{character.name}</th>
                    <td className="py-2.5 px-3 align-top">
                      <PipRow current={manual.wounds[liveId] || 0} threshold={woundsThreshold} colorClass="#c23b3b" size="small" onSet={(n) => manual.setWound(liveId, n)} onAdjust={(d) => manual.adjustWound(liveId, d)} overLabel="Incapacitated" />
                    </td>
                    <td className="py-2.5 pl-3 align-top">
                      {obligationPenalty > 0 && <div className="text-[9px] uppercase tracking-[0.1em] mb-1" style={{ color: "#ffb000" }}>{baseStrainThreshold} → {strainThreshold} triggered</div>}
                      <PipRow current={manual.strain[liveId] || 0} threshold={strainThreshold} colorClass="#ffb000" size="small" onSet={(n) => manual.setStrain(liveId, n)} onAdjust={(d) => manual.adjustStrain(liveId, d)} overLabel="Unconscious" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {vehicles.length > 0 && (
          <div className="overflow-x-auto mt-4">
            <table className="w-full min-w-[620px] border-collapse text-left">
              <thead>
                <tr style={{ borderBottom: "1px solid #3a3f42" }}>
                  <th className="py-2 pr-4 text-[10px] uppercase tracking-[0.15em]" style={{ color: "#8a8f93", width: "22%" }}>Vehicle</th>
                  <th className="py-2 px-3 text-[10px] uppercase tracking-[0.15em]" style={{ color: "#c23b3b", width: "39%" }}>Hull Trauma</th>
                  <th className="py-2 pl-3 text-[10px] uppercase tracking-[0.15em]" style={{ color: "#ffb000", width: "39%" }}>System Strain</th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((vehicle) => {
                  const lv = vehicleLiveOf(manual, vehicle.id);
                  return (
                    <tr key={vehicle.id} style={{ borderBottom: "1px solid #2a2e31" }}>
                      <th className="py-2.5 pr-4 text-[13px] whitespace-nowrap" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>{vehicle.name}{vehicle.hidden ? <span className="text-[10px] ml-1" style={{ color: "#5a5f62" }}>(hidden)</span> : null}</th>
                      <td className="py-2.5 px-3 align-top"><PipRow current={lv.hull || 0} threshold={vehicle.hullTrauma?.threshold ?? 0} colorClass="#c23b3b" size="small" onSet={(n) => manual.setVehicleHull(vehicle.id, n)} onAdjust={(d) => manual.adjustVehicleHull(vehicle.id, d)} /></td>
                      <td className="py-2.5 pl-3 align-top"><PipRow current={lv.systemStrain || 0} threshold={vehicle.systemStrain?.threshold ?? 0} colorClass="#ffb000" size="small" onSet={(n) => manual.setVehicleSystemStrain(vehicle.id, n)} onAdjust={(d) => manual.adjustVehicleSystemStrain(vehicle.id, d)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="border p-4 mb-5" style={{ borderColor: "#ffb00055", background: "#16191b" }}>
        <div className="text-[11px] tracking-[0.2em] uppercase mb-3" style={{ color: "#ffb000" }}><DestinyRulesTip>Party Destiny Pool</DestinyRulesTip></div>
        <div className="flex items-end gap-5 flex-wrap">
          <div><DestinyTokens count={manual.destiny.light} src={BLUE_TOKEN} alt="Light Side Destiny Point" onFlip={() => manual.flipDestiny("light")} /><span className="text-[11px]" style={{ color: "#8a8f93" }}>Light</span></div>
          <div><DestinyTokens count={manual.destiny.dark} src={RED_TOKEN} alt="Dark Side Destiny Point" onFlip={() => manual.flipDestiny("dark")} /><span className="text-[11px]" style={{ color: "#8a8f93" }}>Dark</span></div>
          <GmDestinyCountControls destiny={manual.destiny} onSet={manual.setDestiny} />
        </div>
      </div>
    </>
  );
}

// Every nav tab the GM page can hide, in nav order. Keys live in the same
// /visibility override store as the per-item gear toggles (so they need the
// GM key to change and apply to every browser at the table). Nothing is
// hidden by default — a tab only disappears once the GM flips it. The GM tab
// itself is never listed.
function characterTabKey(character) {
  return `tab:char:${character?.liveId || character?.name || ""}`;
}
function hideableTabs(party, vehicles = []) {
  return [
    ...party.map((c, i) => ({ key: characterTabKey(c), label: c.name || `Character ${i + 1}`, category: "Character", view: null })),
    ...(party.length > 1 ? [{ key: "tab:party", label: "Party View", category: "Tab", view: "party" }] : []),
    { key: "tab:dice", label: "Dice Roller", category: "Tab", view: "dice" },
    { key: "tab:wiki", label: "Wiki", category: "Tab", view: "wiki" },
    ...vehicles.filter((v) => !v.hidden).map((v) => ({ key: `tab:vehicle:${v.id}`, label: v.name || "Vehicle", category: "Tab", view: `vehicle:${v.id}` })),
    { key: "tab:map", label: "Battle Map", category: "Tab", view: "map" },
    { key: "tab:notes", label: "GM Inbox", category: "Tab", view: "notes" },
  ];
}

const DONJON_NAME_TYPES = [
  ["Star Wars Male", "Male Names"],
  ["Star Wars Female", "Female Names"],
  ["Bothan", "Bothan Names"],
  ["Chiss", "Chiss Names"],
  ["Duros", "Duros Names"],
  ["Gamorrean", "Gamorrean Names"],
  ["Hutt", "Hutt Names"],
  ["Ithorian", "Ithorian Names"],
  ["Mon Calamari", "Mon Calamari Names"],
  ["Quarren", "Quarren Names"],
  ["Rodian", "Rodian Names"],
  ["Sullustan", "Sullustan Names"],
  ["Trandoshan", "Trandoshan Names"],
  ["Twilek", "Twi'lek Names"],
  ["Wookiee", "Wookiee Names"],
  ["Droid", "Droid Names"],
  ["Star Wars Location", "Locations"],
  ["Star Wars Planet", "Planet Names"],
];

function GmNameGenerator({ gmKey }) {
  const [type, setType] = useState("");
  const [names, setNames] = useState([]);
  const [status, setStatus] = useState({ state: "idle", message: "" });
  const [copied, setCopied] = useState("");

  async function generate(nextType) {
    setType(nextType);
    setNames([]);
    setStatus({ state: "loading", message: "" });
    setCopied("");
    try {
      const response = await apiFetch(`/gm/names?type=${encodeURIComponent(nextType)}`, {
        cache: "no-store",
        headers: { "x-gm-key": gmKey },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      setNames(Array.isArray(data.names) ? data.names : []);
      setStatus({ state: "ok", message: "" });
    } catch (error) {
      setNames([]);
      setStatus({ state: "error", message: error.message || "Name generator unavailable" });
    }
  }

  async function copyName(name) {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(name);
    } catch {
      setCopied("");
    }
  }

  return (
    <div className="border p-4 mb-5" style={{ borderColor: "#5ec8d855", background: "#101315" }}>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#5ec8d8" }}>Random Name Generator</div>
        <a href="https://donjon.bin.sh/scifi/name/#type=sw" target="_blank" rel="noreferrer" className="text-[10px]" style={{ color: "#5a5f62" }}>Powered by donjon ↗</a>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-1.5">
        {DONJON_NAME_TYPES.map(([value, label]) => {
          const active = type === value;
          const loading = active && status.state === "loading";
          return (
            <button
              key={value}
              type="button"
              onClick={() => generate(value)}
              disabled={status.state === "loading"}
              aria-pressed={active}
              className="border px-2 py-2 text-[11px] uppercase tracking-[0.08em] disabled:opacity-60"
              style={{
                borderColor: active ? "#5ec8d8" : "#3a3f42",
                color: active ? "#081012" : "#c9c5b9",
                background: active ? "#5ec8d8" : "#16191b",
              }}
            >
              {loading ? "Generating…" : label}
            </button>
          );
        })}
      </div>
      {status.state === "error" && <div role="alert" className="mt-3 text-[11px]" style={{ color: "#c23b3b" }}>{status.message}</div>}
      {names.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-1.5 mt-3">
          {names.map((name, index) => (
            <button key={`${name}-${index}`} type="button" onClick={() => copyName(name)} className="border px-2 py-2 text-left text-[12px]" style={{ borderColor: copied === name ? "#6fae60" : "#2a2e31", color: copied === name ? "#6fae60" : "#e7e2d2", background: "#16191b" }} title="Copy name">
              {name}{copied === name ? "  ✓" : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GmPanel({ auth, campaignStore, party, overrides, onOverride, onResetOverrides, onHideTab, manual, vehicles = [], enemyStore, gearStore, editCharacterId = "", onEditConsumed }) {
  const signedIn = auth.state === "in";
  const overrideCount = Object.keys(overrides || {}).length;

  return (
    <div className="relative overflow-hidden border" style={{ borderColor: "#e0763a66", background: "#16191b", boxShadow: "0 0 30px rgba(224,118,58,0.08)" }}>
      <div className="p-5 sm:p-7">
        <div className="flex items-start justify-between gap-3 mb-1 flex-wrap">
          <div className="text-[11px] tracking-[0.25em] uppercase" style={{ color: "#e0763a" }}>GM ONLY</div>
          <div className="flex items-center gap-2">
            {signedIn && overrideCount > 0 && (
              <button
                onClick={onResetOverrides}
                className="text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors"
                style={{ color: "#8a8f93", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}
                title="Clear every live override — items fall back to whatever the campaign file itself says"
              >
                Reset overrides ({overrideCount})
              </button>
            )}
            {signedIn && (
              <button
                onClick={auth.signOut}
                className="text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors"
                style={{ color: "#8a8f93", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}
                title="Forget the key on this browser"
              >
                Sign out
              </button>
            )}
            <button
              onClick={onHideTab}
              className="text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors"
              style={{ color: "#5a5f62", borderColor: "#3a3f42", fontFamily: "'Rajdhani', sans-serif" }}
              title="Hide this tab again — the gesture brings it back"
            >
              Hide tab
            </button>
          </div>
        </div>

        <h1 className="text-2xl sm:text-3xl uppercase tracking-wide mb-2" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
          GM Page
        </h1>

        {!signedIn ? (
          <>
            <p className="text-[11px] leading-relaxed mb-5" style={{ color: "#5a5f62" }}>
              Enter the GM key to reveal and toggle hidden gear across the party.
            </p>
            <GmSignIn onSignIn={auth.signIn} state={auth.state} error={auth.error} />
          </>
        ) : (
          <>
            <GmCampaignDataSection store={campaignStore} />
            <GmCampaignSettingsSection store={campaignStore} />
            <GmCharacterCreationSection gmKey={auth.key} onAdded={() => campaignStore.refresh()} />
            <GmExperienceSection gmKey={auth.key} party={party} onChanged={() => campaignStore.refresh()} />
            <GmManualModeSection manual={manual} party={party} vehicles={vehicles} />
            <GmNameGenerator gmKey={auth.key} />

            <div className="mb-5">
              <GmInitiativeEditor initiative={manual.initiative} onChange={manual.setInitiative} playerNames={party.map((member) => member.name)} />
            </div>

            <div className="mb-5">
              <GmGearBoard party={party} gearStore={gearStore} manual={manual} />
            </div>

            <div className="mb-5">
              <GmCriticalInjuryEditor party={party} manual={manual} />
            </div>

            {vehicles.length > 0 && (
              <div className="mb-5">
                <GmVehicleCritHitEditor vehicles={vehicles} manual={manual} />
              </div>
            )}

            <p className="text-[11px] leading-relaxed mb-5" style={{ color: "#5a5f62" }}>
              Every weapon, armor, and inventory item across the party, whatever the campaign file's own <code style={{ color: "#e7e2d2" }}>hidden</code> flag
              says its starting visibility is. Toggling here overrides that live — reveal something the moment a player
              finally identifies it, or pull something back out of sight mid-scene. Players never receive hidden items at all.
              "Reset overrides" clears every live override and falls back to whatever the campaign file itself says.
            </p>

            {party.map((c) => {
              const cid = c.liveId || c.name;
              const rows = [];
              (c.weapons || []).forEach((w) => {
                if (!w?.name) return;
                const key = visibilityKey(cid, "weapon", w.name);
                const baseline = !!w.hidden;
                const isOverridden = Object.prototype.hasOwnProperty.call(overrides, key);
                rows.push({ key, label: w.name, category: "Weapon", baseline, isOverridden, effective: isOverridden ? overrides[key] : baseline });
              });
              if (c.armor?.name) {
                const key = visibilityKey(cid, "armor", c.armor.name);
                const baseline = !!c.armor.hidden;
                const isOverridden = Object.prototype.hasOwnProperty.call(overrides, key);
                rows.push({ key, label: c.armor.name, category: "Armor", baseline, isOverridden, effective: isOverridden ? overrides[key] : baseline });
              }
              (c.inventory || []).forEach((it) => {
                if (!it?.name) return;
                const key = visibilityKey(cid, "inventory", it.name);
                const baseline = !!it.hidden;
                const isOverridden = Object.prototype.hasOwnProperty.call(overrides, key);
                rows.push({ key, label: it.name, category: "Inventory", baseline, isOverridden, effective: isOverridden ? overrides[key] : baseline });
              });
              if (rows.length === 0) return null;
              return (
                <div key={cid} className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
                  <div className="text-[13px] mb-2" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>{c.name}</div>
                  {rows.map((r) => (
                    <GmVisibilityRow
                      key={r.key}
                      label={r.label}
                      categoryLabel={r.category}
                      baselineHidden={r.baseline}
                      effectiveHidden={r.effective}
                      isOverridden={r.isOverridden}
                      onToggle={(hidden) => onOverride(r.key, hidden)}
                    />
                  ))}
                </div>
              );
            })}

            <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
              <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>Force Sensitivity (GM only)</div>
              <p className="text-[11px] leading-relaxed mb-2" style={{ color: "#5a5f62" }}>
                Never shown on a character sheet. A Force Sensitive character's Advancement Planner offers Force talents
                (talents.json <code style={{ color: "#e7e2d2" }}>"force": "Yes"</code>); everyone else's hides them. The starting
                value is the character's <code style={{ color: "#e7e2d2" }}>forceSensitive</code> flag in the campaign file — toggling here
                overrides it live, and "Reset overrides" falls back to the file.
              </p>
              {party.map((c) => {
                const cid = c.liveId || c.name;
                const key = forceSensitiveKey(cid);
                const baseline = !!c.forceSensitive;
                const isOverridden = Object.prototype.hasOwnProperty.call(overrides, key);
                const effective = isOverridden ? !!overrides[key] : baseline;
                return (
                  <div key={key} className="flex items-center justify-between gap-3 py-1.5 border-b" style={{ borderColor: "#2a2e3155" }}>
                    <span className="text-[13px]" style={{ color: "#e7e2d2" }}>
                      {c.name}
                      {isOverridden && (
                        <span className="ml-2 text-[10px] tracking-[0.1em] uppercase" style={{ color: "#5ec8d8" }} title={`Ledger default: ${baseline ? "Force Sensitive" : "not Force Sensitive"}`}>
                          live override
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => onOverride(key, !effective)}
                      className="text-[11px] tracking-[0.1em] uppercase px-2.5 py-1 border flex-shrink-0"
                      style={{
                        borderColor: effective ? "#5ec8d8" : "#3a3f42",
                        color: effective ? "#5ec8d8" : "#8a8f93",
                        fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                      }}
                    >
                      {effective ? "Force Sensitive" : "Not Force Sensitive"}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
              <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>Tab Visibility</div>
              <p className="text-[11px] leading-relaxed mb-2" style={{ color: "#5a5f62" }}>
                Pull any tab out of the nav for every browser at the table — for a session where you're running
                something off-dashboard, or just don't want players clicking ahead. Everything is visible until you
                hide it here; the GM tab itself can't be hidden.
              </p>
              {hideableTabs(party, vehicles).map((t) => (
                <GmVisibilityRow
                  key={t.key}
                  label={t.label}
                  categoryLabel={t.category}
                  baselineHidden={false}
                  effectiveHidden={!!overrides[t.key]}
                  isOverridden={Object.prototype.hasOwnProperty.call(overrides, t.key)}
                  onToggle={(hidden) => onOverride(t.key, hidden)}
                />
              ))}
            </div>

            {/* Used now and then, so they sit at the bottom. */}
            <div className="mt-6">
              <GmVehicleSection store={campaignStore} />
              <GmCharacterEditorSection store={campaignStore} initialId={editCharacterId} onConsumed={onEditConsumed} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The site's front page (/): the campaigns marked "show on the front page",
// plus Manage campaigns for the site owner (master password).
// ---------------------------------------------------------------------------
const ADMIN_KEY_STORAGE = "swrpg-admin-key";
const homeBtn = "text-[11px] tracking-[0.15em] uppercase px-3 py-1.5 border transition-colors disabled:opacity-40";
const homeField = "bg-[#0b0d0e] border px-2.5 py-1.5 text-[13px] outline-none focus:border-[#5ec8d8]";

function SiteHome() {
  const [listed, setListed] = useState(null);
  const [manage, setManage] = useState(false);
  useEffect(() => {
    document.title = "SWRPG Dashboards";
    fetch("/api/campaigns", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setListed(Array.isArray(d.campaigns) ? d.campaigns : []))
      .catch(() => setListed([]));
  }, []);
  return (
    <div className="min-h-screen px-4 py-10" style={{ background: "#0b0d0e", color: "#e7e2d2" }}>
      <div className="max-w-3xl mx-auto">
        <div className="text-[11px] tracking-[0.3em] uppercase mb-1" style={{ color: "#5ec8d8" }}>Star Wars Roleplaying</div>
        <h1 className="text-3xl uppercase tracking-wide mb-6" style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>Campaign Dashboards</h1>
        {listed === null ? (
          <p className="text-[13px]" style={{ color: "#8a8f93" }}>Loading…</p>
        ) : listed.length === 0 ? (
          <p className="text-[13px] mb-6" style={{ color: "#8a8f93" }}>Your GM will send you the link to your campaign.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 mb-6">
            {listed.map((c) => (
              <a key={c.slug} href={`/c/${c.slug}/`} className="block border px-4 py-4 transition-colors hover:border-[#5ec8d8]" style={{ borderColor: "#2a2e31", background: "#131719" }}>
                <div className="text-[20px] uppercase" style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>{c.name}</div>
                <div className="text-[11px] mt-1" style={{ color: "#5ec8d8" }}>Open dashboard ▶</div>
              </a>
            ))}
          </div>
        )}
        <div className="mt-10 pt-4 border-t" style={{ borderColor: "#2a2e31" }}>
          {!manage ? (
            <button type="button" onClick={() => setManage(true)} className="text-[11px] underline" style={{ color: "#5a5f62" }}>Manage campaigns</button>
          ) : (
            <SiteAdmin onClose={() => setManage(false)} />
          )}
        </div>
      </div>
    </div>
  );
}

function SiteAdmin({ onClose }) {
  const [key, setKey] = useState(() => { try { return campaignStorage.getItem(ADMIN_KEY_STORAGE) || ""; } catch { return ""; } });
  const [typed, setTyped] = useState("");
  const [campaigns, setCampaigns] = useState(null);
  const [status, setStatus] = useState({ state: "idle", msg: "" });
  const [form, setForm] = useState({ name: "", slug: "", gmPassword: "", private: true, listed: false });

  const call = useCallback(async (path, method = "GET", body, useKey = key) => {
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json", "x-admin-key": useKey },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const err = new Error(data.error || `The site said ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }, [key]);

  useEffect(() => {
    if (!key) return;
    call("/api/admin/campaigns").then((d) => setCampaigns(d.campaigns)).catch((err) => {
      if (err.status === 401) { setKey(""); try { campaignStorage.removeItem(ADMIN_KEY_STORAGE); } catch { /* ignore */ } }
      setStatus({ state: "error", msg: err.message });
    });
  }, [key, call]);

  async function signIn(e) {
    e.preventDefault();
    const k = typed.trim();
    if (!k) return;
    setStatus({ state: "busy", msg: "Checking…" });
    try {
      await call("/api/admin/check", "GET", undefined, k);
      try { campaignStorage.setItem(ADMIN_KEY_STORAGE, k); } catch { /* ignore */ }
      setKey(k);
      setTyped("");
      setStatus({ state: "idle", msg: "" });
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }

  function signOut() {
    try { campaignStorage.removeItem(ADMIN_KEY_STORAGE); } catch { /* ignore */ }
    setKey("");
    setCampaigns(null);
  }

  async function run(label, fn) {
    setStatus({ state: "busy", msg: `${label}…` });
    try {
      const msg = await fn();
      setStatus({ state: "ok", msg: msg || "Done." });
    } catch (err) {
      setStatus({ state: "error", msg: err.message });
    }
  }

  const suggestedSlug = form.slug || String(form.name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  const fs = { borderColor: "#3a3f42", color: "#e7e2d2" };
  const lbl = "block text-[10px] tracking-[0.15em] uppercase mb-1";

  if (!key) {
    return (
      <form onSubmit={signIn} className="border p-4" style={{ borderColor: "#3a3f42", background: "#101315" }}>
        <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#e0763a" }}>Manage campaigns</div>
        <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8a8f93" }}>For the site owner. Uses the site's master password (the ADMIN_PASSWORD secret on Cloudflare, or GM_PASSWORD if that's the only one set).</p>
        <div className="flex flex-wrap gap-2">
          <input type="password" value={typed} onChange={(e) => setTyped(e.target.value)} className={`${homeField} flex-1 min-w-[200px]`} style={fs} placeholder="Master password" autoComplete="current-password" />
          <button type="submit" className={homeBtn} style={{ color: "#101315", background: "#5ec8d8", borderColor: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>Sign in</button>
          <button type="button" onClick={onClose} className={homeBtn} style={{ color: "#8a8f93", borderColor: "#3a3f42" }}>Cancel</button>
        </div>
        {status.msg && <p className="mt-2 text-[12px]" style={{ color: status.state === "error" ? "#c23b3b" : "#8a8f93" }}>{status.msg}</p>}
      </form>
    );
  }

  return (
    <div className="border p-4" style={{ borderColor: "#3a3f42", background: "#101315" }}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#e0763a" }}>Manage campaigns</div>
        <button type="button" onClick={signOut} className="text-[11px] underline" style={{ color: "#8a8f93" }}>Sign out</button>
      </div>

      <div className="space-y-2 mb-5">
        {campaigns === null && <p className="text-[12px]" style={{ color: "#8a8f93" }}>Loading…</p>}
        {campaigns?.length === 0 && <p className="text-[12px]" style={{ color: "#8a8f93" }}>No campaigns yet. Create the first one below.</p>}
        {(campaigns || []).map((c) => (
          <div key={c.slug} className="border px-3 py-2.5" style={{ borderColor: "#2a2e31", background: "#131719" }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[16px] uppercase" style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>{c.name}</div>
                <a href={`/c/${c.slug}/`} className="text-[11px] underline break-all" style={{ color: "#8fd3f4" }}>{`${window.location.origin}/c/${c.slug}/`}</a>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className={homeBtn} style={fs} onClick={() => {
                  const name = window.prompt("New name for this campaign:", c.name);
                  if (!name || !name.trim()) return;
                  run("Renaming", async () => { const d = await call(`/api/admin/campaigns/${c.slug}`, "POST", { name }); setCampaigns(d.campaigns); return `Renamed to ${name.trim()}.`; });
                }}>Rename</button>
                <button type="button" className={homeBtn} style={fs} onClick={() => {
                  const pw = window.prompt(`New GM password for ${c.name} (at least 6 characters). The GM will need to sign in again.`);
                  if (!pw) return;
                  run("Saving", async () => { const d = await call(`/api/admin/campaigns/${c.slug}`, "POST", { gmPassword: pw }); setCampaigns(d.campaigns); return `GM password changed for ${c.name}.`; });
                }}>GM password</button>
                <button type="button" className={homeBtn} style={{ ...fs, color: c.listed ? "#6fae60" : "#8a8f93" }} onClick={() => {
                  run("Saving", async () => { const d = await call(`/api/admin/campaigns/${c.slug}`, "POST", { listed: !c.listed }); setCampaigns(d.campaigns); return c.listed ? `${c.name} is no longer on the front page.` : `${c.name} is on the front page.`; });
                }} title="Whether this campaign appears on the front page">{c.listed ? "On front page" : "Unlisted"}</button>
                <button type="button" className={homeBtn} style={{ borderColor: "#c23b3b66", color: "#c23b3b" }} onClick={() => {
                  if (!window.confirm(`Take ${c.name} off the site? Its address stops working. Its data is kept: creating a campaign at the same address (${c.slug}) brings it back.`)) return;
                  run("Removing", async () => { const d = await call(`/api/admin/campaigns/${c.slug}`, "DELETE"); setCampaigns(d.campaigns); return `${c.name} removed from the site.`; });
                }}>Remove</button>
              </div>
            </div>
            {!c.hasGmPassword && <div className="text-[11px] mt-1" style={{ color: "#c9a15a" }}>No GM password set: only the master password signs in as GM.</div>}
          </div>
        ))}
      </div>

      <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#5ec8d8" }}>New campaign</div>
      <div className="grid gap-2 sm:grid-cols-2 mb-2">
        <div>
          <label className={lbl} style={{ color: "#8a8f93" }}>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} className={`${homeField} w-full`} style={fs} placeholder="e.g. Salvage Rights" />
        </div>
        <div>
          <label className={lbl} style={{ color: "#8a8f93" }}>Address</label>
          <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} maxLength={33} className={`${homeField} w-full`} style={fs} placeholder={suggestedSlug || "from the name"} />
        </div>
        <div>
          <label className={lbl} style={{ color: "#8a8f93" }}>GM password</label>
          <input type="password" value={form.gmPassword} onChange={(e) => setForm({ ...form, gmPassword: e.target.value })} className={`${homeField} w-full`} style={fs} placeholder="At least 6 characters" autoComplete="new-password" />
        </div>
        <div className="flex flex-col justify-end gap-1 text-[12px]">
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.private} onChange={(e) => setForm({ ...form, private: e.target.checked })} /> Hard-to-guess address (adds 5 random characters)</label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.listed} onChange={(e) => setForm({ ...form, listed: e.target.checked })} /> Show on the front page</label>
        </div>
      </div>
      <div className="text-[11px] mb-2" style={{ color: "#5a5f62" }}>
        Address: {window.location.origin}/c/{suggestedSlug || "…"}{form.private ? "-xxxxx" : ""}/
      </div>
      <button
        type="button"
        disabled={!form.name.trim() || form.gmPassword.trim().length < 6 || status.state === "busy"}
        onClick={() => run("Creating", async () => {
          const d = await call("/api/admin/campaigns", "POST", { ...form, slug: form.slug || undefined });
          setCampaigns(d.campaigns);
          setForm({ name: "", slug: "", gmPassword: "", private: true, listed: false });
          return `Created ${window.location.origin}/c/${d.slug}/ — open it, sign in as GM with its password, then Import all or create characters.`;
        })}
        className={homeBtn}
        style={{ color: "#101315", background: "#5ec8d8", borderColor: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
      >
        Create campaign
      </button>
      {status.msg && <p className="mt-2 text-[12px] break-all" style={{ color: status.state === "error" ? "#c23b3b" : status.state === "busy" ? "#8a8f93" : "#6fae60" }}>{status.msg}</p>}
    </div>
  );
}

// A campaign address: check the campaign exists before showing anything.
function CampaignGate({ children }) {
  const [state, setState] = useState({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/campaigns/${CAMPAIGN_SLUG}`, { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok && data.exists) {
          document.title = data.name || "SWRPG";
          setState({ status: "ok" });
        } else {
          setState({ status: "missing" });
        }
      })
      // If the check itself fails (offline), try the dashboard anyway.
      .catch(() => !cancelled && setState({ status: "ok" }));
    return () => { cancelled = true; };
  }, []);
  if (state.status === "loading") return <div className="min-h-screen" style={{ background: "#0b0d0e" }} />;
  if (state.status === "missing") {
    return (
      <div className="min-h-screen px-4 py-16" style={{ background: "#0b0d0e", color: "#e7e2d2" }}>
        <div className="max-w-xl mx-auto border p-6" style={{ borderColor: "#3a3f42", background: "#16191b" }}>
          <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#c23b3b" }}>Not found</div>
          <h1 className="text-2xl uppercase mb-2" style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>No campaign at this address</h1>
          <p className="text-[13px] mb-4" style={{ color: "#8a8f93" }}>Check the link your GM sent you.</p>
          <a href="/" className="text-[12px] underline" style={{ color: "#5ec8d8" }}>Go to the front page</a>
        </div>
      </div>
    );
  }
  return children;
}

// The front page (/) lists campaigns; a campaign address (/c/<slug>/) opens
// that campaign's dashboard, or its character creation wizard when the link
// carries ?create=<code>.
export default function App() {
  if (!CAMPAIGN_SLUG) return <SiteHome />;
  const createCode = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("create") : null;
  return (
    <CampaignGate>
      {createCode ? <CreationWizardPage code={createCode.trim().toLowerCase()} /> : <CampaignDashboard />}
    </CampaignGate>
  );
}

function CampaignDashboard() {
  const [activeIdx, setActiveIdx] = useState(0);
  const [viewMode, setViewMode] = useState("character");
  const [editCharacterId, setEditCharacterId] = useState("");
  // Which characteristic (if any) is currently hovered on the Character
  // tab's Characteristics row — drives the brighten/dim effect on the
  // Skills list below it (skills governed by the hovered characteristic
  // stay at full opacity, everything else dims). Reset to null on mouse
  // leave so the effect only applies while actively hovering a tile.
  const [hoveredChar, setHoveredChar] = useState(null);
  const [booted, setBooted] = useState(false);
  const bootTimer = useRef(null);

  // The GM tab is hidden until it's asked for: five quick clicks on the
  // campaign name. It's only a curtain — the actual protection is the key
  // the Worker checks (see GM_PASSWORD in worker/index.js) — but a tab
  // nobody can see is a tab nobody wonders about.
  const gmAuth = useGmAuth();
  const campaignStore = useCampaignStore(gmAuth.state === "in" ? gmAuth.key : null);
  const ledger = campaignStore.campaign || EMPTY_CAMPAIGN;
  const vehicles = useMemo(() => campaignVehicles(ledger), [ledger]);
  const viewVehicle = viewMode.startsWith("vehicle:") ? vehicles.find((v) => `vehicle:${v.id}` === viewMode) || null : null;
  const unactionedNotes = useUnactionedNoteCount(gmAuth.state === "in");
  const gmPending = useGmPendingCount(gmAuth.state === "in" ? gmAuth.key : null);
  const { overrides: visibilityOverrides, refresh: refreshVisibility } = useVisibilityOverrides();
  const navVehicles = vehicles.filter((v) => !v.hidden && !visibilityOverrides[`tab:vehicle:${v.id}`]);
  // A vehicle tab whose vehicle was removed (or hidden) drops back to the sheets.
  useEffect(() => {
    if (viewMode.startsWith("vehicle:") && campaignStore.campaign && !viewVehicle) setViewMode("character");
  }, [viewMode, viewVehicle, campaignStore.campaign]);
  // If the GM hides the tab someone happens to be sitting on, move them to
  // the first tab that's still visible (a character sheet if any are left)
  // rather than leaving them stranded on a nav button that just vanished.
  // The Advancement Planner belongs to the active character's sheet, so it
  // goes when that character's tab does. The GM tab is never hidden.
  useEffect(() => {
    if (viewMode === "gm") return;
    const visibleParty = (ledger.characters || []).filter((c) => !c.hidden);
    const tabs = hideableTabs(visibleParty, campaignVehicles(ledger));
    const hidden = (key) => !!visibilityOverrides[key];
    let currentKey;
    if (viewMode === "character" || viewMode === "advancement") {
      currentKey = visibleParty[activeIdx] ? characterTabKey(visibleParty[activeIdx]) : null;
    } else {
      currentKey = tabs.find((t) => t.view === viewMode)?.key;
    }
    if (!currentKey || !hidden(currentKey)) return;
    const charIdx = visibleParty.findIndex((c) => !hidden(characterTabKey(c)));
    if (charIdx >= 0) {
      setActiveIdx(charIdx);
      setViewMode("character");
      return;
    }
    const next = tabs.find((t) => t.view && !hidden(t.key));
    if (next) setViewMode(next.view);
  }, [viewMode, activeIdx, ledger, visibilityOverrides]);
  const manual = useManualStore();
  const enemyStore = useEnemyStore(gmAuth.key);
  const mapStore = useZoneMapStore(gmAuth.key);
  const gearStore = useGearStore(gmAuth.key);
  const [gmRevealed, setGmRevealed] = useState(() => {
    try {
      return campaignStorage.getItem(GM_REVEAL_STORAGE) === "1";
    } catch {
      return false;
    }
  });
  const revealClicks = useRef({ count: 0, first: 0 });
  function tapCampaignName() {
    const now = Date.now();
    const r = revealClicks.current;
    if (now - r.first > GM_REVEAL_WINDOW_MS) {
      r.first = now;
      r.count = 0;
    }
    r.count += 1;
    if (r.count >= GM_REVEAL_CLICKS) {
      r.count = 0;
      setGmRevealed(true);
      try {
        campaignStorage.setItem(GM_REVEAL_STORAGE, "1");
      } catch {
        /* ignore */
      }
    }
  }
  function hideGmTab() {
    setGmRevealed(false);
    setViewMode("character");
    try {
      campaignStorage.removeItem(GM_REVEAL_STORAGE);
    } catch {
      /* ignore */
    }
  }
  async function handleSetVisibility(key, hidden) {
    try {
      await apiFetch("/visibility", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gm-key": gmAuth.key },
        body: JSON.stringify({ key, hidden }),
      });
    } catch {
      // best-effort — a stale re-fetch reconciles if this failed
    } finally {
      refreshVisibility();
    }
  }
  async function handleResetVisibility() {
    if (!window.confirm("Clear every live visibility override? Items fall back to whatever the campaign file itself says.")) return;
    try {
      await apiFetch("/visibility", { method: "DELETE", headers: { "x-gm-key": gmAuth.key } });
    } catch {
      // best-effort
    } finally {
      refreshVisibility();
    }
  }

  const [playerName, setPlayerName] = useState(() => {
    try { return campaignStorage.getItem("swrpg-dice-player-name") || ""; } catch { return ""; }
  });
  useEffect(() => {
    try { campaignStorage.setItem("swrpg-dice-player-name", playerName); } catch { /* ignore */ }
  }, [playerName]);

  // Clicking a skill's dice pips (Character Sheet tab or Party View table)
  // jumps to the Dice Roller with that skill's Proficiency/Ability/talent-
  // Boost dice preloaded. diceSeedRef guarantees a fresh nonce every click,
  // even re-clicking the same skill, so DiceRollerPanel's effect always
  // re-applies it instead of bailing out on an unchanged dependency.
  const [dicePreset, setDicePreset] = useState(null);
  const diceSeedRef = useRef(0);
  // Drop the loaded weapon/skill preset once its pool has been rolled or
  // cleared (see POOL_CONSUMED_EVENT) so it cannot reseed later rolls.
  useEffect(() => {
    function onConsumed(event) {
      if (event.detail?.clientId === getDicePoolClientId()) setDicePreset(null);
    }
    window.addEventListener(POOL_CONSUMED_EVENT, onConsumed);
    return () => window.removeEventListener(POOL_CONSUMED_EVENT, onConsumed);
  }, []);
  // weaponNote (optional) is a weapon's Special text (e.g. "Pierce 2,
  // Vicious 1") — only passed when this preset came from clicking a weapon
  // row on the character sheet, so it can be surfaced on the shared roll
  // log entry the roll produces (see handleRoll/weaponNote below).
  function loadSkillIntoRoller(skill, characterName, weaponNote, damage = null, adjustments = {}, options = {}) {
    const proficiency = Math.min(skill.rank, skill.characteristic);
    const ability = Math.max(skill.rank, skill.characteristic) - proficiency;
    const pool = { ...EMPTY_POOL, proficiency, ability, boost: (skill.boost || 0) + (adjustments.boost || 0), setback: adjustments.setback || 0 };
    const automaticResults = { ...EMPTY_MANUAL, a: adjustments.advantage || 0, t: adjustments.threat || 0 };
    diceSeedRef.current += 1;
    const preset = {
      pool,
      label: `${characterName} — ${skill.name}`,
      weaponNote: weaponNote || null,
      damage,
      automaticResults,
      nonce: diceSeedRef.current,
    };
    setDicePreset(preset);
    // Loading a pool means "I'm rolling as this character" — auto-fill
    // the shared-log name so the player does not have to type it again.
    if (characterName) setPlayerName(characterName);

    if (options.openBattleMap) {
      const clientId = getDicePoolClientId();
      const cached = readDicePoolCache();
      try {
        campaignStorage.setItem("swrpg-dice-pool-cache", JSON.stringify({ pool, gmUpdatedAt: cached.gmUpdatedAt || 0, presetNonce: preset.nonce }));
      } catch { /* ignore */ }
      apiFetch("/rolls", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, player: (characterName || "Unnamed").slice(0, 40), label: preset.label, pool, weaponNote: preset.weaponNote, damage, automaticResults }),
      }).catch(() => {});
      setViewMode("map");
      return;
    }
    setViewMode("dice");
  }

  const [live, setLive] = useState({ status: "idle" });

  // Tracks when each live value last changed (and which direction), purely
  // to drive the one-shot sweep highlight — never affects displayed values.
  const lastChangeRef = useRef({ wounds: {}, strain: {}, woundsDir: {}, strainDir: {}, destinyLightTs: 0, destinyLightDir: null, destinyDarkTs: 0, destinyDarkDir: null });
  const ledgerRef = useRef(ledger);
  useEffect(() => { ledgerRef.current = ledger; }, [ledger]);
  const [, forceTick] = useState(0);
  const scheduleSweepClear = () => {
    setTimeout(() => forceTick((t) => t + 1), SWEEP_MS + 100);
    setTimeout(() => forceTick((t) => t + 1), PULSE_MS + 100);
  };

  useEffect(() => {
    bootTimer.current = setTimeout(() => setBooted(true), 650);
    return () => clearTimeout(bootTimer.current);
  }, []);

  // The browser tab shows the campaign's name from the site's campaign list
  // (set by CampaignGate), not the in-fiction title inside the campaign data.

  // Wounds/Strain/Destiny/Critical Injuries/Vehicle/Initiative all come from
  // the shared /manual Durable Object (see useManualStore) — every browser
  // polls it and writes to it directly. This mirrors it into `live`, the
  // shape the rest of the dashboard reads, and records which values changed
  // (and in which direction) to drive the one-shot sweep highlight.
  useEffect(() => {
    const storeState = manual.loadState?.state;
    setLive((prev) => {
      if (storeState !== "ok") {
        if (prev.status === "ok") return prev; // keep the last good values through a failed poll
        return { status: storeState === "error" ? "error" : "idle", errorMsg: manual.loadState?.msg };
      }
      if (prev.status === "ok") {
        const now = Date.now();
        const lc = lastChangeRef.current;
        let changed = false;
        const party = (ledgerRef.current.characters || []).filter((p) => !p.hidden && p.liveId);
        party.forEach((p) => {
          const oldW = prev.wounds?.[p.liveId] ?? 0;
          const newW = manual.wounds?.[p.liveId] ?? 0;
          if (oldW !== newW) {
            lc.wounds[p.liveId] = now;
            lc.woundsDir[p.liveId] = newW > oldW ? "up" : "down";
            changed = true;
          }
          const oldS = prev.strain?.[p.liveId] ?? 0;
          const newS = manual.strain?.[p.liveId] ?? 0;
          if (oldS !== newS) {
            lc.strain[p.liveId] = now;
            lc.strainDir[p.liveId] = newS > oldS ? "up" : "down";
            changed = true;
          }
        });
        const oldD = prev.destiny || { light: 0, dark: 0 };
        const newD = manual.destiny || { light: 0, dark: 0 };
        if (oldD.light !== newD.light) {
          lc.destinyLightTs = now;
          lc.destinyLightDir = newD.light > oldD.light ? "up" : "down";
          changed = true;
        }
        if (oldD.dark !== newD.dark) {
          lc.destinyDarkTs = now;
          lc.destinyDarkDir = newD.dark > oldD.dark ? "up" : "down";
          changed = true;
        }
        if (changed) scheduleSweepClear();
      }
      return {
        status: "ok",
        wounds: manual.wounds,
        strain: manual.strain,
        destiny: manual.destiny,
        criticalInjuries: manual.criticalInjuries,
        vehicle: manual.vehicle,
        initiative: manual.initiative,
        obligationStrain: manual.obligationStrain,
        fetchedAt: new Date(),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual.loadState, manual.wounds, manual.strain, manual.destiny, manual.criticalInjuries, manual.vehicle, manual.initiative, manual.obligationStrain]);

  // "hidden" characters stay fully drafted in ledger.json but are filtered
  // out of every view (character tab, Party View, live-overlay tracking)
  // until flipped to false — the whole reveal-a-new-PC workflow.
  const party = (ledger.characters || []).filter((c) => !c.hidden);
  // A new import (or a character being hidden) can leave the selected tab
  // pointing past the end of the party; fall back to the first character.
  useEffect(() => {
    if (party.length && activeIdx >= party.length) setActiveIdx(0);
  }, [party.length, activeIdx]);
  const active = party[activeIdx] || {};
  const overlay = applyLiveOverlay(active, live);

  const v = active.vitals || {};
  const wounds = overlay.wounds;
  const strain = overlay.strain;
  const destiny = overlay.destiny || { light: 0, dark: 0 };
  const destinyUnknown = !overlay.destiny;
  const xp = active.xp || { available: 0, total: 0 };
  const staticCrits = v.criticalInjuries || [];
  const liveCrits = overlay.criticalInjuriesLive || [];
  // Item-level `hidden` mirrors the character-level flag above: a weapon or
  // inventory entry stays fully written in ledger.json but is filtered out of
  // the sheet until flipped to false (or the key is removed). Use it for gear
  // whose retention is unresolved at the table — nothing is lost, and
  // restoring it is a one-word edit. A GM can also flip this live for the
  // session from the GM tab (five clicks on the campaign name) without
  // touching ledger.json at all — see visibilityOverrides/effectiveHidden.
  const activeId = active.liveId || active.name;
  const activeForceSensitive = isForceSensitive(active, visibilityOverrides);
  const effectiveHidden = (category, item) => {
    if (!item?.name) return !!item?.hidden;
    const key = visibilityKey(activeId, category, item.name);
    return Object.prototype.hasOwnProperty.call(visibilityOverrides, key) ? visibilityOverrides[key] : !!item.hidden;
  };
  // Gear the GM has added mid-session via the GM page's Field-Acquired Gear
  // board (see GmGearBoard) — a separate live store from ledger.json, with
  // its own `hidden` flag rather than the visibilityOverrides system above
  // (there's no ledger baseline for something that was never in the ledger
  // to begin with). Only revealed items ever reach here — hidden ones don't
  // even come back from the public /gear read (see publicGearView in
  // worker/index.js) — and only this character's own items are pulled in.
  // Revealed weapons join the real weapons list (so Dice Roller, Precision
  // badges etc. all just work); revealed armor joins the Armor section
  // alongside whatever ledger.json's baseline armor is — see
  // armorOptionsFor/pickWornArmor below, which pick one of these (by id) as
  // actually worn and drive the character's real Soak/Defense from it;
  // equipment surfaces as Inventory. `id` is carried through so the qty
  // stepper (see itemQtyKey) points at the same counter the GM tab uses.
  const revealedGear = (gearStore?.gear || []).filter((g) => g.characterId === activeId && !g.hidden);
  const gearWeapons = revealedGear
    .filter((g) => g.category === "weapon")
    .map((g) => ({ id: g.id, name: g.name, skill: g.skill, damage: g.damage, crit: g.crit, range: g.range, special: g.special, isNew: isRecentlyAdded(g.addedAt) }));
  const gearArmor = revealedGear
    .filter((g) => g.category === "armor")
    .map((g) => ({ id: g.id, name: g.name, soakBonus: g.soakBonus || 0, defenseBonus: g.defenseBonus || 0, rangedDefense: g.rangedDefense ?? undefined, meleeDefense: g.meleeDefense ?? undefined, special: g.special || "", note: g.note, isNew: isRecentlyAdded(g.addedAt) }));
  const gearInventory = revealedGear
    .filter((g) => g.category === "equipment")
    .map((g) => ({ id: g.id, name: g.name, note: g.note || undefined, isNew: isRecentlyAdded(g.addedAt) }));
  const inv = [...(active.inventory || []).filter((i) => !effectiveHidden("inventory", i)), ...gearInventory];
  const mo = active.motivationObligation || {};
  const obligation = mo.obligation || {};
  const chars = active.characteristics || {};
  const skills = buildSkills(active);
  const talents = [...(active.talents || [])].sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
  const weapons = [...(active.weapons || []).filter((w) => !effectiveHidden("weapon", w)), ...gearWeapons];
  const armor = active.armor || {};
  const armorHidden = effectiveHidden("armor", armor);
  // Every armor option this character has — ledger baseline (unless the GM
  // has hidden it) plus revealed field-acquired armor — narrowed down to
  // whichever one is actually worn right now (armorOptionsFor/pickWornArmor,
  // above), which is what actually drives Soak and Defense below rather than
  // always assuming the ledger baseline the way this used to.
  const armorOptions = [
    ...(armor.name && !armorHidden ? [{ id: "ledger", name: armor.name, soakBonus: armor.soakBonus || 0, rangedDefense: armor.rangedDefense, meleeDefense: armor.meleeDefense, defenseBonus: armor.defenseBonus, special: armor.special || "" }] : []),
    ...gearArmor,
  ];
  const wornArmor = pickWornArmor(armorOptions, manual.wornArmorOf(activeId));
  const activeDefense = armorDefense(wornArmor);
  const computedSoak = (chars.brawn || 0) + armorSoakBonus(wornArmor);

  const CHAR_LABELS = [
    ["brawn", "BR"], ["agility", "AG"], ["intellect", "INT"],
    ["cunning", "CUN"], ["willpower", "WIL"], ["presence", "PR"],
  ];

  const partySkillSets = party.map((p) => buildSkills(p));
  const partySkillNames = FULL_SKILL_LIST;
  const partyOverlays = party.map((p) => applyLiveOverlay(p, live));
  // Destiny is shared across the whole party, so any overlay carrying a
  // value works as the source.
  const partyDestinyRaw = partyOverlays.find((o) => o.destiny)?.destiny || party[0]?.destiny || null;
  const partyDestiny = partyDestinyRaw || { light: 0, dark: 0 };
  const partyDestinyUnknown = !partyDestinyRaw;

  const now = Date.now();
  const lc = lastChangeRef.current;
  const woundsSweepOn = !!active.liveId && (now - (lc.wounds[active.liveId] || 0)) < SWEEP_MS;
  const woundsDir = lc.woundsDir[active.liveId];
  const strainSweepOn = !!active.liveId && (now - (lc.strain[active.liveId] || 0)) < SWEEP_MS;
  const strainDir = lc.strainDir[active.liveId];
  const destinyLightSweepOn = (now - (lc.destinyLightTs || 0)) < SWEEP_MS;
  const destinyDarkSweepOn = (now - (lc.destinyDarkTs || 0)) < SWEEP_MS;

  return (
    <div
      className="min-h-screen w-full flex items-start justify-center p-4 sm:p-8"
      style={{ background: "radial-gradient(circle at 50% 0%, #1b1f22 0%, #101315 70%)", fontFamily: "'JetBrains Mono', monospace" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
        @keyframes scan { 0% { transform: translateY(-100%); opacity: 0.9; } 100% { transform: translateY(2200%); opacity: 0; } }
        @keyframes flicker { 0%,100% { opacity: 1; } 92% { opacity: 1; } 93% { opacity: 0.4; } 94% { opacity: 1; } }
        @keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes inboxPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(224,118,58,0); background-color: transparent; } 50% { box-shadow: 0 0 14px 2px rgba(224,118,58,0.55); background-color: rgba(224,118,58,0.22); } }
        @keyframes sweepUp { 0% { clip-path: inset(100% 0 0 0); opacity: 1; } 55% { clip-path: inset(0 0 0 0); opacity: 1; } 100% { clip-path: inset(0 0 0 0); opacity: 0; } }
        @keyframes sweepDown { 0% { clip-path: inset(0 0 100% 0); opacity: 1; } 55% { clip-path: inset(0 0 0 0); opacity: 1; } 100% { clip-path: inset(0 0 0 0); opacity: 0; } }
        @keyframes initBreathe { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(1.08); } }
        @keyframes destinyFlight { 0% { transform: translate3d(0,0,0); } 45% { transform: translate3d(var(--destiny-mid-x), var(--destiny-mid-y), 0); } 100% { transform: translate3d(var(--destiny-dx), var(--destiny-dy), 0); } }
        .destiny-flight-token { position: fixed; width: 33px; height: 33px; z-index: 95; pointer-events: none; animation: destinyFlight .56s cubic-bezier(.22,.72,.28,1) both; filter: drop-shadow(0 0 7px rgba(255,176,0,.65)); }
        .destiny-flight-token img { position: absolute; inset: 0; width: 33px; height: 33px; }
        @keyframes diceBurst { 0% { opacity: 0; transform: translate3d(-90px, 90px, 0) rotate(0deg) scale(0.72); } 7% { opacity: 1; } 48% { opacity: 1; transform: translate3d(calc(var(--burst-x) - 70px), calc(var(--burst-y) + 90px), 0) rotate(calc(var(--burst-turn) - 95deg)) scale(1.08); } 55% { opacity: 1; transform: translate3d(var(--burst-x), var(--burst-y), 0) rotate(var(--burst-turn)) scale(1); } 72% { opacity: 1; transform: translate3d(var(--burst-x), var(--burst-y), 0) rotate(var(--burst-turn)) scale(1); } 100% { opacity: 0; transform: translate3d(var(--log-x), var(--log-y), 0) rotate(calc(var(--burst-turn) + 240deg)) scale(0.12); } }
        @keyframes diceBurstReduced { 0% { opacity: 0; transform: translate3d(var(--burst-x), calc(var(--burst-y) + 24px), 0) scale(0.92); } 35%, 70% { opacity: 1; transform: translate3d(var(--burst-x), var(--burst-y), 0) scale(1); } 100% { opacity: 0; transform: translate3d(var(--log-x), var(--log-y), 0) scale(0.2); } }
        .dice-burst-layer { position: fixed; inset: 0; z-index: 90; pointer-events: none; overflow: hidden; }
        .dice-burst-item { position: fixed; left: 0; bottom: 0; display: block; animation: diceBurst 4.2s cubic-bezier(.18,.68,.24,1) both; filter: drop-shadow(0 5px 7px rgba(0,0,0,.85)); will-change: transform, opacity; }
        @media (prefers-reduced-motion: reduce) { .dice-burst-item { animation-name: diceBurstReduced; animation-duration: 1.1s; } }
        .boot-scan { position: absolute; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, transparent, #5ec8d8, transparent); animation: scan 0.65s ease-out forwards; pointer-events: none; }
        .flicker-in { animation: flicker 1.4s ease-out; }
        .mono-num { font-variant-numeric: tabular-nums; }
        .live-dot { animation: pulse-dot 1.6s ease-in-out infinite; }
        .init-breathe { animation: initBreathe 2.6s ease-in-out infinite; }
      `}</style>

      {/* All tabs share the full available width so switching views keeps
          the page edges and navigation in the same position. */}
      <div className="w-full max-w-none">
        <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span
              onClick={tapCampaignName}
              className="text-[11px] tracking-[0.2em] uppercase select-none"
              style={{ color: "#5ec8d8", fontFamily: "'Rajdhani', sans-serif", cursor: "default" }}
            >
              {ledger.campaign || "Untitled Campaign"}
            </span>
          </div>
        </div>

        {party.length > 0 && (
          <div className="flex gap-1.5 mb-4 flex-wrap">
            {party.map((p, i) => visibilityOverrides[characterTabKey(p)] ? null : (
              <button
                key={i}
                onClick={() => { setActiveIdx(i); setViewMode("character"); }}
                className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                style={{
                  color: viewMode === "character" && activeIdx === i ? "#101315" : "#e7e2d2",
                  background: viewMode === "character" && activeIdx === i ? "#5ec8d8" : "transparent",
                  borderColor: viewMode === "character" && activeIdx === i ? "#5ec8d8" : "#3a3f42",
                  fontFamily: "'Rajdhani', sans-serif", fontWeight: 600,
                }}
              >
                {p.name || `Character ${i + 1}`}
              </button>
            ))}
            {party.length > 1 && !visibilityOverrides["tab:party"] && (
              <button
                onClick={() => setViewMode("party")}
                className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                style={{
                  color: viewMode === "party" ? "#101315" : "#e7e2d2",
                  background: viewMode === "party" ? "#ffb000" : "transparent",
                  borderColor: viewMode === "party" ? "#ffb000" : "#3a3f42",
                  fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                }}
              >
                ⚔ Party View
              </button>
            )}
            {!visibilityOverrides["tab:dice"] && (
              <button
                onClick={() => setViewMode("dice")}
                className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                style={{
                  color: viewMode === "dice" ? "#101315" : "#e7e2d2",
                  background: viewMode === "dice" ? "#5ec8d8" : "transparent",
                  borderColor: viewMode === "dice" ? "#5ec8d8" : "#3a3f42",
                  fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                }}
              >
                🎲 Dice Roller
              </button>
            )}
            {!visibilityOverrides["tab:wiki"] && (
              <button
                onClick={() => setViewMode("wiki")}
                className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                style={{
                  color: viewMode === "wiki" ? "#101315" : "#e7e2d2",
                  background: viewMode === "wiki" ? "#5ec8d8" : "transparent",
                  borderColor: viewMode === "wiki" ? "#5ec8d8" : "#3a3f42",
                  fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                }}
              >
                📖 Wiki
              </button>
            )}
            {navVehicles.map((v) => {
              const on = viewMode === `vehicle:${v.id}`;
              return (
                <button
                  key={v.id}
                  onClick={() => setViewMode(`vehicle:${v.id}`)}
                  className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                  style={{
                    color: on ? "#101315" : "#e7e2d2",
                    background: on ? "#5ec8d8" : "transparent",
                    borderColor: on ? "#5ec8d8" : "#3a3f42",
                    fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                  }}
                  title={v.class || undefined}
                >
                  🚀 {v.name || "Vehicle"}
                </button>
              );
            })}
            {!visibilityOverrides["tab:map"] && (
              <button
                onClick={() => setViewMode("map")}
                className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                style={{
                  color: viewMode === "map" ? "#101315" : "#e7e2d2",
                  background: viewMode === "map" ? "#5ec8d8" : "transparent",
                  borderColor: viewMode === "map" ? "#5ec8d8" : "#3a3f42",
                  fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                }}
              >
                ▦ Battle Map
              </button>
            )}
            {!visibilityOverrides["tab:notes"] && (
              <button
                onClick={() => setViewMode("notes")}
                className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                title={unactionedNotes > 0 ? `${unactionedNotes} message${unactionedNotes === 1 ? "" : "s"} not yet actioned` : undefined}
                style={{
                  color: viewMode === "notes" ? "#101315" : "#e7e2d2",
                  background: viewMode === "notes" ? "#e0763a" : "transparent",
                  borderColor: viewMode === "notes" || unactionedNotes > 0 ? "#e0763a" : "#3a3f42",
                  fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                  // Pulses while any message hasn't been ticked as actioned.
                  // Stops while the inbox itself is open.
                  animation: unactionedNotes > 0 && viewMode !== "notes" ? "inboxPulse 1.6s ease-in-out infinite" : "none",
                }}
              >
                ✉ GM Inbox{unactionedNotes > 0 ? ` (${unactionedNotes})` : ""}
              </button>
            )}
            {gmRevealed && (
              <button
                onClick={() => setViewMode("gm")}
                className="text-[12px] tracking-wide px-3 py-1.5 border transition-colors"
                style={{
                  color: viewMode === "gm" ? "#101315" : "#e7e2d2",
                  background: viewMode === "gm" ? "#ffb000" : "transparent",
                  borderColor: viewMode === "gm" || gmPending > 0 ? "#ffb000" : "#3a3f42",
                  fontFamily: "'Rajdhani', sans-serif", fontWeight: 700,
                  // Pulses while XP purchases or finished characters wait for approval.
                  animation: gmPending > 0 && viewMode !== "gm" ? "inboxPulse 1.6s ease-in-out infinite" : "none",
                }}
                title={gmPending > 0 ? `${gmPending} waiting for your approval` : undefined}
              >
                ★ GM{gmPending > 0 ? ` (${gmPending})` : ""}
              </button>
            )}
          </div>
        )}

        {!campaignStore.campaign && viewMode !== "gm" ? (
          <EmptyCampaignPanel
            status={campaignStore.status}
            error={campaignStore.error}
            isGm={gmRevealed}
            onOpenGm={() => setViewMode("gm")}
          />
        ) : viewMode === "dice" ? (
          <DiceRollerPanel
            playerName={playerName}
            setPlayerName={setPlayerName}
            preset={dicePreset}
            partyDestiny={partyDestinyUnknown ? null : partyDestiny}
            destinyLightSweepOn={destinyLightSweepOn}
            destinyDarkSweepOn={destinyDarkSweepOn}
            destinyLightDir={lc.destinyLightDir}
            destinyDarkDir={lc.destinyDarkDir}
            initiative={live.initiative}
            party={party}
            manual={manual}
            gmKey={gmAuth.state === "in" ? gmAuth.key : null}
          />
        ) : viewMode === "wiki" ? (
          <WikiPanel url={ledger.wikiUrl} />
        ) : viewMode.startsWith("vehicle:") ? (
          <VehicleTab
            key={viewVehicle?.id || "none"}
            vehicle={viewVehicle}
            party={party}
            partySkillSets={partySkillSets}
            live={live}
            loadSkillIntoRoller={loadSkillIntoRoller}
            manual={manual}
          />
        ) : viewMode === "map" ? (
          <BattleSession roster={party} enemyStore={enemyStore} mapStore={mapStore} isGm={gmAuth.state === "in"} gmKey={gmAuth.key} manual={manual} initiative={live.initiative} partyDestiny={partyDestinyUnknown ? null : partyDestiny} />
        ) : viewMode === "notes" ? (
          <GMNotesPanel />
        ) : viewMode === "gm" ? (
          <GmPanel
            auth={gmAuth}
            campaignStore={campaignStore}
            party={party}
            overrides={visibilityOverrides}
            onOverride={handleSetVisibility}
            onResetOverrides={handleResetVisibility}
            onHideTab={hideGmTab}
            manual={manual}
            vehicles={vehicles}
            enemyStore={enemyStore}
            gearStore={gearStore}
            editCharacterId={editCharacterId}
            onEditConsumed={() => setEditCharacterId("")}
          />
        ) : viewMode === "advancement" ? (
          <AdvancementPlanner
            character={active}
            skills={skills}
            talents={talents}
            xpAvailable={xp.available}
            onBack={() => setViewMode("character")}
            forceSensitive={activeForceSensitive}
          />
        ) : viewMode === "party" ? (
          <div className="relative overflow-hidden border" style={{ borderColor: "#3a3f42", background: "#16191b", boxShadow: "0 0 30px rgba(255,176,0,0.06)" }}>
            <div className="p-5 sm:p-7">
              <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#ffb000" }}>
                PARTY SKILL COMPARISON
              </div>
              <h1 className="text-2xl sm:text-3xl uppercase tracking-wide mb-4" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
                {ledger.campaign || "The Party"}
              </h1>

              <InitiativeTracker initiative={live.initiative} />

              <div className="border p-3 mb-4 flex items-center gap-6 flex-wrap" style={{ borderColor: "#ffb00055", background: "#ffb00009" }}>
                <div className="text-[11px] tracking-[0.2em] uppercase flex items-center gap-1.5" style={{ color: "#ffb000" }}>
                  <DestinyRulesTip>
                    Party Destiny Pool
                  </DestinyRulesTip>
                </div>
                {partyDestinyUnknown ? (
                  <span className="text-[11px] italic" style={{ color: "#5a5f62" }}>Connecting…</span>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5">
                      <DestinyTokens count={partyDestiny.light} src={BLUE_TOKEN} alt="Light Side Destiny Point" sweepActive={destinyLightSweepOn} sweepDir={lc.destinyLightDir} sweepColor="#8fd3f4" onFlip={() => manual.flipDestiny("light")} />
                      <span className="text-[11px]" style={{ color: "#8a8f93" }}>light</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <DestinyTokens count={partyDestiny.dark} src={RED_TOKEN} alt="Dark Side Destiny Point" sweepActive={destinyDarkSweepOn} sweepDir={lc.destinyDarkDir} sweepColor="#c23b3b" onFlip={() => manual.flipDestiny("dark")} />
                      <span className="text-[11px]" style={{ color: "#8a8f93" }}>dark</span>
                    </div>
                  </>
                )}
              </div>

              <div className="flex items-center gap-4 mb-4 text-[11px]" style={{ color: "#8a8f93" }}>
                <span className="flex items-center gap-1">
                  <img src={YELLOW_ICON} alt="Proficiency die" className="w-2.5 h-2.5 inline-block" /> proficiency dice
                </span>
                <span className="flex items-center gap-1">
                  <img src={GREEN_ICON} alt="Ability die" className="w-2.5 h-2.5 inline-block" /> ability dice
                </span>
                <span className="flex items-center gap-1" style={{ color: "#5ec8d8" }}><img src={BOOST_ICON} alt="Boost" style={{ width: 12, height: 12, display: "inline-block" }} /> talent boost die</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-[12px]" style={{ color: "#e7e2d2", minWidth: `${280 + party.length * 110}px` }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #2a2e31" }}>
                      <th className="text-left font-normal pb-2" style={{ color: "#5a5f62" }}></th>
                      {party.map((p, i) => (
                        <th key={i} className="text-left font-normal pb-2 px-2 text-[14px]" style={{ color: "#8a8f93", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
                          {p.name || `Character ${i + 1}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="pt-2 pb-1 text-[10px] tracking-[0.2em] uppercase" style={{ color: "#5a5f62" }}>Wounds</td>
                      {partyOverlays.map((o, i) => {
                        const liveId = party[i]?.liveId;
                        const sweepOn = !!liveId && (now - (lc.wounds[liveId] || 0)) < SWEEP_MS;
                        return (
                          <td key={i} className="relative pt-2 pb-1 px-2 mono-num text-[14px]" style={{ color: severityColor(o.wounds.current, o.wounds.threshold) }}>
                            {o.wounds.current ?? "—"} / {o.wounds.threshold}
                            <SweepOverlay active={sweepOn} dir={lc.woundsDir[liveId]} color="#c23b3b" />
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td className="py-1 text-[10px] tracking-[0.2em] uppercase" style={{ color: "#5a5f62" }}>Strain</td>
                      {partyOverlays.map((o, i) => {
                        const liveId = party[i]?.liveId;
                        const sweepOn = !!liveId && (now - (lc.strain[liveId] || 0)) < SWEEP_MS;
                        return (
                          <td key={i} className="relative py-1 px-2 mono-num text-[14px]" style={{ color: severityColor(o.strain.current, o.strain.threshold) }}>
                            <div>{o.strain.current ?? "—"} / {o.strain.threshold}</div>
                            {o.strain.obligationPenalty > 0 && (
                              <div className="mt-1"><ObligationStrainBadge base={o.strain.baseThreshold} penalty={o.strain.obligationPenalty} triggered={manual.obligationStrain?.triggeredId === liveId} /></div>
                            )}
                            <SweepOverlay active={sweepOn} dir={lc.strainDir[liveId]} color="#ffb000" />
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td className="py-1 text-[10px] tracking-[0.2em] uppercase" style={{ color: "#5a5f62" }}>Soak</td>
                      {party.map((p, i) => {
                        // Brawn + whichever armor this character currently has
                        // marked "worn" (see armorOptionsFor/pickWornArmor) —
                        // same live source the character tab's Soak stat uses,
                        // not the static ledger.json vitals.soak value.
                        const pid = p.liveId || p.name;
                        const worn = pickWornArmor(armorOptionsFor(pid, p, gearStore?.gear || []), manual.wornArmorOf(pid));
                        const soak = (p.characteristics?.brawn || 0) + armorSoakBonus(worn);
                        return <td key={i} className="py-1 px-2 mono-num text-[14px]" style={{ color: "#e7e2d2" }}>{soak}</td>;
                      })}
                    </tr>
                    <tr>
                      <td className="py-1 text-[10px] tracking-[0.2em] uppercase" style={{ color: "#5a5f62" }}>Defense (R/M)</td>
                      {party.map((p, i) => {
                        const pid = p.liveId || p.name;
                        const worn = pickWornArmor(armorOptionsFor(pid, p, gearStore?.gear || []), manual.wornArmorOf(pid));
                        const d = armorDefense(worn);
                        return <td key={i} className="py-1 px-2 mono-num text-[14px]" style={{ color: "#e7e2d2" }}>{d.ranged}/{d.melee}</td>;
                      })}
                    </tr>
                    <tr style={{ borderBottom: "1px solid #2a2e31" }}>
                      <td className="py-1 pb-2 text-[10px] tracking-[0.2em] uppercase" style={{ color: "#5a5f62" }}>Critical Injuries</td>
                      {party.map((p, i) => {
                        const liveCount = partyOverlays[i]?.criticalInjuriesLive?.length || 0;
                        const n = (p.vitals?.criticalInjuries || []).length + liveCount;
                        return (
                          <td
                            key={i}
                            className={`py-1 pb-2 px-2 text-[14px] ${n > 0 ? "cursor-pointer hover:opacity-70 transition-opacity" : ""}`}
                            onClick={n > 0 ? () => { setActiveIdx(i); setViewMode("character"); } : undefined}
                            title={n > 0 ? "Click to view this character's Critical Injuries" : undefined}
                          >
                            {n === 0 ? (
                              <span style={{ color: "#3a3f42" }}>—</span>
                            ) : (
                              <span className="flex items-center gap-1">
                                {Array.from({ length: Math.min(n, 5) }, (_, k) => (
                                  <span key={k} className="w-2.5 h-2.5 inline-block" style={{ background: "#c23b3b" }} />
                                ))}
                                {n > 5 && <span className="text-[12px] mono-num" style={{ color: "#c23b3b" }}>+{n - 5}</span>}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    <tr style={{ borderBottom: "1px solid #2a2e31" }}>
                      <td className="pt-3 pb-2 text-[10px] tracking-[0.2em] uppercase" style={{ color: "#5a5f62" }}>Unspent XP</td>
                      {party.map((p, i) => (
                        <td key={i} className="pt-3 pb-2 px-2">
                          <button
                            type="button"
                            onClick={() => { setActiveIdx(i); setViewMode("advancement"); }}
                            title="Open this character's Advancement Planner"
                            className="mono-num px-3 py-1 border transition-colors"
                            style={{ color: "#5ec8d8", borderColor: "#5ec8d866", background: "#5ec8d80d" }}
                            onMouseEnter={(event) => { event.currentTarget.style.borderColor = "#5ec8d8"; event.currentTarget.style.background = "#5ec8d81a"; }}
                            onMouseLeave={(event) => { event.currentTarget.style.borderColor = "#5ec8d866"; event.currentTarget.style.background = "#5ec8d80d"; }}
                          >
                            {p.xp?.available ?? 0}
                          </button>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td colSpan={party.length + 1} className="pt-3 pb-1 text-[10px] tracking-[0.2em] uppercase" style={{ color: "#5a5f62" }}>
                        Skill
                      </td>
                    </tr>
                    {["General", "Combat", "Knowledge"].flatMap((group) => {
                      const rows = partySkillNames.filter((s) => s.group === group);
                      if (rows.length === 0) return [];
                      return [
                        <tr key={`${group}-header`}>
                          <td colSpan={party.length + 1} className="pt-3 pb-1 text-[10px] tracking-[0.2em] uppercase" style={{ color: "#5a5f62" }}>
                            {group}
                          </td>
                        </tr>,
                        ...rows.map((skillDef) => (
                          <tr key={`${group}-${skillDef.name}`} style={{ borderTop: "1px solid #2a2e31" }}>
                            <td className="py-1.5 pr-3">
                              <SkillNameTip name={skillDef.name}>
                                <span>{skillDef.name} <span style={{ color: "#5a5f62" }}>({CHAR_ABBR[skillDef.char] || "?"})</span></span>
                              </SkillNameTip>
                            </td>
                            {partySkillSets.map((set, ci) => {
                              const s = set.find((x) => x.name === skillDef.name);
                              return (
                                <td key={ci} className="py-1.5 px-2">
                                  <button
                                    onClick={() => s && loadSkillIntoRoller(s, party[ci]?.name || `Character ${ci + 1}`)}
                                    title="Load into Dice Roller"
                                    className="hover:opacity-80 transition-opacity"
                                  >
                                    <SkillPips rank={s?.rank ?? 0} characteristic={s?.characteristic ?? 0} boost={s?.boost ?? 0} />
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        )),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
        <div
          className="relative overflow-hidden border"
          style={{ borderColor: "#3a3f42", background: "#16191b", boxShadow: "0 0 30px rgba(94,200,216,0.06)" }}
        >
          {!booted && <div className="boot-scan" />}

          <div className={`p-5 sm:p-7 ${booted ? "flicker-in" : ""}`}>
            <div className="flex items-start justify-between border-b pb-4 mb-5" style={{ borderColor: "#2a2e31" }}>
              <div className="flex items-start gap-4">
                {active.portrait ? (
                  // Fixed height, auto width: preserves whatever aspect ratio
                  // was uploaded (tall character-card art, a square headshot,
                  // a wide crop) instead of force-cropping everything into a
                  // square. max-w caps how wide an unusually wide image can
                  // get before it starts letterboxing (object-contain) rather
                  // than blowing out the header row.
                  <div className="relative group flex-shrink-0">
                    <img
                      src={active.portrait}
                      alt={`${active.name || "Character"} portrait`}
                      className="h-20 w-auto max-w-[5rem] object-contain border cursor-zoom-in"
                      style={{ borderColor: "#3a3f42", background: "#101315" }}
                    />
                    <div className="hidden group-hover:flex fixed inset-0 items-center justify-center pointer-events-none" style={{ zIndex: 130, background: "rgba(8,10,11,0.78)" }} aria-hidden="true">
                      <img src={active.portrait} alt="" className="max-w-[92vw] max-h-[92vh] object-contain border" style={{ borderColor: "#5ec8d8", background: "#101315", boxShadow: "0 16px 60px rgba(0,0,0,0.85)" }} />
                    </div>
                  </div>
                ) : (
                  <div
                    className="h-20 w-16 flex-shrink-0 border flex items-center justify-center text-center px-1"
                    style={{ borderColor: "#3a3f42", background: "#101315" }}
                  >
                    <span className="text-[9px] tracking-[0.1em] uppercase leading-tight" style={{ color: "#5a5f62" }}>Not Uploaded</span>
                  </div>
                )}
                <div>
                  <div className="text-[11px] tracking-[0.25em] uppercase mb-1" style={{ color: "#5ec8d8" }}>PERSONNEL FILE</div>
                  <h1 className="text-2xl sm:text-3xl uppercase tracking-wide" style={{ color: "#e7e2d2", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
                    {active.name || "Unknown"}
                  </h1>
                  <div className="text-[13px] mt-0.5" style={{ color: "#8a8f93" }}>
                    {[splitSpeciesText(active.species).race, active.career].filter(Boolean).join(" — ") || "—"}
                  </div>
                </div>
              </div>
              <div className="text-right text-[11px]" style={{ color: "#5a5f62" }}>
                <div>LAST UPDATE</div>
                <div className="mono-num" style={{ color: "#8a8f93" }}>
                  {active.updated ? new Date(active.updated).toLocaleString() : "—"}
                </div>
                {gmAuth.state === "in" && (
                  <button
                    type="button"
                    onClick={() => { setEditCharacterId(active.liveId || active.name); setViewMode("gm"); }}
                    className="mt-2 text-[10px] tracking-[0.15em] uppercase px-2 py-1 border"
                    style={{ color: "#ffb000", borderColor: "#ffb00066", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
                    title="Fix this sheet on the GM page"
                  >
                    ✎ Edit sheet (GM)
                  </button>
                )}
              </div>
            </div>

            <CharacterDescriptionField characterId={active.liveId || active.name} species={active.species} />

            <>
                {(mo.motivation || obligation.type) && (
                  <div className="space-y-3 mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
                    {mo.motivation && (
                      <Stat label="Motivation"><span className="text-[13px]" style={{ color: "#e7e2d2" }}>{mo.motivation}</span></Stat>
                    )}
                    {obligation.type && (
                      <Stat label="Obligation">
                        <span className="text-[13px]" style={{ color: "#e7e2d2" }}>
                          {obligation.type} <span className="mono-num" style={{ color: "#ffb000" }}>({obligation.value})</span>
                          {obligation.note ? ` — ${obligation.note}` : ""}
                        </span>
                      </Stat>
                    )}
                  </div>
                )}

                <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
                  <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>Hooks</div>
                  {Array.isArray(active.hooks) && active.hooks.length > 0 && (
                    <ul className="list-disc pl-4 space-y-1 mb-3">
                      {active.hooks.map((h, i) => (
                        <li key={i} className="text-[13px]" style={{ color: "#e7e2d2" }}>{h}</li>
                      ))}
                    </ul>
                  )}
                  <LiveNoteField
                    characterId={active.liveId || active.name}
                    field="hooksNote"
                    label="Notes"
                    placeholder="Flags, cooperation goals, or anything else that comes up in play"
                    maxLength={800}
                  />
                </div>

                <InitiativeTracker initiative={live.initiative} />

                <div className="border p-3 mb-4 flex items-center gap-6 flex-wrap" style={{ borderColor: "#ffb00055", background: "#ffb00009" }}>
                  <div className="text-[11px] tracking-[0.2em] uppercase flex items-center gap-1.5" style={{ color: "#ffb000" }}>
                    <DestinyRulesTip>
                      Destiny Pool (party)
                    </DestinyRulesTip>
                  </div>
                  {destinyUnknown ? (
                    <span className="text-[11px] italic" style={{ color: "#5a5f62" }}>Connecting…</span>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5">
                        <DestinyTokens count={destiny.light} src={BLUE_TOKEN} alt="Light Side Destiny Point" sweepActive={destinyLightSweepOn} sweepDir={lc.destinyLightDir} sweepColor="#8fd3f4" onFlip={() => manual.flipDestiny("light")} />
                        <span className="text-[11px]" style={{ color: "#8a8f93" }}>light</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <DestinyTokens count={destiny.dark} src={RED_TOKEN} alt="Dark Side Destiny Point" sweepActive={destinyDarkSweepOn} sweepDir={lc.destinyDarkDir} sweepColor="#c23b3b" onFlip={() => manual.flipDestiny("dark")} />
                        <span className="text-[11px]" style={{ color: "#8a8f93" }}>dark</span>
                      </div>
                    </>
                  )}
                </div>

                <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
                  <Stat label={`Wounds — ${wounds.current ?? "—"} / ${wounds.threshold}`}>
                    <div className="relative">
                      <PipRow
                        current={wounds.current}
                        threshold={wounds.threshold}
                        colorClass="#c23b3b"
                        scale={1.75}
                        onSet={active.liveId ? (n) => manual.setWound(active.liveId, n) : undefined}
                        onAdjust={active.liveId ? (d) => manual.adjustWound(active.liveId, d) : undefined}
                        overLabel="Incapacitated"
                      />
                      <SweepOverlay active={woundsSweepOn} dir={woundsDir} color="#c23b3b" />
                    </div>
                  </Stat>
                  <Stat label={(
                    <>
                      <span>Strain — {strain.current ?? "—"} / {strain.threshold}</span>
                      {strain.obligationPenalty > 0 && (
                        <ObligationStrainBadge base={strain.baseThreshold} penalty={strain.obligationPenalty} triggered={manual.obligationStrain?.triggeredId === activeId} />
                      )}
                    </>
                  )}>
                    <div className="relative">
                      <PipRow
                        current={strain.current}
                        threshold={strain.threshold}
                        colorClass="#ffb000"
                        scale={1.75}
                        onSet={active.liveId ? (n) => manual.setStrain(active.liveId, n) : undefined}
                        onAdjust={active.liveId ? (d) => manual.adjustStrain(active.liveId, d) : undefined}
                        overLabel="Unconscious"
                      />
                      <SweepOverlay active={strainSweepOn} dir={strainDir} color="#ffb000" />
                    </div>
                  </Stat>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 items-stretch">
                    <MetricBox
                      label={
                        <HoverLabel
                          title="Soak"
                          body="Reduces incoming damage before it becomes wounds. Equal to Brawn, plus armor/gear bonuses. Subtracted from each hit individually."
                        >
                          Soak
                        </HoverLabel>
                      }
                    >
                      <span className="text-xl mono-num" style={{ color: "#e7e2d2" }}>{computedSoak}</span>
                    </MetricBox>
                    <XPUnspentStat available={xp.available} onOpen={() => setViewMode("advancement")} />
                    <MetricBox label="Credits" accent="#ffb000">
                      <LiveCreditsField characterId={active.liveId || active.name} ledgerCredits={active.credits ?? 0} />
                    </MetricBox>
                  </div>
                </div>

                {(staticCrits.length > 0 || liveCrits.length > 0) && (
                  <div className="mb-5 p-3 border" style={{ borderColor: "#c23b3b44", background: "#c23b3b11" }}>
                    <div className="text-[11px] tracking-[0.2em] uppercase mb-1.5 flex items-center gap-1.5" style={{ color: "#c23b3b" }}>
                      Critical Injuries
                    </div>
                    <div className="space-y-1.5">
                      {staticCrits.map((crit, i) => <CriticalInjuryTile key={`s${i}`} text={crit} />)}
                      {liveCrits.map((crit, i) => <CriticalInjuryTile key={`l${i}`} text={crit} />)}
                    </div>
                  </div>
                )}

                <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#8a8f93" }}>Weapons</div>
                    {weapons.length > 0 && (
                      <div className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "#5a5f62" }}>
                        Click a card to load its pool
                      </div>
                    )}
                  </div>
                  {weapons.length === 0 ? (
                    <span className="text-[13px]" style={{ color: "#5a5f62" }}>No weapons recorded.</span>
                  ) : (
                    <div className="space-y-2.5">
                      {weapons.map((w, i) => {
                        // normalizeSkillName strips punctuation/case so "Ranged (Light)"
                        // (how the reference weapon data spells it), "Ranged: Light" (the
                        // sheet's own canonical spelling) and "Ranged Heavy" (a third
                        // spelling that turns up in a few reference entries) all match —
                        // a plain string-equality check here was the "skill not on sheet"
                        // bug for anything pulled from the fuzzy weapon lookup.
                        const weaponSkill = skills.find((s) => normalizeSkillName(s.name) === normalizeSkillName(w.skill));
                        // A talent like Precision can re-link a specific weapon's
                        // pool to a different characteristic than the skill's own
                        // canonical one (see FULL_SKILL_LIST) — e.g. Cunning
                        // instead of Brawn/Agility for a one-handed small weapon.
                        // This only swaps the die COUNT used for this weapon's
                        // pool display; the Skills section below is untouched, so
                        // a two-handed or heavy weapon that wouldn't qualify for
                        // the talent still reads normally against that skill.
                        const effectiveSkill = w.characteristicOverride && weaponSkill
                          ? { ...weaponSkill, characteristic: active.characteristics?.[w.characteristicOverride.toLowerCase()] ?? weaponSkill.characteristic }
                          : weaponSkill;
                        const wKey = itemQtyKey(activeId, w, "wpn");
                        return (
                          <WeaponCard
                            key={i}
                            weapon={w}
                            skill={effectiveSkill}
                            onLoad={(note, damage, adjustments) => loadSkillIntoRoller(effectiveSkill, active.name || "Unknown", note, damage, adjustments, { openBattleMap: true })}
                            qty={manual.qtyOf(wKey)}
                            onAdjustQty={(d) => manual.adjustQty(wKey, d)}
                            brawn={chars.brawn}
                          />
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-3.5 pt-3.5 border-t" style={{ borderColor: "#2a2e3166" }}>
                    <LiveNoteField
                      characterId={active.liveId || active.name}
                      field="weaponsNote"
                      label="Field Notes"
                      placeholder="e.g. picked up a second holdout blaster"
                      helper="Quick mid-session notes — not mechanical, just for the table to remember."
                    />
                  </div>
                </div>

                <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
                  <div className="text-[11px] tracking-[0.2em] uppercase mb-2 flex items-center gap-2" style={{ color: "#8a8f93" }}>
                    Armor
                    {armorOptions.length > 1 && (
                      <span className="normal-case tracking-normal text-[10px]" style={{ color: "#5a5f62" }}>— check which one's worn; Soak and Defense above follow it</span>
                    )}
                  </div>
                  {armorOptions.length === 0 ? (
                    <span className="text-[13px]" style={{ color: "#5a5f62" }}>No armor recorded.</span>
                  ) : (
                    armorOptions.map((a, i) => {
                      const isWorn = wornArmor?.id === a.id;
                      const showWornToggle = armorOptions.length > 1;
                      const def = armorDefense(a);
                      return (
                        <div key={a.id || i} className="text-[13px] flex items-baseline justify-between flex-wrap gap-x-5 gap-y-1.5 py-1.5" style={{ borderBottom: i < armorOptions.length - 1 ? "1px solid #2a2e3166" : "none" }}>
                          <span className="flex items-center gap-2" style={{ color: showWornToggle && !isWorn ? "#5a5f62" : "#e7e2d2" }}>
                            {showWornToggle && (
                              <input
                                type="checkbox"
                                checked={isWorn}
                                onChange={() => manual.setWornArmor(activeId, isWorn ? "" : a.id)}
                                title={isWorn ? "Currently worn — click to take it off" : "Mark as worn"}
                                style={{ accentColor: "#5ec8d8", cursor: "pointer" }}
                              />
                            )}
                            {a.name}
                            {a.isNew && <NewBadge size={18} />}
                            {showWornToggle && isWorn && (
                              <span className="text-[9px] uppercase tracking-[0.15em]" style={{ color: "#5ec8d8" }}>Worn</span>
                            )}
                          </span>
                          <span className="flex items-baseline gap-5">
                            <span className="inline-flex items-baseline gap-1.5">
                              <TipLabel text="Soak" title={STAT_TIPS.soak[0]} body={STAT_TIPS.soak[1]} />
                              <span className="mono-num" style={{ color: "#e7e2d2" }}>+{a.soakBonus || 0}</span>
                            </span>
                            <span className="inline-flex items-baseline gap-1.5">
                              <TipLabel text="Defense" title={STAT_TIPS.defense[0]} body={STAT_TIPS.defense[1]} width={300} align="right" />
                              <span className="mono-num" style={{ color: "#e7e2d2" }}>{def.ranged} Ranged / {def.melee} Melee</span>
                            </span>
                          </span>
                          {splitSpecial(a.special).length > 0 && (
                            <div className="w-full flex flex-wrap gap-1.5">
                              {splitSpecial(a.special).map((sp, k) => <SpecialChip key={k} text={sp} placement="below" />)}
                            </div>
                          )}
                          {a.note && <ExpandableText text={a.note} className="w-full text-[12px] block" style={{ color: "#5ec8d8" }} />}
                        </div>
                      );
                    })
                  )}
                  <div className="mt-3.5 pt-3.5 border-t" style={{ borderColor: "#2a2e3166" }}>
                    <LiveNoteField
                      characterId={active.liveId || active.name}
                      field="armorNote"
                      label="Field Notes"
                      placeholder="e.g. patched a scorch mark, plating feels looser than it should"
                      helper="Quick mid-session notes — not mechanical, just for the table to remember."
                    />
                  </div>
                </div>

                <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
                  <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>Characteristics</div>
                  <div className="overflow-x-auto">
                    <div className="grid grid-cols-6 gap-1.5 min-w-[360px]">
                      {CHAR_LABELS.map(([key, abbr]) => (
                        <div
                          key={key}
                          onMouseEnter={() => setHoveredChar(key)}
                          onMouseLeave={() => setHoveredChar(null)}
                          className="text-center border py-2"
                          style={{
                            borderColor: hoveredChar === key ? "#5ec8d8" : "#2a2e31",
                            cursor: "default",
                            transition: "border-color 150ms ease",
                          }}
                        >
                          <div className="text-[10px] tracking-widest" style={{ color: "#5a5f62" }}>{abbr}</div>
                          <div className="text-xl mono-num" style={{ color: "#e7e2d2" }}>{chars[key] ?? "—"}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
                  <div className="flex items-center justify-between mb-2 flex-wrap gap-y-1">
                    <div className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "#8a8f93" }}>Skills</div>
                    <div className="text-[11px] flex items-center gap-3">
                      <span className="flex items-center gap-1" style={{ color: "#8a8f93" }}>
                        <img src={YELLOW_ICON} alt="Proficiency die" className="w-2.5 h-2.5 inline-block" /> proficiency
                      </span>
                      <span className="flex items-center gap-1" style={{ color: "#8a8f93" }}>
                        <img src={GREEN_ICON} alt="Ability die" className="w-2.5 h-2.5 inline-block" /> ability
                      </span>
                      <span style={{ color: "#5ec8d8" }}>career skill</span>
                      <span className="inline-flex items-center gap-1" style={{ color: "#5ec8d8" }}><img src={BOOST_ICON} alt="Boost" style={{ width: 12, height: 12, display: "inline-block" }} /> talent boost</span>
                    </div>
                  </div>
                  {(() => {
                    // Left column holds General skills; right column holds
                    // Combat then Knowledge stacked underneath each other —
                    // matches the reference layout (two columns by group,
                    // not a 2-up wrap of every skill regardless of group).
                    const renderGroup = (group) => (
                      <div key={group} className="mb-3 last:mb-0">
                        <div className="text-[10px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "#5a5f62" }}>{group}</div>
                        <div className="grid gap-y-1">
                          {skills.filter((s) => s.group === group).map((s, i) => (
                            <button
                              key={i}
                              onClick={() => loadSkillIntoRoller(s, active.name || "Unknown")}
                              className="text-[13px] flex items-center justify-between gap-3 text-left hover:opacity-80 transition-opacity"
                              style={{
                                opacity: hoveredChar && s.char !== hoveredChar ? 0.3 : 1,
                                transition: "opacity 150ms ease",
                              }}
                            >
                              <SkillNameTip name={s.name}>
                                <span style={{ color: s.career ? "#5ec8d8" : "#e7e2d2" }}>
                                  {s.name} <span style={{ color: "#5a5f62" }}>({CHAR_ABBR[s.char] || "?"})</span>
                                </span>
                              </SkillNameTip>
                              <SkillPips rank={s.rank} characteristic={s.characteristic} boost={s.boost} />
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                    return (
                      <div className="grid sm:grid-cols-2 gap-x-6">
                        <div>{renderGroup("General")}</div>
                        <div>
                          {renderGroup("Combat")}
                          {renderGroup("Knowledge")}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="mb-5 pb-5 border-b" style={{ borderColor: "#2a2e31" }}>
                  <div className="text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: "#8a8f93" }}>Talents</div>
                  {talents.length === 0 ? (
                    <span className="text-[13px]" style={{ color: "#5a5f62" }}>No talents recorded.</span>
                  ) : (
                    <div className="space-y-2.5">
                      {talents.map((t, i) => (
                        <div key={i} className="text-[13px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2">
                              {t.tier != null && (
                                <span className="text-[10px] tracking-wide px-1.5 py-0.5" style={{ background: "#2a2e31", color: "#8fd3f4", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
                                  T{t.tier}
                                </span>
                              )}
                              <span style={{ color: "#e7e2d2", fontWeight: 600 }}>{t.name}</span>
                            </span>
                            {t.rank > 1 && <span className="mono-num" style={{ color: "#8fd3f4" }}>×{t.rank}</span>}
                          </div>
                          {t.description && (
                            <div className="text-[12px] leading-snug mt-0.5" style={{ color: "#8a8f93" }}><TalentRulesText text={t.description} size={13} /></div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-[11px] tracking-[0.2em] uppercase mb-1" style={{ color: "#8a8f93" }}>Inventory</div>
                  <div className="text-[11px] mb-2" style={{ color: "#5a5f62" }}>Weapons and armor are listed above, not repeated here.</div>
                  {inv.length === 0 ? (
                    <span className="text-[13px]" style={{ color: "#5a5f62" }}>No items recorded.</span>
                  ) : (
                    <div className="space-y-2">
                      {inv.map((item, i) => {
                        const invKey = itemQtyKey(activeId, item, "inv");
                        const invQty = manual.qtyOf(invKey);
                        return (
                          <div
                            key={i}
                            className="text-[13px] pb-2"
                            style={{ borderBottom: i < inv.length - 1 ? "1px solid #2a2e31" : "none", opacity: invQty <= 0 ? 0.5 : 1 }}
                          >
                            <div className="flex items-center gap-2 flex-wrap justify-between">
                              <span className="flex items-center gap-2" style={{ color: "#e7e2d2" }}>
                                <span>{item.name}</span>
                                {item.isNew && <NewBadge size={18} />}
                              </span>
                              <QtyStepper value={invQty} onAdjust={(d) => manual.adjustQty(invKey, d)} title="How many you're carrying — use this to track consumables" />
                            </div>
                            {item.note && <ExpandableText text={item.note} className="text-[12px] block mt-0.5" style={{ color: "#5ec8d8" }} />}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-3.5 pt-3.5 border-t" style={{ borderColor: "#2a2e3166" }}>
                    <LiveNoteField
                      characterId={active.liveId || active.name}
                      field="inventoryNote"
                      label="Field Notes"
                      placeholder="e.g. traded the spare power cell for ration bars"
                      helper="Quick mid-session notes — not mechanical, just for the table to remember."
                    />
                  </div>
                </div>

                <div className="pt-5 mt-5 border-t" style={{ borderColor: "#2a2e31" }}>
                  <GMNoteBox characterName={active.name} />
                </div>
              </>
          </div>
        </div>
        )}

      </div>
    </div>
  );
}
