"""PNG exports of the Kanti+ icons, rendered from the VectorDrawable XML with Chromium headless.

Writes android/docs/launcher-icon/*.png (current and previous icons, masks, monochrome, comparison)
and android/companion/docs/brand/play/ (512 px store icon, 1024 x 500 feature graphic).

Usage: python3 export.py <repo root> <previous res/drawable dir>
"""
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import preview  # noqa: E402  (VectorDrawable -> SVG helpers)

REPO = pathlib.Path(sys.argv[1])
OLD = pathlib.Path(sys.argv[2])
RES = REPO / "android/companion/src/main/res/drawable"
ICONS = REPO / "android/docs/launcher-icon"
PLAY = REPO / "android/companion/docs/brand/play"
FONT = REPO / "android/companion/src/main/res/font/instrument_sans.ttf"
NAMES = {"standard": "ic_launcher", "school": "ic_launcher_schule", "notebook": "ic_launcher_notiz"}
SQUARE = '<rect x="18" y="18" width="72" height="72"/>'
preview.MASKS["square"] = SQUARE


def tile(res, name, mask, px, mono=None):
    """mono = (background, glyph) colours for the one-colour layer."""
    preview.uid[0] += 1
    cid = f"x{preview.uid[0]}"
    if mono:
        d, body, _ = preview.vd_body(res / f"{name}_monochrome.xml", override=mono[1])
        layers = f'<rect width="108" height="108" fill="{mono[0]}"/>{body}'
    else:
        d1, b1, _ = preview.vd_body(res / f"{name}_background.xml")
        d2, b2, _ = preview.vd_body(res / f"{name}_foreground.xml")
        d, layers = d1 + d2, b1 + b2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72" width="{px}" height="{px}"><defs>{d}<clipPath id="{cid}">{preview.MASKS[mask]}</clipPath></defs>'
            f'<g clip-path="url(#{cid})">{layers}</g></svg>')


def shoot(html, width, height, out, transparent=True):
    with tempfile.TemporaryDirectory() as tmp:
        page = pathlib.Path(tmp) / "page.html"
        page.write_text(html)
        args = ["chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
                f"--window-size={width},{height}", f"--screenshot={out}", f"file://{page}"]
        if transparent:
            args.insert(4, "--default-background-color=00000000")
        subprocess.run(args, check=True, capture_output=True, timeout=120)


def page(cells, width, height, background="transparent"):
    return (f'<!doctype html><html><head><meta charset="utf-8"><style>@font-face {{ font-family: Inst; src: url("file://{FONT}"); font-weight: 100 900; }}'
            f'html, body {{ margin: 0; padding: 0; width: {width}px; height: {height}px; background: {background}; overflow: hidden; font-family: Inst, sans-serif; }}'
            f'.c {{ position: absolute; width: 512px; height: 512px; }}</style></head><body>{cells}</body></html>')


def crop(sheet, x, y, w, h, out, kind="PNG32"):
    subprocess.run(["magick", str(sheet), "-crop", f"{w}x{h}+{x}+{y}", "+repage", f"{kind}:{out}"], check=True)


ICONS.mkdir(parents=True, exist_ok=True)
PLAY.mkdir(parents=True, exist_ok=True)
MONO = {"mono-dark": ("#1B1F24", "#FFFFFF"), "mono-light": ("#E7E5E0", "#1B1F24"), "mono-themed": ("#D7E5F0", "#1F4E79")}
jobs = []
for row, (label, name) in enumerate(NAMES.items()):
    variants = [("512", "square", None), ("round", "circle", None), ("squircle", "squircle", None)] + [(k, "circle", v) for k, v in MONO.items()]
    for col, (suffix, mask, mono) in enumerate(variants):
        jobs.append((f"{label}-{suffix}.png", col * 512, row * 512, tile(RES, name, mask, 512, mono)))
    jobs.append((f"old-{label}-512.png", 6 * 512, row * 512, tile(OLD, name, "square", 512)))
    jobs.append((f"old-{label}-round.png", 7 * 512, row * 512, tile(OLD, name, "circle", 512)))
cells = "".join(f'<div class="c" style="left:{x}px;top:{y}px">{svg}</div>' for _, x, y, svg in jobs)
with tempfile.TemporaryDirectory() as tmp:
    sheet = pathlib.Path(tmp) / "sheet.png"
    shoot(page(cells, 8 * 512, 3 * 512), 8 * 512, 3 * 512, sheet)
    for fname, x, y, _ in jobs:
        crop(sheet, x, y, 512, 512, ICONS / fname)

# Comparison sheet: rows Kanti / Schule / Notiz; Old, New, circle, squircle, monochrome, themed.
heads = ["Old", "New", "Circle", "Squircle", "Monochrome", "Themed"]
rows = []
for label, (title, name) in zip(NAMES, (("Kanti+", "ic_launcher"), ("Schule", "ic_launcher_schule"), ("Notiz", "ic_launcher_notiz"))):
    cellset = [tile(OLD, name, "circle", 260), tile(RES, name, "square", 260), tile(RES, name, "circle", 260), tile(RES, name, "squircle", 260),
               tile(RES, name, "circle", 260, MONO["mono-light"]), tile(RES, name, "circle", 260, MONO["mono-themed"])]
    rows.append(f'<div class="row"><div class="lab">{title}</div>{"".join(f"<div>{c}</div>" for c in cellset)}</div>')
comparison = (f'<!doctype html><html><head><meta charset="utf-8"><style>@font-face {{ font-family: Inst; src: url("file://{FONT}"); }}'
              'html, body { margin: 0; width: 1852px; height: 908px; background: #F6F7F8; font-family: Inst, sans-serif; color: #2A3640; overflow: hidden; }'
              '.head, .row { display: flex; gap: 20px; padding-left: 168px; } .head div { width: 260px; font-size: 20px; color: #55636E; padding: 14px 0 6px; }'
              '.row { position: relative; margin-bottom: 20px; } .lab { position: absolute; left: 20px; top: 118px; font-size: 21px; }</style></head><body>'
              f'<div class="head">{"".join(f"<div>{h}</div>" for h in heads)}</div>{"".join(rows)}</body></html>')
shoot(comparison, 1852, 908, ICONS / "comparison-raw.png", transparent=False)
subprocess.run(["magick", str(ICONS / "comparison-raw.png"), f"PNG24:{ICONS / 'comparison.png'}"], check=True)
(ICONS / "comparison-raw.png").unlink()

# Google Play store icon: 512 x 512, 32-bit PNG, full-bleed and fully opaque (Play adds the mask and shadow).
store = PLAY / "kanti-play-icon-512.png"
with tempfile.TemporaryDirectory() as tmp:
    raw = pathlib.Path(tmp) / "store.png"
    shoot(page(f'<div class="c">{tile(RES, "ic_launcher", "square", 512)}</div>', 512, 512, "#143552"), 512, 512, raw, transparent=False)
    subprocess.run(["magick", str(raw), "-alpha", "on", "-channel", "A", "-evaluate", "set", "100%", "+channel", f"PNG32:{store}"], check=True)

# Feature graphic: 1024 x 500, 24-bit PNG without alpha. Key content stays inside the centre.
mark = tile(RES, "ic_launcher", "squircle", 236)
band = "".join(f'<i style="background:{c}"></i>' for c in ["rgba(246,248,246,.22)"] * 2 + ["#E7B552"] + ["rgba(246,248,246,.22)"] * 4)
feature_html = (f'<!doctype html><html><head><meta charset="utf-8"><style>@font-face {{ font-family: Inst; src: url("file://{FONT}"); font-weight: 100 900; }}'
                'html, body { margin: 0; width: 1024px; height: 500px; overflow: hidden; background: #143552; font-family: Inst, sans-serif; color: #F6F8F6; }'
                '.wrap { position: absolute; left: 112px; top: 112px; display: flex; gap: 52px; align-items: center; }'
                '.mark { width: 236px; height: 236px; border-radius: 56px; box-shadow: 0 0 0 2px rgba(246,248,246,.10); }'
                'h1 { margin: 0; font-size: 104px; font-weight: 650; letter-spacing: -2px; line-height: 1; }'
                'p { margin: 18px 0 0; font-size: 31px; color: rgba(246,248,246,.86); line-height: 1.25; }'
                'small { display: block; margin-top: 14px; font-size: 19px; color: rgba(246,248,246,.62); }'
                '.band { position: absolute; left: 112px; right: 112px; bottom: 54px; display: flex; gap: 8px; } .band i { flex: 1; height: 10px; border-radius: 5px; }'
                '</style></head><body><div class="wrap"><div class="mark">'
                f'{mark}</div><div><h1>Kanti+</h1><p>Stundenplan, Noten und Prüfungen<br>immer im Blick.</p><small>Inoffizielle App für Schulnetz</small></div></div>'
                f'<div class="band">{band}</div></body></html>')
with tempfile.TemporaryDirectory() as tmp:
    raw = pathlib.Path(tmp) / "feature.png"
    shoot(feature_html, 1024, 500, raw, transparent=False)
    subprocess.run(["magick", str(raw), "-background", "#143552", "-alpha", "remove", "-alpha", "off", f"PNG24:{PLAY / 'kanti-feature-1024x500.png'}"], check=True)
print("exported", len(jobs), "icon PNGs, comparison, store icon and feature graphic")
