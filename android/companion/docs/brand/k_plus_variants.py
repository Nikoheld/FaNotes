"""K+ mix variants: the old K+ concept executed with the new direction's weights, palette and polish."""
import pathlib

OUT = pathlib.Path(__file__).parent
INK, PAPER, GOLD = "#143552", "#F6F8F6", "#E7B552"


def k_plus(cap, join, w=9.5, dx=-4.0, plus_w=None, plus_len=8.5, arm_end=21.0):
    sx = 36 + dx
    jx = sx + 2
    plus_w = plus_w or w
    px = 71.5 + dx
    return (f'<path d="M{sx},34 V74" stroke="{PAPER}" stroke-width="{w}" stroke-linecap="{cap}" fill="none"/>'
            f'<path d="M{jx + arm_end},34 L{jx},55 L{jx + arm_end},74" stroke="{PAPER}" stroke-width="{w}" stroke-linecap="{cap}" stroke-linejoin="{join}" fill="none"/>'
            f'<path d="M{px - plus_len},54 H{px + plus_len} M{px},{54 - plus_len} V{54 + plus_len}" stroke="{GOLD}" stroke-width="{plus_w}" stroke-linecap="{cap}" fill="none"/>')


OLD = ('<defs><linearGradient id="og" gradientUnits="userSpaceOnUse" x1="12" y1="0" x2="96" y2="108"><stop offset="0" stop-color="#1A648C"/><stop offset="1" stop-color="#102E44"/></linearGradient></defs>'
       '<rect width="108" height="108" fill="url(#og)"/>'
       '<path d="M31,36V72M31,54L50,36M31,54L50,72" stroke="#F7F4EC" stroke-width="7" fill="none"/>'
       '<path d="M61,54H77M69,44V64" stroke="#E2B657" stroke-width="7" fill="none"/>')
FIRST = (f'<rect width="108" height="108" fill="{INK}"/><g transform="translate(4.32 4.32) scale(0.92)">'
         f'<rect x="28.5" y="33" width="9" height="42" rx="4.5" fill="{PAPER}"/>'
         f'<path d="M44.5 54 L58.5 37.5 M44.5 54 L58.5 70.5" stroke="{PAPER}" stroke-width="9" stroke-linecap="round" fill="none"/>'
         f'<circle cx="42" cy="54" r="8.5" fill="{PAPER}"/><path d="M66 54 H82 M74 46 V62" stroke="{GOLD}" stroke-width="8.5" stroke-linecap="round" fill="none"/></g>')
VARIANTS = {
    "Old (main)": OLD,
    "First new (node)": FIRST,
    "M1 · K+ rounded": f'<rect width="108" height="108" fill="{INK}"/><g transform="translate(4.32 4.32) scale(0.92)">{k_plus("round", "round")}</g>',
    "M2 · K+ cut": f'<rect width="108" height="108" fill="{INK}"/><g transform="translate(4.32 4.32) scale(0.92)">{k_plus("butt", "miter", w=9)}</g>',
    "M3 · K+ soft cut": f'<rect width="108" height="108" fill="{INK}"/><g transform="translate(4.32 4.32) scale(0.92)">{k_plus("square", "round", w=9, plus_len=7.5)}</g>',
}
MASKS = {"circle": '<circle cx="54" cy="54" r="36"/>',
         "squircle": '<path d="M54 18 C80 18 90 28 90 54 C90 80 80 90 54 90 C28 90 18 80 18 54 C18 28 28 18 54 18 Z"/>'}
n = [0]


def icon(body, mask, px, mono=None):
    n[0] += 1
    if mono:
        bg, fg = mono
        import re
        body = re.sub(r'(stroke|fill)="#(?:F6F8F6|E7B552|F7F4EC|E2B657)"', lambda m: f'{m.group(1)}="{fg}"', body)
        body = re.sub(r'<rect width="108" height="108" fill="[^"]+"/>', f'<rect width="108" height="108" fill="{bg}"/>', body)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72" width="{px}" height="{px}"><defs><clipPath id="c{n[0]}">{MASKS[mask]}</clipPath></defs>'
            f'<g clip-path="url(#c{n[0]})">{body}</g></svg>')


cols = []
for name, body in VARIANTS.items():
    cols.append(f'<div class="v"><h3>{name}</h3>{icon(body, "squircle", 150)}<div class="r">{icon(body, "circle", 48)}{icon(body, "squircle", 48)}{icon(body, "circle", 32)}</div>'
                f'<div class="r"><span class="d">{icon(body, "circle", 48, ("#1F3A5F", "#D3E3FD"))}</span><span class="s">{icon(body, "squircle", 56)}</span></div></div>')
html = f'''<!doctype html><html><head><meta charset="utf-8"><style>
body {{ margin: 0; padding: 20px; background: #F4F5F2; font-family: sans-serif; width: 1060px; }}
.row {{ display: flex; gap: 14px; }} .v {{ background: #fff; border: 1px solid #DCE0DA; border-radius: 16px; padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 8px; }}
h3 {{ margin: 0; font-size: 14px; color: #151C22; }} .r {{ display: flex; gap: 8px; align-items: center; }}
.d {{ background: #1B1F24; padding: 6px; border-radius: 10px; }} .s {{ background: linear-gradient(#F0F5FA, #E2EBF3); padding: 6px; border-radius: 10px; }}
</style></head><body><div class="row">{"".join(cols)}</div></body></html>'''
(OUT / "mix.html").write_text(html)
print("ok")
