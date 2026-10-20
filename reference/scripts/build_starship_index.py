"""Build dashboard/public/data/starship-index.json from reference/starships.json.

Uses each ship's Genesys v2 conversion (the campaign runs Genesys vehicle
rules) and splits its weapons text into rows the Vehicle tab can show.
Also writes dashboard/public/data/vehicle-template.json: the generic crew
positions (pilot, gunner, ...) taken from the sample ledger.json.

Run from anywhere:  python3 reference/scripts/build_starship_index.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "reference" / "starships.json"
OUT = ROOT / "dashboard" / "public" / "data" / "starship-index.json"
TEMPLATE_OUT = ROOT / "dashboard" / "public" / "data" / "vehicle-template.json"
SAMPLE = ROOT / "dashboard" / "public" / "data" / "ledger.json"


def flat(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def to_int(v, default=0):
    m = re.search(r"[-+]?\d+", str(v if v is not None else ""))
    return int(m.group()) if m else default


def split_weapons(text):
    """'A (Fire Arc Forward; Damage 4; ...)\n\nB (...)' -> list of rows."""
    text = flat(text)
    if not text or text.lower() in ("none", "-", "—"):
        return []
    rows = []
    depth = 0
    start = 0
    for i, ch in enumerate(text):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                rows.append(text[start:i + 1].strip(" .,;"))
                start = i + 1
    tail = text[start:].strip(" .,;")
    if tail:
        rows.append(tail)
    out = []
    for row in rows:
        m = re.match(r"^(.*?)\s*\((.*)\)$", row)
        if not m:
            out.append({"name": row[:120], "fireArc": "", "range": "", "damage": 0, "crit": 0, "qualities": ""})
            continue
        name, inner = m.group(1).strip(), m.group(2)
        w = {"name": name[:120], "fireArc": "", "range": "", "damage": 0, "crit": 0, "qualities": ""}
        quals = []
        for part in [p.strip() for p in inner.split(";") if p.strip()]:
            low = part.lower()
            if low.startswith("fire arc"):
                w["fireArc"] = part[8:].strip()
            elif low.startswith("damage"):
                w["damage"] = to_int(part)
            elif low.startswith("critical") or low.startswith("crit"):
                w["crit"] = to_int(part)
            elif low.startswith("range"):
                w["range"] = part[5:].strip().strip("[]")
            else:
                quals.append(part)
        w["qualities"] = ", ".join(quals)
        out.append(w)
    return out


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    ships = []
    for category, entries in data.items():
        for e in entries:
            g = e.get("genesys_v2") or {}
            title = flat(e.get("ship"))
            ships.append({
                "name": title,
                "category": category,
                "model": flat(e.get("model")),
                "manufacturer": flat(e.get("manufacturer")),
                "silhouette": to_int(g.get("silhouette", e.get("silhouette"))),
                "speed": to_int(g.get("max_speed", e.get("speed"))),
                "handling": to_int(g.get("handling", e.get("handling"))),
                "defense": to_int(g.get("defense")),
                "armor": to_int(g.get("armor", e.get("armor"))),
                "hullTrauma": to_int(g.get("hull_trauma_threshold", e.get("hull_trauma"))),
                "systemStrain": to_int(g.get("system_strain_threshold", e.get("system_strain"))),
                "sensors": flat(g.get("sensor_range") or e.get("sensor_range")),
                "hyperdrive": flat(e.get("hyperdrive")),
                "crew": flat(e.get("crew")),
                "passengers": e.get("passengers"),
                "encumbrance": e.get("encumbrance"),
                "notes": flat(e.get("special_notes_abilities") or g.get("conversion_notes")),
                "source": flat(e.get("source")),
                "weapons": split_weapons(g.get("weapons") or e.get("weapons")),
            })
    ships.sort(key=lambda s: (s["category"], s["name"]))
    OUT.write_text(json.dumps(ships, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(ships)} ships -> {OUT.relative_to(ROOT)}")

    sample = json.loads(SAMPLE.read_text(encoding="utf-8"))
    positions = (sample.get("vehicle") or {}).get("crewPositions") or []
    TEMPLATE_OUT.write_text(json.dumps({"crewPositions": positions}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(positions)} crew positions -> {TEMPLATE_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
