# Campaign wiki

The player-facing campaign wiki: session recaps, a timeline, open threads, a
cross-linked cast, and a searchable talent list. It lives in this repo next to
`dashboard/` instead of in a separate wiki repo.

## How it's published

```
wiki/content/*.md  ->  wiki/build.py  ->  wiki/docs/index.html  ->  GitHub Pages
```

- **GitHub builds it.** Every push to `main` that touches `wiki/` (or the
  talent list or dice icons it borrows) runs `.github/workflows/wiki.yml`,
  which builds the page and publishes it to GitHub Pages. `wiki/docs/` is not
  committed.
- **Cloudflare ignores it.** The dashboard Worker builds and serves only
  `dashboard/`. To stop wiki-only pushes from triggering a Worker redeploy,
  set the Worker's build watch paths to `dashboard/*` (Cloudflare dashboard →
  the Worker → Settings → Build → Build watch paths).
- **Shared with the dashboard:** the talent list (`reference/talents.json`)
  and the dice and symbol icons (`dashboard/public/images/`). Update them once
  and both the dashboard and the wiki pick up the change.

One-time GitHub setup: Settings → Pages → Build and deployment → Source:
**GitHub Actions**. To link the wiki from the dashboard's Wiki tab, put the
Pages address in the campaign's wiki link.

GitHub Pages from a **private** repo needs a paid GitHub plan, and the
published site is public either way. Keep anything secret out of `content/`.

## Editing

`content/` is an [Obsidian](https://obsidian.md) vault. Every entity
(character, place, ship, item, faction) is one markdown file with
`[[wikilinks]]` to the others. Open the folder in Obsidian for backlinks and
the graph view.

Preview locally (Python 3, no dependencies):

```bash
python3 wiki/build.py
```

then open `wiki/docs/index.html`. The build fails, and the published page
isn't updated, if any `[[wikilink]]` points at a page that doesn't exist;
those links show in red.

## Campaign settings

The campaign name, sidebar tagline, description and footer note live in the
`CAMPAIGN` block at the top of `build.py`. `template.html` carries no
campaign names. The sidebar's "Session N" comes from the highest `session:`
in the vault.

## Adding a session

1. Record and transcribe the session (`names.txt` helps the transcriber with
   names).
2. Add `content/session-N.md` (`group: "Sessions"`, `session: N`, and an
   `order` that puts it first), add a `## Session N` block to `timeline.md`,
   and update `threads.md` and `overview.md`.
3. Add or update entity pages.
4. Commit and push. GitHub rebuilds and republishes the page.

## Frontmatter

```yaml
---
title: "The Rebel Alliance"
group: "Factions"           # sidebar section (see GROUP_ORDER in build.py)
type: faction               # character | place | ship | thing | faction | doc
conf: hi                    # hi | mid | lo  — how confident we are
short: "Alliance"           # optional: the form people actually say
aka: ["The Rebels"]         # real alternate names
aliases: ["The Alliants"]   # transcription mangles
session: 3                  # session pages only
dek: "One line under the title."
---
```

- **`aka`**: genuine alternate names. Shown as *Also known as*, added to
  `names.txt`, never to `corrections.json`.
- **`aliases`**: spellings a transcript actually produced. Shown as *Also
  transcribed as*, and they feed `corrections.json`.

Session pages use `type: doc`. The timeline and threads pages use
`layout: timeline` / `layout: threads`, and the talent list uses
`layout: talents`. In the timeline, `## Session N` lines become dividers and
each beat is ``- `M02` **Title** — text``, where the marker is the mission
(`M01`, `M02`, `INT` for interludes).

## The two name files

`build.py` regenerates both on every run:

- **`names.txt`**: canonical spellings only, prompted *into* the transcriber.
- **`corrections.json`**: alias → spoken form, applied to the transcript
  *after* recognition.

## What doesn't belong here

GM notes, stat blocks, NPC secrets and anything the players haven't learned.
Those now live on the dashboard's GM side. `wiki/gm/`, `wiki/private/` and
`*.gm.md` are git-ignored for local drafts.
