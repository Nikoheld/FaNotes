"""Reproduce the tablet fallback paths as compact desktop data (no font tracing)."""
import json, math, pathlib, re
root = pathlib.Path(__file__).resolve().parents[2]
src = (root / 'android/core/src/main/kotlin/ch/fasrv/fanotes/ink/SchoolScript.kt').read_text()
entries = re.findall(r'("(?:[^"\\]|\\.)*") to listOf\((.*?)(?=\n        "|\n    \))', src, re.S)
glyphs = {}
for label, body in entries:
    paths = []
    for kind, args in re.findall(r'(line|oval)\(([^()]*)\)', body):
        v = [float(s) for s in args.split(',') if s.strip()]
        if kind == 'line':
            paths.append([[v[i], v[i+1]] for i in range(0, len(v), 2)])
        else:
            x,y,rx,ry = v[:4]
            paths.append([[x+math.cos(-math.pi/2+2*math.pi*i/18)*rx, y+math.sin(-math.pi/2+2*math.pi*i/18)*ry] for i in range(19)])
    glyphs[json.loads(label)] = paths
# Preserve German sharp-s in synthesis, irrespective of the Swiss spelling preference.
glyphs['ß'] = [[[.25,.92],[.25,.28],[.35,.1],[.55,.1],[.66,.24],[.52,.46],[.7,.62],[.7,.8],[.55,.92],[.4,.84]]]
glyphs['ẞ'] = glyphs['ß']
assert len(glyphs) >= 80
(root / 'fanotes/src/lib/schoolScriptPaths.json').write_text(json.dumps(glyphs, separators=(',', ':')) + '\n')
