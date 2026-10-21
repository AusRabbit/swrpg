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
campaign as one JSON file, and **Import all** restores it (with Undo for the
campaign record). The file also carries a `live` section: what players type
on their sheets (description, the Notes boxes, credits), the GM's live
show/hide and Force-sensitivity overrides, field-acquired gear, session state
(wounds, strain, Destiny, critical injuries, vehicle damage, item counts, worn
armour) and crew seats. Import all puts those back too. Not included: rolls,
the GM inbox, the battle map, the enemy board, initiative and the wiki.
**One character** exports a single sheet with its notes, and imports one
back: it replaces the character with the same name (undoable from Edit a
character) or adds them as new.
`dashboard/public/data/ledger.json` is a sample of that format: Import it to start a
new deployment. The site never reads it directly.

## Running a campaign

- **New characters:** GM page → Character creation → start a draft and send
  the player the link. Approve it when they submit.
- **Awarding XP:** GM page → Experience → Award XP. Tick characters (or
  "Whole party"), enter the amount and a reason.
- **Fixing a sheet:** on a character's sheet press **✎ Edit sheet (GM)**
  (or GM page → Edit a character, at the bottom). Change skill ranks, career skills,
  talents, characteristics, thresholds, XP, credits, Motivation and
  Obligations (add, edit or remove any number); anything else
  (weapons, armour, gear) through the "full sheet as JSON" box. Edits don't
  charge or refund XP. **XP total** isn't editable: it's every XP the
  character has had, shown with a breakdown (starting XP, spent on the
  build, earned and spent during the campaign, unspent). Changing XP
  unspent is logged as a GM adjustment and moves the total with it.
  Adding, removing or re-ranking Toughened/Grit moves the wound/strain
  threshold. Each talent shows the skills it Boosts (automatic for Physical
  Training, Stalker, Uncanny Senses, Command, Sense Emotions and Combat
  Veteran; add or remove skills per talent), and each skill has buttons for
  extra Boost/Setback dice added by hand (click to add, right-click to
  remove).
  **Portrait:** upload a picture (shrunk to 800px in the browser and saved
  with the campaign straight away) or use a web address. Portraits travel
  with Export all / Import all.
  **Undo last edit** puts back the previous version.
- **Tab order:** GM page → Character tab order (near the bottom): move
  characters up or down and **Save order**; everyone's tabs follow it.
- **Spending XP:** players open their sheet's XP box (Advancement Planner),
  choose skills and talents, and press **Submit for approval**. The
  ★ GM tab pulses with a count while anything is waiting. Approve or reject
  it under GM page → Experience → Waiting for approval. Approving re-checks
  the cost against the character's current XP before applying it.

## Several campaigns on one site

One deployment hosts any number of campaigns, each at its own address:
`https://<site>/campaign/<campaign>/`. Every campaign has its own data (sheets,
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
- **Moving a campaign** (to another site, or to a new address): GM page →
  Campaign data → Export all on the old one, Import all on the new one, then
  upload the wiki zip again.

## Setup checklist

1. Set `"name"` in `dashboard/wrangler.jsonc` to the Worker name you want.
2. Deploy the dashboard to Cloudflare (steps in
   [`dashboard/README.md`](dashboard/README.md)) and add `ADMIN_PASSWORD`
   (or keep `GM_PASSWORD`) as a secret there.
3. Open the site, press **Manage campaigns**, sign in with that password and
   create your first campaign. Send players its link.
4. Wiki (per campaign): write the markdown in `wiki/content/` (pictures in
   `wiki/content/img/`), run `python wiki/build.py`, zip the `wiki/docs`
   folder, then on the campaign's GM page → **Wiki → Upload wiki…** pick
   the zip. It shows on that campaign's Wiki tab straight away (and at
   `/campaign/<campaign>/wiki/`). Upload again to replace it. No GitHub Pages
   needed.
5. Ships: GM page → Vehicles (bottom of the page, click to expand) →
   + Add vehicle. Pick a stock ship (or start blank), rename it, adjust the
   numbers and crew seats, then Add vehicle. Each vehicle gets its own
   dashboard tab named after it; add as many as you need.

## Privacy

The deployed dashboard is a public URL. Anyone with a campaign's link can
read whatever its players can see, so keep secrets in GM-only fields; a
hard-to-guess address keeps unlisted campaigns out of sight. GM writes need
that campaign's GM password (or the master password). To restrict the site itself, put it behind Cloudflare Access.
An uploaded wiki has the same reach as the campaign link, so only put
player-known material in `wiki/content/`.
