# swrpg-beta

A SWRPG campaign run entirely from its website. The GM signs in on the
dashboard's GM page and manages everything there. There is no ledger file
to edit, no `live.json`, and no Quick Save or consolidation step.

## What's in the repo

```
dashboard/    The Cloudflare Worker app: character sheets, dice roller, shared
              session state, GM page. See dashboard/README.md.
wiki/         The player-facing campaign wiki, built by GitHub Actions and
              published on GitHub Pages. Cloudflare never builds or serves it.
              See wiki/README.md.
reference/    Rules data (talents, weapons, armour, adversaries) shared by the
              dashboard and the wiki.
.github/      wiki.yml: builds wiki/ and deploys it to GitHub Pages.
```

## Where campaign data lives

Everything the GM used to keep in a ledger now lives in the Worker's Durable
Objects:

- **Campaign** (`CampaignLog`): character sheets, vehicle, wiki link, XP
  history, character-creation drafts and XP purchase requests.
- **Session state** (`ManualLog`): wounds, strain, Destiny, Critical
  Injuries, initiative.
- The roll log, notes inbox, enemy board, battle map, crew seats and gear
  each have their own store.

Back up from the GM page: **Campaign data → Export all** downloads the whole
campaign as one JSON file, and **Import all** restores it (with Undo).
**One character** exports a single sheet, and imports one back: it replaces
the character with the same name (undoable from Edit a character) or adds
them as new.
`dashboard/public/data/ledger.json` is a sample of that format: Import it to start a
new deployment. The site never reads it directly.

## Running a campaign

- **New characters:** GM page → Character creation → start a draft and send
  the player the link. Approve it when they submit.
- **Awarding XP:** GM page → Experience → Award XP. Tick characters (or
  "Whole party"), enter the amount and a reason.
- **Fixing a sheet:** on a character's sheet press **✎ Edit sheet (GM)**
  (or GM page → Edit a character, at the bottom). Change skill ranks, career skills,
  talents, characteristics, thresholds, XP and credits; anything else
  (weapons, armour, gear) through the "full sheet as JSON" box. Edits don't
  charge or refund XP. **Undo last edit** puts back the previous version.
- **Spending XP:** players open their sheet's XP box (Advancement Planner),
  choose skills and talents, and press **Submit for approval**. The
  ★ GM tab pulses with a count while anything is waiting. Approve or reject
  it under GM page → Experience → Waiting for approval. Approving re-checks
  the cost against the character's current XP before applying it.

## Several campaigns on one site

One deployment hosts any number of campaigns, each at its own address:
`https://<site>/c/<campaign>/`. Every campaign has its own data (sheets,
rolls, dice pool, wounds, map, notes…) and its own GM password; nothing is
shared between them. The browser also saves each campaign's GM sign-in,
dice pool and roll-log name separately, so you can have several open at once.

- **Front page** (`/`): lists the campaigns you've marked "Show on the front
  page". Unlisted campaigns are reachable only by their link.
- **Manage campaigns** (small link at the bottom of the front page): sign in
  with the site's **master password** to create a campaign (name, address,
  GM password, optional hard-to-guess address), rename it, change its GM
  password, list/unlist it, or remove it. Removing only takes it off the
  site; its data stays and comes back if you create the same address again.
- **Master password**: the `ADMIN_PASSWORD` secret on Cloudflare, or your
  existing `GM_PASSWORD` if that's the only one set. It also signs in as GM
  in every campaign.
- **Moving a campaign in**: on its old site, GM page → Campaign data →
  Export all. On the new campaign's GM page, Import all.

## Setup checklist

1. Set `"name"` in `dashboard/wrangler.jsonc` to the Worker name you want.
2. Deploy the dashboard to Cloudflare (steps in
   [`dashboard/README.md`](dashboard/README.md)) and add `ADMIN_PASSWORD`
   (or keep `GM_PASSWORD`) as a secret there.
3. Open the site, press **Manage campaigns**, sign in with that password and
   create your first campaign. Send players its link.
4. Wiki (per campaign): in GitHub, Settings → Pages → Source: **GitHub Actions**. Push, and
   the wiki appears at `https://<user>.github.io/<repo>/`. Paste that URL
   into GM page → Campaign settings → Wiki link.
5. Ships: GM page → Vehicles (bottom of the page, click to expand) →
   + Add vehicle. Pick a stock ship (or start blank), rename it, adjust the
   numbers and crew seats, then Add vehicle. Each vehicle gets its own
   dashboard tab named after it; add as many as you need.

## Privacy

The deployed dashboard is a public URL. Anyone with a campaign's link can
read whatever its players can see, so keep secrets in GM-only fields; a
hard-to-guess address keeps unlisted campaigns out of sight. GM writes need
that campaign's GM password (or the master password). To restrict the site itself, put it behind Cloudflare Access.
The GitHub Pages wiki is public too, so only put player-known material in
`wiki/content/`.
