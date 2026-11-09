"""Before/after preview of the Kanti+ icons, rendered from the actual VectorDrawable XML.

Usage: python3 preview.py <before res/drawable dir> <after res/drawable dir> <font path> <out.html>
"""
import pathlib
import sys
import xml.etree.ElementTree as ET

A = "{http://schemas.android.com/apk/res/android}"
AAPT = "{http://schemas.android.com/aapt}"
uid = [0]


def color(value):
    if not value:
        return None, 1.0
    v = value.lstrip("#")
    if len(v) == 8:
        return "#" + v[2:], int(v[:2], 16) / 255
    return "#" + v[-6:], 1.0


def vd_body(path, override=None):
    """SVG elements for a VectorDrawable, in its own viewport units."""
    root = ET.parse(path).getroot()
    defs, out = [], []

    def walk(node):
        for child in node:
            tag = child.tag
            if tag == "group":
                tx = float(child.get(A + "translateX", 0)); ty = float(child.get(A + "translateY", 0))
                sx = float(child.get(A + "scaleX", 1)); sy = float(child.get(A + "scaleY", 1))
                out.append(f'<g transform="translate({tx} {ty}) scale({sx} {sy})">'); walk(child); out.append("</g>")
            elif tag == "path":
                d = child.get(A + "pathData")
                fill, fa = color(child.get(A + "fillColor"))
                for attr in child.iter(AAPT + "attr"):
                    grad = attr.find("gradient")
                    if grad is not None:
                        uid[0] += 1
                        gid = f"g{uid[0]}"
                        defs.append(f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{grad.get(A + "startX")}" y1="{grad.get(A + "startY")}" x2="{grad.get(A + "endX")}" y2="{grad.get(A + "endY")}">'
                                    f'<stop offset="0" stop-color="{grad.get(A + "startColor")}"/><stop offset="1" stop-color="{grad.get(A + "endColor")}"/></linearGradient>')
                        fill, fa = f"url(#{gid})", 1.0
                stroke, sa = color(child.get(A + "strokeColor"))
                if override:
                    fill = override if fill and fa > 0 else fill
                    stroke = override if stroke else stroke
                attrs = [f'd="{d}"', f'fill="{fill if fill and fa > 0 else "none"}"']
                if child.get(A + "fillType") == "evenOdd":
                    attrs.append('fill-rule="evenodd"')
                if stroke:
                    attrs += [f'stroke="{stroke}"', f'stroke-width="{child.get(A + "strokeWidth", 1)}"',
                              f'stroke-linecap="{child.get(A + "strokeLineCap", "butt")}"', f'stroke-linejoin="{child.get(A + "strokeLineJoin", "miter")}"']
                out.append(f"<path {' '.join(attrs)}/>")
    walk(root)
    return "".join(defs), "".join(out), root.get(A + "viewportWidth")


MASKS = {
    "circle": '<circle cx="54" cy="54" r="36"/>',
    "squircle": '<path d="M54 18 C80 18 90 28 90 54 C90 80 80 90 54 90 C28 90 18 80 18 54 C18 28 28 18 54 18 Z"/>',
    "rounded": '<rect x="18" y="18" width="72" height="72" rx="16"/>',
}


def icon(res, name, mask, px, themed=""):
    uid[0] += 1
    cid = f"c{uid[0]}"
    if themed:
        bg, fg = ("#1F3A5F", "#D3E3FD") if themed == "dark" else ("#D3E3FD", "#0B3A6E")
        mono = res / f"{name}_monochrome.xml"
        d, body, _ = vd_body(mono, override=fg)
        layers = f'<rect width="108" height="108" fill="{bg}"/>{body}'
    else:
        d1, b1, _ = vd_body(res / f"{name}_background.xml")
        d2, b2, _ = vd_body(res / f"{name}_foreground.xml")
        d, layers = d1 + d2, b1 + b2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72" width="{px}" height="{px}"><defs>{d}<clipPath id="{cid}">{MASKS[mask]}</clipPath></defs>'
            f'<g clip-path="url(#{cid})">{layers}</g></svg>')


def stat(res, px, tint):
    d, body, view = vd_body(res / "ic_stat.xml", override=tint)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {view} {view}" width="{px}" height="{px}"><defs>{d}</defs>{body}</svg>'


def splash(res, name, dark):
    page = "#111315" if dark else "#F4F5F2"
    return f'<div class="phone" style="background:{page}">{icon(res, name, "circle", 84)}</div>'


def column(res, title):
    rows = []
    for name, label in (("ic_launcher", "Kanti (standard)"), ("ic_launcher_schule", "Schule"), ("ic_launcher_notiz", "Notiz")):
        big = "".join(icon(res, name, m, 96) for m in MASKS)
        small = icon(res, name, "squircle", 48) + icon(res, name, "circle", 32)
        themed = icon(res, name, "circle", 48, "dark") + icon(res, name, "circle", 48, "light")
        rows.append(f'<div class="item"><div class="label">{label}</div><div class="line">{big}</div>'
                    f'<div class="line"><span class="tag">48 / 32 px</span>{small}<span class="tag">themed</span>{themed}</div></div>')
    walls = (f'<div class="line"><div class="wall dark">{icon(res, "ic_launcher", "squircle", 56)}<em>Kanti+</em></div>'
             f'<div class="wall snow">{icon(res, "ic_launcher", "squircle", 56)}<em>Kanti+</em></div>'
             f'<div class="wall light">{icon(res, "ic_launcher", "circle", 56)}<em>Kanti+</em></div></div>')
    notes = (f'<div class="line"><div class="bar dark">{stat(res, 24, "#FFFFFF")}<b>Neue Prüfung</b></div>'
             f'<div class="bar light">{stat(res, 24, "#3C4A57")}<b>Neue Prüfung</b></div></div>')
    splashes = f'<div class="line"><span class="tag">splash</span>{splash(res, "ic_launcher", False)}{splash(res, "ic_launcher", True)}</div>'
    return f'<div class="col"><h2>{title}</h2>{"".join(rows)}<div class="item"><div class="label">Home screen · notification · splash</div>{walls}{notes}{splashes}</div></div>'


def main():
    BEFORE, AFTER, FONT, OUT = (pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3], pathlib.Path(sys.argv[4]))
    html = f'''<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face {{ font-family: Inst; src: url("file://{FONT}"); font-weight: 100 900; }}
    body {{ margin: 0; padding: 24px 28px; background: #F4F5F2; color: #151C22; font-family: Inst, sans-serif; width: 1240px; }}
    h1 {{ font-size: 26px; margin: 0 0 4px; }} h2 {{ font-size: 20px; margin: 0 0 10px; }} p {{ margin: 0 0 14px; color: #505B64; font-size: 14px; }}
    .cols {{ display: flex; gap: 18px; }} .col {{ flex: 1; background: #fff; border: 1px solid #DCE0DA; border-radius: 18px; padding: 16px 18px; }}
    .item {{ border-top: 1px solid #DCE0DA; padding: 10px 0; }} .label {{ font-size: 13px; color: #505B64; margin-bottom: 6px; }}
    .line {{ display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 4px 0; }} .tag {{ font-size: 11px; color: #7F8991; }}
    .wall {{ display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 12px; border-radius: 12px; }}
    .wall em {{ font-style: normal; font-size: 11px; }} .dark {{ background: #1B1F24; color: #ECEDEE; }} .light {{ background: #E9EEF3; color: #151C22; }}
    .snow {{ background: linear-gradient(#F0F5FA, #E2EBF3); color: #11253A; }}
    .bar {{ display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 10px; font-size: 13px; }}
    .phone {{ width: 92px; height: 150px; border-radius: 16px; display: flex; align-items: center; justify-content: center; border: 1px solid #DCE0DA; }}
    </style></head><body><h1>Kanti+ icon: before and after</h1>
    <p>Rendered from the VectorDrawable XML in res/drawable (before: main, after: this branch). Masks show the 72 dp visible area of the 108 dp adaptive canvas; themed = Android 13+ monochrome layer in system colours.</p>
    <div class="cols">{column(BEFORE, "Before")}{column(AFTER, "After")}</div></body></html>'''
    OUT.write_text(html)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
