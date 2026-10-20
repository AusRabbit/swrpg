// Character creation rules, shared by the player's creation wizard (App.jsx)
// and the Worker (worker/index.js), which re-runs them before the GM's
// approval adds the character to the campaign. Plain JavaScript with no
// React or browser APIs, so both sides import the same file and can never
// disagree about a cost.
//
// Data comes from public/data/chargen.json (species, careers and
// specialisations, built from the FFG wiki). Talents are this campaign's
// Genesys list (public/data/talents.json), bought at tier x 5 XP with the
// house pyramid rule, the same as the Advancement Planner.
//
// Rules applied (Star Wars FFG core rulebooks):
//   - Characteristics start at the species values. Raising one costs
//     10 x the new value, one step at a time, to a maximum of 5.
//   - Free skill ranks: species ranks; the career's free ranks (4 for an
//     eight-skill career, 3 for a six-skill one) on different career skills;
//     2 on different specialisation bonus skills. Droids get 2 more career
//     ranks and 1 more specialisation rank.
//   - No skill may go above rank 2 during creation.
//   - Buying a skill rank costs 5 x the new rank, plus 5 if it isn't a
//     career skill (career skills = the career's plus the specialisation's).
//   - Optional extra Obligation: +5 for +5 XP or +1,000 credits, or +10 for
//     +10 XP or +2,500 credits.

export const CHARACTERISTICS = ["brawn", "agility", "intellect", "cunning", "willpower", "presence"];
export const CHAR_LABEL = { brawn: "Brawn", agility: "Agility", intellect: "Intellect", cunning: "Cunning", willpower: "Willpower", presence: "Presence" };

export const ALL_SKILLS = [
  "Astrogation", "Athletics", "Charm", "Coercion", "Computers", "Cool", "Coordination", "Deception", "Discipline",
  "Leadership", "Mechanics", "Medicine", "Negotiation", "Perception", "Piloting: Planetary", "Piloting: Space",
  "Resilience", "Skulduggery", "Stealth", "Streetwise", "Survival", "Vigilance",
  "Brawl", "Gunnery", "Lightsaber", "Melee", "Ranged: Heavy", "Ranged: Light",
  "Knowledge: Core Worlds", "Knowledge: Education", "Knowledge: Lore", "Knowledge: Outer Rim",
  "Knowledge: Underworld", "Knowledge: Warfare", "Knowledge: Xenology",
];

export const CREATION_MAX_CHARACTERISTIC = 5;
export const CREATION_MAX_RANK = 2;
export const BASE_OBLIGATION = 10;
export const STARTING_CREDITS = 500;

export const OBLIGATION_BONUSES = [
  { key: "none", label: "No extra Obligation", obligation: 0, xp: 0, credits: 0 },
  { key: "xp5", label: "+5 Obligation for +5 XP", obligation: 5, xp: 5, credits: 0 },
  { key: "cr1000", label: "+5 Obligation for +1,000 credits", obligation: 5, xp: 0, credits: 1000 },
  { key: "xp10", label: "+10 Obligation for +10 XP", obligation: 10, xp: 10, credits: 0 },
  { key: "cr2500", label: "+10 Obligation for +2,500 credits", obligation: 10, xp: 0, credits: 2500 },
];

export function emptyDraft() {
  return {
    name: "", playerName: "", gender: "", age: "", description: "",
    species: "", speciesChoices: [], speciesFree: [], subspeciesNote: "",
    career: "", specialization: "",
    characteristics: {},
    freeCareer: [], freeSpec: [],
    bought: {},
    talents: [],
    motivation: { type: "", note: "" },
    obligation: { type: "", note: "" },
    obligationBonus: "none",
  };
}

export function characteristicCost(base, final) {
  let cost = 0;
  for (let v = base + 1; v <= final; v++) cost += 10 * v;
  return cost;
}

export function skillRankCost(newRank, isCareer) {
  return newRank * 5 + (isCareer ? 0 : 5);
}

export function talentCost(tier) {
  return (Number(tier) || 0) * 5;
}

// House pyramid rule (see the Advancement Planner): every tier that has a
// talent must have strictly fewer talents than the tier below it.
export function pyramidLegal(counts) {
  for (let t = 2; t <= 5; t++) {
    if ((counts[t] || 0) > 0 && (counts[t] || 0) >= (counts[t - 1] || 0)) return false;
  }
  return true;
}

export function slugId(name, taken = []) {
  const base = String(name || "pc").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "pc";
  const used = new Set(taken.map((t) => String(t).toLowerCase()));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

export function findSpecies(data, name) {
  return (data?.species || []).find((s) => s.name === name) || null;
}
export function findCareer(data, name) {
  return (data?.careers || []).find((c) => c.name === name) || null;
}
export function findSpecialization(data, name) {
  return (data?.specializations || []).find((s) => s.name === name) || null;
}

// Specialisations open to a career: its own, plus universal ones.
export function specializationsFor(data, careerName) {
  return (data?.specializations || []).filter((s) => !s.careers?.length || s.careers.includes(careerName));
}

export function freeRankCounts(species, career, spec) {
  const droid = !!species?.droid;
  const careerCount = career ? Math.min((career.freeRanks || 4) + (droid ? 2 : 0), career.careerSkills.length) : 0;
  const specCount = spec ? Math.min(2 + (droid ? 1 : 0), (spec.bonusSkills || []).length) : 0;
  return { careerCount, specCount };
}

const uniq = (list) => [...new Set(list)];

// The whole build: what everything costs, what's wrong with it, and (when
// nothing is wrong) the finished character in the campaign's sheet shape.
// `errors` entries are { step, msg } so the wizard can show each one on the
// step that caused it.
export function computeBuild(draft, data, opts = {}) {
  const d = { ...emptyDraft(), ...(draft || {}) };
  const errors = [];
  const err = (step, msg) => errors.push({ step, msg });

  if (!String(d.name || "").trim()) err("concept", "Give the character a name.");

  const species = findSpecies(data, d.species);
  const career = findCareer(data, d.career);
  const spec = findSpecialization(data, d.specialization);
  if (!species) err("species", "Choose a species.");
  if (!career) err("career", "Choose a career.");
  if (!spec) err("career", "Choose a specialisation.");
  else if (career && spec.careers?.length && !spec.careers.includes(career.name)) err("career", `${spec.name} isn't a ${career.name} specialisation.`);

  const careerSkills = new Set([...(career?.careerSkills || []), ...(spec?.bonusSkills || [])]);
  const isCareer = (skill) => careerSkills.has(skill);

  // Characteristics
  const chars = {};
  let charCost = 0;
  for (const c of CHARACTERISTICS) {
    const base = species?.characteristics?.[c] ?? 1;
    const raw = Number(d.characteristics?.[c]);
    const val = Number.isFinite(raw) ? Math.round(raw) : base;
    if (val < base) err("characteristics", `${CHAR_LABEL[c]} can't go below the species value of ${base}.`);
    if (val > CREATION_MAX_CHARACTERISTIC) err("characteristics", `${CHAR_LABEL[c]} can't go above ${CREATION_MAX_CHARACTERISTIC} during creation.`);
    chars[c] = Math.max(base, Math.min(CREATION_MAX_CHARACTERISTIC, val));
    charCost += characteristicCost(base, chars[c]);
  }

  // Free ranks
  const ranks = {}; // skill -> { species, career, spec, bought }
  const add = (skill, key, n = 1) => {
    if (!ALL_SKILLS.includes(skill)) return;
    ranks[skill] = ranks[skill] || { species: 0, career: 0, spec: 0, bought: 0 };
    ranks[skill][key] += n;
  };
  if (species) {
    (species.skillRanks || []).forEach((s) => add(s, "species"));
    (species.skillChoices || []).forEach((options, i) => {
      const pick = d.speciesChoices?.[i];
      if (!pick || !options.includes(pick)) err("species", `Choose your free species rank: ${options.join(" or ")}.`);
      else add(pick, "species");
    });
    if (species.freeSkillChoice) {
      const rule = species.freeSkillChoice;
      const picks = uniq((d.speciesFree || []).filter((s) => ALL_SKILLS.includes(s)));
      if (picks.length !== rule.count) err("skills", `${species.name}: choose ${rule.count} free species skill rank${rule.count === 1 ? "" : "s"} (${rule.note})`);
      if (rule.rule === "non-career") picks.filter(isCareer).forEach((s) => err("skills", `${s} is a career skill; the ${species.name} free ranks must go on non-career skills.`));
      picks.slice(0, rule.count).forEach((s) => add(s, "species"));
    }
  }
  const { careerCount, specCount } = freeRankCounts(species, career, spec);
  const freeCareer = uniq((d.freeCareer || []).filter((s) => career?.careerSkills.includes(s)));
  const freeSpec = uniq((d.freeSpec || []).filter((s) => spec?.bonusSkills.includes(s)));
  if (career && freeCareer.length !== careerCount) err("skills", `Choose ${careerCount} different ${career.name} career skills for your free ranks (${freeCareer.length} chosen).`);
  if (spec && freeSpec.length !== specCount) err("skills", `Choose ${specCount} different ${spec.name} skills for your free ranks (${freeSpec.length} chosen).`);
  freeCareer.slice(0, careerCount).forEach((s) => add(s, "career"));
  freeSpec.slice(0, specCount).forEach((s) => add(s, "spec"));

  // Bought ranks
  let skillCost = 0;
  for (const [skill, nRaw] of Object.entries(d.bought || {})) {
    const n = Math.max(0, Math.round(Number(nRaw) || 0));
    if (!n || !ALL_SKILLS.includes(skill)) continue;
    const r = ranks[skill] || { species: 0, career: 0, spec: 0, bought: 0 };
    const free = r.species + r.career + r.spec;
    for (let k = 1; k <= n; k++) skillCost += skillRankCost(free + k, isCareer(skill));
    add(skill, "bought", n);
  }
  for (const [skill, r] of Object.entries(ranks)) {
    const total = r.species + r.career + r.spec + r.bought;
    if (total > CREATION_MAX_RANK) err("skills", `${skill} would be rank ${total}; no skill can go above ${CREATION_MAX_RANK} during creation.`);
  }

  // Talents
  const talents = (d.talents || []).filter((t) => t && t.name && Number(t.tier) >= 1 && Number(t.tier) <= 5);
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let talentCostTotal = 0;
  const seen = new Map();
  for (const t of talents) {
    counts[Number(t.tier)] += 1;
    talentCostTotal += talentCost(t.tier);
    const key = t.name.toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
    if (seen.get(key) > 1 && !/^yes$/i.test(String(t.ranked || ""))) err("talents", `${t.name} isn't a ranked talent, so it can only be taken once.`);
    if (t.force === "Yes" && !spec?.forceSensitive) err("talents", `${t.name} is a Force talent; only a Force-sensitive character can take it.`);
  }
  if (!pyramidLegal(counts)) err("talents", "Each talent tier needs fewer talents than the tier below it.");

  // Obligation bonus and XP
  const bonus = OBLIGATION_BONUSES.find((b) => b.key === d.obligationBonus) || OBLIGATION_BONUSES[0];
  const xpStart = (species?.startingXp || 0) + bonus.xp;
  const xpSpent = charCost + skillCost + talentCostTotal;
  const xpLeft = xpStart - xpSpent;
  if (xpLeft < 0) err("review", `That's ${-xpLeft} XP more than you have.`);
  if (!String(d.obligation?.type || "").trim()) err("story", "Give your Obligation a type (e.g. Debt, Bounty, Obsession).");
  if (!String(d.motivation?.type || "").trim()) err("story", "Give your Motivation a type (e.g. Ambition, Cause, Relationship).");

  const baseObligation = Number.isFinite(opts.baseObligation) ? opts.baseObligation : BASE_OBLIGATION;
  const result = {
    species, career, spec, careerSkills: [...careerSkills], ranks, counts: { careerCount, specCount },
    cost: { characteristics: charCost, skills: skillCost, talents: talentCostTotal, total: xpSpent },
    xpStart, xpLeft, bonus, errors, ok: errors.length === 0, character: null,
  };
  if (!species || !career || !spec) return result;

  // Finished character, in the campaign's sheet shape.
  const skills = ALL_SKILLS
    .map((name) => {
      const r = ranks[name];
      const rank = r ? r.species + r.career + r.spec + r.bought : 0;
      return { name, rank, career: isCareer(name) };
    })
    .filter((s) => s.rank > 0 || s.career);
  const talentList = [];
  for (const t of species.talents || []) talentList.push({ name: t, rank: 1, description: `${species.name} species ability. See ${species.wiki}` });
  for (const t of talents) {
    const existing = talentList.find((x) => x.name.toLowerCase() === t.name.toLowerCase() && x.tier === Number(t.tier));
    if (existing) { existing.rank += 1; continue; }
    talentList.push({
      name: t.name, tier: Number(t.tier), rank: 1,
      ranked: /^yes$/i.test(String(t.ranked || "")),
      activation: t.activation || "",
      description: t.text_swrpg || t.description || "",
    });
  }
  result.character = {
    name: String(d.name).trim().slice(0, 60),
    career: `${career.name} — ${spec.name}`,
    species: species.name + (d.subspeciesNote ? ` (${String(d.subspeciesNote).slice(0, 80)})` : ""),
    ...(spec.forceSensitive ? { forceSensitive: true } : {}),
    characteristics: chars,
    vitals: {
      wounds: { threshold: species.woundBase + chars.brawn },
      strain: { threshold: species.strainBase + chars.willpower },
      soak: chars.brawn,
    },
    xp: { available: Math.max(0, xpLeft), total: xpStart },
    credits: (Number.isFinite(opts.startingCredits) ? opts.startingCredits : STARTING_CREDITS) + bonus.credits,
    motivationObligation: {
      motivation: [d.motivation?.type, d.motivation?.note].filter(Boolean).join(" — ").slice(0, 600),
      obligation: {
        type: String(d.obligation?.type || "").slice(0, 60),
        value: baseObligation + bonus.obligation,
        note: String(d.obligation?.note || "").slice(0, 1500),
      },
    },
    skills,
    talents: talentList,
    weapons: [],
    armor: {},
    inventory: [],
    hooks: [],
    creation: {
      playerName: String(d.playerName || "").slice(0, 60),
      gender: String(d.gender || "").slice(0, 40),
      age: String(d.age || "").slice(0, 40),
      speciesWiki: species.wiki,
      specializationWiki: spec.wiki,
      freeRanks: { species: Object.entries(ranks).filter(([, r]) => r.species).map(([s]) => s), career: freeCareer, specialization: freeSpec },
      xpSpent: result.cost,
    },
  };
  return result;
}

// ---------------------------------------------------------------------------
// Spending XP after creation (the Advancement Planner's "Submit for
// approval"). Same costs as the planner: a skill rank is 5 x the new rank,
// plus 5 if it isn't a career skill, up to rank 5; a talent is tier x 5 XP
// with the house pyramid (each tier must hold fewer talent ranks than the
// tier below). The Worker prices a request when the player submits it, and
// again when the GM approves it, against the character as it is then.
// ---------------------------------------------------------------------------
export const ADVANCE_MAX_RANK = 5;

// Talent effects applied automatically when a purchase is approved. Anything
// else (Dedication's characteristic choice, Enduring's soak) the GM adjusts
// by hand.
export const TALENT_EFFECTS = {
  toughened: { wounds: 2 },
  grit: { strain: 1 },
};

export function normalizeSkillKey(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

export function talentRankCounts(talents) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const t of talents || []) {
    const tier = Number(t?.tier);
    if (tier >= 1 && tier <= 5) counts[tier] += Math.max(1, Number(t.rank) || 1);
  }
  return counts;
}

// request: { skills: { "Brawl": 2, ... } (target ranks), talents: [{ name, tier, ranked, force, activation, text_swrpg }] }
export function priceAdvancement(character, request, opts = {}) {
  const errors = [];
  const lines = [];
  let cost = 0;
  const current = new Map((character?.skills || []).map((s) => [normalizeSkillKey(s.name), s]));
  const skillTargets = {};
  for (const [nameRaw, targetRaw] of Object.entries(request?.skills || {})) {
    const name = ALL_SKILLS.find((s) => normalizeSkillKey(s) === normalizeSkillKey(nameRaw));
    if (!name) { errors.push(`Unknown skill: ${nameRaw}.`); continue; }
    const have = current.get(normalizeSkillKey(name));
    const from = Math.max(0, Number(have?.rank) || 0);
    const to = Math.round(Number(targetRaw) || 0);
    if (to <= from) continue;
    if (to > ADVANCE_MAX_RANK) { errors.push(`${name} can't go above rank ${ADVANCE_MAX_RANK}.`); continue; }
    const career = !!have?.career;
    let c = 0;
    for (let r = from + 1; r <= to; r++) c += skillRankCost(r, career);
    cost += c;
    skillTargets[name] = to;
    lines.push(`${name} ${from}→${to} (${career ? "career" : "non-career"}, ${c} XP)`);
  }
  const talents = (request?.talents || []).filter((t) => t && t.name);
  const counts = talentRankCounts(character?.talents);
  for (const t of talents) {
    const tier = Math.round(Number(t.tier) || 0);
    if (tier < 1 || tier > 5) { errors.push(`${t.name} needs a tier from 1 to 5.`); continue; }
    if (t.force === "Yes" && !opts.forceSensitive) errors.push(`${t.name} is a Force talent; only a Force-sensitive character can take it.`);
    const owned = (character?.talents || []).some((x) => String(x.name).toLowerCase() === String(t.name).toLowerCase());
    if (owned && !/^yes$/i.test(String(t.ranked || ""))) errors.push(`${t.name} isn't a ranked talent and is already on the sheet.`);
    counts[tier] += 1;
    cost += talentCost(tier);
    lines.push(`Tier ${tier} talent — ${t.name} (${talentCost(tier)} XP)`);
  }
  if (talents.length && !pyramidLegal(counts)) errors.push("That breaks the talent pyramid: each tier needs fewer talents than the tier below it.");
  if (!lines.length) errors.push("Nothing to buy.");
  const available = Math.max(0, Number(character?.xp?.available) || 0);
  if (cost > available) errors.push(`That costs ${cost} XP but only ${available} XP is available.`);
  return { ok: errors.length === 0, errors, cost, lines, skillTargets, talents };
}

// The character after an approved purchase.
export function applyAdvancement(character, priced, note = "") {
  const next = JSON.parse(JSON.stringify(character || {}));
  next.skills = Array.isArray(next.skills) ? next.skills : [];
  for (const [name, to] of Object.entries(priced.skillTargets)) {
    const s = next.skills.find((x) => normalizeSkillKey(x.name) === normalizeSkillKey(name));
    if (s) s.rank = to;
    else next.skills.push({ name, rank: to, career: false });
  }
  next.talents = Array.isArray(next.talents) ? next.talents : [];
  next.vitals = next.vitals || {};
  for (const t of priced.talents) {
    const tier = Math.round(Number(t.tier));
    const same = next.talents.find((x) => String(x.name).toLowerCase() === String(t.name).toLowerCase() && Number(x.tier) === tier);
    if (same) same.rank = (Number(same.rank) || 1) + 1;
    else next.talents.push({ name: t.name, tier, rank: 1, ranked: /^yes$/i.test(String(t.ranked || "")), activation: t.activation || "", description: t.text_swrpg || t.description || "" });
    const fx = TALENT_EFFECTS[String(t.name).toLowerCase()];
    if (fx?.wounds) next.vitals.wounds = { ...(next.vitals.wounds || {}), threshold: (Number(next.vitals.wounds?.threshold) || 0) + fx.wounds };
    if (fx?.strain) next.vitals.strain = { ...(next.vitals.strain || {}), threshold: (Number(next.vitals.strain?.threshold) || 0) + fx.strain };
  }
  next.xp = { ...(next.xp || {}), available: Math.max(0, (Number(next.xp?.available) || 0) - priced.cost) };
  next.xpLog = [...(Array.isArray(next.xpLog) ? next.xpLog : []), { at: new Date().toISOString(), amount: -priced.cost, note: [priced.lines.join("; "), note].filter(Boolean).join(" — ").slice(0, 600) }].slice(-200);
  next.updated = new Date().toISOString();
  return next;
}
