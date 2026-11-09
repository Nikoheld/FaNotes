"""Kanti+ logo directions: SVG layers on the 108 x 108 adaptive-icon canvas and a preview sheet."""
import json
import pathlib

OUT = pathlib.Path(__file__).parent
INK = "#143552"        # tile: deep ink blue (Snow ink family, Stundentakt accent)
INK_DEEP = "#0E2638"
PAPER = "#F6F8F6"
GOLD = "#E7B552"

# Each direction: background, foreground (colour), monochrome (single colour silhouette).
DIRECTIONS = {
    "A": {
        "name": "Taktschiene",
        "idea": "A K whose arms branch from a node on the time rail; the gold plus is the add-on.",
        "bg": f'<rect x="0" y="0" width="108" height="108" fill="{INK}"/>',
        "fg": (
            f'<rect x="29" y="33" width="9" height="42" rx="4.5" fill="{PAPER}"/>'
            f'<path d="M44.5 54 L58.5 37.5 M44.5 54 L58.5 70.5" stroke="{PAPER}" stroke-width="9" stroke-linecap="round" fill="none"/>'
            f'<circle cx="42" cy="54" r="7.5" fill="{PAPER}"/>'
            f'<path d="M65 54 H81 M73 46 V62" stroke="{GOLD}" stroke-width="8" stroke-linecap="round" fill="none"/>'
        ),
    },
    "B": {
        "name": "Tagesband",
        "idea": "A plus made of day-band segments around a gold 'now' node.",
        "bg": f'<rect x="0" y="0" width="108" height="108" fill="{INK}"/>',
        "fg": (
            f'<rect x="27" y="47.5" width="17" height="13" rx="6.5" fill="{PAPER}" fill-opacity="0.55"/>'
            f'<rect x="64" y="47.5" width="17" height="13" rx="6.5" fill="{PAPER}"/>'
            f'<rect x="47.5" y="27" width="13" height="17" rx="6.5" fill="{PAPER}" fill-opacity="0.55"/>'
            f'<rect x="47.5" y="64" width="13" height="17" rx="6.5" fill="{PAPER}" fill-opacity="0.55"/>'
            f'<circle cx="54" cy="54" r="7.5" fill="{GOLD}"/>'
        ),
    },
    "C": {
        "name": "Kachel",
        "idea": "A timetable tile with the K cut out and a gold plus badge.",
        "bg": f'<rect x="0" y="0" width="108" height="108" fill="{INK}"/>',
        "fg": (
            '<mask id="kc"><rect x="0" y="0" width="108" height="108" fill="#fff"/>'
            '<rect x="40" y="40" width="7.5" height="30" rx="3.75" fill="#000"/>'
            '<path d="M48 55 L60 41.5 M48 55 L60 68.5" stroke="#000" stroke-width="7.5" stroke-linecap="round"/></mask>'
            f'<rect x="31" y="31" width="42" height="48" rx="11" fill="{PAPER}" mask="url(#kc)"/>'
            f'<circle cx="72" cy="35" r="11.5" fill="{INK}"/>'
            f'<circle cx="72" cy="35" r="9" fill="{GOLD}"/>'
            f'<path d="M66.5 35 H77.5 M72 29.5 V40.5" stroke="{INK}" stroke-width="3.6" stroke-linecap="round"/>'
        ),
    },
}


def mono(fg: str) -> str:
    """Single-colour silhouette for themed icons and the notification icon."""
    import re
    out = re.sub(r'fill="#(?!000|fff)[0-9A-Fa-f]{6}"', 'fill="#000000"', fg)
    out = re.sub(r'stroke="#(?!000)[0-9A-Fa-f]{6}"', 'stroke="#000000"', out)
    return out.replace(' fill-opacity="0.55"', '')


def svg(body: str, view: str = "0 0 108 108", size: int = 108) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" width="{size}" height="{size}">{body}</svg>'


for key, d in DIRECTIONS.items():
    (OUT / f"dir-{key}-full.svg").write_text(svg(d["bg"] + d["fg"]))
    (OUT / f"dir-{key}-mono.svg").write_text(svg(mono(d["fg"])))

MASKS = {
    "circle": '<circle cx="54" cy="54" r="36"/>',
    "squircle": '<path d="M54 18 C80 18 90 28 90 54 C90 80 80 90 54 90 C28 90 18 80 18 54 C18 28 28 18 54 18 Z"/>',
    "rounded": '<rect x="18" y="18" width="72" height="72" rx="16"/>',
}


def masked(key: str, mask: str, px: int, themed: str = "") -> str:
    d = DIRECTIONS[key]
    clip = f'<clipPath id="m{key}{mask}{px}{themed}">{MASKS[mask]}</clipPath>'
    if themed == "dark":
        body = f'<rect width="108" height="108" fill="#1F3A5F"/><g fill="#D3E3FD" stroke="#D3E3FD">{mono(d["fg"]).replace("#000000", "#D3E3FD")}</g>'
    elif themed == "light":
        body = f'<rect width="108" height="108" fill="#D3E3FD"/>{mono(d["fg"]).replace("#000000", "#0B3A6E")}'
    else:
        body = d["bg"] + d["fg"]
    return svg(f'<defs>{clip}</defs><g clip-path="url(#m{key}{mask}{px}{themed})">{body}</g>', "18 18 72 72", px)


def notif(key: str, px: int, color: str) -> str:
    d = DIRECTIONS[key]
    return svg(mono(d["fg"]).replace("#000000", color), "26 26 56 56", px)


font = "file:///srv/agents/fanotes/chats/companion-683d7e0e/fanotes-brand/android/companion/src/main/res/font/instrument_sans.ttf"
rows = []
for key, d in DIRECTIONS.items():
    big = "".join(f'<div class="cell">{masked(key, m, 132)}<span>{m}</span></div>' for m in MASKS)
    small = "".join(masked(key, m, 48) for m in MASKS)
    tiny = masked(key, "circle", 32)
    themed = f'<div class="wall dark">{masked(key, "circle", 48, "dark")}</div><div class="wall light">{masked(key, "circle", 48, "light")}</div>'
    notes = f'<div class="bar dark">{notif(key, 24, "#FFFFFF")}<b>12:30</b></div><div class="bar light">{notif(key, 24, "#3C4A57")}<b>12:30</b></div>'
    walls = f'<div class="wall dark">{masked(key, "squircle", 60)}<em>Kanti+</em></div><div class="wall snow">{masked(key, "squircle", 60)}<em>Kanti+</em></div>'
    rows.append(f'''<section><h2>{key} · {d["name"]}</h2><p>{d["idea"]}</p>
      <div class="row">{big}<div class="cell col"><div class="small">{small}</div><div class="small">{tiny}<span>48 / 32 px</span></div></div>
      <div class="cell col">{walls}</div><div class="cell col">{themed}<span>themed (Android 13+)</span></div><div class="cell col">{notes}<span>notification</span></div></div></section>''')

html = f'''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face {{ font-family: Inst; src: url("{font}"); font-weight: 100 900; }}
body {{ margin: 0; padding: 28px 32px; background: #F4F5F2; color: #151C22; font-family: Inst, sans-serif; width: 1180px; }}
h1 {{ font-size: 28px; margin: 0 0 4px; }} h2 {{ font-size: 20px; margin: 0 0 2px; }} p {{ margin: 0 0 12px; color: #505B64; font-size: 14px; }}
section {{ background: #fff; border: 1px solid #DCE0DA; border-radius: 18px; padding: 18px 20px; margin: 16px 0; }}
.row {{ display: flex; gap: 22px; align-items: center; }} .cell {{ display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 12px; color: #505B64; }}
.col {{ gap: 10px; }} .small {{ display: flex; gap: 10px; align-items: center; }}
.wall {{ display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 14px; border-radius: 14px; }}
.wall em {{ font-style: normal; font-size: 12px; }} .dark {{ background: #1B1F24; color: #ECEDEE; }} .light {{ background: #E9EEF3; color: #151C22; }}
.snow {{ background: linear-gradient(#F0F5FA, #E2EBF3); color: #11253A; }}
.bar {{ display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 10px; font-size: 13px; }}
</style></head><body><h1>Kanti+ logo directions</h1><p>Adaptive icon 108 dp canvas; masks show the 72 dp visible area. Same tile and palette as the Stundentakt design system (ink {INK}, paper {PAPER}, gold {GOLD}).</p>
{"".join(rows)}</body></html>'''
(OUT / "directions.html").write_text(html)
print("written", [p.name for p in OUT.glob("dir-*.svg")])
