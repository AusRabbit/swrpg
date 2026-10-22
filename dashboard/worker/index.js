// Character creation rules and data, shared with the website (see
// src/chargen.js). The Worker re-runs the rules before a new character is
// added, so a player's browser can't hand it an impossible build.
import { computeBuild, priceAdvancement, applyAdvancement } from "../src/chargen.js";
import CHARGEN_DATA from "../public/data/chargen.json";

// This project deploys as a Cloudflare Worker with static assets (not a
// classic Pages project), so custom routes can't use the `functions/` folder
// convention. This is the actual Worker entry point (see "main" in
// wrangler.jsonc): it serves the shared Durable Object routes below (/manual,
// /rolls, /notes, /bio, /crew, /visibility, /enemies, /gear, /map) and falls
// back to serving the built static site (via the ASSETS binding) for
// everything else. Nothing here talks to GitHub.

// --- Shared dice roller log (Durable Object) --------------------------------
// Ephemeral, separate from the campaign ledger entirely. Previously backed by
// a KV namespace, which had two real problems in play: KV writes here were a
// non-atomic read-modify-write (GET the whole array, mutate in JS, PUT the
// whole array back), so two rolls posted within the same second or two could
// race — whichever PUT landed second silently overwrote the first, no merge,
// so one roll would just vanish. And KV reads are only *eventually*
// consistent across Cloudflare's edge, so a fresh roll could take anywhere
// up to ~60-120s to show up for someone polling from a different colo.
//
// A Durable Object fixes both. Every request for a given DO id is routed to
// one specific instance, and that instance handles requests strictly one at
// a time — true serialization, so the unshift/trim/persist below can never
// interleave with another POST the way the KV version's read-modify-write
// could. Its storage is also strongly consistent: a write is visible on the
// very next read, anywhere, with no propagation delay. We always route to
// one fixed instance (idFromName below), so there's exactly one
// always-current copy of the log, not a per-colo cache of it.
//
// Players' browsers still POST a roll after computing it client-side, and
// everyone viewing the dashboard still polls GET /rolls every 1.5s — the
// client-facing API is unchanged, only the storage underneath it.
//
// This never reads or writes ledger.json or the /manual store — Wounds/
// Strain/Destiny live in ManualLog below, XP on the character in CampaignLog.
//
// Setup: the RollLog class below is declared in the `migrations` block of
// wrangler.jsonc using `new_sqlite_classes`, which provisions it on Durable
// Objects' SQLite storage backend — available on the Workers Free plan
// (the older KV-backed Durable Object storage needs Workers Paid). No KV
// namespace is required for this anymore; the old ROLLS_KV binding can be
// removed once this is deployed and confirmed working.

const ROLL_LOG_MAX = 40;
const POOL_DRAFT_TTL_MS = 5 * 60 * 1000;
const CORS_HEADERS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "content-type, x-gm-key, x-admin-key" };
// Dice pool breakdown (per die type, e.g. { proficiency: 2, difficulty: 3,
// setback: 2, ... }) — stored alongside the summarised result so the shared
// log can render the actual pool as icons, not just the outcome. Sanitized
// to known die-type keys, non-negative integers, capped at a sane per-die
// maximum so a malformed/malicious body can't bloat a stored entry.
const POOL_KEYS = ["proficiency", "ability", "boost", "challenge", "difficulty", "setback", "force"];
// Per-die roll results (one entry per die actually rolled, e.g.
// { die: "proficiency", symbols: ["s", "a"] }) — stored alongside the pool
// counts so the shared log can show what each die landed on, not just the
// pool that was selected. Sanitized to known die/symbol keys and capped so
// a malformed/malicious body can't bloat a stored entry.
const SYMBOL_KEYS = ["s", "f", "a", "t", "tr", "d", "lp", "dp"];
// Pool counts are capped at 20 per die type (see the pool sanitizers below)
// and there are POOL_KEYS.length die types, so cap the stored per-die results
// at the most any accepted pool can roll. A fixed 20 truncated bigger pools.
const ROLL_ENTRY_MAX = POOL_KEYS.length * 20;
const SYMBOLS_PER_DIE_MAX = 4;
// Manually-added symbol counts from the dice roller's "Add dice results"
// panel (a GM-awarded Advantage, a Triumph off a talent, etc. folded into
// the roll without a die producing it) — stored alongside the entry so the
// shared log can show what was added by hand vs. actually rolled. Only the
// 6 symbol types the panel exposes (no lp/dp — those are Force-die only).
// Sanitized the same way as pool: known keys, non-negative integers, capped.
const MANUAL_SYMBOL_KEYS = ["s", "f", "a", "t", "tr", "d"];
// Utility-roll entries (D100 / Critical Injury / Critical Hit / Obligation
// buttons in the dice roller's "Utility rolls" section) piggyback on this
// same shared log so everyone at the table sees what came up, without
// pretending to be a narrative dice-pool roll. Deliberately not assigned to
// any character — `player` on these entries is a generic label ("Critical
// Injury", "Critical Hit", etc.), never a PC/NPC name, per the facilitator's
// "dumb button, don't record who it happens to" instruction. Sanitized the
// same way as everything else here: known kind, bounded numbers, truncated
// strings.
const UTILITY_KINDS = ["d100", "obligation", "critInjury", "critHit"];
// GM rolls. The /rolls route checks the GM key itself and passes the result
// to this Durable Object as the internal ROLL_GM_HEADER (any copy of that
// header sent by a browser is stripped first), so a player can't make their
// own roll show up as "GM:". gmTone picks the log entry's background colour
// so the table can tell what kind of NPC rolled: friend (blue), neutral
// (green) or enemy (red).
const ROLL_GM_HEADER = "x-roll-gm";
const GM_TONES = ["friend", "neutral", "enemy"];
function sanitizeGmTone(v) {
  return GM_TONES.includes(v) ? v : "enemy";
}

// Small shared sanitizers used by the newer Durable Objects below (Manual
// mode, the Enemy board, the Zone battle map). Kept terse and generic —
// clamp a number into range, truncate a string, coerce/generate a safe id.
function sInt(v, min, max, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sText(v, max) {
  return String(v ?? "").slice(0, max);
}

function sId(v) {
  // Row ids are generated client-side (crypto.randomUUID) purely so React
  // can key rows across reorders; they're never used to address storage.
  const t = String(v ?? "").slice(0, 40);
  return /^[A-Za-z0-9_-]+$/.test(t) ? t : crypto.randomUUID();
}

export class RollLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rolls = [];
    this.pools = {};
    // Hydrate from durable storage once, before this instance handles its
    // first request. blockConcurrencyWhile holds off every incoming request
    // until the callback resolves, so nothing can observe a half-loaded
    // this.rolls.
    this.ctx.blockConcurrencyWhile(async () => {
      this.rolls = (await this.ctx.storage.get("rolls")) || [];
      this.pools = (await this.ctx.storage.get("pools")) || {};
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      const cutoff = Date.now() - POOL_DRAFT_TTL_MS;
      const activePools = Object.values(this.pools).filter((draft) => draft.updatedAt > cutoff).sort((a, b) => b.updatedAt - a.updatedAt);
      if (activePools.length !== Object.keys(this.pools).length) {
        this.pools = Object.fromEntries(activePools.map((draft) => [draft.id, draft]));
        await this.ctx.storage.put("pools", this.pools);
      }
      return new Response(JSON.stringify({ rolls: this.rolls, pools: activePools }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }

    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      const clientId = String(body?.clientId ?? "").slice(0, 80);
      if (!/^[A-Za-z0-9_-]+$/.test(clientId)) {
        return new Response(JSON.stringify({ error: "Invalid pool client id" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      const pool = {};
      let hasDice = false;
      POOL_KEYS.forEach((key) => {
        const n = Number(body?.pool?.[key]);
        pool[key] = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20) : 0;
        if (pool[key] > 0) hasDice = true;
      });
      if (!hasDice) {
        delete this.pools[clientId];
      } else {
        const automaticResults = {};
        let hasAutomaticResults = false;
        MANUAL_SYMBOL_KEYS.forEach((key) => {
          const n = Number(body?.automaticResults?.[key]);
          automaticResults[key] = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20) : 0;
          if (automaticResults[key] > 0) hasAutomaticResults = true;
        });
        const damageValue = Number(body?.damage);
        this.pools[clientId] = {
          id: clientId,
          updatedAt: Date.now(),
          player: String(body?.player ?? "Unnamed").slice(0, 40),
          label: String(body?.label ?? "Custom pool").slice(0, 120),
          pool,
          weaponNote: body?.weaponNote ? String(body.weaponNote).slice(0, 200) : null,
          damage: Number.isFinite(damageValue) ? Math.max(0, Math.min(9999, Math.floor(damageValue))) : null,
          automaticResults: hasAutomaticResults ? automaticResults : null,
          updatedBy: "player",
          // Remembered so the pool still logs as a GM roll if someone rolls
          // it from the shared tray instead of the GM's own Roll button.
          gm: request.headers.get(ROLL_GM_HEADER) === "1",
          gmTone: request.headers.get(ROLL_GM_HEADER) === "1" ? sanitizeGmTone(body?.gmTone) : null,
        };
      }
      await this.ctx.storage.put("pools", this.pools);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
    }

    if (request.method === "PATCH") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      const clientId = String(body?.clientId ?? "").slice(0, 80);
      const existing = this.pools[clientId];
      if (!existing) return new Response(JSON.stringify({ error: "Shared pool not found" }), { status: 404, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      const pool = {};
      POOL_KEYS.forEach((key) => {
        const n = Number(body?.pool?.[key]);
        pool[key] = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20) : 0;
      });
      this.pools[clientId] = { ...existing, pool, updatedAt: Date.now(), updatedBy: "battlemap" };
      await this.ctx.storage.put("pools", this.pools);
      return new Response(JSON.stringify({ ok: true, pool: this.pools[clientId] }), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      const pool = {};
      POOL_KEYS.forEach((key) => {
        const n = Number(body?.pool?.[key]);
        pool[key] = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20) : 0;
      });

      const rolls = Array.isArray(body?.rolls)
        ? body.rolls.slice(0, ROLL_ENTRY_MAX).reduce((acc, r) => {
            if (!POOL_KEYS.includes(r?.die)) return acc;
            const symbols = Array.isArray(r?.symbols)
              ? r.symbols.filter((s) => SYMBOL_KEYS.includes(s)).slice(0, SYMBOLS_PER_DIE_MAX)
              : [];
            acc.push({ die: r.die, symbols });
            return acc;
          }, [])
        : [];

      let manual = null;
      if (body?.manual && typeof body.manual === "object") {
        const m = {};
        let any = false;
        MANUAL_SYMBOL_KEYS.forEach((key) => {
          const n = Number(body.manual[key]);
          const v = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20) : 0;
          m[key] = v;
          if (v > 0) any = true;
        });
        manual = any ? m : null;
      }

      let utility = null;
      if (body?.utility && typeof body.utility === "object") {
        const kind = UTILITY_KINDS.includes(body.utility.kind) ? body.utility.kind : null;
        if (kind) {
          const rollNum = Number(body.utility.roll);
          const table = Array.isArray(body.utility.table)
            ? body.utility.table.slice(0, 40).map((o) => ({
                name: String(o?.name ?? "").slice(0, 40),
                type: String(o?.type ?? "").slice(0, 40),
                value: Number.isFinite(Number(o?.value)) ? Math.max(0, Math.min(999, Math.floor(Number(o.value)))) : 0,
              }))
            : [];
          utility = {
            kind,
            roll: Number.isFinite(rollNum) ? Math.max(0, Math.min(9999, Math.floor(rollNum))) : 0,
            severity: String(body.utility.severity ?? "").slice(0, 40),
            name: String(body.utility.name ?? "").slice(0, 80),
            effect: String(body.utility.effect ?? "").slice(0, 500),
            baseRoll: Number.isFinite(Number(body.utility.baseRoll)) ? Math.max(0, Math.min(9999, Math.floor(Number(body.utility.baseRoll)))) : 0,
            modifier: Number.isFinite(Number(body.utility.modifier)) ? Math.max(0, Math.min(999, Math.floor(Number(body.utility.modifier)))) : 0,
            total: Number.isFinite(Number(body.utility.total)) ? Math.max(0, Math.min(999, Math.floor(Number(body.utility.total)))) : 0,
            triggered: body.utility.triggered ? String(body.utility.triggered).slice(0, 80) : null,
            triggeredIndex: Number.isInteger(body.utility.triggeredIndex) ? Math.max(-1, Math.min(40, body.utility.triggeredIndex)) : -1,
            double: !!body.utility.double,
            table,
          };
        }
      }

      // GM if the GM key came with this request, or if it's the GM's own
      // shared pool being rolled from the tray by someone else.
      const postClientId = String(body?.clientId ?? "").slice(0, 80);
      const sourceDraft = /^[A-Za-z0-9_-]+$/.test(postClientId) ? this.pools[postClientId] : null;
      const keyedGm = request.headers.get(ROLL_GM_HEADER) === "1";
      const isGm = keyedGm || !!sourceDraft?.gm;
      const gmTone = keyedGm ? sanitizeGmTone(body?.gmTone) : (isGm ? sanitizeGmTone(sourceDraft?.gmTone) : null);

      const entry = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        player: String(body?.player ?? "Unknown").slice(0, 40),
        gm: isGm,
        gmTone,
        poolLabel: String(body?.poolLabel ?? "").slice(0, 200),
        weaponNote: body?.weaponNote ? String(body.weaponNote).slice(0, 200) : null,
        pool,
        rolls,
        manual,
        netSuccess: Number.isFinite(body?.netSuccess) ? body.netSuccess : 0,
        netAdvantage: Number.isFinite(body?.netAdvantage) ? body.netAdvantage : 0,
        triumph: Number.isFinite(body?.triumph) ? body.triumph : 0,
        despair: Number.isFinite(body?.despair) ? body.despair : 0,
        lightPoint: Number.isFinite(body?.lightPoint) ? Math.max(0, Math.min(40, Math.floor(body.lightPoint))) : 0,
        darkPoint: Number.isFinite(body?.darkPoint) ? Math.max(0, Math.min(40, Math.floor(body.darkPoint))) : 0,
        damage: Number.isFinite(body?.damage) ? Math.max(0, Math.min(9999, Math.floor(body.damage))) : null,
        utility,
      };

      // A Durable Object instance processes one request to completion before
      // starting the next, so this read-modify-write is safe from the race
      // that affected the KV version — no other POST can interleave here.
      this.rolls.unshift(entry);
      this.rolls = this.rolls.slice(0, ROLL_LOG_MAX);
      const rollClientId = String(body?.clientId ?? "").slice(0, 80);
      const clearsSharedPool = /^[A-Za-z0-9_-]+$/.test(rollClientId) && !!this.pools[rollClientId];
      if (clearsSharedPool) delete this.pools[rollClientId];
      await Promise.all([
        this.ctx.storage.put("rolls", this.rolls),
        ...(clearsSharedPool ? [this.ctx.storage.put("pools", this.pools)] : []),
      ]);

      return new Response(JSON.stringify({ ok: true, entry }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    if (request.method === "DELETE") {
      this.rolls = [];
      await this.ctx.storage.put("rolls", []);
      return new Response(JSON.stringify({ ok: true, rolls: [] }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
}

// --- Shared GM notes log (Durable Object) -----------------------------------
// Same pattern and same reasons as RollLog above (serialized writes, strongly
// consistent reads, one fixed instance shared by the whole campaign). Players
// submit short free-text notes from the character sheet (e.g. desired XP
// spends); the GM reads them from a "GM Inbox" panel. Ephemeral and separate
// from the ledger — the GM still actions notes manually in the ledger repo,
// this is just the inbox.
const NOTES_LOG_MAX = 40;
const NOTE_TEXT_MAX = 500;

export class NotesLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.notes = [];
    this.ctx.blockConcurrencyWhile(async () => {
      this.notes = (await this.ctx.storage.get("notes")) || [];
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ notes: this.notes }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      // Toggling/setting the "actioned" tick on an existing note is a
      // distinct operation from creating one — recognized by an id with no
      // text field, so a normal "create" POST (which always sends text)
      // can never be misread as an update. Actioned notes stay in the
      // inbox (dimmed, ticked) until the GM explicitly dismisses them —
      // unlike DELETE below, this never removes anything.
      if (body?.id && body.text === undefined) {
        const note = this.notes.find((n) => n.id === body.id);
        if (!note) {
          return new Response(JSON.stringify({ error: "Note not found" }), { status: 404, headers: { "content-type": "application/json", ...CORS_HEADERS } });
        }
        note.actioned = !!body.actioned;
        await this.ctx.storage.put("notes", this.notes);
        return new Response(JSON.stringify({ ok: true, entry: note }), {
          status: 200,
          headers: { "content-type": "application/json", ...CORS_HEADERS },
        });
      }

      const text = String(body?.text ?? "").trim().slice(0, NOTE_TEXT_MAX);
      if (!text) {
        return new Response(JSON.stringify({ error: "Note text is required" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      const entry = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        player: String(body?.player ?? "Unknown").slice(0, 40),
        text,
        read: false,
        actioned: false,
      };

      this.notes.unshift(entry);
      this.notes = this.notes.slice(0, NOTES_LOG_MAX);
      await this.ctx.storage.put("notes", this.notes);

      return new Response(JSON.stringify({ ok: true, entry }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    if (request.method === "DELETE") {
      let id = null;
      try {
        const body = await request.json();
        id = body?.id ?? null;
      } catch {
        // no body / not JSON -> treat as "clear all"
      }

      if (id) {
        this.notes = this.notes.filter((n) => n.id !== id);
      } else {
        this.notes = [];
      }
      await this.ctx.storage.put("notes", this.notes);
      return new Response(JSON.stringify({ ok: true, notes: this.notes }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
}

// --- Shared character description field (Durable Object) -------------------
// Same serialized-writes / strongly-consistent-reads pattern as RollLog and
// NotesLog above, but this one is an upsert-by-key store rather than an
// append-only log: a small set of free-text notes per character, keyed by
// that character's liveId (the client falls back to the character's name if
// liveId isn't set). Originally just the Character tab's "Description"
// field (size, colour, appearance etc.); now also backs three "dumb" — no
// parsing, no mechanical effect — mid-play note fields at the bottom of the
// Weapons/Armor/Inventory sections, so players can jot things down (e.g.
// "picked up a second holdout blaster") without waiting on the GM. Players
// fill these in themselves and every viewer of the dashboard sees the same
// shared value. Entirely separate from ledger.json and the /manual store: the ledger
// stays authoritative for everything mechanical, this is just player-
// editable flavour/scratch text layered on top.
//
// Each character's entry is a small object keyed by field name:
// { description, weaponsNote, armorNote, inventoryNote }. Older saves from
// before this field split stored the description as a plain string — GET
// below normalizes that shape on the way out (read-time only, no rewrite),
// so existing saved descriptions keep working with no migration step.
const BIO_TEXT_MAX = 500;
const BIO_KEY_MAX = 60;
// "credits" is the player-editable credit balance on the Character tab,
// stored as a small JSON string {"value": n, "base": ledgerCredits} — see
// LiveCreditsField in App.jsx.
const BIO_FIELDS = ["description", "weaponsNote", "armorNote", "inventoryNote", "hooksNote", "credits"];

export class BioLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.bios = {};
    this.ctx.blockConcurrencyWhile(async () => {
      this.bios = (await this.ctx.storage.get("bios")) || {};
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    // Bulk restore from a campaign import (only reachable from the Worker
    // itself: no public route forwards this path).
    if (new URL(request.url).pathname === "/__restore" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const incoming = body.bios && typeof body.bios === "object" ? body.bios : {};
      const next = body.merge ? { ...this.bios } : {};
      for (const [rawId, entry] of Object.entries(incoming).slice(0, 200)) {
        const id = String(rawId).trim().slice(0, BIO_KEY_MAX);
        if (!id || !entry || typeof entry !== "object") continue;
        const clean = {};
        for (const f of BIO_FIELDS) {
          const t = String(entry[f] ?? "").trim().slice(0, BIO_TEXT_MAX);
          if (t) clean[f] = t;
        }
        if (Object.keys(clean).length) next[id] = clean;
        else if (body.merge) delete next[id];
      }
      this.bios = next;
      await this.ctx.storage.put("bios", this.bios);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (request.method === "GET") {
      const normalized = {};
      for (const [key, value] of Object.entries(this.bios)) {
        normalized[key] = typeof value === "string" ? { description: value } : value;
      }
      return new Response(JSON.stringify({ bios: normalized }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      const characterId = String(body?.characterId ?? "").trim().slice(0, BIO_KEY_MAX);
      if (!characterId) {
        return new Response(JSON.stringify({ error: "characterId is required" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      const field = BIO_FIELDS.includes(body?.field) ? body.field : "description";
      const text = String(body?.text ?? "").trim().slice(0, BIO_TEXT_MAX);

      const existing = this.bios[characterId];
      const entry = typeof existing === "string" ? { description: existing } : { ...(existing || {}) };

      // Empty text removes just that field rather than storing a blank
      // string, so a cleared field falls back to showing its placeholder
      // again for every viewer, not an intentionally-blank saved value.
      if (text) {
        entry[field] = text;
      } else {
        delete entry[field];
      }

      if (Object.keys(entry).length > 0) {
        this.bios[characterId] = entry;
      } else {
        delete this.bios[characterId];
      }
      await this.ctx.storage.put("bios", this.bios);

      return new Response(JSON.stringify({ ok: true, characterId, field, text }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
}

// --- Shared vehicle crew assignments (Durable Object) -----------------------
// Same upsert-by-key pattern as BioLog above, but the key is a vehicle crew
// position id (e.g. "pilot", "gunner") from ledger.json's vehicle.crewPositions,
// and the value is the assigned character's liveId (or name, if that
// character has no liveId). Lets any player claim a seat from a dropdown on
// the Vehicle tab and have it sync live for everyone — the GM never has to
// hand-edit anything for crew assignments to update, same as wounds/strain/
// destiny in the /manual store. Entirely separate from ledger.json: this is just "who's sitting where" layered on top
// of the static ship profile.
const CREW_KEY_MAX = 60;

export class CrewLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.crew = {};
    this.ctx.blockConcurrencyWhile(async () => {
      this.crew = (await this.ctx.storage.get("crew")) || {};
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    // Bulk restore from a campaign import (only reachable from the Worker
    // itself: no public route forwards this path).
    if (new URL(request.url).pathname === "/__restore" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const incoming = body.crew && typeof body.crew === "object" ? body.crew : {};
      const next = {};
      for (const [k, v] of Object.entries(incoming).slice(0, 500)) {
        const key = String(k).trim().slice(0, CREW_KEY_MAX);
        const val = String(v ?? "").trim().slice(0, CREW_KEY_MAX);
        if (key && val) next[key] = val;
      }
      this.crew = next;
      await this.ctx.storage.put("crew", this.crew);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ crew: this.crew }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      const positionId = String(body?.positionId ?? "").trim().slice(0, CREW_KEY_MAX);
      if (!positionId) {
        return new Response(JSON.stringify({ error: "positionId is required" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      const characterId = String(body?.characterId ?? "").trim().slice(0, CREW_KEY_MAX);

      // Empty characterId clears the seat entirely rather than storing a
      // blank string, so an unassigned seat falls back to the "— Unassigned
      // —" option for every viewer, not an intentionally-blank saved value.
      if (characterId) {
        this.crew[positionId] = characterId;
      } else {
        delete this.crew[positionId];
      }
      await this.ctx.storage.put("crew", this.crew);

      return new Response(JSON.stringify({ ok: true, positionId, characterId, crew: this.crew }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
}

// --- GM auth ------------------------------------------------------------
// Each campaign has its own GM password (set from the front page's Manage
// campaigns, stored hashed in CampaignRegistry), sent by the GM's browser
// as the x-gm-key header. The site's master password (the ADMIN_PASSWORD
// secret, or GM_PASSWORD if that's all that's set) also works everywhere. No sessions, no rotation, no
// per-user identity — the only thing this buys, and the only thing that
// actually matters, is that the Worker can tell a GM request from a player
// request server-side. A hand-typed password compared in the browser
// wouldn't add anything a curious player couldn't already see in devtools.
//
// This campaign's ledger.json is a public static asset already fetched in
// full by every browser (see the ASSETS fallback below), so this key does
// NOT make a weapon or inventory item's underlying stats secret the way a
// redacted API response would — see VisibilityLog's comment below for what
// this mechanism does and doesn't buy you.
const GM_HEADER = "x-gm-key";

// Constant-time-ish comparison — a timing attack is a silly thing to worry
// about at this scale, but the correct comparison costs three lines.
function secretsMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Decided once per request by the campaign router (see checkGmKey below):
// the campaign's own GM password, or the site's master password.
function gmAuthorised(request, env) {
  return !!env.GM_OK;
}

function gmDenied(env) {
  return new Response(
    JSON.stringify({
      error: env.GM_CONFIGURED ? "Wrong GM key" : "This campaign has no GM password yet. Set one from the site's front page (Manage campaigns).",
      configured: !!env.GM_CONFIGURED,
    }),
    { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS } }
  );
}

// --- Live item-visibility overrides (Durable Object) ------------------------
// A weapon, armor or inventory item can be authored with `"hidden": true` in
// ledger.json — that part is unchanged, and is display-only: ledger.json is
// a public static asset, so a hidden item's name and stats already ship to
// every browser and simply aren't drawn. This store layers a *live* override
// on top of that baseline so the GM can flip an item's visibility mid-session
// from the GM tab without editing and redeploying ledger.json — e.g.
// revealing a weapon's true stats the moment a player finally identifies it.
//
// Same upsert-by-key pattern as BioLog/CrewLog. Keys are
// "<characterId>::<category>::<itemName>" (category: weapon/armor/
// inventory) — item name rather than array index, since items don't carry a
// stable id and names are what a GM actually recognises when toggling.
// Renaming an item in ledger.json orphans its override (falls back to the
// ledger's own `hidden` value) rather than following the rename; low-stakes
// for a home game, and simpler than trying to track identity across edits.
//
// GET is open to every browser (the Character tab needs to merge overrides
// into what it renders for players too, and nothing here reveals anything
// beyond the item name already present in the public ledger.json). Writing
// an override requires the GM key.
const VISIBILITY_KEY_MAX = 160;

export class VisibilityLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.overrides = {};
    this.ctx.blockConcurrencyWhile(async () => {
      this.overrides = (await this.ctx.storage.get("overrides")) || {};
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    // Bulk restore from a campaign import (only reachable from the Worker
    // itself: no public route forwards this path).
    if (new URL(request.url).pathname === "/__restore" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const incoming = body.overrides && typeof body.overrides === "object" ? body.overrides : {};
      const next = {};
      for (const [k, v] of Object.entries(incoming).slice(0, 2000)) {
        const key = String(k).trim().slice(0, VISIBILITY_KEY_MAX);
        if (key) next[key] = !!v;
      }
      this.overrides = next;
      await this.ctx.storage.put("overrides", this.overrides);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ overrides: this.overrides }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      const key = String(body?.key ?? "").trim().slice(0, VISIBILITY_KEY_MAX);
      if (!key) {
        return new Response(JSON.stringify({ error: "key is required" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      // clear: true removes the override entirely, falling back to
      // whatever ledger.json itself says for that item.
      if (body?.clear) {
        delete this.overrides[key];
      } else {
        this.overrides[key] = !!body?.hidden;
      }
      await this.ctx.storage.put("overrides", this.overrides);

      return new Response(JSON.stringify({ ok: true, overrides: this.overrides }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    if (request.method === "DELETE") {
      this.overrides = {};
      await this.ctx.storage.put("overrides", {});
      return new Response(JSON.stringify({ ok: true, overrides: {} }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
}

// --- Shared session state (Durable Object) ----------------------------------
// The single source of truth for live session state: Wounds, Strain, Destiny,
// Critical Injuries, the Vehicle's Hull Trauma/System Strain/Critical Hits,
// the initiative tracker, item counts and worn armor. Every browser polls
// GET /manual and POSTs changes here. It's deliberately open-write, same
// trust model as /rolls, /notes, /bio and /crew — anyone at the table can
// click +/- on their own box. GM_PASSWORD gates nothing here.
//
// (The stored shape still carries a legacy `enabled` flag from when this was
// an opt-in "Manual Mode" alongside data/live.json; the dashboard ignores it.)
// POSTs are a shallow per-field merge rather than a whole-document replace,
// so one browser flipping a single wound pip doesn't clobber another
// browser's in-flight destiny click.
const MANUAL_ID_MAX = 60;
const MANUAL_WOUND_MAX = 200;
const MANUAL_DESTINY_MAX = 20;
const MANUAL_CRIT_MAX = 20;
const MANUAL_INITIATIVE_MAX = 40;
const MANUAL_KIND_CHOICES = ["pc", "npc"];
// itemQty keys are "gear:<uuid>" or "<wpn|armor|inv>:<characterId>:<item name>"
// (see itemQtyKey in App.jsx) — longer than a plain liveId, so this gets its
// own, more generous length limit rather than reusing MANUAL_ID_MAX.
const MANUAL_QTY_KEY_MAX = 140;
const MANUAL_QTY_MAX = 999;
const MANUAL_QTY_ENTRIES_MAX = 500;
// wornArmor keys are characterId (a liveId or a bare character name), values
// are an armor option id — "ledger" for the ledger.json baseline, or a
// GearLog item's own uuid (see armorOptionsFor/pickWornArmor in App.jsx).
// Entry count is naturally bounded by party size, but capped anyway for the
// same reason MANUAL_QTY_ENTRIES_MAX is.
const MANUAL_WORN_ARMOR_KEY_MAX = 140;
const MANUAL_WORN_ARMOR_VALUE_MAX = 60;
const MANUAL_WORN_ARMOR_ENTRIES_MAX = 100;

function sManualCounterMap(raw, max) {
  const out = {};
  if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([k, v]) => {
      const id = String(k).slice(0, MANUAL_ID_MAX);
      if (!id) return;
      out[id] = sInt(v, 0, max, 0);
    });
  }
  return out;
}

// Unlike sManualCounterMap, this one is capped in ENTRY COUNT too
// (MANUAL_QTY_ENTRIES_MAX) — it grows one key per distinct item ever seen
// across the whole party, with nothing that ever prunes old keys, so it
// needs its own ceiling rather than trusting callers to keep it small.
function sManualQtyMap(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (Object.keys(out).length >= MANUAL_QTY_ENTRIES_MAX) break;
      const id = String(k).slice(0, MANUAL_QTY_KEY_MAX);
      if (!id) continue;
      out[id] = sInt(v, 0, MANUAL_QTY_MAX, 0);
    }
  }
  return out;
}

// Same shape as sManualQtyMap but for a string value rather than a clamped
// int — "" is a valid, meaningful value here (explicitly unarmored), so
// unlike the other maps this one doesn't filter anything out by value.
function sManualWornArmorMap(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (Object.keys(out).length >= MANUAL_WORN_ARMOR_ENTRIES_MAX) break;
      const id = String(k).slice(0, MANUAL_WORN_ARMOR_KEY_MAX);
      if (!id) continue;
      out[id] = sText(v, MANUAL_WORN_ARMOR_VALUE_MAX);
    }
  }
  return out;
}

function sManualCritMap(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([k, v]) => {
      const id = String(k).slice(0, MANUAL_ID_MAX);
      if (!id) return;
      out[id] = Array.isArray(v) ? v.map((n) => sInt(n, 1, 150, 1)).slice(0, MANUAL_CRIT_MAX) : [];
    });
  }
  return out;
}

const MANUAL_VEHICLES_MAX = 20;
function sVehicleLive(v, prev) {
  const p = prev || { hull: 0, systemStrain: 0, criticalHits: [] };
  return {
    hull: v?.hull != null ? sInt(v.hull, 0, MANUAL_WOUND_MAX, p.hull) : p.hull,
    systemStrain: v?.systemStrain != null ? sInt(v.systemStrain, 0, MANUAL_WOUND_MAX, p.systemStrain) : p.systemStrain,
    criticalHits: Array.isArray(v?.criticalHits) ? v.criticalHits.map((n) => sInt(n, 1, 150, 1)).slice(0, MANUAL_CRIT_MAX) : p.criticalHits,
  };
}
function sManualVehicles(raw, prev = {}) {
  const out = { ...prev };
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      const id = String(k).slice(0, MANUAL_ID_MAX);
      if (!id) continue;
      if (v === null) { delete out[id]; continue; }
      if (!(id in out) && Object.keys(out).length >= MANUAL_VEHICLES_MAX) continue;
      out[id] = sVehicleLive(v, out[id]);
    }
  }
  return out;
}

function sObligationStrain(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    active: !!value.active,
    triggeredId: sText(value.triggeredId, MANUAL_ID_MAX),
    triggeredName: sText(value.triggeredName, 80),
    multiplier: sInt(value.multiplier, 1, 2, 1),
    roll: sInt(value.roll, 0, 100, 0),
    penalties: sManualCounterMap(value.penalties, 10),
  };
}

function emptyManualState() {
  return {
    enabled: false,
    wounds: {},
    strain: {},
    destiny: { light: 0, dark: 0 },
    criticalInjuries: {},
    vehicle: { hull: 0, systemStrain: 0, criticalHits: [] },
    // One entry per campaign vehicle id (see CampaignLog's `vehicles`).
    // `vehicle` above is the old single-ship slot, kept only so an old
    // stored document still parses.
    vehicles: {},
    initiative: { order: [], taken: 0 },
    obligationStrain: sObligationStrain(null),
    // Live carried-quantity counters for weapons/armor/equipment — see
    // itemQtyKey in App.jsx. Independent of `enabled`: there's no
    // ledger.json baseline for "how many grenades are left" the way there
    // is for wounds/strain, so this is always live regardless of whether
    // Manual Mode itself is toggled on.
    itemQty: {},
    // Which armor each character currently has marked "worn" when they own
    // more than one — see armorOptionsFor/pickWornArmor in App.jsx. Same
    // always-live rule as itemQty above.
    wornArmor: {},
  };
}

function sanitizeInitiative(raw) {
  const entries = (Array.isArray(raw?.order) ? raw.order : [])
    .map((kind, index) => ({ kind, score: raw.results?.[index] }))
    .filter(({ kind }) => MANUAL_KIND_CHOICES.includes(kind))
    .slice(0, MANUAL_INITIATIVE_MAX);
  return {
    order: entries.map(({ kind }) => kind),
    results: entries.map(({ score }) => score && Number.isInteger(score.successes) && Number.isInteger(score.advantages) && score.successes >= 0 && score.advantages >= 0 && score.successes <= 999 && score.advantages <= 999 ? { successes: score.successes, advantages: score.advantages } : null),
    taken: sInt(raw?.taken, 0, entries.length, 0),
  };
}


function sanitizeManualState(raw) {
  const base = emptyManualState();
  if (!raw || typeof raw !== "object") return base;
  return {
    enabled: !!raw.enabled,
    wounds: sManualCounterMap(raw.wounds, MANUAL_WOUND_MAX),
    strain: sManualCounterMap(raw.strain, MANUAL_WOUND_MAX),
    destiny: {
      light: sInt(raw.destiny?.light, 0, MANUAL_DESTINY_MAX, 0),
      dark: sInt(raw.destiny?.dark, 0, MANUAL_DESTINY_MAX, 0),
    },
    criticalInjuries: sManualCritMap(raw.criticalInjuries),
    vehicle: {
      hull: sInt(raw.vehicle?.hull, 0, MANUAL_WOUND_MAX, 0),
      systemStrain: sInt(raw.vehicle?.systemStrain, 0, MANUAL_WOUND_MAX, 0),
      criticalHits: Array.isArray(raw.vehicle?.criticalHits)
        ? raw.vehicle.criticalHits.map((n) => sInt(n, 1, 150, 1)).slice(0, MANUAL_CRIT_MAX)
        : [],
    },
    vehicles: sManualVehicles(raw.vehicles),
    initiative: sanitizeInitiative(raw.initiative),
    obligationStrain: sObligationStrain(raw.obligationStrain),
    itemQty: sManualQtyMap(raw.itemQty),
    wornArmor: sManualWornArmorMap(raw.wornArmor),
  };
}

// Shallow per-field merge: a POST only needs to send the field(s) it's
// changing (e.g. `{ wounds: { pc1: 2 } }`), and every other field of the
// stored document is left untouched — including keys inside a nested map
// like `wounds`/`criticalInjuries` that the POST didn't mention.
function mergeManualState(prev, patch) {
  if (!patch || typeof patch !== "object") return prev;
  const next = { ...prev };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (patch.wounds && typeof patch.wounds === "object") {
    next.wounds = { ...prev.wounds, ...sManualCounterMap(patch.wounds, MANUAL_WOUND_MAX) };
  }
  if (patch.strain && typeof patch.strain === "object") {
    next.strain = { ...prev.strain, ...sManualCounterMap(patch.strain, MANUAL_WOUND_MAX) };
  }
  if (patch.destiny && typeof patch.destiny === "object") {
    next.destiny = {
      light: patch.destiny.light != null ? sInt(patch.destiny.light, 0, MANUAL_DESTINY_MAX, prev.destiny.light) : prev.destiny.light,
      dark: patch.destiny.dark != null ? sInt(patch.destiny.dark, 0, MANUAL_DESTINY_MAX, prev.destiny.dark) : prev.destiny.dark,
    };
  }
  if (patch.criticalInjuries && typeof patch.criticalInjuries === "object") {
    next.criticalInjuries = { ...prev.criticalInjuries, ...sManualCritMap(patch.criticalInjuries) };
  }
  if (patch.vehicle && typeof patch.vehicle === "object") {
    next.vehicle = {
      hull: patch.vehicle.hull != null ? sInt(patch.vehicle.hull, 0, MANUAL_WOUND_MAX, prev.vehicle.hull) : prev.vehicle.hull,
      systemStrain: patch.vehicle.systemStrain != null ? sInt(patch.vehicle.systemStrain, 0, MANUAL_WOUND_MAX, prev.vehicle.systemStrain) : prev.vehicle.systemStrain,
      criticalHits: Array.isArray(patch.vehicle.criticalHits)
        ? patch.vehicle.criticalHits.map((n) => sInt(n, 1, 150, 1)).slice(0, MANUAL_CRIT_MAX)
        : prev.vehicle.criticalHits,
    };
  }
  if (patch.vehicles && typeof patch.vehicles === "object") {
    next.vehicles = sManualVehicles(patch.vehicles, prev.vehicles || {});
  }
  if (patch.initiative && typeof patch.initiative === "object") {
    const hasOrder = Array.isArray(patch.initiative.order);
    next.initiative = sanitizeInitiative({
      order: hasOrder ? patch.initiative.order : prev.initiative.order,
      results: Array.isArray(patch.initiative.results) ? patch.initiative.results : hasOrder ? [] : prev.initiative.results,
      taken: patch.initiative.taken ?? prev.initiative.taken,
    });
  }
  if (patch.obligationStrain && typeof patch.obligationStrain === "object") {
    next.obligationStrain = sObligationStrain(patch.obligationStrain);
  }
  if (patch.itemQty && typeof patch.itemQty === "object") {
    // Same per-key merge as wounds/strain above, but re-cap the combined
    // result at MANUAL_QTY_ENTRIES_MAX afterwards — the incoming patch is
    // normally just one key, but the merge itself could otherwise grow
    // unbounded over a long campaign as new items keep getting picked up.
    const merged = { ...prev.itemQty, ...sManualQtyMap(patch.itemQty) };
    const keys = Object.keys(merged).slice(0, MANUAL_QTY_ENTRIES_MAX);
    next.itemQty = Object.fromEntries(keys.map((k) => [k, merged[k]]));
  }
  if (patch.wornArmor && typeof patch.wornArmor === "object") {
    // Same per-key merge/re-cap pattern as itemQty above. A normal POST here
    // is one key (the character picking a different armor, or taking
    // everything off), overwriting whatever that character's key held
    // before — that overwrite is what makes the checkboxes mutually
    // exclusive, since there's only ever one worn-armor id per character.
    const merged = { ...prev.wornArmor, ...sManualWornArmorMap(patch.wornArmor) };
    const keys = Object.keys(merged).slice(0, MANUAL_WORN_ARMOR_ENTRIES_MAX);
    next.wornArmor = Object.fromEntries(keys.map((k) => [k, merged[k]]));
  }
  return next;
}

export class ManualLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = emptyManualState();
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get("state");
      if (stored) this.state = sanitizeManualState(stored);
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify(this.state), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      this.state = mergeManualState(this.state, body);
      await this.ctx.storage.put("state", this.state);
      return new Response(JSON.stringify(this.state), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    if (request.method === "DELETE") {
      this.state = emptyManualState();
      await this.ctx.storage.put("state", this.state);
      return new Response(JSON.stringify(this.state), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
}

// --- Enemy board (Durable Object) -------------------------------------------
// The GM's combat tracker for whatever the party is currently fighting,
// stated in this system's own terms rather than a generic health bar:
// Minion / Rival / Nemesis, a Wound Threshold, Soak, and — Nemesis only — a
// Strain Threshold. Damage is entered raw and Soak is subtracted
// automatically, same as an NPC turn resolves at the table.
//
// Only the GM page can edit this (see gmAuthorised below); players get a
// redacted read-only view with Soak and exact thresholds stripped — see
// publicEnemyView.
const ENEMY_MAX = 30;
const ENEMY_KINDS = ["minion", "rival", "nemesis", "other"]; // other: a white token, soak and wounds only
const ENEMY_STAT_MAX = 60;
const ENEMY_MINION_COUNT_MAX = 20;

function sanitizeEnemies(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, ENEMY_MAX).map((e) => {
    const type = ENEMY_KINDS.includes(e?.type) ? e.type : "minion";
    const woundThreshold = sInt(e?.woundThreshold, 1, ENEMY_STAT_MAX, 5);
    const strainThreshold = type === "nemesis" ? sInt(e?.strainThreshold, 1, ENEMY_STAT_MAX, 10) : 0;
    // A minion group's total wound pool is woundThreshold * minionCount —
    // one minion's worth of wounds knocks one minion out of the group. Rival
    // and Nemesis are always a lone actor, so minionCount is pinned to 1.
    const minionCount = type === "minion" ? sInt(e?.minionCount, 1, ENEMY_MINION_COUNT_MAX, 1) : 1;
    const woundCapacity = woundThreshold * minionCount;
    // Every adversary type is only actually taken down once wounds EXCEED
    // capacity (see enemyStatus in App.jsx) — clamping the stored value AT
    // capacity here silently overwrote anything the GM set past it on the
    // next round-trip (the client shows the typed value immediately, then a
    // few seconds later the next /gm/enemies poll hands back this
    // over-clamped figure and it visibly reverts). The +ENEMY_STAT_MAX
    // headroom keeps a sanity ceiling without cutting off right at the
    // threshold the GM needs to cross.
    return {
      id: sId(e?.id),
      name: sText(e?.name, 60),
      type,
      soak: sInt(e?.soak, 0, ENEMY_STAT_MAX, 0),
      woundThreshold,
      minionCount,
      wounds: sInt(e?.wounds, 0, woundCapacity + ENEMY_STAT_MAX, 0),
      strainThreshold,
      strain: type === "nemesis" ? sInt(e?.strain, 0, strainThreshold + ENEMY_STAT_MAX, 0) : 0,
      hidden: !!e?.hidden,
      // A friendly NPC on the board (green token) rather than a foe.
      friendly: !!e?.friendly,
    };
  });
}

export class EnemyLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.enemies = [];
    this.ctx.blockConcurrencyWhile(async () => {
      this.enemies = (await this.ctx.storage.get("enemies")) || [];
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ enemies: this.enemies }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      if (!Array.isArray(body?.enemies)) {
        return new Response(JSON.stringify({ error: "enemies must be an array" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      this.enemies = sanitizeEnemies(body.enemies);
      await this.ctx.storage.put("enemies", this.enemies);
      return new Response(JSON.stringify({ ok: true, enemies: this.enemies }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    if (request.method === "DELETE") {
      this.enemies = [];
      await this.ctx.storage.put("enemies", []);
      return new Response(JSON.stringify({ ok: true, enemies: [] }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
}

function publicEnemyView(enemies) {
  return (enemies || [])
    .filter((e) => !e.hidden)
    .map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      woundThreshold: e.woundThreshold,
      minionCount: e.minionCount,
      wounds: e.wounds,
      strainThreshold: e.strainThreshold,
      strain: e.strain,
      friendly: !!e.friendly,
    }));
}

// --- GM-added gear (Durable Object) -----------------------------------------
// Field-acquired weapons/armor/equipment the GM adds to a character mid-
// session (via the reference/weapons.json-backed lookup on the GM page),
// separate from whatever ledger.json itself lists for that character — same
// reasoning as ENEMY_LOG: a live store the GM can add to and reveal without
// touching the ledger or redeploying. Every item is `hidden: true` by
// default so the GM can stage a pickup before the party has actually
// identified it, then flip it visible when appropriate — same
// hidden-by-default / reveal pattern as the enemy board.
const GEAR_MAX = 200;
const GEAR_CATEGORIES = ["weapon", "armor", "equipment"];
const GEAR_STAT_MAX = 60;
// Some reference "ability" text (see reference/armor.json, equipment.json)
// runs to several hundred characters — the character tab's ExpandableText
// twisty is what makes that safe to store in full rather than pre-clipping
// it server-side the way the old 200-char cap silently did.
const GEAR_NOTE_MAX = 2000;

// Weapon damage is normally a flat number, but Melee/Brawl/Lightsaber (and a
// few thrown) weapons are printed in the reference data — and by GMs typing
// ledger.json by hand — as "+N" or "Brawn+N", meaning Brawn + N rather than
// a flat N (see parseWeaponDamage/weaponDamageTotal in App.jsx, and
// reference/weapons.json). Routing that through sInt() would silently turn
// "+2" into a flat 2 and lose the Brawn addition entirely, so this keeps the
// "+" marker (normalized to "+N") instead of flattening it.
function sGearDamage(v) {
  if (typeof v === "string") {
    const s = v.trim();
    const m = s.match(/^\+\s*(\d+)$/) || s.match(/^brawn\s*\+\s*(\d+)$/i);
    if (m) return `+${sInt(m[1], 0, GEAR_STAT_MAX, 0)}`;
  }
  return sInt(v, 0, GEAR_STAT_MAX, 0);
}

const CHARACTERISTIC_NAMES = ["brawn", "agility", "intellect", "cunning", "willpower", "presence"];
function sanitizeGear(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, GEAR_MAX).map((g) => {
    const category = GEAR_CATEGORIES.includes(g?.category) ? g.category : "equipment";
    const base = {
      id: sId(g?.id),
      characterId: sText(g?.characterId, 80),
      category,
      name: sText(g?.name, 80),
      hidden: g?.hidden === false ? false : true, // defaults hidden unless explicitly revealed
      // When this was added, in epoch ms — drives the character tab's "New"
      // badge fading out on its own after a while (see NEW_BADGE_WINDOW_MS
      // in App.jsx) rather than staying on forever. 0 (not a valid
      // timestamp) rather than "now" for anything missing it, so an item
      // saved before this field existed doesn't suddenly read as fresh.
      addedAt: Number.isFinite(g?.addedAt) ? Math.max(0, Math.trunc(g.addedAt)) : 0,
    };
    if (category === "weapon") {
      return {
        ...base,
        skill: sText(g?.skill, 40),
        damage: sGearDamage(g?.damage),
        crit: sInt(g?.crit, 0, GEAR_STAT_MAX, 0),
        range: sText(g?.range, 20),
        special: sText(g?.special, 200) || "—",
        // A talent (Finesse, Precision…) letting this weapon use a different
        // characteristic: e.g. { characteristicOverride: "Cunning", overrideTalent: "Precision" }.
        ...(CHARACTERISTIC_NAMES.includes(String(g?.characteristicOverride || "").toLowerCase())
          ? { characteristicOverride: String(g.characteristicOverride).slice(0, 1).toUpperCase() + String(g.characteristicOverride).slice(1).toLowerCase(), overrideTalent: sText(g?.overrideTalent, 40) }
          : {}),
        ...(sText(g?.note, GEAR_NOTE_MAX) ? { note: sText(g?.note, GEAR_NOTE_MAX) } : {}),
      };
    }
    if (category === "armor") {
      return {
        ...base,
        soakBonus: sInt(g?.soakBonus, 0, GEAR_STAT_MAX, 0),
        defenseBonus: sInt(g?.defenseBonus, 0, GEAR_STAT_MAX, 0),
        // Separate ranged/melee defence from the GM page's manual armor
        // form. Absent (null) on older items and reference-index armor,
        // which fall back to defenseBonus for both.
        rangedDefense: g?.rangedDefense == null ? null : sInt(g.rangedDefense, 0, GEAR_STAT_MAX, 0),
        meleeDefense: g?.meleeDefense == null ? null : sInt(g.meleeDefense, 0, GEAR_STAT_MAX, 0),
        special: sText(g?.special, 200),
        note: sText(g?.note, GEAR_NOTE_MAX),
      };
    }
    return { ...base, note: sText(g?.note, GEAR_NOTE_MAX) };
  });
}

export class GearLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.gear = [];
    this.ctx.blockConcurrencyWhile(async () => {
      this.gear = (await this.ctx.storage.get("gear")) || [];
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ gear: this.gear }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      if (!Array.isArray(body?.gear)) {
        return new Response(JSON.stringify({ error: "gear must be an array" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      this.gear = sanitizeGear(body.gear);
      await this.ctx.storage.put("gear", this.gear);
      return new Response(JSON.stringify({ ok: true, gear: this.gear }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    if (request.method === "DELETE") {
      this.gear = [];
      await this.ctx.storage.put("gear", []);
      return new Response(JSON.stringify({ ok: true, gear: [] }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
}

// Redacted for players: hidden items are dropped entirely rather than just
// flagged, same as publicEnemyView — a hidden pickup shouldn't even hint at
// its own existence in the public payload.
function publicGearView(gear) {
  return (gear || []).filter((g) => !g.hidden);
}

// --- Battle map (Durable Object) --------------------------------------------
// Zone-based, not a fixed grid: the GM builds whatever shape the scene needs
// by adding/removing zone cells one at a time (see ZONE_MAX below), and each
// zone carries its own 5x5 sub-grid for placing tokens precisely within it.
// Storage is one flat list of zone coordinates plus a token map, same
// thin-store-nothing-derived philosophy as this project's other shared logs:
// who a token *is* comes from the roster/enemy board, never copied here.
//
// Enemy tokens can only be placed/moved by the GM (checked server-side by
// cross-referencing the enemy board — see the /map handler below); PC tokens
// are open to anyone, so the whole table can push its own token around.
const ZONE_MAX = 60;
const ZONE_COORD_MIN = -20;
const ZONE_COORD_MAX = 20;
const MAP_TOKENS_MAX = 60;
const MAP_ID_MAX = 60;
const SUBCELL_MAX = 3; // 0-3, a 4x4 sub-grid per zone
// Eight compass parking boxes just outside the zone grid — for tokens that
// are "out there, in that direction, too distant to matter right now"
// rather than sitting in an actual zone. A token here carries a `compass`
// field instead of zx/zy/sx/sy, plus `cs` (which of the box's 5 snap
// points it's on — see COMPASS_SUB_MAX), and is exempt from zone pruning
// (see pruneTokensOutsideZones) since it was never in a zone to begin with.
const COMPASS_DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const COMPASS_SUB_MAX = 4; // 0-4, five snap points per compass box

function zoneKey(x, y) {
  return `${x},${y}`;
}

// Default/reset shape: a 3x3 block of zones rather than a single square —
// keep this in sync with DEFAULT_ZONES in the dashboard's App.jsx.
const DEFAULT_ZONES = Array.from({ length: 3 }, (_, y) => Array.from({ length: 3 }, (_, x) => ({ x, y }))).flat();

function sanitizeZones(raw) {
  if (!Array.isArray(raw)) return DEFAULT_ZONES;
  const seen = new Set();
  const out = [];
  raw.slice(0, ZONE_MAX * 2).forEach((z) => {
    const x = sInt(z?.x, ZONE_COORD_MIN, ZONE_COORD_MAX, 0);
    const y = sInt(z?.y, ZONE_COORD_MIN, ZONE_COORD_MAX, 0);
    const key = zoneKey(x, y);
    if (seen.has(key) || out.length >= ZONE_MAX) return;
    seen.add(key);
    out.push({ x, y });
  });
  return out.length ? out : DEFAULT_ZONES;
}

export class ZoneMapLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.zones = DEFAULT_ZONES;
    this.tokens = {};
    this.ctx.blockConcurrencyWhile(async () => {
      this.zones = sanitizeZones((await this.ctx.storage.get("zones")) || null);
      const rawTokens = (await this.ctx.storage.get("tokens")) || {};
      // Re-clamp sub-cell coordinates on load in case they were written under
      // an older sub-grid size (e.g. the 3x3 layout this replaced) — without
      // this a token stranded past the current grid's edge would just never
      // match any cell in the current 4x4 grid and silently vanish from view.
      this.tokens = {};
      Object.keys(rawTokens).forEach((id) => {
        const t = rawTokens[id] || {};
        if (COMPASS_DIRS.includes(t.compass)) {
          this.tokens[id] = { compass: t.compass, cs: sInt(t.cs, 0, COMPASS_SUB_MAX, 0) };
          return;
        }
        this.tokens[id] = {
          zx: sInt(t.zx, ZONE_COORD_MIN, ZONE_COORD_MAX, 0),
          zy: sInt(t.zy, ZONE_COORD_MIN, ZONE_COORD_MAX, 0),
          sx: sInt(t.sx, 0, SUBCELL_MAX, 1),
          sy: sInt(t.sy, 0, SUBCELL_MAX, 1),
        };
      });
    });
  }

  async persist() {
    await this.ctx.storage.put("zones", this.zones);
    await this.ctx.storage.put("tokens", this.tokens);
  }

  // Dropping a zone also drops any token sitting in it, so a token can never
  // point at a cell that no longer exists. Compass-parked tokens (see
  // COMPASS_DIRS) were never in a zone, so they're untouched by this.
  pruneTokensOutsideZones() {
    const valid = new Set(this.zones.map((z) => zoneKey(z.x, z.y)));
    Object.keys(this.tokens).forEach((id) => {
      const t = this.tokens[id];
      if (t.compass) return;
      if (!valid.has(zoneKey(t.zx, t.zy))) delete this.tokens[id];
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ zones: this.zones, tokens: this.tokens }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      // Zone add/remove — GM only, enforced by the route handler below
      // (this DO trusts whatever calls it).
      if (body?.addZone) {
        const x = sInt(body.addZone.x, ZONE_COORD_MIN, ZONE_COORD_MAX, 0);
        const y = sInt(body.addZone.y, ZONE_COORD_MIN, ZONE_COORD_MAX, 0);
        if (!this.zones.some((z) => z.x === x && z.y === y) && this.zones.length < ZONE_MAX) {
          this.zones.push({ x, y });
        }
        await this.persist();
        return new Response(JSON.stringify({ ok: true, zones: this.zones, tokens: this.tokens }), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      if (body?.removeZone) {
        const x = sInt(body.removeZone.x, ZONE_COORD_MIN, ZONE_COORD_MAX, 0);
        const y = sInt(body.removeZone.y, ZONE_COORD_MIN, ZONE_COORD_MAX, 0);
        // Never remove the last zone — there must always be somewhere to
        // stand.
        if (this.zones.length > 1) {
          this.zones = this.zones.filter((z) => !(z.x === x && z.y === y));
          this.pruneTokensOutsideZones();
        }
        await this.persist();
        return new Response(JSON.stringify({ ok: true, zones: this.zones, tokens: this.tokens }), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      // Full reset — GM-only (enforced by the route handler below). Wipes
      // every token and every zone back to the starting 3x3 block.
      if (body?.reset) {
        this.zones = DEFAULT_ZONES;
        this.tokens = {};
        await this.persist();
        return new Response(JSON.stringify({ ok: true, zones: this.zones, tokens: this.tokens }), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }

      // Token move/place/remove.
      const id = String(body?.id ?? "").trim().slice(0, MAP_ID_MAX);
      if (!id) {
        return new Response(JSON.stringify({ error: "id is required" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      if (body?.off) {
        delete this.tokens[id];
      } else if (body?.compass) {
        if (!COMPASS_DIRS.includes(body.compass)) {
          return new Response(JSON.stringify({ error: "Invalid compass direction" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
        }
        if (!this.tokens[id] && Object.keys(this.tokens).length >= MAP_TOKENS_MAX) {
          return new Response(JSON.stringify({ error: `The map holds at most ${MAP_TOKENS_MAX} tokens` }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
        }
        this.tokens[id] = { compass: body.compass, cs: sInt(body.cs, 0, COMPASS_SUB_MAX, 0) };
      } else {
        const zx = sInt(body?.zx, ZONE_COORD_MIN, ZONE_COORD_MAX, 0);
        const zy = sInt(body?.zy, ZONE_COORD_MIN, ZONE_COORD_MAX, 0);
        if (!this.zones.some((z) => z.x === zx && z.y === zy)) {
          return new Response(JSON.stringify({ error: "That zone doesn't exist" }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
        }
        const sx = sInt(body?.sx, 0, SUBCELL_MAX, 1);
        const sy = sInt(body?.sy, 0, SUBCELL_MAX, 1);
        if (!this.tokens[id] && Object.keys(this.tokens).length >= MAP_TOKENS_MAX) {
          return new Response(JSON.stringify({ error: `The map holds at most ${MAP_TOKENS_MAX} tokens` }), { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } });
        }
        this.tokens[id] = { zx, zy, sx, sy };
      }
      await this.persist();
      return new Response(JSON.stringify({ ok: true, zones: this.zones, tokens: this.tokens }), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
    }

    if (request.method === "DELETE") {
      this.tokens = {};
      await this.persist();
      return new Response(JSON.stringify({ ok: true, zones: this.zones, tokens: {} }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
}

function publicMapView(tokens, enemies) {
  const hiddenIds = new Set((enemies || []).filter((e) => e.hidden).map((e) => e.id));
  const out = {};
  Object.entries(tokens || {}).forEach(([id, pos]) => {
    if (!hiddenIds.has(id)) out[id] = pos;
  });
  return out;
}

// --- Campaign data (Durable Object) -----------------------------------------
// The campaign itself: title, wiki link, every character sheet, the vehicle,
// NPCs and locations. This replaces dashboard/public/data/ledger.json as the
// site's source of truth. The GM loads a campaign in with Import on the GM
// page (an existing ledger.json works as-is) and takes a copy out with
// Export. The shape is deliberately identical to ledger.json, so every tab
// that used to read that file reads this without changing.
//
// Players get a redacted copy (see publicCampaignView): hidden characters,
// hidden gear and a hidden vehicle never leave the server. The GM's own
// browser, signed in, gets everything via /gm/campaign.
//
// `revision` goes up by one on every change. Browsers poll with
// ?since=<revision> and get a tiny "unchanged" reply most of the time.
//
// One previous campaign is kept as `snapshot` whenever an import replaces
// the current one, so "Undo last import" can put it back.
const CAMPAIGN_BODY_MAX = 1_500_000; // bytes of JSON accepted on import
const PORTRAIT_MAX_BYTES = 2_000_000;
const PORTRAIT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const WIKI_FILE_MAX = 15_000_000; // one file of an uploaded wiki
const WIKI_TOTAL_MAX = 100_000_000; // the whole uploaded wiki
const WIKI_FILES_MAX = 2000;
const WIKI_CHUNK_BYTES = 1_000_000; // stored in pieces under the per-value limit
const WIKI_TYPES = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", json: "application/json", txt: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
};
function wikiType(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return WIKI_TYPES[ext] || "application/octet-stream";
}
// A safe relative path inside the wiki: no "..", no leading slash, plain
// characters only. Returns "" when it can't be used.
function wikiCleanPath(raw) {
  let p = String(raw || "").replace(/\\/g, "/").replace(/^\/+/, "");
  try { p = decodeURIComponent(p); } catch { return ""; }
  if (!p || p.length > 200 || !/^[A-Za-z0-9._()\- /]+$/.test(p)) return "";
  const parts = p.split("/");
  if (parts.some((x) => !x || x === "." || x === "..")) return "";
  return parts.join("/");
}
// The uploaded wiki is GM-supplied HTML. It's served under a sandbox policy
// (no allow-same-origin), so its scripts run in an isolated origin and can't
// read this site's saved GM sign-ins or call its routes as the viewer.
const WIKI_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals";
const CAMPAIGN_EDIT_MAX = 200_000; // bytes accepted by the settings / vehicle editors
const CAMPAIGN_CHARACTERS_MAX = 40;
const CAMPAIGN_DEPTH_MAX = 12;
const CAMPAIGN_STRING_MAX = 20_000;
const CAMPAIGN_ARRAY_MAX = 1000;
const CAMPAIGN_KEYS_MAX = 200;

// Generic deep clean for imported JSON: keeps the ledger.json shape intact
// (the dashboard reads dozens of optional fields, and older ledgers carry
// extras), but bounds depth, string length, list length and key count so a
// malformed or hostile file can't bloat storage.
function cleanCampaignValue(v, depth) {
  if (depth > CAMPAIGN_DEPTH_MAX) return null;
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.slice(0, CAMPAIGN_STRING_MAX);
  if (Array.isArray(v)) return v.slice(0, CAMPAIGN_ARRAY_MAX).map((x) => cleanCampaignValue(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v).slice(0, CAMPAIGN_KEYS_MAX)) {
      if (val === undefined) continue;
      out[String(k).slice(0, 100)] = cleanCampaignValue(val, depth + 1);
    }
    return out;
  }
  return null;
}

// Returns { campaign } or { error }.
function sanitizeCampaignImport(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "That file isn't a campaign: expected a JSON object like ledger.json." };
  }
  if (!Array.isArray(raw.characters)) {
    return { error: "That file has no \"characters\" list, so it doesn't look like a ledger.json." };
  }
  if (raw.characters.length > CAMPAIGN_CHARACTERS_MAX) {
    return { error: `Too many characters (${raw.characters.length}); the limit is ${CAMPAIGN_CHARACTERS_MAX}.` };
  }
  const unnamed = raw.characters.findIndex((c) => !c || typeof c !== "object" || typeof c.name !== "string" || !c.name.trim());
  if (unnamed !== -1) {
    return { error: `Character ${unnamed + 1} in the file has no name.` };
  }
  const campaign = cleanCampaignValue(raw, 0);
  campaign.campaign = typeof campaign.campaign === "string" ? campaign.campaign : "";
  campaign.npcs = Array.isArray(campaign.npcs) ? campaign.npcs : [];
  campaign.locations = Array.isArray(campaign.locations) ? campaign.locations : [];
  normalizeCampaignVehicles(campaign);
  return { campaign };
}

// GM page settings: campaign title and wiki link. Returns { patch } or { error }.
function sanitizeCampaignSettings(raw) {
  const patch = {};
  if (raw && typeof raw.title === "string") patch.campaign = raw.title.trim().slice(0, 120);
  if (raw && typeof raw.wikiUrl === "string") {
    const w = raw.wikiUrl.trim();
    if (w) {
      let u;
      try { u = new URL(w); } catch { return { error: "That wiki link isn't a valid web address." }; }
      if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "The wiki link must start with https://" };
      patch.wikiUrl = u.toString().slice(0, 500);
    } else {
      patch.wikiUrl = "";
    }
  }
  if (!Object.keys(patch).length) return { error: "Nothing to change." };
  return { patch };
}

// GM page character editor. The GM sends the whole edited sheet; the
// liveId never changes (wounds, strain, crew seats and bios are keyed on it),
// numbers are forced to numbers, and the name must stay unique.
// Returns { character } or { error }.
function sanitizeCharacterEdit(raw, before, characters, idx, { fromFile = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "That isn't a character sheet." };
  const c = cleanCampaignValue(raw, 0) || {};
  c.name = String(c.name || "").trim().slice(0, 80);
  if (!c.name) return { error: "The character needs a name." };
  const clash = characters.some((o, i) => i !== idx && (o.name === c.name || o.liveId === c.name));
  if (clash) return { error: `Another character is already called ${c.name}.` };
  if (before.liveId) c.liveId = before.liveId;
  else delete c.liveId;
  const num = (x, lo, hi, dflt = 0) => {
    const n = Math.round(Number(x));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  c.characteristics = c.characteristics && typeof c.characteristics === "object" ? c.characteristics : {};
  for (const k of ["brawn", "agility", "intellect", "cunning", "willpower", "presence"]) c.characteristics[k] = num(c.characteristics[k], 1, 7, 1);
  c.skills = (Array.isArray(c.skills) ? c.skills : [])
    .filter((s) => s && typeof s === "object" && String(s.name || "").trim())
    .map((s) => ({ ...s, name: String(s.name).trim(), rank: num(s.rank, 0, 5), career: !!s.career }));
  c.talents = (Array.isArray(c.talents) ? c.talents : [])
    .filter((t) => t && typeof t === "object" && String(t.name || "").trim())
    .map((t) => ({ ...t, name: String(t.name).trim(), tier: num(t.tier, 1, 5, 1), rank: num(t.rank, 1, 10, 1) }));
  // Portrait: an uploaded picture ("upload:<time>", set by the upload route),
  // a web address, or a picture bundled with the site (/images/...).
  if (typeof c.portrait === "string" && c.portrait) {
    const p = c.portrait.trim().slice(0, 500);
    if (/^upload:\d+$/.test(p) || /^\/images\/[\w./ -]+$/.test(p)) c.portrait = p;
    else {
      try {
        const u = new URL(p);
        c.portrait = u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
      } catch { c.portrait = undefined; }
    }
    if (!c.portrait) delete c.portrait;
  } else delete c.portrait;
  // Extra dice the GM added to skills by hand: { "Athletics": { boost, setback } }.
  if (c.skillDice && typeof c.skillDice === "object") {
    const dice = {};
    for (const [k, v] of Object.entries(c.skillDice).slice(0, 60)) {
      const boost = num(v?.boost, 0, 5);
      const setback = num(v?.setback, 0, 5);
      if (boost || setback) dice[String(k).slice(0, 60)] = { ...(boost ? { boost } : {}), ...(setback ? { setback } : {}) };
    }
    if (Object.keys(dice).length) c.skillDice = dice; else delete c.skillDice;
  } else delete c.skillDice;
  c.talents = c.talents.map((t) => (Array.isArray(t.boostsSkills) ? { ...t, boostsSkills: t.boostsSkills.map((x) => String(x || "").slice(0, 60)).filter(Boolean).slice(0, 20) } : t));
  c.vitals = c.vitals && typeof c.vitals === "object" ? c.vitals : {};
  c.vitals.wounds = { ...(c.vitals.wounds || {}), threshold: num(c.vitals.wounds?.threshold, 0, 99) };
  c.vitals.strain = { ...(c.vitals.strain || {}), threshold: num(c.vitals.strain?.threshold, 0, 99) };
  c.vitals.soak = num(c.vitals.soak, 0, 99);
  // XP total isn't edited directly: it's everything the character has ever
  // had. Changing unspent XP here counts as a GM adjustment, so the total
  // moves by the same amount and the change is logged.
  // (A character file being imported keeps its own XP figures and history.)
  if (fromFile) {
    c.xp = { ...(c.xp || {}), available: num(c.xp?.available, 0, 100000), total: num(c.xp?.total, 0, 100000) };
    c.xpLog = Array.isArray(c.xpLog) ? c.xpLog.slice(-200) : [];
  } else {
    const beforeAvail = Number(before?.xp?.available) || 0;
    const beforeTotal = Number(before?.xp?.total) || 0;
    const available = num(c.xp?.available, 0, 100000);
    const delta = available - beforeAvail;
    c.xp = { ...(c.xp || {}), available, total: Math.max(0, beforeTotal + delta) };
    const log = Array.isArray(before?.xpLog) ? before.xpLog : [];
    c.xpLog = delta ? [...log, { at: new Date().toISOString(), amount: delta, kind: "adjust", note: "GM edit" }].slice(-200) : log;
  }
  // Motivation and any number of Obligations (the GM page writes a list;
  // older sheets have a single `obligation`, left as it is until edited).
  if (c.motivationObligation && typeof c.motivationObligation === "object") {
    const mo = c.motivationObligation;
    mo.motivation = String(mo.motivation || "").slice(0, 600);
    if (Array.isArray(mo.obligations)) {
      mo.obligations = mo.obligations
        .filter((o) => o && typeof o === "object")
        .slice(0, 12)
        .map((o) => ({ type: String(o.type || "").trim().slice(0, 60), value: num(o.value, 0, 100), note: String(o.note || "").trim().slice(0, 1500) }))
        .filter((o) => o.type || o.value || o.note);
      delete mo.obligation;
    }
  }
  if (c.credits !== undefined) c.credits = num(c.credits, 0, 100000000);
  c.updated = new Date().toISOString();
  return { character: c };
}

// GM page vehicle editor. Keeps the shape the Vehicle tab reads; numbers are
// forced to numbers so a typo can't break the pips. Returns { vehicle } or { error }.
const VEHICLE_NUMBER_FIELDS = ["silhouette", "speed", "handling", "defense", "armor"];
function sanitizeVehicle(raw) {
  if (raw === null) return { vehicle: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "That isn't a vehicle." };
  const v = cleanCampaignValue(raw, 0) || {};
  v.name = String(v.name || "").trim().slice(0, 120);
  if (!v.name) return { error: "The vehicle needs a name." };
  const num = (x, lo, hi) => {
    const n = Math.round(Number(x));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
  };
  for (const f of VEHICLE_NUMBER_FIELDS) v[f] = num(v[f], f === "handling" ? -10 : 0, 99);
  v.hullTrauma = { threshold: num(v.hullTrauma?.threshold, 0, 999) };
  v.systemStrain = { threshold: num(v.systemStrain?.threshold, 0, 999) };
  v.weapons = (Array.isArray(v.weapons) ? v.weapons : [])
    .filter((w) => w && typeof w === "object" && String(w.name || "").trim())
    .map((w) => ({ ...w, name: String(w.name).trim(), damage: num(w.damage, 0, 99), crit: num(w.crit, 0, 99) }));
  v.crewPositions = (Array.isArray(v.crewPositions) ? v.crewPositions : []).filter((c) => c && typeof c === "object" && c.id && c.name);
  v.specialFeatures = (Array.isArray(v.specialFeatures) ? v.specialFeatures : []).map((x) => String(x || "").trim()).filter(Boolean);
  v.hidden = !!v.hidden;
  if (typeof v.image === "string" && /^upload:\d+$/.test(v.image.trim())) v.image = v.image.trim();
  else if (typeof v.image === "string" && /^https?:\/\//i.test(v.image.trim())) v.image = v.image.trim().slice(0, 500);
  else delete v.image;
  v.id = String(v.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  return { vehicle: v };
}

// The campaign keeps a list of vehicles, each with a stable id (live hull
// and crew seats are keyed on it). An older file with a single top-level
// `vehicle` is moved into the list.
const CAMPAIGN_VEHICLES_MAX = 20;
function normalizeCampaignVehicles(campaign) {
  if (!campaign || typeof campaign !== "object") return campaign;
  let list = Array.isArray(campaign.vehicles) ? campaign.vehicles.filter((v) => v && typeof v === "object") : [];
  if (!list.length && campaign.vehicle && typeof campaign.vehicle === "object") list = [campaign.vehicle];
  const taken = [];
  campaign.vehicles = list.slice(0, CAMPAIGN_VEHICLES_MAX).map((v) => {
    const wanted = String(v.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
    const id = wanted && !taken.includes(wanted) ? wanted : creationSlug(v.name || "ship", taken);
    taken.push(id);
    return { ...v, id };
  });
  delete campaign.vehicle;
  return campaign;
}

function campaignSummary(campaign) {
  if (!campaign) return null;
  return {
    title: campaign.campaign || "",
    characters: (campaign.characters || []).length,
    hiddenCharacters: (campaign.characters || []).filter((c) => c?.hidden).length,
    vehicle: (campaign.vehicles || []).length > 0 || !!campaign.vehicle,
    vehicles: (campaign.vehicles || []).length || (campaign.vehicle ? 1 : 0),
    npcs: (campaign.npcs || []).length,
    locations: (campaign.locations || []).length,
  };
}

// What players are allowed to receive. An item's live GM override (the
// VisibilityLog, keyed "<characterId>::<weapon|armor|inventory>::<name>")
// wins over the file's own `hidden` flag, exactly as the sheet itself
// decides — so revealing something on the GM page reveals it here too.
function publicCampaignView(campaign, overrides = {}) {
  if (!campaign) return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(overrides, k);
  const hiddenItem = (cid, category, item) => {
    if (!item || typeof item !== "object") return false;
    const key = `${cid}::${category}::${item.name}`;
    return item.name && has(key) ? !!overrides[key] : !!item.hidden;
  };
  const characters = (campaign.characters || [])
    .filter((c) => !c.hidden)
    .map((c) => {
      const cid = c.liveId || c.name;
      const out = { ...c };
      if (Array.isArray(c.weapons)) out.weapons = c.weapons.filter((w) => !hiddenItem(cid, "weapon", w));
      if (Array.isArray(c.inventory)) out.inventory = c.inventory.filter((i) => !hiddenItem(cid, "inventory", i));
      if (c.armor && hiddenItem(cid, "armor", c.armor)) out.armor = {};
      return out;
    });
  const out = { ...campaign, characters };
  out.vehicles = (campaign.vehicles || []).filter((v) => v && !v.hidden);
  delete out.vehicle;
  return out;
}

// Character creation invites (see CampaignLog.handleCreation).
const CREATION_DRAFTS_MAX = 20;
const CREATION_DRAFT_MAX = 60_000; // bytes of JSON per draft
const CREATION_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function creationCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CREATION_CODE_ALPHABET[b % CREATION_CODE_ALPHABET.length]).join("");
}
function creationSlug(name, taken) {
  const base = String(name || "pc").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "pc";
  const used = new Set(taken.map((t) => String(t).toLowerCase()));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

// Small, fast, non-cryptographic string hash (FNV-1a) for change tags.
function quickHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class CampaignLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.campaign = null;
    this.revision = 0;
    this.updatedAt = 0;
    this.snapshot = null;
    this.drafts = {};
    this.advance = {};
    this.charUndo = {};
    this.ctx.blockConcurrencyWhile(async () => {
      this.charUndo = (await this.ctx.storage.get("charUndo")) || {};
      this.drafts = (await this.ctx.storage.get("drafts")) || {};
      this.advance = (await this.ctx.storage.get("advance")) || {};
      this.campaign = normalizeCampaignVehicles((await this.ctx.storage.get("campaign")) || null);
      this.revision = (await this.ctx.storage.get("revision")) || 0;
      this.updatedAt = (await this.ctx.storage.get("updatedAt")) || 0;
      this.snapshot = (await this.ctx.storage.get("snapshot")) || null;
    });
  }

  json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
    });
  }

  async save(campaign, snapshot) {
    this.campaign = campaign;
    this.snapshot = snapshot;
    this.revision += 1;
    this.updatedAt = Date.now();
    await this.ctx.storage.put({ campaign, snapshot, revision: this.revision, updatedAt: this.updatedAt });
  }

  async saveDrafts() {
    await this.ctx.storage.put("drafts", this.drafts);
  }

  draftView(entry) {
    return {
      code: entry.code, label: entry.label, status: entry.status,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, submittedAt: entry.submittedAt || 0,
      draft: entry.draft, characterName: entry.characterName || "", note: entry.note || "",
    };
  }

  // Character creation. A GM makes an invite (a short code); the player
  // opens /?create=<code> and fills the draft in; Submit runs the rules;
  // the GM approves, which re-runs them here and adds the character.
  async handleCreation(request, url) {
    const parts = url.pathname.split("/").filter(Boolean); // ["creation", code?, action?]
    const code = parts[1] || "";
    const action = parts[2] || "";
    let body = {};
    if (request.method === "POST" || request.method === "PUT") {
      try { body = await request.json(); } catch { body = {}; }
    }

    if (!code) {
      if (request.method === "GET") {
        const list = Object.values(this.drafts).sort((a, b) => b.updatedAt - a.updatedAt).map((e) => this.draftView(e));
        return this.json({ drafts: list });
      }
      if (request.method === "POST") {
        if (Object.keys(this.drafts).length >= CREATION_DRAFTS_MAX) return this.json({ error: `There are already ${CREATION_DRAFTS_MAX} creation invites. Delete an old one first.` }, 409);
        let newCode;
        do { newCode = creationCode(); } while (this.drafts[newCode]);
        const now = Date.now();
        this.drafts[newCode] = { code: newCode, label: sText(body.label, 60), status: "open", createdAt: now, updatedAt: now, draft: { playerName: sText(body.label, 60) } };
        await this.saveDrafts();
        return this.json({ ok: true, entry: this.draftView(this.drafts[newCode]) });
      }
      return this.json({ error: "Method not allowed" }, 405);
    }

    const entry = this.drafts[code];
    if (!entry) return this.json({ error: "That character creation link isn't valid any more. Ask the GM for a new one." }, 404);

    if (!action && request.method === "GET") return this.json({ entry: this.draftView(entry) });
    if (!action && request.method === "DELETE") {
      delete this.drafts[code];
      await this.saveDrafts();
      return this.json({ ok: true });
    }

    const draftIn = body && typeof body.draft === "object" && body.draft ? cleanCampaignValue(body.draft, 0) : null;
    if (draftIn && JSON.stringify(draftIn).length > CREATION_DRAFT_MAX) return this.json({ error: "That character is too large to save." }, 413);

    if (!action && request.method === "PUT") {
      if (entry.status !== "open") return this.json({ error: entry.status === "approved" ? "This character has already been added to the campaign." : "This character has been sent to the GM. Ask the GM to reopen it if you need to change something." }, 409);
      if (!draftIn) return this.json({ error: "Nothing to save." }, 400);
      entry.draft = draftIn;
      entry.updatedAt = Date.now();
      await this.saveDrafts();
      return this.json({ ok: true, updatedAt: entry.updatedAt });
    }
    if (action === "submit" && request.method === "POST") {
      if (entry.status !== "open") return this.json({ error: "This character has already been sent to the GM." }, 409);
      if (draftIn) entry.draft = draftIn;
      const build = computeBuild(entry.draft, CHARGEN_DATA);
      if (!build.ok) return this.json({ error: "The character isn't finished yet.", errors: build.errors }, 400);
      entry.status = "submitted";
      entry.updatedAt = entry.submittedAt = Date.now();
      entry.characterName = build.character.name;
      await this.saveDrafts();
      return this.json({ ok: true, entry: this.draftView(entry) });
    }
    if (action === "reopen" && request.method === "POST") {
      if (entry.status === "approved") return this.json({ error: "This character is already in the campaign." }, 409);
      entry.status = "open";
      entry.note = sText(body.note, 500);
      entry.updatedAt = Date.now();
      await this.saveDrafts();
      return this.json({ ok: true, entry: this.draftView(entry) });
    }
    if (action === "approve" && request.method === "POST") {
      if (entry.status === "approved") return this.json({ error: "This character is already in the campaign." }, 409);
      const build = computeBuild(entry.draft, CHARGEN_DATA, {
        baseObligation: Number.isFinite(Number(body.baseObligation)) ? Math.max(0, Math.min(100, Math.round(Number(body.baseObligation)))) : undefined,
      });
      if (!build.ok) return this.json({ error: "This character doesn't pass the creation rules.", errors: build.errors }, 400);
      const campaign = this.campaign ? { ...this.campaign } : { campaign: "", characters: [], npcs: [], locations: [] };
      const characters = Array.isArray(campaign.characters) ? [...campaign.characters] : [];
      if (characters.length >= CAMPAIGN_CHARACTERS_MAX) return this.json({ error: `The campaign already has ${CAMPAIGN_CHARACTERS_MAX} characters.` }, 409);
      const taken = characters.flatMap((c) => [c.liveId, c.name]).filter(Boolean);
      const liveId = creationSlug(build.character.name, taken);
      const character = { ...build.character, liveId, hidden: body.visible === false, updated: new Date().toISOString() };
      characters.push(character);
      campaign.characters = characters;
      await this.save(campaign, this.snapshot);
      entry.status = "approved";
      entry.characterName = character.name;
      entry.liveId = liveId;
      entry.updatedAt = Date.now();
      await this.saveDrafts();
      return this.json({ ok: true, liveId, name: character.name, description: String(entry.draft?.description || "").slice(0, BIO_TEXT_MAX), revision: this.revision });
    }
    return this.json({ error: "Not found" }, 404);
  }

  // XP. The GM awards it; a player submits a purchase from the Advancement
  // Planner; the GM approves (which prices it again against the character as
  // it is now, then applies it) or rejects it with a note. Every award and
  // spend is also written to the character's xpLog.
  //   GET  /advance                 list of purchase requests (newest first)
  //   POST /advance                 { characterId, skills, talents, note, forceSensitive }
  //   POST /advance/<id>/approve    { forceSensitive }
  //   POST /advance/<id>/reject     { note }
  //   POST /xp                      { characterIds: [...] | "all", amount, reason }
  async handleXp(request, url) {
    const parts = url.pathname.split("/").filter(Boolean);
    let body = {};
    if (request.method === "POST") { try { body = await request.json(); } catch { body = {}; } }
    const chars = () => (this.campaign?.characters || []);
    const cidOf = (c) => c.liveId || c.name;

    if (parts[0] === "xp" && request.method === "POST") {
      if (!this.campaign) return this.json({ error: "There's no campaign loaded." }, 409);
      const amount = Math.round(Number(body.amount));
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000) return this.json({ error: "Enter an amount of XP between -1000 and 1000 (not 0)." }, 400);
      const ids = body.characterIds === "all" ? chars().filter((c) => !c.hidden).map(cidOf) : (Array.isArray(body.characterIds) ? body.characterIds.map(String) : []);
      if (!ids.length) return this.json({ error: "Choose at least one character." }, 400);
      const reason = sText(body.reason, 200);
      const at = new Date().toISOString();
      const names = [];
      const characters = chars().map((c) => {
        if (!ids.includes(cidOf(c))) return c;
        names.push(c.name);
        const xp = c.xp || {};
        const available = Math.max(0, (Number(xp.available) || 0) + amount);
        const total = Math.max(0, (Number(xp.total) || 0) + amount);
        const xpLog = [...(Array.isArray(c.xpLog) ? c.xpLog : []), { at, amount, kind: "award", note: reason || (amount > 0 ? "XP awarded" : "XP removed") }].slice(-200);
        return { ...c, xp: { ...xp, available, total }, xpLog, updated: at };
      });
      if (!names.length) return this.json({ error: "None of those characters are in the campaign." }, 404);
      await this.save({ ...this.campaign, characters }, this.snapshot);
      return this.json({ ok: true, names, amount });
    }

    if (parts[0] !== "advance") return this.json({ error: "Not found" }, 404);
    const id = parts[1] || "";
    const action = parts[2] || "";
    const saveAdvance = () => this.ctx.storage.put("advance", this.advance);
    const listView = () => Object.values(this.advance).sort((a, b) => b.createdAt - a.createdAt);

    if (!id && request.method === "GET") return this.json({ requests: listView() });
    if (!id && request.method === "POST") {
      const character = chars().find((c) => cidOf(c) === String(body.characterId || "") && !c.hidden);
      if (!character) return this.json({ error: "That character isn't in the campaign." }, 404);
      const pending = listView().filter((r) => r.status === "pending");
      if (pending.length >= 50) return this.json({ error: "There are too many requests waiting for the GM." }, 409);
      if (pending.some((r) => r.characterId === cidOf(character))) return this.json({ error: `${character.name} already has a purchase waiting for the GM. Wait for it to be approved or rejected first.` }, 409);
      const req = { skills: cleanCampaignValue(body.skills || {}, 0), talents: cleanCampaignValue(Array.isArray(body.talents) ? body.talents.slice(0, 20) : [], 0) };
      const priced = priceAdvancement(character, req, { forceSensitive: !!body.forceSensitive || !!character.forceSensitive });
      if (!priced.ok) return this.json({ error: priced.errors.join(" "), errors: priced.errors }, 400);
      const rid = crypto.randomUUID();
      this.advance[rid] = {
        id: rid, characterId: cidOf(character), characterName: character.name, createdAt: Date.now(), status: "pending",
        request: req, cost: priced.cost, lines: priced.lines, note: sText(body.note, 500), gmNote: "",
      };
      // Keep the store small: drop decided requests beyond the newest 100.
      const decided = listView().filter((r) => r.status !== "pending").slice(100);
      decided.forEach((r) => { delete this.advance[r.id]; });
      await saveAdvance();
      return this.json({ ok: true, request: this.advance[rid] });
    }

    const entry = this.advance[id];
    if (!entry) return this.json({ error: "That request no longer exists." }, 404);
    if (entry.status !== "pending") return this.json({ error: `That request was already ${entry.status}.` }, 409);
    if (action === "reject" && request.method === "POST") {
      entry.status = "rejected";
      entry.gmNote = sText(body.note, 500);
      entry.decidedAt = Date.now();
      await saveAdvance();
      return this.json({ ok: true, request: entry });
    }
    if (action === "approve" && request.method === "POST") {
      const idx = chars().findIndex((c) => cidOf(c) === entry.characterId);
      if (idx === -1) return this.json({ error: "That character isn't in the campaign any more." }, 404);
      const character = chars()[idx];
      const priced = priceAdvancement(character, entry.request, { forceSensitive: !!body.forceSensitive || !!character.forceSensitive });
      if (!priced.ok) return this.json({ error: `Can't approve: ${priced.errors.join(" ")}`, errors: priced.errors }, 400);
      const updated = applyAdvancement(character, priced, entry.note);
      const characters = [...chars()];
      characters[idx] = updated;
      await this.save({ ...this.campaign, characters }, this.snapshot);
      entry.status = "approved";
      entry.cost = priced.cost;
      entry.lines = priced.lines;
      entry.gmNote = sText(body.note, 500);
      entry.decidedAt = Date.now();
      await saveAdvance();
      return this.json({ ok: true, request: entry, xpLeft: updated.xp.available });
    }
    return this.json({ error: "Not found" }, 404);
  }

  // Internal API, only ever reached through the Worker's own routes below
  // (which do the GM-key check and the player redaction):
  //   GET    /           -> { campaign, revision, updatedAt, hasSnapshot, snapshotSummary }
  //   POST   /import     -> replace the campaign (current one becomes the snapshot)
  //   POST   /restore    -> swap the snapshot back in (and keep the replaced one, so it can be redone)
  // The campaign wiki: the docs/ folder wiki/build.py makes (index.html plus
  // img/ and anything else), uploaded from the GM page as a zip. The browser
  // unzips it and sends each file; they're stored under a new version and
  // only swapped in on commit, so players never see a half-uploaded wiki.
  // Files live in their own storage keys (in chunks under the per-value
  // limit), never in the campaign record: that holds only a summary under
  // `wiki` ({ fileName, size, files, uploadedAt }).
  //   GET    /wiki/<path>        a file of the live wiki ("" = index.html)
  //   POST   /wiki/begin         start an upload -> { version }
  //   PUT    /wiki/file?v=&path= one file's bytes
  //   POST   /wiki/commit        { version, fileName } -> make it live
  //   DELETE /wiki               remove the wiki
  async wikiDeletePrefix(prefix) {
    for (;;) {
      const batch = await this.ctx.storage.list({ prefix, limit: 128 });
      if (!batch.size) return;
      await this.ctx.storage.delete([...batch.keys()]);
    }
  }

  async handleWiki(request, url) {
    const sub = url.pathname.slice("/wiki".length).replace(/^\//, "");
    const active = (await this.ctx.storage.get("wikiActive")) || null;
    if (request.method === "GET") {
      const path = wikiCleanPath(sub || "index.html");
      if (!path) return new Response("Not found", { status: 404 });
      if (!active) {
        // A wiki uploaded as a single page before zips were supported.
        const count = path === "index.html" ? (await this.ctx.storage.get("wikiChunks")) || 0 : 0;
        if (!count) return new Response("Not found", { status: 404 });
        const keys = Array.from({ length: count }, (_, i) => `wiki:${i}`);
        const parts = await this.ctx.storage.get(keys);
        return new Response(keys.map((k) => parts.get(k) || "").join(""), { status: 200, headers: { "x-wiki-etag": "legacy" } });
      }
      const meta = active.files[path];
      if (!meta) return new Response("Not found", { status: 404 });
      const etag = `"${active.version}-${quickHash(path)}"`;
      if ((request.headers.get("if-none-match") || "") === etag) return new Response(null, { status: 304, headers: { "x-wiki-etag": etag } });
      const keys = Array.from({ length: meta.chunks }, (_, i) => `wf:${active.version}:${path}:${i}`);
      const got = new Map();
      for (let i = 0; i < keys.length; i += 128) {
        const part = await this.ctx.storage.get(keys.slice(i, i + 128));
        for (const [k, v] of part) got.set(k, v);
      }
      const body = new Uint8Array(meta.size);
      let off = 0;
      for (const k of keys) {
        const c = got.get(k);
        if (!c) return new Response("This wiki file is incomplete", { status: 500 });
        body.set(c, off);
        off += c.byteLength;
      }
      return new Response(body, { status: 200, headers: { "x-wiki-etag": etag } });
    }

    if (request.method === "POST" && sub === "begin") {
      const pending = await this.ctx.storage.get("wikiPending");
      if (pending?.version) await this.wikiDeletePrefix(`wf:${pending.version}:`);
      const version = crypto.randomUUID().slice(0, 8);
      await this.ctx.storage.put("wikiPending", { version, startedAt: Date.now(), files: {} });
      return this.json({ ok: true, version });
    }

    if (request.method === "PUT" && sub === "file") {
      const pending = await this.ctx.storage.get("wikiPending");
      const version = url.searchParams.get("v") || "";
      if (!pending || pending.version !== version) return this.json({ error: "This upload has expired. Start it again." }, 409);
      const path = wikiCleanPath(url.searchParams.get("path") || "");
      if (!path) return this.json({ error: "That file name can't be used in a wiki." }, 400);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > WIKI_FILE_MAX) return this.json({ error: `${path} is too large (over ${WIKI_FILE_MAX / 1e6} MB).` }, 413);
      const prev = pending.files[path];
      const total = Object.values(pending.files).reduce((n, f) => n + f.size, 0) - (prev ? prev.size : 0) + bytes.byteLength;
      if (total > WIKI_TOTAL_MAX) return this.json({ error: `The wiki is too large (over ${WIKI_TOTAL_MAX / 1e6} MB in total).` }, 413);
      if (!prev && Object.keys(pending.files).length >= WIKI_FILES_MAX) return this.json({ error: `Too many files (the limit is ${WIKI_FILES_MAX}).` }, 413);
      const entries = {};
      let chunks = 0;
      for (let i = 0; i < bytes.byteLength || i === 0; i += WIKI_CHUNK_BYTES) {
        entries[`wf:${version}:${path}:${chunks}`] = bytes.slice(i, i + WIKI_CHUNK_BYTES);
        chunks += 1;
        if (bytes.byteLength === 0) break;
      }
      await this.ctx.storage.put(entries);
      pending.files[path] = { size: bytes.byteLength, chunks };
      await this.ctx.storage.put("wikiPending", pending);
      return this.json({ ok: true });
    }

    if (request.method === "POST" && sub === "commit") {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const pending = await this.ctx.storage.get("wikiPending");
      if (!pending || pending.version !== body.version) return this.json({ error: "This upload has expired. Start it again." }, 409);
      if (!pending.files["index.html"]) return this.json({ error: "The upload has no index.html at its top level." }, 400);
      const next = {
        version: pending.version,
        files: pending.files,
        uploadedAt: Date.now(),
        fileName: String(body.fileName || "wiki").slice(0, 120),
      };
      await this.ctx.storage.put("wikiActive", next);
      await this.ctx.storage.delete("wikiPending");
      if (active?.version) await this.wikiDeletePrefix(`wf:${active.version}:`);
      await this.wikiDeleteLegacy();
      const files = Object.values(next.files);
      const campaign = this.campaign ? { ...this.campaign } : { campaign: "", characters: [], npcs: [], locations: [], vehicles: [] };
      campaign.wiki = { fileName: next.fileName, size: files.reduce((n, f) => n + f.size, 0), files: files.length, uploadedAt: next.uploadedAt };
      await this.save(campaign, this.snapshot);
      return this.json({ ok: true, revision: this.revision, wiki: campaign.wiki });
    }

    if (request.method === "DELETE" && !sub) {
      if (active?.version) await this.wikiDeletePrefix(`wf:${active.version}:`);
      await this.ctx.storage.delete("wikiActive");
      await this.wikiDeleteLegacy();
      const campaign = this.campaign ? { ...this.campaign } : { campaign: "", characters: [], npcs: [], locations: [], vehicles: [] };
      delete campaign.wiki;
      await this.save(campaign, this.snapshot);
      return this.json({ ok: true, revision: this.revision });
    }
    return this.json({ error: "Not found" }, 404);
  }

  // Character portraits uploaded from the GM page. One image per character
  // (already resized in the browser), stored under "portrait:<id>"; the
  // character's `portrait` becomes "upload:<timestamp>" so the sheet knows
  // to load it from /portrait/<id> and so a new upload busts the cache.
  async handlePortrait(request, url) {
    if (url.pathname === "/portraits/export" && request.method === "GET") {
      const all = new Map([...(await this.ctx.storage.list({ prefix: "portrait:" })), ...(await this.ctx.storage.list({ prefix: "vimage:" }))]);
      const out = {};
      for (const [k, v] of all) {
        let bin = "";
        const bytes = v.bytes;
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        // Vehicle pictures travel as "vimage:<id>", portraits by character id.
        out[k.startsWith("vimage:") ? k : k.slice("portrait:".length)] = { type: v.type, data: btoa(bin) };
      }
      return this.json({ portraits: out });
    }
    if (url.pathname === "/portraits/import" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const entries = {};
      for (const [id, p] of Object.entries(body.portraits || {}).slice(0, CAMPAIGN_CHARACTERS_MAX)) {
        if (!PORTRAIT_TYPES.includes(p?.type) || typeof p?.data !== "string") continue;
        let bytes;
        try { bytes = Uint8Array.from(atob(p.data), (ch) => ch.charCodeAt(0)); } catch { continue; }
        const key = String(id).startsWith("vimage:") ? String(id).slice(0, 90) : `portrait:${String(id).slice(0, 80)}`;
        if (bytes.byteLength && bytes.byteLength <= PORTRAIT_MAX_BYTES) entries[key] = { type: p.type, bytes };
      }
      if (Object.keys(entries).length) await this.ctx.storage.put(entries);
      return this.json({ ok: true, restored: Object.keys(entries).length });
    }
    const id = String(url.searchParams.get("id") || "").slice(0, 80);
    if (!id) return this.json({ error: "Which character?" }, 400);
    if (request.method === "GET") {
      const p = await this.ctx.storage.get(`portrait:${id}`);
      if (!p) return new Response("Not found", { status: 404 });
      return new Response(p.bytes, { status: 200, headers: { "content-type": p.type } });
    }
    const characters = Array.isArray(this.campaign?.characters) ? [...this.campaign.characters] : [];
    const idx = characters.findIndex((c) => (c.liveId || c.name) === id);
    if (idx === -1) return this.json({ error: "That character isn't in the campaign." }, 404);
    if (request.method === "PUT") {
      const type = String(request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!PORTRAIT_TYPES.includes(type)) return this.json({ error: "Use a JPEG, PNG, WebP or GIF picture." }, 400);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.byteLength) return this.json({ error: "That picture is empty." }, 400);
      if (bytes.byteLength > PORTRAIT_MAX_BYTES) return this.json({ error: "That picture is too large (over 2 MB)." }, 413);
      await this.ctx.storage.put(`portrait:${id}`, { type, bytes });
      characters[idx] = { ...characters[idx], portrait: `upload:${Date.now()}` };
    } else if (request.method === "DELETE") {
      await this.ctx.storage.delete(`portrait:${id}`);
      const { portrait, ...rest } = characters[idx];
      characters[idx] = rest;
    } else {
      return this.json({ error: "Method not allowed" }, 405);
    }
    await this.save({ ...this.campaign, characters }, this.snapshot);
    return this.json({ ok: true, revision: this.revision, portrait: characters[idx].portrait || null });
  }

  // A vehicle's picture (shown at the top of its tab). Same storage pattern
  // as portraits: "vimage:<vehicleId>", and the vehicle's `image` becomes
  // "upload:<timestamp>".
  async handleVehicleImage(request, url) {
    const id = String(url.searchParams.get("id") || "").slice(0, 80);
    if (!id) return this.json({ error: "Which vehicle?" }, 400);
    if (request.method === "GET") {
      const p = await this.ctx.storage.get(`vimage:${id}`);
      if (!p) return new Response("Not found", { status: 404 });
      return new Response(p.bytes, { status: 200, headers: { "content-type": p.type } });
    }
    const campaign = normalizeCampaignVehicles({ ...(this.campaign || { characters: [] }) });
    const vehicles = [...campaign.vehicles];
    const idx = vehicles.findIndex((v) => v.id === id);
    if (idx === -1) return this.json({ error: "That vehicle isn't in the campaign." }, 404);
    if (request.method === "PUT") {
      const type = String(request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!PORTRAIT_TYPES.includes(type)) return this.json({ error: "Use a JPEG, PNG, WebP or GIF picture." }, 400);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.byteLength) return this.json({ error: "That picture is empty." }, 400);
      if (bytes.byteLength > PORTRAIT_MAX_BYTES) return this.json({ error: "That picture is too large (over 2 MB)." }, 413);
      await this.ctx.storage.put(`vimage:${id}`, { type, bytes });
      vehicles[idx] = { ...vehicles[idx], image: `upload:${Date.now()}` };
    } else if (request.method === "DELETE") {
      await this.ctx.storage.delete(`vimage:${id}`);
      const { image, ...rest } = vehicles[idx];
      vehicles[idx] = rest;
    } else {
      return this.json({ error: "Method not allowed" }, 405);
    }
    campaign.vehicles = vehicles;
    await this.save(campaign, this.snapshot);
    return this.json({ ok: true, revision: this.revision, image: vehicles[idx].image || null });
  }

  async wikiDeleteLegacy() {
    const old = (await this.ctx.storage.get("wikiChunks")) || 0;
    if (old) await this.ctx.storage.delete(Array.from({ length: old }, (_, i) => `wiki:${i}`));
    if (old) await this.ctx.storage.delete("wikiChunks");
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/wiki" || url.pathname.startsWith("/wiki/")) return this.handleWiki(request, url);
    if (url.pathname === "/portrait" || url.pathname.startsWith("/portraits/")) return this.handlePortrait(request, url);
    if (url.pathname === "/vimage") return this.handleVehicleImage(request, url);
    if (url.pathname.startsWith("/creation")) return this.handleCreation(request, url);
    if (url.pathname.startsWith("/advance") || url.pathname === "/xp") return this.handleXp(request, url);
    if (request.method === "GET") {
      return this.json({
        campaign: this.campaign,
        revision: this.revision,
        updatedAt: this.updatedAt,
        hasSnapshot: !!this.snapshot,
        snapshotSummary: campaignSummary(this.snapshot?.campaign),
        editUndo: Object.fromEntries(Object.entries(this.charUndo).map(([id, u]) => [id, { savedAt: u.savedAt, note: u.note || "" }])),
      });
    }
    // One character from a file: replaces the character with the same liveId
    // (or name), otherwise joins the campaign. A replaced character can be
    // put back with /character/undo, like a GM edit.
    if (request.method === "POST" && url.pathname === "/character/import") {
      let raw;
      try { raw = await request.json(); } catch { return this.json({ error: "That file isn't valid JSON." }, 400); }
      const incoming = raw?.character && typeof raw.character === "object" ? raw.character : raw;
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || Array.isArray(incoming.characters)) {
        return this.json({ error: "That file isn't a single character. Use Import all for a whole campaign." }, 400);
      }
      const campaign = this.campaign ? { ...this.campaign } : { campaign: "", characters: [], npcs: [], locations: [], vehicles: [] };
      const characters = Array.isArray(campaign.characters) ? [...campaign.characters] : [];
      const name = String(incoming.name || "").trim();
      let idx = characters.findIndex((c) => (incoming.liveId && c.liveId === incoming.liveId));
      if (idx === -1) idx = characters.findIndex((c) => c.name === name);
      const before = idx === -1 ? { liveId: "" } : characters[idx];
      if (idx === -1 && characters.length >= CAMPAIGN_CHARACTERS_MAX) return this.json({ error: `The campaign already has ${CAMPAIGN_CHARACTERS_MAX} characters.` }, 409);
      const { character, error } = sanitizeCharacterEdit(incoming, before, characters, idx, { fromFile: true });
      if (error) return this.json({ error }, 400);
      if (idx === -1) {
        character.liveId = creationSlug(incoming.liveId || character.name, characters.flatMap((c) => [c.liveId, c.name]).filter(Boolean));
        characters.push(character);
      } else {
        this.charUndo[before.liveId || before.name] = { character: before, savedAt: Date.now(), note: "Before import" };
        await this.ctx.storage.put("charUndo", this.charUndo);
        characters[idx] = character;
      }
      campaign.characters = characters;
      await this.save(campaign, this.snapshot);
      return this.json({ ok: true, revision: this.revision, replaced: idx !== -1, name: character.name, liveId: character.liveId || character.name });
    }
    if (request.method === "POST" && (url.pathname === "/character" || url.pathname === "/character/undo")) {
      let raw;
      try { raw = await request.json(); } catch { return this.json({ error: "That request isn't valid JSON." }, 400); }
      if (!this.campaign) return this.json({ error: "There's no campaign loaded yet." }, 409);
      const characterId = String(raw?.characterId || "");
      const characters = Array.isArray(this.campaign.characters) ? [...this.campaign.characters] : [];
      const idx = characters.findIndex((c) => (c.liveId || c.name) === characterId);
      if (idx === -1) return this.json({ error: "That character isn't in the campaign." }, 404);
      const before = characters[idx];
      let next;
      let undoEntry;
      if (url.pathname === "/character/undo") {
        const undo = this.charUndo[characterId];
        if (!undo) return this.json({ error: "There's no earlier version of this character to go back to." }, 409);
        next = undo.character;
        undoEntry = { character: before, savedAt: Date.now(), note: "Undo" };
      } else {
        const { character, error } = sanitizeCharacterEdit(raw?.character, before, characters, idx);
        if (error) return this.json({ error }, 400);
        const note = String(raw?.note || "").trim().slice(0, 300);
        character.editLog = [...(Array.isArray(before.editLog) ? before.editLog : []), { at: new Date().toISOString(), note: note || "GM edit" }].slice(-100);
        next = character;
        undoEntry = { character: before, savedAt: Date.now(), note };
      }
      characters[idx] = next;
      this.charUndo[characterId] = undoEntry;
      await this.ctx.storage.put("charUndo", this.charUndo);
      await this.save({ ...this.campaign, characters }, this.snapshot);
      return this.json({ ok: true, revision: this.revision });
    }
    // Reorder the characters (the order of the dashboard's character tabs).
    // body: { order: [characterId, ...] }; anyone not listed keeps their
    // relative place at the end.
    if (request.method === "POST" && url.pathname === "/order") {
      let raw;
      try { raw = await request.json(); } catch { return this.json({ error: "That request isn't valid JSON." }, 400); }
      if (!this.campaign) return this.json({ error: "There's no campaign loaded yet." }, 409);
      const order = Array.isArray(raw?.order) ? raw.order.map((x) => String(x)) : [];
      const characters = Array.isArray(this.campaign.characters) ? [...this.campaign.characters] : [];
      const idOf = (c) => c.liveId || c.name;
      const rank = (c) => { const i = order.indexOf(idOf(c)); return i === -1 ? order.length + characters.indexOf(c) : i; };
      characters.sort((a, b) => rank(a) - rank(b));
      await this.save({ ...this.campaign, characters }, this.snapshot);
      return this.json({ ok: true, revision: this.revision });
    }
    if (request.method === "POST" && (url.pathname === "/settings" || url.pathname === "/vehicle")) {
      let raw;
      try { raw = await request.json(); } catch { return this.json({ error: "That request isn't valid JSON." }, 400); }
      const campaign = this.campaign ? { ...this.campaign } : { campaign: "", characters: [], npcs: [], locations: [] };
      if (url.pathname === "/settings") {
        const { patch, error } = sanitizeCampaignSettings(raw);
        if (error) return this.json({ error }, 400);
        Object.assign(campaign, patch);
      } else {
        normalizeCampaignVehicles(campaign);
        const vehicles = [...campaign.vehicles];
        if (raw?.removeId) {
          const before = vehicles.length;
          campaign.vehicles = vehicles.filter((v) => v.id !== String(raw.removeId));
          if (campaign.vehicles.length === before) return this.json({ error: "That vehicle isn't in the campaign." }, 404);
        } else {
          const { vehicle, error } = sanitizeVehicle(raw?.vehicle === undefined || raw?.vehicle === null ? undefined : raw.vehicle);
          if (error) return this.json({ error }, 400);
          const idx = vehicle.id ? vehicles.findIndex((v) => v.id === vehicle.id) : -1;
          if (idx === -1) {
            if (vehicles.length >= CAMPAIGN_VEHICLES_MAX) return this.json({ error: `The campaign already has ${CAMPAIGN_VEHICLES_MAX} vehicles.` }, 409);
            vehicle.id = creationSlug(vehicle.name, vehicles.map((v) => v.id));
            vehicles.push(vehicle);
          } else {
            vehicles[idx] = vehicle;
          }
          campaign.vehicles = vehicles;
          await this.save(campaign, this.snapshot);
          return this.json({ ok: true, revision: this.revision, id: vehicle.id });
        }
      }
      await this.save(campaign, this.snapshot);
      return this.json({ ok: true, revision: this.revision });
    }
    if (request.method === "POST" && url.pathname === "/import") {
      let raw;
      try {
        raw = await request.json();
      } catch {
        return this.json({ error: "That file isn't valid JSON." }, 400);
      }
      const { campaign, error } = sanitizeCampaignImport(raw);
      if (error) return this.json({ error }, 400);
      // The wiki is uploaded per campaign, not carried in the file: keep
      // whatever this campaign already has.
      delete campaign.live;
      delete campaign.exportedAt;
      if (this.campaign?.wiki) campaign.wiki = this.campaign.wiki;
      else delete campaign.wiki;
      const snapshot = this.campaign ? { campaign: this.campaign, savedAt: Date.now() } : this.snapshot;
      await this.save(campaign, snapshot);
      return this.json({ ok: true, revision: this.revision, summary: campaignSummary(campaign) });
    }
    if (request.method === "POST" && url.pathname === "/restore") {
      if (!this.snapshot) return this.json({ error: "There's no earlier campaign to go back to." }, 409);
      const previous = this.snapshot.campaign;
      const replaced = this.campaign ? { campaign: this.campaign, savedAt: Date.now() } : null;
      await this.save(previous, replaced);
      return this.json({ ok: true, revision: this.revision, summary: campaignSummary(previous) });
    }
    return this.json({ error: "Method not allowed" }, 405);
  }
}

// --- Campaign "live" data in exports ----------------------------------------
// Export all also carries the things that live outside the campaign record:
// the per-character fields players type on their sheets (description, the
// Notes boxes, credits), the GM's live show/hide and Force-sensitivity
// overrides, field-acquired gear, session state (wounds, strain, Destiny,
// critical injuries, vehicle damage, item counts, worn armour) and crew
// seats. Import all puts them back. Rolls, the notes inbox, the battle map,
// the enemy board, initiative and the wiki are left out.
async function doJson(ns, env, name, path = "/", init = { method: "GET" }) {
  const res = await ns.get(ns.idFromName(doName(env, name))).fetch(new Request(`https://live.internal${path}`, init));
  return res.json().catch(() => ({}));
}
async function exportLive(env) {
  const [bio, vis, gear, manual, crew] = await Promise.all([
    doJson(env.BIO_LOG, env, "shared-bio-log"),
    doJson(env.VISIBILITY_LOG, env, "shared-visibility-log"),
    doJson(env.GEAR_LOG, env, "shared-gear-log"),
    doJson(env.MANUAL_LOG, env, "shared-manual-log"),
    doJson(env.CREW_LOG, env, "shared-crew-log"),
  ]);
  const { initiative, enabled, ...session } = manual || {};
  const portraits = await doJson(env.CAMPAIGN_LOG, env, "shared-campaign", "/portraits/export");
  return { bios: bio.bios || {}, overrides: vis.overrides || {}, gear: gear.gear || [], session, crew: crew.crew || {}, portraits: portraits.portraits || {} };
}
async function importLive(env, live) {
  if (!live || typeof live !== "object") return;
  const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const jobs = [];
  if (live.bios && typeof live.bios === "object") jobs.push(doJson(env.BIO_LOG, env, "shared-bio-log", "/__restore", post({ bios: live.bios })));
  if (live.overrides && typeof live.overrides === "object") jobs.push(doJson(env.VISIBILITY_LOG, env, "shared-visibility-log", "/__restore", post({ overrides: live.overrides })));
  if (Array.isArray(live.gear)) jobs.push(doJson(env.GEAR_LOG, env, "shared-gear-log", "/", post({ gear: live.gear })));
  if (live.crew && typeof live.crew === "object") jobs.push(doJson(env.CREW_LOG, env, "shared-crew-log", "/__restore", post({ crew: live.crew })));
  if (live.portraits && typeof live.portraits === "object") jobs.push(doJson(env.CAMPAIGN_LOG, env, "shared-campaign", "/portraits/import", post({ portraits: live.portraits })));
  if (live.session && typeof live.session === "object") {
    const { initiative, enabled, ...session } = live.session;
    jobs.push((async () => {
      await doJson(env.MANUAL_LOG, env, "shared-manual-log", "/", { method: "DELETE" });
      await doJson(env.MANUAL_LOG, env, "shared-manual-log", "/", post(session));
    })());
  }
  await Promise.all(jobs);
}

async function routeCampaign(request, env, ctx) {
    const url = new URL(request.url);
    // Is a GM key configured, and is this browser's stored key still right?
    // The GM sign-in form asks this before storing a key, and re-asks on
    // every load, so a rotated secret is reported at the door rather than
    // as an inexplicably empty GM page.
    if (url.pathname === "/gm/names") {
      if (!gmAuthorised(request, env)) return gmDenied(env);
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "content-type": "application/json", ...CORS_HEADERS } });
      }
      const allowedTypes = new Set([
        "Star Wars Male", "Star Wars Female", "Bothan", "Chiss", "Duros", "Gamorrean", "Hutt", "Ithorian",
        "Mon Calamari", "Quarren", "Rodian", "Sullustan", "Trandoshan", "Twilek", "Wookiee", "Droid",
        "Star Wars Location", "Star Wars Planet",
      ]);
      const type = url.searchParams.get("type") || "Star Wars Male";
      if (!allowedTypes.has(type)) {
        return new Response(JSON.stringify({ error: "Unknown name type" }), { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS } });
      }
      try {
        const upstreamUrl = new URL("https://donjon.bin.sh/name/rpc-name.fcgi");
        upstreamUrl.searchParams.set("type", type);
        upstreamUrl.searchParams.set("n", "10");
        upstreamUrl.searchParams.set("as_json", "1");
        const upstream = await fetch(upstreamUrl.toString(), { headers: { accept: "application/json" } });
        if (!upstream.ok) throw new Error(`Donjon returned ${upstream.status}`);
        const payload = await upstream.json();
        const names = Array.isArray(payload)
          ? payload.filter((name) => typeof name === "string").slice(0, 10).map((name) => name.slice(0, 100))
          : [];
        if (!names.length) throw new Error("Donjon returned no names");
        return new Response(JSON.stringify({ names, source: "donjon" }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: `Name generator unavailable: ${error.message}` }), {
          status: 502,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
    }
    if (url.pathname === "/gm/check") {
      if (!gmAuthorised(request, env)) return gmDenied(env);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }
    if (url.pathname === "/visibility") {
      if (!env.VISIBILITY_LOG) {
        return new Response(JSON.stringify({ error: "VISIBILITY_LOG Durable Object not bound on this Worker yet — see setup note in worker/index.js", overrides: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
      // Reading the current overrides is open to every browser (see the
      // comment on VisibilityLog above); only writing a new one needs the
      // GM key.
      if (request.method !== "GET" && request.method !== "OPTIONS" && !gmAuthorised(request, env)) {
        return gmDenied(env);
      }
      const id = env.VISIBILITY_LOG.idFromName(doName(env, "shared-visibility-log"));
      const stub = env.VISIBILITY_LOG.get(id);
      return stub.fetch(request);
    }
    if (url.pathname === "/rolls") {
      if (!env.ROLL_LOG) {
        return new Response(JSON.stringify({ error: "ROLL_LOG Durable Object not bound on this Worker yet — see setup note in worker/index.js", rolls: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
      // Fixed name -> always the same single DO instance, so the whole
      // campaign shares exactly one authoritative roll log.
      const id = env.ROLL_LOG.idFromName(doName(env, "shared-roll-log"));
      const stub = env.ROLL_LOG.get(id);
      // Tell the log whether this request carries a valid GM key. Strip any
      // browser-supplied copy of the internal header first so it can't be
      // forged. A wrong or missing key just means an ordinary player roll.
      const fwdHeaders = new Headers(request.headers);
      fwdHeaders.delete(ROLL_GM_HEADER);
      if ((request.method === "POST" || request.method === "PUT") && gmAuthorised(request, env)) {
        fwdHeaders.set(ROLL_GM_HEADER, "1");
      }
      return stub.fetch(new Request(request, { headers: fwdHeaders }));
    }
    if (url.pathname === "/notes") {
      if (!env.NOTES_LOG) {
        return new Response(JSON.stringify({ error: "NOTES_LOG Durable Object not bound on this Worker yet — see setup note in worker/index.js", notes: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
      const id = env.NOTES_LOG.idFromName(doName(env, "shared-notes-log"));
      const stub = env.NOTES_LOG.get(id);
      return stub.fetch(request);
    }
    if (url.pathname === "/bio") {
      if (!env.BIO_LOG) {
        return new Response(JSON.stringify({ error: "BIO_LOG Durable Object not bound on this Worker yet — see setup note in worker/index.js", bios: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
      const id = env.BIO_LOG.idFromName(doName(env, "shared-bio-log"));
      const stub = env.BIO_LOG.get(id);
      return stub.fetch(request);
    }
    if (url.pathname === "/crew") {
      if (!env.CREW_LOG) {
        return new Response(JSON.stringify({ error: "CREW_LOG Durable Object not bound on this Worker yet — see setup note in worker/index.js", crew: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
      const id = env.CREW_LOG.idFromName(doName(env, "shared-crew-log"));
      const stub = env.CREW_LOG.get(id);
      return stub.fetch(request);
    }
    // Manual mode — deliberately open write, same trust model as /rolls,
    // /notes, /bio and /crew above. See ManualLog's comment for why.
    if (url.pathname === "/manual") {
      if (!env.MANUAL_LOG) {
        return new Response(JSON.stringify({ error: "MANUAL_LOG Durable Object not bound on this Worker yet — see setup note in worker/index.js", ...emptyManualState() }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
      const id = env.MANUAL_LOG.idFromName(doName(env, "shared-manual-log"));
      const stub = env.MANUAL_LOG.get(id);
      return stub.fetch(request);
    }
    if (url.pathname === "/enemies" || url.pathname === "/gm/enemies") {
      const isGm = url.pathname.startsWith("/gm/");
      if (!env.ENEMY_LOG) {
        return new Response(JSON.stringify({ error: "ENEMY_LOG Durable Object not bound on this Worker yet — see setup note in worker/index.js", enemies: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
      const id = env.ENEMY_LOG.idFromName(doName(env, "shared-enemy-board"));
      const stub = env.ENEMY_LOG.get(id);

      if (isGm) {
        if (!gmAuthorised(request, env)) return gmDenied(env);
        return stub.fetch(request);
      }

      // The public view is read-only and redacted: Soak never leaves the
      // server, and every write goes through /gm/enemies — a player can
      // watch a wound tick up but never move it and never sees Soak.
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "The enemy board is edited from the GM page" }), {
          status: 405,
          headers: { "content-type": "application/json", ...CORS_HEADERS },
        });
      }
      const res = await stub.fetch(new Request("https://enemy-board.internal/", { method: "GET" }));
      const data = await res.json();
      return new Response(JSON.stringify({ enemies: publicEnemyView(data.enemies) }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }
    if (url.pathname === "/gear" || url.pathname === "/gm/gear") {
      const isGm = url.pathname.startsWith("/gm/");
      if (!env.GEAR_LOG) {
        return new Response(JSON.stringify({ error: "GEAR_LOG Durable Object not bound on this Worker yet — see setup note in worker/index.js", gear: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
      const id = env.GEAR_LOG.idFromName(doName(env, "shared-gear-log"));
      const stub = env.GEAR_LOG.get(id);

      if (isGm) {
        if (!gmAuthorised(request, env)) return gmDenied(env);
        return stub.fetch(request);
      }

      // Same redaction pattern as /enemies: read-only for players, and any
      // hidden item is dropped entirely rather than merely flagged.
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Gear is edited from the GM page" }), {
          status: 405,
          headers: { "content-type": "application/json", ...CORS_HEADERS },
        });
      }
      const res2 = await stub.fetch(new Request("https://gear-log.internal/", { method: "GET" }));
      const data2 = await res2.json();
      return new Response(JSON.stringify({ gear: publicGearView(data2.gear) }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }
    if (url.pathname === "/map" || url.pathname === "/gm/map") {
      const isGm = url.pathname.startsWith("/gm/");
      if (!env.MAP_LOG) {
        return new Response(JSON.stringify({ error: "MAP_LOG Durable Object not bound on this Worker yet — see setup note in worker/index.js", zones: [{ x: 0, y: 0 }], tokens: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
        });
      }
      if (isGm && !gmAuthorised(request, env)) return gmDenied(env);

      const stub = env.MAP_LOG.get(env.MAP_LOG.idFromName(doName(env, "shared-battle-map")));

      // Zone add/remove is GM-only regardless of path, since it reshapes the
      // board for everyone.
      if (request.method === "POST") {
        let body;
        try {
          body = await request.clone().json();
        } catch {
          body = null;
        }
        if ((body?.addZone || body?.removeZone) && !isGm) {
          return new Response(JSON.stringify({ error: "Only the GM can add or remove zones" }), { status: 403, headers: { "content-type": "application/json", ...CORS_HEADERS } });
        }
        if (body?.reset && !isGm) {
          return new Response(JSON.stringify({ error: "Only the GM can reset the map" }), { status: 403, headers: { "content-type": "application/json", ...CORS_HEADERS } });
        }
        // A token move targeting an enemy id needs the GM key — only the GM
        // manipulates enemy tokens; anyone can move their own PC token.
        if (body?.id && !body?.off && !isGm && env.ENEMY_LOG) {
          const eRes = await env.ENEMY_LOG.get(env.ENEMY_LOG.idFromName(doName(env, "shared-enemy-board"))).fetch(new Request("https://enemy-board.internal/", { method: "GET" }));
          const enemies = (await eRes.json()).enemies || [];
          if (enemies.some((e) => e.id === body.id)) {
            return new Response(JSON.stringify({ error: "Only the GM can move enemy tokens" }), { status: 403, headers: { "content-type": "application/json", ...CORS_HEADERS } });
          }
        }
      }

      if (request.method !== "GET" || isGm) return stub.fetch(request);

      const res = await stub.fetch(new Request("https://battle-map.internal/", { method: "GET" }));
      const data = await res.json();
      let enemies = [];
      if (env.ENEMY_LOG) {
        const eRes = await env.ENEMY_LOG.get(env.ENEMY_LOG.idFromName(doName(env, "shared-enemy-board"))).fetch(new Request("https://enemy-board.internal/", { method: "GET" }));
        enemies = (await eRes.json()).enemies || [];
      }
      return new Response(JSON.stringify({ zones: data.zones, tokens: publicMapView(data.tokens, enemies) }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }
    // Character creation (see CampaignLog.handleCreation).
    //   GET  /creation/<code>          player: load the draft
    //   PUT  /creation/<code>          player: save the draft
    //   POST /creation/<code>/submit   player: send it to the GM
    //   GET  /gm/creation              GM: list invites
    //   POST /gm/creation              GM: new invite { label }
    //   DELETE /gm/creation/<code>     GM: delete an invite
    //   POST /gm/creation/<code>/approve { visible }  GM: add to the campaign
    //   POST /gm/creation/<code>/reopen  { note }     GM: send back to the player
    if (url.pathname.startsWith("/creation/") || url.pathname === "/gm/creation" || url.pathname.startsWith("/gm/creation/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS };
      if (!env.CAMPAIGN_LOG) return new Response(JSON.stringify({ error: "CAMPAIGN_LOG Durable Object not bound on this Worker yet — add it to wrangler.jsonc" }), { status: 503, headers: jsonHeaders });
      const isGm = url.pathname.startsWith("/gm/");
      const rest = url.pathname.slice(isGm ? "/gm/creation".length : "/creation".length); // "", "/<code>", "/<code>/<action>"
      const [, code = "", action = ""] = rest.split("/");
      if (code && !/^[a-z0-9]{8}$/.test(code)) return new Response(JSON.stringify({ error: "That character creation link isn't valid." }), { status: 404, headers: jsonHeaders });
      if (isGm) {
        if (!gmAuthorised(request, env)) return gmDenied(env);
      } else {
        // Players may only load, save and submit their own draft.
        const allowed = code && ((!action && (request.method === "GET" || request.method === "PUT")) || (action === "submit" && request.method === "POST"));
        if (!allowed) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: jsonHeaders });
      }
      if (isGm && !code && !["GET", "POST"].includes(request.method)) return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
      if (isGm && code && !action && request.method !== "DELETE" && request.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
      if (isGm && action && !["approve", "reopen"].includes(action)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: jsonHeaders });

      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > CREATION_DRAFT_MAX * 2) return new Response(JSON.stringify({ error: "That character is too large to save." }), { status: 413, headers: jsonHeaders });
      const body = request.method === "POST" || request.method === "PUT" ? await request.text() : undefined;
      const stub = env.CAMPAIGN_LOG.get(env.CAMPAIGN_LOG.idFromName(doName(env, "shared-campaign")));
      const res = await stub.fetch(new Request(`https://campaign.internal/creation${code ? `/${code}` : ""}${action ? `/${action}` : ""}`, { method: request.method, body }));
      const data = await res.json();

      // On approval, also put the player's description into the shared
      // Description field on the character sheet (the /bio store).
      if (isGm && action === "approve" && res.ok && data.description && env.BIO_LOG) {
        await env.BIO_LOG.get(env.BIO_LOG.idFromName(doName(env, "shared-bio-log"))).fetch(new Request("https://bio.internal/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ characterId: data.liveId, field: "description", text: data.description }),
        }));
      }
      return new Response(JSON.stringify(data), { status: res.status, headers: jsonHeaders });
    }
    // XP (see CampaignLog.handleXp).
    //   GET  /campaign/advance                    anyone: purchase requests and their status
    //   POST /campaign/advance                    player: submit a purchase
    //   POST /gm/campaign/advance/<id>/approve    GM
    //   POST /gm/campaign/advance/<id>/reject     GM
    //   POST /gm/campaign/xp                      GM: award (or remove) XP
    if (url.pathname === "/campaign/advance" || url.pathname.startsWith("/gm/campaign/advance/") || url.pathname === "/gm/campaign/xp") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS };
      if (!env.CAMPAIGN_LOG) return new Response(JSON.stringify({ error: "CAMPAIGN_LOG Durable Object not bound on this Worker yet — add it to wrangler.jsonc" }), { status: 503, headers: jsonHeaders });
      const isGm = url.pathname.startsWith("/gm/");
      if (isGm && !gmAuthorised(request, env)) return gmDenied(env);
      if (isGm && request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
      if (!isGm && !["GET", "POST"].includes(request.method)) return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
      const internal = isGm ? url.pathname.slice("/gm/campaign".length) : "/advance";
      if (isGm && internal.startsWith("/advance/") && !/^\/advance\/[0-9a-f-]{36}\/(approve|reject)$/.test(internal)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: jsonHeaders });
      let bodyText = request.method === "POST" ? await request.text() : undefined;
      if (bodyText && bodyText.length > 50_000) return new Response(JSON.stringify({ error: "That request is too large." }), { status: 413, headers: jsonHeaders });
      // Force sensitivity can also be switched on live from the GM page (a
      // VisibilityLog override); pass the effective value through.
      if (request.method === "POST" && env.VISIBILITY_LOG && (internal === "/advance" || internal.endsWith("/approve"))) {
        let parsed = {};
        try { parsed = JSON.parse(bodyText || "{}"); } catch { parsed = {}; }
        let charId = parsed.characterId;
        if (!charId && internal.endsWith("/approve")) {
          const listRes = await env.CAMPAIGN_LOG.get(env.CAMPAIGN_LOG.idFromName(doName(env, "shared-campaign"))).fetch(new Request("https://campaign.internal/advance", { method: "GET" }));
          const rid = internal.split("/")[2];
          charId = ((await listRes.json()).requests || []).find((r) => r.id === rid)?.characterId;
        }
        if (charId) {
          const vRes = await env.VISIBILITY_LOG.get(env.VISIBILITY_LOG.idFromName(doName(env, "shared-visibility-log"))).fetch(new Request("https://visibility.internal/", { method: "GET" }));
          const ov = (await vRes.json()).overrides || {};
          const key = `${charId}::force::sensitive`;
          delete parsed.forceSensitive;
          if (Object.prototype.hasOwnProperty.call(ov, key)) parsed.forceSensitive = !!ov[key];
          bodyText = JSON.stringify(parsed);
        }
      }
      const stub = env.CAMPAIGN_LOG.get(env.CAMPAIGN_LOG.idFromName(doName(env, "shared-campaign")));
      const res = await stub.fetch(new Request(`https://campaign.internal${internal}`, { method: request.method, body: bodyText }));
      return new Response(await res.text(), { status: res.status, headers: jsonHeaders });
    }
    // Character portraits.
    //   GET    /portrait/<id>      anyone with the campaign link
    //   PUT    /gm/portrait/<id>   GM: upload (body is the image)
    //   DELETE /gm/portrait/<id>   GM: remove
    const portraitMatch = /^\/(gm\/)?(portrait|vehicle-image)\/([^/]{1,200})$/.exec(url.pathname);
    if (portraitMatch) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      const isGm = !!portraitMatch[1];
      let id;
      try { id = decodeURIComponent(portraitMatch[3]); } catch { id = ""; }
      const stub = env.CAMPAIGN_LOG.get(env.CAMPAIGN_LOG.idFromName(doName(env, "shared-campaign")));
      const target = `https://campaign.internal/${portraitMatch[2] === "vehicle-image" ? "vimage" : "portrait"}?id=${encodeURIComponent(id)}`;
      if (isGm) {
        if (!gmAuthorised(request, env)) return gmDenied(env);
        if (request.method !== "PUT" && request.method !== "DELETE") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "content-type": "application/json", ...CORS_HEADERS } });
        const declared = Number(request.headers.get("content-length") || 0);
        if (declared > PORTRAIT_MAX_BYTES) return new Response(JSON.stringify({ error: "That picture is too large (over 2 MB)." }), { status: 413, headers: { "content-type": "application/json", ...CORS_HEADERS } });
        const res = await stub.fetch(new Request(target, { method: request.method, headers: { "content-type": request.headers.get("content-type") || "" }, body: request.method === "PUT" ? await request.arrayBuffer() : undefined }));
        return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS } });
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const res = await stub.fetch(new Request(target, { method: "GET" }));
      if (!res.ok) return new Response("Not found", { status: 404, headers: { "cache-control": "no-cache" } });
      // The address carries ?v=<upload time>, so a cached copy is always the current picture.
      return new Response(request.method === "HEAD" ? null : res.body, { status: 200, headers: { "content-type": res.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    }

    // The campaign's uploaded wiki (the docs/ folder from wiki/build.py).
    //   GET    /wiki/, /wiki/<path>    anyone with the campaign link
    //   POST   /gm/wiki/begin          GM: start an upload
    //   PUT    /gm/wiki/file?v=&path=  GM: one file
    //   POST   /gm/wiki/commit         GM: make the upload live
    //   DELETE /gm/wiki                GM: remove the wiki
    // HTML is served with a sandbox policy (see WIKI_CSP).
    if (url.pathname === "/wiki" || url.pathname.startsWith("/wiki/") || url.pathname === "/gm/wiki" || url.pathname.startsWith("/gm/wiki/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      const stub = env.CAMPAIGN_LOG.get(env.CAMPAIGN_LOG.idFromName(doName(env, "shared-campaign")));
      const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS };
      if (url.pathname.startsWith("/gm/wiki")) {
        if (!gmAuthorised(request, env)) return gmDenied(env);
        const sub = url.pathname.slice("/gm/wiki".length);
        const allowed = (request.method === "POST" && (sub === "/begin" || sub === "/commit")) || (request.method === "PUT" && sub === "/file") || (request.method === "DELETE" && sub === "");
        if (!allowed) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: jsonHeaders });
        const declared = Number(request.headers.get("content-length") || 0);
        if (declared > WIKI_FILE_MAX) return new Response(JSON.stringify({ error: `That file is too large (over ${WIKI_FILE_MAX / 1e6} MB).` }), { status: 413, headers: jsonHeaders });
        const body = request.method === "PUT" || request.method === "POST" ? await request.arrayBuffer() : undefined;
        const res = await stub.fetch(new Request(`https://campaign.internal/wiki${sub}${url.search}`, { method: request.method, body }));
        return new Response(await res.text(), { status: res.status, headers: jsonHeaders });
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      // Relative links (img/…) need the trailing slash.
      if (url.pathname === "/wiki") return new Response(null, { status: 301, headers: { location: `wiki/${url.search}` } });
      const path = wikiCleanPath(url.pathname.slice("/wiki/".length) || "index.html");
      const res = path
        ? await stub.fetch(new Request(`https://campaign.internal/wiki/${encodeURIComponent(path).replace(/%2F/g, "/")}`, { method: "GET", headers: { "if-none-match": request.headers.get("if-none-match") || "" } }))
        : new Response("Not found", { status: 404 });
      const isHtml = path && /\.html?$/i.test(path);
      const headers = {
        "content-type": res.ok ? wikiType(path) : "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-cache",
      };
      // HTML and SVG can carry scripts: both run sandboxed in an isolated origin.
      if (isHtml || /\.svg$/i.test(path || "")) headers["content-security-policy"] = WIKI_CSP;
      const etag = res.headers.get("x-wiki-etag");
      if (etag && etag !== "legacy") headers.etag = etag;
      if (res.status === 304) return new Response(null, { status: 304, headers });
      if (!res.ok) {
        headers["content-security-policy"] = WIKI_CSP;
        return new Response(path === "index.html" ? "No wiki has been uploaded for this campaign yet." : "Not found", { status: 404, headers });
      }
      return new Response(request.method === "HEAD" ? null : res.body, { status: 200, headers });
    }

    // Campaign data: the replacement for ledger.json (see CampaignLog).
    //   GET  /campaign            players: redacted, read only
    //   GET  /gm/campaign         GM: everything
    //   POST /gm/campaign/import  GM: replace with an uploaded ledger.json
    //   POST /gm/campaign/restore GM: undo the last import
    //   GET  /gm/campaign/export  GM: download the whole campaign
    //   POST /gm/campaign/settings GM: title and wiki link
    //   POST /gm/campaign/vehicle  GM: add, edit or remove the vehicle
    //   POST /gm/campaign/order    GM: { order: [characterId, ...] } tab order
    //   POST /gm/campaign/character       GM: fix a character sheet { characterId, character, note }
    //   POST /gm/campaign/character/undo  GM: put back the version before the last fix
    //   POST /gm/campaign/character/import GM: add or replace one character from a file
    // Both GETs accept ?since=<revision> and answer { unchanged: true } when
    // nothing has moved, so the 5-second poll costs almost nothing.
    if (url.pathname === "/campaign" || url.pathname.startsWith("/gm/campaign")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS };
      if (!env.CAMPAIGN_LOG) {
        return new Response(JSON.stringify({ error: "CAMPAIGN_LOG Durable Object not bound on this Worker yet — add it to wrangler.jsonc", campaign: null, revision: 0 }), { status: 200, headers: jsonHeaders });
      }
      const isGm = url.pathname.startsWith("/gm/");
      if (isGm && !gmAuthorised(request, env)) return gmDenied(env);
      const stub = env.CAMPAIGN_LOG.get(env.CAMPAIGN_LOG.idFromName(doName(env, "shared-campaign")));
      const sub = isGm ? url.pathname.slice("/gm/campaign".length) : "";

      if (isGm && request.method === "POST" && (sub === "/import" || sub === "/restore")) {
        const declared = Number(request.headers.get("content-length") || 0);
        if (declared > CAMPAIGN_BODY_MAX) {
          return new Response(JSON.stringify({ error: "That file is too big for a campaign (over 1.5 MB)." }), { status: 413, headers: jsonHeaders });
        }
        let body = sub === "/import" ? await request.text() : "";
        if (body.length > CAMPAIGN_BODY_MAX) {
          return new Response(JSON.stringify({ error: "That file is too big for a campaign (over 1.5 MB)." }), { status: 413, headers: jsonHeaders });
        }
        // The live section (sheet notes, session state…) goes to its own
        // stores, not into the campaign record.
        let live = null;
        if (sub === "/import") {
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed === "object" && parsed.live) {
              live = parsed.live;
              delete parsed.live;
              body = JSON.stringify(parsed);
            }
          } catch { /* the Durable Object reports bad JSON */ }
        }
        const res = await stub.fetch(new Request(`https://campaign.internal${sub}`, { method: "POST", body: sub === "/import" ? body : undefined }));
        if (res.ok && live) {
          await importLive(env, live);
          const data = await res.json();
          return new Response(JSON.stringify({ ...data, liveRestored: true }), { status: 200, headers: jsonHeaders });
        }
        return res;
      }

      // POST /gm/campaign/settings  { title?, wikiUrl? }
      // POST /gm/campaign/vehicle   { vehicle: {...} | null }
      if (isGm && request.method === "POST" && (sub === "/settings" || sub === "/vehicle" || sub === "/order" || sub === "/character" || sub === "/character/undo" || sub === "/character/import")) {
        const declared = Number(request.headers.get("content-length") || 0);
        const body = declared > CAMPAIGN_EDIT_MAX ? "" : await request.text();
        if (declared > CAMPAIGN_EDIT_MAX || body.length > CAMPAIGN_EDIT_MAX) {
          return new Response(JSON.stringify({ error: "That's too large to save." }), { status: 413, headers: jsonHeaders });
        }
        const res = await stub.fetch(new Request(`https://campaign.internal${sub}`, { method: "POST", body }));
        // A character file can carry that character's sheet notes
        // ({ live: { bio: {...} } }): put them back under its (new) id.
        if (sub === "/character/import" && res.ok) {
          const data = await res.json();
          let bio = null;
          try { bio = JSON.parse(body)?.live?.bio || null; } catch { bio = null; }
          if (bio && typeof bio === "object" && data.liveId) {
            await doJson(env.BIO_LOG, env, "shared-bio-log", "/__restore", { method: "POST", body: JSON.stringify({ merge: true, bios: { [data.liveId]: bio } }) });
          }
          return new Response(JSON.stringify(data), { status: 200, headers: jsonHeaders });
        }
        return res;
      }

      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: isGm ? "Not found" : "The campaign is edited from the GM page" }), { status: isGm ? 404 : 405, headers: jsonHeaders });
      }

      const res = await stub.fetch(new Request("https://campaign.internal/", { method: "GET" }));
      const data = await res.json();

      if (isGm && sub === "/export") {
        if (!data.campaign) return new Response(JSON.stringify({ error: "There's no campaign loaded to export yet." }), { status: 404, headers: jsonHeaders });
        const day = new Date().toISOString().slice(0, 10);
        const slug = String(data.campaign.campaign || "campaign").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "campaign";
        const { wiki, ...exported } = data.campaign;
        exported.live = await exportLive(env);
        exported.exportedAt = new Date().toISOString();
        return new Response(JSON.stringify(exported, null, 2), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="${slug}-${day}.json"`,
            "cache-control": "no-store",
            ...CORS_HEADERS,
          },
        });
      }
      if (isGm && sub !== "") {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: jsonHeaders });
      }

      const since = url.searchParams.get("since");
      if (isGm) {
        const tag = String(data.revision);
        if (since === tag) return new Response(JSON.stringify({ unchanged: true, revision: tag }), { status: 200, headers: jsonHeaders });
        return new Response(JSON.stringify({ ...data, revision: tag }), { status: 200, headers: jsonHeaders });
      }

      // The player copy also depends on the GM page's live hide/reveal
      // overrides, so its change tag covers both: revealing an item mid-
      // session reaches players on their next poll even though the campaign
      // itself didn't change.
      let overrides = {};
      if (env.VISIBILITY_LOG && data.campaign) {
        const vRes = await env.VISIBILITY_LOG.get(env.VISIBILITY_LOG.idFromName(doName(env, "shared-visibility-log"))).fetch(new Request("https://visibility.internal/", { method: "GET" }));
        overrides = (await vRes.json()).overrides || {};
      }
      const tag = `${data.revision}:${quickHash(JSON.stringify(overrides))}`;
      if (since === tag) return new Response(JSON.stringify({ unchanged: true, revision: tag }), { status: 200, headers: jsonHeaders });
      return new Response(JSON.stringify({ campaign: publicCampaignView(data.campaign, overrides), revision: tag, updatedAt: data.updatedAt }), { status: 200, headers: jsonHeaders });
    }
    return env.ASSETS.fetch(request);
}

// =============================================================================
// Several campaigns on one site.
//
// Every campaign lives under its own address, /campaign/<slug>/. The router below
// strips that prefix, then runs the normal routes (routeCampaign above) with
// every Durable Object name prefixed by the slug — so each campaign has its
// own campaign data, roll log, dice pool, session state, map, notes and so
// on, and nothing is shared between them. The browser does the same with
// what it saves locally (see campaignStorage in src/App.jsx).
//
// The list of campaigns and their GM passwords (hashed) lives in one
// CampaignRegistry Durable Object. The front page (/) lists the campaigns
// marked "listed"; the site owner manages them with the master password.
// =============================================================================

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(["api", "assets", "data", "images", "sounds", "c", "campaign", "admin", "gm"]);
const REGISTRY_CACHE_MS = 15_000;
const ADMIN_HEADER = "x-admin-key";

function doName(env, base) {
  return `${env.CAMPAIGN_SLUG}:${base}`;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
function gmHashFor(slug, password) {
  return sha256Hex(`swrpg-gm:${slug}:${password}`);
}
function masterPassword(env) {
  return env.ADMIN_PASSWORD || env.GM_PASSWORD || "";
}
function adminAuthorised(request, env) {
  const expected = masterPassword(env);
  return !!expected && secretsMatch(request.headers.get(ADMIN_HEADER) || "", expected);
}

export class CampaignRegistry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.campaigns = {};
    this.ctx.blockConcurrencyWhile(async () => {
      this.campaigns = (await this.ctx.storage.get("campaigns")) || {};
    });
  }
  json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET") return this.json({ campaigns: this.campaigns });
    let body = {};
    try { body = await request.json(); } catch { return this.json({ error: "Invalid JSON" }, 400); }
    const slug = String(body.slug || "");
    if (url.pathname === "/create") {
      if (this.campaigns[slug]) return this.json({ error: "That address is already taken." }, 409);
      if (Object.keys(this.campaigns).length >= 50) return this.json({ error: "This site already has 50 campaigns." }, 409);
      this.campaigns[slug] = { name: body.name, listed: !!body.listed, gmHash: body.gmHash || "", createdAt: Date.now(), updatedAt: Date.now() };
    } else if (url.pathname === "/update") {
      const c = this.campaigns[slug];
      if (!c) return this.json({ error: "No campaign at that address." }, 404);
      if (typeof body.name === "string") c.name = body.name;
      if (typeof body.listed === "boolean") c.listed = body.listed;
      if (typeof body.gmHash === "string") c.gmHash = body.gmHash;
      c.updatedAt = Date.now();
    } else if (url.pathname === "/remove") {
      if (!this.campaigns[slug]) return this.json({ error: "No campaign at that address." }, 404);
      delete this.campaigns[slug];
    } else {
      return this.json({ error: "Not found" }, 404);
    }
    await this.ctx.storage.put("campaigns", this.campaigns);
    return this.json({ ok: true, campaigns: this.campaigns });
  }
}

// Each Worker instance keeps the registry for a few seconds, so ordinary
// polling doesn't add a registry lookup to every request.
let registryCache = { at: 0, campaigns: null };
function registryStub(env) {
  return env.CAMPAIGN_REGISTRY.get(env.CAMPAIGN_REGISTRY.idFromName("campaign-registry"));
}
async function loadRegistry(env, fresh = false) {
  if (!fresh && registryCache.campaigns && Date.now() - registryCache.at < REGISTRY_CACHE_MS) return registryCache.campaigns;
  const res = await registryStub(env).fetch(new Request("https://registry.internal/", { method: "GET" }));
  const data = await res.json();
  registryCache = { at: Date.now(), campaigns: data.campaigns || {} };
  return registryCache.campaigns;
}
async function registryWrite(env, action, body) {
  const res = await registryStub(env).fetch(new Request(`https://registry.internal/${action}`, { method: "POST", body: JSON.stringify(body) }));
  const data = await res.json();
  if (res.ok && data.campaigns) registryCache = { at: Date.now(), campaigns: data.campaigns };
  return { status: res.status, data };
}

function apiJson(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS } });
}

function slugFromName(name) {
  return String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
}
function randomSuffix(n = 5) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// Front-page and admin routes (no campaign in the address).
//   GET    /api/campaigns              anyone: the listed campaigns
//   GET    /api/campaigns/<slug>       anyone: does this campaign exist (and its name)
//   GET    /api/admin/campaigns        master: every campaign
//   POST   /api/admin/campaigns        master: { name, slug?, private?, gmPassword, listed }
//   POST   /api/admin/campaigns/<slug> master: { name?, gmPassword?, listed? }
//   DELETE /api/admin/campaigns/<slug> master: take it off the site (data is kept)
async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!env.CAMPAIGN_REGISTRY) return apiJson({ error: "CAMPAIGN_REGISTRY Durable Object not bound — add it to wrangler.jsonc" }, 500);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  if (parts[1] === "campaigns" && request.method === "GET") {
    const all = await loadRegistry(env);
    if (parts[2]) {
      const c = all[parts[2]];
      return c ? apiJson({ exists: true, slug: parts[2], name: c.name }) : apiJson({ exists: false }, 404);
    }
    return apiJson({ campaigns: Object.entries(all).filter(([, c]) => c.listed).map(([slug, c]) => ({ slug, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  if (parts[1] !== "admin") return apiJson({ error: "Not found" }, 404);
  if (!masterPassword(env)) return apiJson({ error: "No master password set on this site (wrangler secret put ADMIN_PASSWORD).", configured: false }, 401);
  if (!adminAuthorised(request, env)) return apiJson({ error: "Wrong master password", configured: true }, 401);
  if (parts[2] === "check") return apiJson({ ok: true });
  if (parts[2] !== "campaigns") return apiJson({ error: "Not found" }, 404);
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 10_000) return apiJson({ error: "Too large" }, 413);
  const view = (all) => Object.entries(all).map(([slug, c]) => ({ slug, name: c.name, listed: !!c.listed, hasGmPassword: !!c.gmHash, createdAt: c.createdAt })).sort((a, b) => a.name.localeCompare(b.name));
  if (request.method === "GET" && !parts[3]) return apiJson({ campaigns: view(await loadRegistry(env, true)) });
  let body = {};
  if (request.method === "POST") {
    try { body = await request.json(); } catch { return apiJson({ error: "Invalid JSON" }, 400); }
  }
  const gmPassword = typeof body.gmPassword === "string" ? body.gmPassword.trim() : undefined;
  if (gmPassword !== undefined && gmPassword && (gmPassword.length < 6 || gmPassword.length > 200)) return apiJson({ error: "The GM password needs 6 to 200 characters." }, 400);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : undefined;
  if (request.method === "POST" && !parts[3]) {
    if (!name) return apiJson({ error: "The campaign needs a name." }, 400);
    if (!gmPassword) return apiJson({ error: "Set a GM password for the campaign." }, 400);
    let slug = String(body.slug || "").trim().toLowerCase() || slugFromName(name);
    if (!slug) slug = "campaign";
    if (body.private) slug = `${slug.slice(0, 33)}-${randomSuffix()}`;
    if (RESERVED_SLUGS.has(slug)) return apiJson({ error: `"${slug}" is used by the site itself; pick another address.` }, 400);
    if (!SLUG_RE.test(slug)) return apiJson({ error: "The address can only use lowercase letters, numbers and dashes (up to 40)." }, 400);
    const { status, data } = await registryWrite(env, "create", { slug, name, listed: !!body.listed, gmHash: await gmHashFor(slug, gmPassword) });
    if (status !== 200) return apiJson({ error: data.error }, status);
    return apiJson({ ok: true, slug, campaigns: view(data.campaigns) });
  }
  const slug = parts[3];
  if (request.method === "POST") {
    const patch = { slug };
    if (name !== undefined) { if (!name) return apiJson({ error: "The campaign needs a name." }, 400); patch.name = name; }
    if (typeof body.listed === "boolean") patch.listed = body.listed;
    if (gmPassword) patch.gmHash = await gmHashFor(slug, gmPassword);
    const { status, data } = await registryWrite(env, "update", patch);
    if (status !== 200) return apiJson({ error: data.error }, status);
    return apiJson({ ok: true, campaigns: view(data.campaigns) });
  }
  if (request.method === "DELETE") {
    const { status, data } = await registryWrite(env, "remove", { slug });
    if (status !== 200) return apiJson({ error: data.error }, status);
    return apiJson({ ok: true, campaigns: view(data.campaigns) });
  }
  return apiJson({ error: "Method not allowed" }, 405);
}

async function checkGmKey(request, env, slug, entry) {
  const key = request.headers.get(GM_HEADER) || "";
  if (!key) return false;
  const master = masterPassword(env);
  if (master && secretsMatch(key, master)) return true;
  if (!entry.gmHash) return false;
  return secretsMatch(await gmHashFor(slug, key), entry.gmHash);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);

    // Links from before campaigns moved to /campaign/<slug>/ still work.
    const old = /^\/c\/([a-z0-9-]{1,40})(\/.*)?$/.exec(url.pathname);
    if (old && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(null, { status: 301, headers: { location: `/campaign/${old[1]}${old[2] || "/"}${url.search}` } });
    }

    const m = /^\/campaign\/([a-z0-9-]{1,40})(\/.*)?$/.exec(url.pathname);
    // The front page and the site's static files.
    if (!m) return env.ASSETS.fetch(request);

    const slug = m[1];
    const rest = m[2] || "/";
    const inner = new URL(url);
    inner.pathname = rest;
    const innerRequest = new Request(inner.toString(), request);

    // Pages (anything that isn't an API call) are the same single-page app
    // for every campaign; it reads the campaign from the address itself.
    const registry = env.CAMPAIGN_REGISTRY ? await loadRegistry(env) : {};
    let entry = registry[slug];
    if (!entry && env.CAMPAIGN_REGISTRY) entry = (await loadRegistry(env, true))[slug];
    if (!entry) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      const accept = request.headers.get("accept") || "";
      if (request.method === "GET" && (accept.includes("text/html") || request.headers.get("sec-fetch-mode") === "navigate")) return env.ASSETS.fetch(new Request(new URL("/", url).toString(), request));
      return apiJson({ error: "There's no campaign at this address." }, 404);
    }

    const scoped = Object.create(env);
    scoped.CAMPAIGN_SLUG = slug;
    scoped.CAMPAIGN_NAME = entry.name;
    scoped.GM_CONFIGURED = !!entry.gmHash || !!masterPassword(env);
    scoped.GM_OK = await checkGmKey(request, env, slug, entry);
    return routeCampaign(innerRequest, scoped, ctx);
  },
};
