"""
Convert the original Excel price sheet into data/seed.json.

Usage:
    python -I scripts/import_xlsx.py "<path-to-xlsx>" [output.json]

Layout expected (Sheet1):
    B = section (merged vertically), C = destination,
    D/E/F = sedan  (commercial / suitable / round trip)
    H/I/J = minivan (commercial / suitable / round trip)
    Rows where B:C are merged and E/F are empty are "flat" items (over-day, daily hire).
    Long single-cell rows after the table are conditions / notes.
"""
import json
import re
import sys
import uuid

import openpyxl

TATWEEL = "ـ"


def clean(text):
    if text is None:
        return ""
    text = str(text).replace(TATWEEL, "")
    text = re.sub(r"\s*-\s*", " - ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip(" -")


def num(v):
    if v is None or v == "" or v == 0:
        return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def uid(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def merged_value(ws, row, col):
    """Return the value of a cell, resolving merged ranges to their top-left cell."""
    for rng in ws.merged_cells.ranges:
        if rng.min_row <= row <= rng.max_row and rng.min_col <= col <= rng.max_col:
            return ws.cell(rng.min_row, rng.min_col).value
    return ws.cell(row, col).value


def is_bc_merged(ws, row):
    for rng in ws.merged_cells.ranges:
        if rng.min_row == row and rng.min_col == 2 and rng.max_col >= 3:
            return True
    return False


def main(src, out):
    wb = openpyxl.load_workbook(src, data_only=True)
    ws = wb.active

    title = clean(ws.cell(1, 2).value)
    m = re.search(r"(\d{1,2})\s*/\s*(\d{1,2})\s*/\s*(\d{4})", title or "")
    effective = f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}" if m else ""

    sections, routes, notes = [], [], []
    section_by_name = {}
    last_section = None
    daily_section = None

    for r in range(6, ws.max_row + 1):
        b_raw = ws.cell(r, 2).value
        c_raw = ws.cell(r, 3).value
        d_raw = merged_value(ws, r, 4)

        # Notes: wide merged text rows (B:J or wider) without any price.
        wide = any(rng.min_row == r and rng.min_col == 2 and rng.max_col >= 9 for rng in ws.merged_cells.ranges)
        if b_raw and (wide or (not c_raw and d_raw is None and ws.cell(r, 8).value is None)):
            text = clean(b_raw)
            if text:
                notes.append({"id": uid("n"), "text": text})
            continue

        if b_raw is None and c_raw is None and d_raw is None:
            continue

        df_merged = any(rng.min_row <= r <= rng.max_row and rng.min_col == 4 and rng.max_col >= 6 for rng in ws.merged_cells.ranges)
        flat = df_merged or is_bc_merged(ws, r) or (
            ws.cell(r, 5).value is None and ws.cell(r, 6).value is None and not isinstance(merged_value(ws, r, 5), (int, float))
        )

        if is_bc_merged(ws, r):
            name = clean(b_raw)
            if name.startswith("يومية"):
                if daily_section is None:
                    daily_section = {"id": uid("s"), "name": "اليوميات داخل القاهرة", "note": ""}
                    sections.append(daily_section)
                target = daily_section
            else:
                target = last_section
        else:
            sec_name = clean(merged_value(ws, r, 2))
            if sec_name not in section_by_name:
                sec = {"id": uid("s"), "name": sec_name, "note": ""}
                section_by_name[sec_name] = sec
                sections.append(sec)
            target = section_by_name[sec_name]
            last_section = target
            name = clean(c_raw)

        sedan = [num(merged_value(ws, r, c)) for c in (4, 5, 6)]
        van = [num(merged_value(ws, r, c)) for c in (8, 9, 10)]

        routes.append({
            "id": uid("r"),
            "sectionId": target["id"],
            "name": name,
            "kind": "flat" if flat else "route",
            "prices": {
                "sedan": {"commercial": sedan[0], "suitable": None if flat else sedan[1], "round": None if flat else sedan[2]},
                "van": {"commercial": van[0], "suitable": None if flat else van[1], "round": None if flat else van[2]},
            },
        })

    data = {
        "settings": {
            "brand": "ليموزين",
            "title": "قائمة أسعار القاهرة",
            "subtitle": "أسعار التوصيل من وإلى القاهرة والمطارات والمحافظات",
            "effectiveDate": effective,
            "currency": "ج.م",
            "phone": "",
        },
        "vehicles": [
            {"id": "sedan", "name": "سيدان"},
            {"id": "van", "name": "ميني فان"},
        ],
        "fareTypes": [
            {"id": "commercial", "name": "تجاري"},
            {"id": "suitable", "name": "مناسب"},
            {"id": "round", "name": "ذهاب وعودة"},
        ],
        "sections": sections,
        "routes": routes,
        "notes": notes,
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print(f"sections={len(sections)} routes={len(routes)} notes={len(notes)} -> {out}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "data/seed.json")
