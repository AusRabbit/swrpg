# [campaign-repo-name]

[Campaign Name] — SWRPG campaign ledger and player dashboard, combined into
one **private** repo.

> **This is a template.** Copy the whole folder, rename it for the new
> campaign, then work through the checklist below before the first session.

## New campaign checklist

1. **Rename** the copied folder / repo (e.g. `my-new-campaign`) and replace
   `[campaign-repo-name]` / `[Campaign Name]` at the top of this README.
2. **Ledger** — fill in `ledgers/Ledger.md`: campaign header table, Section 1
   (one row per PC, ship), and Section 5 (copy the 5a sheet once per PC as
   5b, 5c, …). `ledgers/updates/` should hold only `_TEMPLATE.md` to start.
3. **Dashboard data** —
   - `dashboard/public/data/ledger.json`: set `campaign`, replace the
     placeholder `[PC 1 Name]` character with one entry per PC (each with a
     unique `liveId`, e.g. `pc1`, `pc2`…), and fill in the `vehicle` object
     (or delete it if the party has no ship). The crew positions and their
     actions are generic vehicle rules and can stay as they are.
   - `dashboard/data/live.json`: add one key per PC `liveId` under
     `wounds`, `strain`, and `criticalInjuries`.
   - Portraits: drop images into `dashboard/public/images/portraits/` and set
     each character's `"portrait": "/images/portraits/<file>.png"` (optional
     — the sheet renders without one).
4. **Browser tab title** — `dashboard/index.html` and the `document.title`
   line in `dashboard/src/App.jsx` (search for `TEMPLATE:`).
5. **Worker config** —
   - `dashboard/worker/index.js`: set `OWNER` and `REPO` to the new GitHub
     repo (these tell `/live` where to read `live.json` from).
   - `dashboard/wrangler.jsonc`: set `"name"` to the new Worker's name.
6. **GitHub + Cloudflare** — create the new private repo, push, then follow
   the deploy steps in [`dashboard/README.md`](dashboard/README.md)
   (`GITHUB_TOKEN` and `GM_PASSWORD` secrets).

## Structure

```
ledgers/      GM-only master ledger. Full campaign state, secrets, unrevealed
              plot material. Never read by the dashboard build or runtime.
dashboard/    The player-facing Cloudflare Worker app (character sheets, live
              vitals, dice roller, GM notes inbox). See dashboard/README.md
              for the app itself and Cloudflare deploy steps.
```

## Why these two live in one private repo

The ledger (`ledgers/`) is the GM's working notes — it contains spoilers,
NPC secrets, and provisional material the players haven't learned in play.
The dashboard (`dashboard/`) is what players actually look at during a
session. Keeping both in one **private** repo means:

- The GM edits the ledger and the dashboard's player-facing data files
  side by side, in the same place, without juggling two repos.
- Nobody outside invited collaborators can browse the source — including
  `ledgers/` — because the repo is private.

That said, repo privacy only protects the *source*. The dashboard is
deployed as a public site so players can load it without a GitHub account,
and it serves only the built `dashboard/dist` output — never `ledgers/`,
which isn't part of that build. The dashboard's own data files
(`dashboard/public/data/ledger.json`, `dashboard/data/live.json`) are
**hand-curated exports**, written for players — see
[`dashboard/README.md`](dashboard/README.md) for exactly what belongs in
them and what never does. If a session needs the deployed site itself
restricted (not just the repo), that's a separate Cloudflare Access
configuration, also covered there.

## Ledger maintenance

See the Ledger Protocol in [`ledgers/Ledger.md`](ledgers/Ledger.md) (Section
0) for save conventions and Quick Save updates in `ledgers/updates/`.
