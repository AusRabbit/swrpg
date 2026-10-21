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

Back up from the GM page: **Campaign data → Export** downloads the whole
campaign as one JSON file, and **Import** restores it (with Undo).
`dashboard/public/data/ledger.json` is a sample of that format: Import it to start a
new deployment. The site never reads it directly.

## Running a campaign

- **New characters:** GM page → Character creation → start a draft and send
  the player the link. Approve it when they submit.
- **Awarding XP:** GM page → Experience → Award XP. Tick characters (or
  "Whole party"), enter the amount and a reason.
- **Fixing a sheet:** on a character's sheet press **✎ Edit sheet (GM)**
  (or GM page → Edit a character). Change skill ranks, career skills,
  talents, characteristics, thresholds, XP and credits; anything else
  (weapons, armour, gear) through the "full sheet as JSON" box. Edits don't
  charge or refund XP. **Undo last edit** puts back the previous version.
- **Spending XP:** players open their sheet's XP box (Advancement Planner),
  choose skills and talents, and press **Submit for approval**. The
  ★ GM tab pulses with a count while anything is waiting. Approve or reject
  it under GM page → Experience → Waiting for approval. Approving re-checks
  the cost against the character's current XP before applying it.

## Setup checklist

1. Set `"name"` in `dashboard/wrangler.jsonc` to the Worker name you want.
2. Set the browser tab title in `dashboard/index.html` and the
   `document.title` line in `dashboard/src/App.jsx` (search `TEMPLATE:`).
3. Deploy the dashboard to Cloudflare (steps in
   [`dashboard/README.md`](dashboard/README.md)) and add `GM_PASSWORD` as a
   secret there.
4. Wiki: in GitHub, Settings → Pages → Source: **GitHub Actions**. Push, and
   the wiki appears at `https://<user>.github.io/<repo>/`. Paste that URL
   into GM page → Campaign settings → Wiki link.
5. Ship: GM page → Vehicle. Pick a stock ship (or start blank), rename it,
   adjust the numbers and crew seats, then Add vehicle. The Vehicle tab
   appears for everyone.

## Privacy

The deployed dashboard is a public URL. Anyone with it can read whatever
players can see, so keep secrets in GM-only fields. GM writes need
`GM_PASSWORD`. To restrict the site itself, put it behind Cloudflare Access.
The GitHub Pages wiki is public too, so only put player-known material in
`wiki/content/`.
