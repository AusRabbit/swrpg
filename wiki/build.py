#!/usr/bin/env python3
"""
Build the campaign wiki.

Reads  content/*.md   (Obsidian-style vault: YAML-ish frontmatter + [[wikilinks]])
Writes docs/index.html (one self-contained page, no runtime dependencies)

This folder lives inside the campaign repo next to dashboard/. It shares two
things with the dashboard rather than keeping its own copies:

  - the talent list:  ../reference/talents.json
  - the dice/symbol icons for talent rules text:  ../dashboard/public/images/

GitHub Actions runs this on every push that touches wiki/ (see
.github/workflows/wiki.yml) and publishes docs/ to GitHub Pages. Cloudflare
never sees it: the dashboard Worker only builds and serves dashboard/.

Standard library only. Run it locally with:  python3 wiki/build.py
"""

import html
import shutil
import json
import pathlib
import re
import sys
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parent
CONTENT = ROOT / "content"
OUT = ROOT / "docs"
TALENTS_FILE = REPO / "reference" / "talents.json"
ICON_DIR = REPO / "dashboard" / "public" / "images"

# ---------------------------------------------------------------- campaign
# Everything campaign-specific lives here; template.html carries no names.
CAMPAIGN = {
    "name": "[Campaign Name]",  # TEMPLATE: rename per campaign
    # Sidebar subtitle. The current session number is appended automatically
    # from the highest `session:` value in the vault.
    "tagline": "[Ship or crew name]",  # TEMPLATE
    "description": ("Campaign archive — "
                    "crew, ship, session recaps and a cross-linked cast."),
    # Footer on every page (HTML allowed): where this material comes from.
    "source_note": ("Compiled from the crew's character sheets and session recordings. "
                    "This archive records established play and flags uncertain details."),
}

TYPE_LABEL = {"character": "Character", "place": "Place", "thing": "Item",
              "faction": "Faction", "ship": "Ship", "doc": "Session"}
CONF_LABEL = {"hi": "Confirmed", "mid": "Needs review", "lo": "Low confidence"}
GROUP_ORDER = ["Campaign", "Sessions", "Player Characters", "Allies & Contacts",
               "Places", "Ships", "Things", "Factions", "Reference"]

WIKILINK = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")


# ---------------------------------------------------------------- parsing

def parse_frontmatter(text):
    """Minimal frontmatter reader: `key: value`, with JSON arrays for lists."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    raw, body = text[3:end], text[end + 4:]
    meta = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, _, val = line.partition(":")
        val = val.strip()
        if val.startswith("["):
            try:
                val = json.loads(val)
            except ValueError:
                val = []
        elif len(val) > 1 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        meta[key.strip()] = val
    return meta, body.lstrip("\n")


def load_pages():
    pages = []
    for path in sorted(CONTENT.glob("*.md")):
        meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
        if not meta.get("title"):
            sys.exit("%s is missing a title in its frontmatter" % path.name)
        meta["id"] = path.stem
        meta["raw"] = body
        aliases = meta.get("aliases") or []
        meta["aliases"] = [a for a in aliases if isinstance(a, str)]
        aka = meta.get("aka") or []
        meta["aka"] = [a for a in aka if isinstance(a, str)]
        pages.append(meta)
    return pages


# ---------------------------------------------------------------- inline markdown

def inline(text, resolve, unresolved):
    """Escape, then apply the inline subset: wikilinks, emphasis, code."""
    out = html.escape(text, quote=False)

    def link(m):
        target = m.group(1).strip()
        label = (m.group(2) or "").strip()
        pid = resolve(target)
        shown = label or (resolve.title(pid) if pid else target)
        if not pid:
            unresolved.append(target)
            return '<a class="wl missing" title="No page for this yet">%s</a>' % shown
        return '<a class="wl" href="#%s">%s</a>' % (pid, shown)

    out = WIKILINK.sub(link, out)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", out)
    return out


# ---------------------------------------------------------------- block markdown

CALLOUT = re.compile(r"^>\s*\[!(\w+)\]\s*(.*)$")
# A line on its own: ![caption](img/file.jpg). Paths are relative to content/,
# so Obsidian shows the picture too; build() copies content/img/ to docs/img/.
IMAGE = re.compile(r"^!\[([^\]]*)\]\(([^)\s]+)\)$")


def render_prose(body, resolve, unresolved):
    lines = body.split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        m = CALLOUT.match(stripped)
        if m:
            kind, heading = m.group(1).lower(), m.group(2)
            i += 1
            para = []
            while i < len(lines) and lines[i].lstrip().startswith(">"):
                para.append(lines[i].lstrip()[1:].strip())
                i += 1
            cls = "panel note" + (" warn" if kind in ("warning", "caution") else "")
            out.append('<div class="%s"><div class="ph">%s</div><p>%s</p></div>'
                       % (cls, inline(heading, resolve, unresolved),
                          inline(" ".join(para).strip(), resolve, unresolved)))
            continue

        m = IMAGE.match(stripped)
        if m:
            caption, src = m.group(1).strip(), m.group(2)
            if not (CONTENT / src).is_file():
                unresolved.append("image: " + src)
            out.append('<figure class="fig"><img src="%s" alt="%s" loading="lazy">%s</figure>'
                       % (html.escape(src), html.escape(caption),
                          "<figcaption>%s</figcaption>" % inline(caption, resolve, unresolved)
                          if caption else ""))
            i += 1
            continue

        if stripped.startswith("## "):
            out.append("<h2>%s</h2>" % inline(stripped[3:], resolve, unresolved))
            i += 1
            continue

        if stripped.startswith("- "):
            items = []
            while i < len(lines) and lines[i].strip().startswith("- "):
                items.append("<li>%s</li>" % inline(lines[i].strip()[2:], resolve, unresolved))
                i += 1
            out.append("<ul>%s</ul>" % "".join(items))
            continue

        para = []
        while i < len(lines) and lines[i].strip() and not lines[i].strip().startswith(("## ", "- ", ">")):
            para.append(lines[i].strip())
            i += 1
        out.append("<p>%s</p>" % inline(" ".join(para), resolve, unresolved))

    return "".join(out)


BEAT = re.compile(r"^-\s*`([^`]+)`\s*\*\*(.+?)\*\*\s*[—-]\s*(.*)$")


def render_timeline(body, resolve, unresolved):
    rows = []
    for line in body.split("\n"):
        if line.strip().startswith("## "):   # session divider
            rows.append("<h2>%s</h2>" % inline(line.strip()[3:], resolve, unresolved))
            continue
        m = BEAT.match(line.strip())
        if not m:
            continue
        rows.append(
            '<div class="beat"><div class="t">%s</div><div class="b">'
            '<strong>%s</strong><p>%s</p></div></div>'
            % (html.escape(m.group(1)),
               inline(m.group(2), resolve, unresolved),
               inline(m.group(3), resolve, unresolved))
        )
    return "".join(rows)


def render_threads(body, resolve, unresolved):
    blocks, cur = [], None
    for line in body.split("\n"):
        s = line.strip()
        if s.startswith("### "):
            if cur:
                blocks.append(cur)
            cur = {"title": s[4:], "cls": "open", "status": "", "body": []}
        elif cur is not None and s.startswith("`"):
            m = re.match(r"^`(\w+)`\s*(.*)$", s)
            if m:
                cur["cls"], cur["status"] = m.group(1), m.group(2)
        elif cur is not None and s:
            cur["body"].append(s)
    if cur:
        blocks.append(cur)
    return "".join(
        '<div class="thread %s"><div class="st">%s</div><h3>%s</h3><p>%s</p></div>'
        % (b["cls"], html.escape(b["status"]),
           inline(b["title"], resolve, unresolved),
           inline(" ".join(b["body"]), resolve, unresolved))
        for b in blocks
    )


# ---------------------------------------------------------------- assembly

# Talent rules text (talents.json "text_swrpg") is written in shorthand
# glyphs. The talents page draws each one with the matching dice/symbol image
# from the dashboard's own icon folder, embedded as a data URI so
# docs/index.html stays a single self-contained file. ◑ (a Force point of
# either side) has no image and stays as text.
TALENT_GLYPHS = {
    "✔": ("Success", "symbol-success.png"),
    "✖": ("Failure", "symbol-failure.png"),
    "▲": ("Advantage", "symbol-advantage.png"),
    "▼": ("Threat", "symbol-threat.png"),
    "★": ("Triumph", "symbol-triumph.png"),
    "☠": ("Despair", "symbol-despair.png"),
    "○": ("Light side Force point", "symbol-light-side.png"),
    "●": ("Dark side Force point", "symbol-dark-side.png"),
    "🟩": ("Ability die", "die-ability.png"),
    "🟨": ("Proficiency die", "die-proficiency.png"),
    "🟦": ("Boost die", "die-boost.png"),
    "◆": ("Difficulty die", "die-difficulty.png"),
    "🟥": ("Challenge die", "die-challenge.png"),
    "⬛": ("Setback die", "die-setback.png"),
    "⚪": ("Force die", "die-force.png"),
}


def talent_glyphs():
    import base64
    out = {}
    for glyph, (label, fname) in TALENT_GLYPHS.items():
        f = ICON_DIR / fname
        src = ("data:image/png;base64," + base64.b64encode(f.read_bytes()).decode("ascii")) if f.exists() else ""
        out[glyph] = {"label": label, "src": src}
    return out


def build():
    pages = load_pages()
    by_id = {p["id"]: p for p in pages}

    talent_source = json.loads(TALENTS_FILE.read_text(encoding="utf-8")) if TALENTS_FILE.exists() else {}
    talents = []
    for t in talent_source.get("talents", []):
        item = {
            "name": t.get("name", ""),
            "tier": t.get("tier"),
            "activation": t.get("activation", ""),
            "ranked": t.get("ranked", "No"),
            "text": t.get("text_swrpg") or t.get("text_original_genesys", ""),
            "source": t.get("source", ""),
            "from": t.get("from", ""),
            "superseded": t.get("superseded_by_version"),
            "force": t.get("force", "No"),
            "notes": t.get("notes"),
        }
        item["search"] = " ".join(str(item[k] or "") for k in
                                  ("name", "tier", "activation", "ranked", "text", "source", "from", "notes")).lower()
        if item["force"] == "Yes":
            item["search"] += " force talent"
        talents.append(item)
    talents.sort(key=lambda t: (int(t["tier"] or 99), t["name"].lower()))

    alias_index = {}
    for p in pages:
        alias_index.setdefault(p["title"].lower(), p["id"])
        for a in p["aka"] + p["aliases"]:
            alias_index.setdefault(a.lower(), p["id"])

    def resolve(target):
        if target in by_id:
            return target
        return alias_index.get(target.lower())
    # In running prose a bare [[link]] shows the page's `short` form when it
    # has one ("Rennick", not "Colonel Doran Rennick"); [[id|label]] overrides.
    resolve.title = lambda pid: (by_id[pid].get("short") or by_id[pid]["title"]) if pid else ""

    # first pass: render bodies, collecting the link graph
    graph, unresolved_all = {}, []
    for p in pages:
        found = []
        layout = p.get("layout", "prose")
        renderer = {"timeline": render_timeline, "threads": render_threads}.get(layout, render_prose)
        p["html"] = renderer(p["raw"], resolve, found)
        unresolved_all += [(p["id"], t) for t in found]
        targets = {resolve(m.group(1).strip()) for m in WIKILINK.finditer(p["raw"])}
        graph[p["id"]] = {t for t in targets if t and t != p["id"]}

    backlinks = {p["id"]: [] for p in pages}
    for src, targets in graph.items():
        for t in targets:
            backlinks[t].append(src)

    def sort_key(p):
        g = p.get("group", "")
        gi = GROUP_ORDER.index(g) if g in GROUP_ORDER else len(GROUP_ORDER)
        return (gi, int(p.get("order", 99)), p["title"])

    payload = []
    for p in sorted(pages, key=sort_key):
        payload.append({
            "id": p["id"],
            "title": p["title"],
            "group": p.get("group", "Other"),
            "type": p.get("type", "thing"),
            "typeLabel": TYPE_LABEL.get(p.get("type", "thing"), "Page"),
            "layout": p.get("layout", "prose"),
            "dek": p.get("dek", ""),
            "conf": p.get("conf", ""),
            "confLabel": CONF_LABEL.get(p.get("conf", ""), ""),
            "player": p.get("player", ""),
            "aliases": p["aliases"],
            "aka": p["aka"],
            "html": p["html"],
            "backlinks": sorted(backlinks[p["id"]], key=lambda i: by_id[i]["title"]),
            "search": " ".join([p["title"]] + p["aka"] + p["aliases"] + [p.get("dek", "")]).lower(),
        })

    titles = {p["id"]: p["title"] for p in pages}
    sessions = [int(p["session"]) for p in pages if str(p.get("session", "")).isdigit()]
    tagline = CAMPAIGN["tagline"] + (" · Session %d" % max(sessions) if sessions else "")
    tpl = (ROOT / "template.html").read_text(encoding="utf-8")
    page = (tpl
            .replace("__CAMPAIGN_HTML__", html.escape(CAMPAIGN["name"]))
            .replace("__TAGLINE_HTML__", html.escape(tagline))
            .replace("__DESCRIPTION_HTML__", html.escape(CAMPAIGN["description"]))
            .replace("/*__CAMPAIGN_JSON__*/", json.dumps(CAMPAIGN["name"], ensure_ascii=False))
            .replace("/*__SOURCE_NOTE__*/", json.dumps(CAMPAIGN["source_note"], ensure_ascii=False))
            .replace("/*__PAGES__*/", json.dumps(payload, ensure_ascii=False))
            .replace("/*__TITLES__*/", json.dumps(titles, ensure_ascii=False))
            .replace("/*__TALENTS__*/", json.dumps(talents, ensure_ascii=False))
            .replace("/*__GLYPHS__*/", json.dumps(talent_glyphs(), ensure_ascii=False))
            .replace("__BUILT__", date.today().isoformat()))

    OUT.mkdir(exist_ok=True)
    # Images live in the vault (content/img/) and are published beside the page.
    if (CONTENT / "img").is_dir():
        if (OUT / "img").exists():
            shutil.rmtree(OUT / "img")
        shutil.copytree(CONTENT / "img", OUT / "img")
    (OUT / "index.html").write_text(page, encoding="utf-8")
    (OUT / ".nojekyll").write_text("", encoding="utf-8")

    # Two different artefacts, for two different jobs.
    #
    # names.txt  - CANONICAL SPELLINGS ONLY. This is prompted into the
    #              transcriber, so listing a mangled spelling here would teach
    #              it that the mangling is a real word. Never include aliases.
    # corrections.json - alias -> canonical. Applied to the transcript AFTER
    #              recognition, to repair what the prompt didn't prevent.
    entities = [p for p in pages if p.get("type") != "doc"]

    names = set()
    for p in entities:
        names.add(p["title"])
        if p.get("short"):
            names.add(p["short"])          # the form people actually say
        names.update(p["aka"])             # real alternate names are canonical too
    names = sorted(names)
    (ROOT / "names.txt").write_text(
        "# Canonical names only - pass to the transcriber with --names.\n"
        "# Do NOT add misspellings here; they belong in corrections.json.\n"
        + "\n".join(names) + "\n", encoding="utf-8")

    corrections = {}
    for p in entities:
        # Correct towards the spoken form, not the formal title: a
        # transcript should read "Brak", not "Sgt Brak Tanris".
        canonical = p.get("short") or p["title"]
        for a in p["aliases"]:
            if a.lower() != canonical.lower():
                corrections[a] = canonical
    (ROOT / "corrections.json").write_text(
        json.dumps(dict(sorted(corrections.items())), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8")

    print("%d pages -> wiki/docs/index.html" % len(pages))
    print("%d talents from %s" % (len(talents), TALENTS_FILE.relative_to(REPO)))
    print("%d canonical names -> wiki/names.txt" % len(names))
    print("%d corrections -> wiki/corrections.json" % len(corrections))
    if unresolved_all:
        print("\nUnresolved wikilinks or missing images (links render in red on the site):")
        for src, target in unresolved_all:
            print("  %-26s -> [[%s]]" % (src + ".md", target))
        return 1
    print("All wikilinks resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(build())
