/* Canvas renderer for FaNotes ink pages (paper + strokes), following the .famd spec
 * (SPEC.md sections 3.4, 3.5, 5) and fanotes/src/lib/inkStrokePaint.ts, paperStyles.ts.
 * Exposes window.FamdInk.renderPage(canvas, doc, options). */
(function (root) {
  'use strict'

  var SMOOTHING = 0.68
  var MAX_PIXELS = 24 * 1024 * 1024
  var MAX_SIDE = 16000
  var HEX = /^#[\da-f]{6}$/iu
  var EFFECTS = {
    rainbow: [[0, '#ff4d6d'], [0.17, '#ffb13b'], [0.34, '#e9e34a'], [0.51, '#48ce87'], [0.68, '#3aa8ff'], [0.84, '#815cff'], [1, '#e84dba']],
    aurora: [[0, '#68f6ca'], [0.34, '#32b9ef'], [0.68, '#7968f4'], [1, '#e85bd2']],
    sunset: [[0, '#ffcf59'], [0.36, '#ff754e'], [0.68, '#d84dba'], [1, '#694ee8']],
    ocean: [[0, '#62ead5'], [0.36, '#1eb6db'], [0.7, '#2671df'], [1, '#4036a9']],
    gold: [[0, '#7c5013'], [0.24, '#f7d779'], [0.5, '#b27620'], [0.76, '#fff0a8'], [1, '#8b5914']],
    silver: [[0, '#59616d'], [0.24, '#f5f7fb'], [0.5, '#8b929d'], [0.76, '#ffffff'], [1, '#626975']],
    neon: [[0, '#45ffe6'], [0.34, '#5e8bff'], [0.68, '#db55ff'], [1, '#ff4ba8']],
  }
  var BRUSH_PASSES = {
    fineliner: [{ w: 1, a: 1 }],
    pencil: [{ w: 0.72, a: 0.58 }, { w: 0.22, a: 0.2, j: 1.4 }, { w: 0.18, a: 0.14, j: 1.8 }],
    paintbrush: [{ w: 1.4, a: 0.16 }, { w: 0.92, a: 0.82 }],
    highlighter: [{ w: 1, a: 0.34 }],
    watercolor: [{ w: 1.48, a: 0.11 }, { w: 1.14, a: 0.17 }, { w: 0.78, a: 0.27 }],
    marker: [{ w: 1, a: 0.9 }],
    calligraphy: [{ w: 1, a: 1 }],
    spray: [{ w: 1, a: 1 }],
  }

  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
  var num = function (v, fallback) { var n = Number(v); return Number.isFinite(n) && n !== 0 ? n : fallback }
  var unit = function (s) { var v = Math.sin(s * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v) }

  function drawPaper(ctx, width, height, style) {
    ctx.save()
    ctx.fillStyle = '#fbfcff'
    ctx.fillRect(0, 0, width, height)
    if (style !== 'blank') {
      var scale = width / 900
      var step = function (mm) { return Math.max(2, Math.round(width * mm / 210)) }
      ctx.lineWidth = Math.max(1, scale * 0.7)
      var lines = function (s, from, color, withEdge) {
        ctx.strokeStyle = color
        ctx.beginPath()
        for (var x = from; x <= width; x += s) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, height) }
        for (var y = from; y <= height; y += s) { ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5) }
        ctx.stroke()
      }
      if (style === 'dots') {
        var ds = step(7.5)
        ctx.fillStyle = 'rgba(92, 107, 142, .28)'
        for (var y = ds; y < height; y += ds) {
          for (var x = ds; x < width; x += ds) {
            ctx.beginPath()
            ctx.arc(x, y, Math.max(0.8, scale * 1.05), 0, Math.PI * 2)
            ctx.fill()
          }
        }
      } else if (style === 'squares') lines(step(5), 0, 'rgba(92, 118, 168, .22)')
      else if (style === 'grid') lines(step(7.5), step(7.5), 'rgba(103, 116, 147, .145)')
      else if (style === 'lines') {
        var ls = step(7.5)
        ctx.strokeStyle = 'rgba(103, 116, 147, .145)'
        ctx.beginPath()
        for (var ly = ls; ly < height; ly += ls) { ctx.moveTo(0, ly + 0.5); ctx.lineTo(width, ly + 0.5) }
        ctx.stroke()
        ctx.strokeStyle = 'rgba(210, 82, 105, .16)'
        ctx.beginPath()
        ctx.moveTo(ls * 1.65 + 0.5, 0)
        ctx.lineTo(ls * 1.65 + 0.5, height)
        ctx.stroke()
      } else if (style === 'millimeter') {
        lines(step(1), step(1), 'rgba(92, 118, 168, .1)')
        lines(step(5), step(5), 'rgba(72, 98, 148, .22)')
      }
    }
    ctx.restore()
  }

  function normalizeStroke(raw) {
    if (!raw || !Array.isArray(raw.points) || !raw.points.length) return null
    var art = raw.purpose === 'art'
    var points = raw.points.map(function (p) {
      var pr = p && p.pressure
      return {
        x: clamp(Number(p && p.x) || 0, -4, 4),
        y: clamp(Number(p && p.y) || 0, -4, 4),
        pressure: pr === undefined || pr === null ? 0.5 : clamp(Number(pr) || 0.5, 0, 1),
      }
    })
    var brush = art && typeof raw.brush === 'string' && BRUSH_PASSES[raw.brush] ? raw.brush : 'fineliner'
    var paths = []
    ;['symbolPaths', 'figurePaths', 'graphPaths'].forEach(function (key) {
      if (Array.isArray(raw[key])) {
        raw[key].forEach(function (d) {
          if (typeof d === 'string' && d.length <= 8000 && /^[MLHVCSQTAZmlhvcsqtaz\d\s.,eE+-]+$/u.test(d)) paths.push(d)
        })
      }
    })
    return {
      points: points,
      baseWidth: clamp(num(raw.baseWidth, 4), 0.5, 64),
      pressureEnabled: raw.pressureEnabled !== false,
      color: typeof raw.color === 'string' && HEX.test(raw.color) ? raw.color : '#1b1b1b',
      colorEffect: typeof raw.colorEffect === 'string' && EFFECTS[raw.colorEffect] ? raw.colorEffect : 'solid',
      brush: brush,
      art: art,
      opacity: art ? clamp(num(raw.opacity, 1), 0.08, 1) : 1,
      seed: Math.round(clamp(Math.abs(Number(raw.textureSeed) || 1), 1, 2147483647)),
      stamp: paths.length > 0 && (typeof raw.symbolId === 'string' || typeof raw.figureId === 'string' || typeof raw.graphExpression === 'string' || Array.isArray(raw.graphPaths) || Array.isArray(raw.figurePaths)),
      paths: paths,
      rotation: clamp(Number(raw.symbolRotation) || 0, -180, 180),
      figureLineWidth: Number(raw.figureLineWidth) > 0 ? Number(raw.figureLineWidth) : 0,
    }
  }

  // Pixel-space points and nib widths.
  function nibOf(s, a, b, scale) {
    var p = ((a.pressure) + (b.pressure)) / 2
    var w = s.pressureEnabled ? s.baseWidth * (0.4 + Math.max(0.08, p) * 1.12) : s.baseWidth
    return Math.max(1, w * scale)
  }

  function segmentPath(ctx, P, i, s, scale, smoothing) {
    var n = P.length
    var nib = function (j, k) { return nibOf(s, P[j], P[k], scale) }
    var pull = function (j) {
      var wanted = clamp(smoothing, 0, 1) * 0.85
      var leg = Math.hypot(P[j + 1].px - P[j].px, P[j + 1].py - P[j].py)
      var nibJ = Math.min(nib(Math.max(0, j - 1), j), nib(j, j + 1))
      if (leg <= 0.01 || nibJ <= 0) return wanted
      return Math.min(wanted, nibJ * 0.35 / leg)
    }
    var segEnd = function (j) {
      if (smoothing <= 0 || j >= n - 1) return { x: P[j].px, y: P[j].py }
      var k = pull(j) * 0.5
      return { x: P[j].px + (P[j + 1].px - P[j].px) * k, y: P[j].py + (P[j + 1].py - P[j].py) * k }
    }
    var start = i <= 1 ? { x: P[0].px, y: P[0].py } : segEnd(i - 1)
    var end = smoothing > 0 && i < n - 1 ? segEnd(i) : { x: P[i].px, y: P[i].py }
    return { start: start, end: end, curved: smoothing > 0 && i < n - 1 && Math.hypot(end.x - P[i].px, end.y - P[i].py) > 0.15 }
  }

  function strokePass(ctx, s, P, scale, pass, paint, op) {
    ctx.strokeStyle = paint
    ctx.fillStyle = paint
    ctx.lineCap = pass.cap || 'round'
    ctx.lineJoin = 'round'
    var n = P.length
    var jitter = function (idx, axis) { return pass.j ? (unit(s.seed + idx * 53 + (op || 0) * 2 + axis) - 0.5) * scale * pass.j : 0 }
    if (n === 1) {
      var d = nibOf(s, P[0], P[0], scale) * pass.w
      ctx.beginPath()
      ctx.arc(P[0].px, P[0].py, d / 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    for (var i = 1; i < n; i += 1) {
      if (Math.hypot(P[i].px - P[i - 1].px, P[i].py - P[i - 1].py) < 0.2) continue
      var seg = segmentPath(null, P, i, s, scale, SMOOTHING)
      var jx = jitter(i, 0)
      var jy = jitter(i, 1)
      ctx.beginPath()
      ctx.moveTo(seg.start.x + jx, seg.start.y + jy)
      if (seg.curved) ctx.quadraticCurveTo(P[i].px + jx, P[i].py + jy, seg.end.x + jx, seg.end.y + jy)
      else ctx.lineTo(P[i].px + jx, P[i].py + jy)
      ctx.lineWidth = nibOf(s, P[i - 1], P[i], scale) * pass.w
      ctx.stroke()
    }
  }

  function calligraphy(ctx, s, P, scale, paint) {
    ctx.fillStyle = paint
    var ang = -0.22 * Math.PI
    var ux = Math.cos(ang)
    var uy = Math.sin(ang)
    if (P.length === 1) {
      var nib = nibOf(s, P[0], P[0], scale)
      ctx.beginPath()
      ctx.ellipse(P[0].px, P[0].py, nib / 2, Math.max(0.5, nib * 0.16), ang, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    for (var i = 1; i < P.length; i += 1) {
      var w = nibOf(s, P[i - 1], P[i], scale) / 2
      var hx = ux * w
      var hy = uy * w
      ctx.beginPath()
      ctx.moveTo(P[i - 1].px + hx, P[i - 1].py + hy)
      ctx.lineTo(P[i].px + hx, P[i].py + hy)
      ctx.lineTo(P[i].px - hx, P[i].py - hy)
      ctx.lineTo(P[i - 1].px - hx, P[i - 1].py - hy)
      ctx.closePath()
      ctx.fill()
    }
  }

  function spray(ctx, s, P, scale, paint) {
    ctx.fillStyle = paint
    var count = Math.round(clamp(s.baseWidth * 0.68, 6, 24))
    var segs = P.length === 1 ? [[P[0], P[0]]] : P.slice(1).map(function (p, i) { return [P[i], p] })
    segs.forEach(function (pair, idx) {
      var radius = nibOf(s, pair[0], pair[1], scale) / 2
      for (var k = 0; k < count; k += 1) {
        var key = s.seed + idx * 1009 + k * 37
        var prog = unit(key + 1)
        var angle = unit(key + 2) * Math.PI * 2
        var spread = Math.sqrt(unit(key + 3)) * radius
        var cx = pair[0].px + (pair[1].px - pair[0].px) * prog + Math.cos(angle) * spread
        var cy = pair[0].py + (pair[1].py - pair[0].py) * prog + Math.sin(angle) * spread
        ctx.globalAlpha = s.opacity * (0.2 + unit(key + 5) * 0.5)
        ctx.beginPath()
        ctx.arc(cx, cy, Math.max(0.35, scale * (0.28 + unit(key + 4) * 0.62)), 0, Math.PI * 2)
        ctx.fill()
      }
    })
    ctx.globalAlpha = 1
  }

  function makePaint(ctx, s, W, H) {
    var stops = EFFECTS[s.colorEffect]
    if (!stops) return s.color
    var g = ctx.createLinearGradient(0, 0.08 * H, W, 0.28 * H)
    stops.forEach(function (st) { g.addColorStop(st[0], st[1]) })
    return g
  }

  function drawStamp(ctx, s, P, scale) {
    var k = s.baseWidth * scale / 24
    ctx.save()
    ctx.globalAlpha = s.opacity
    ctx.translate(P[0].px, P[0].py)
    ctx.rotate(s.rotation * Math.PI / 180)
    ctx.scale(k, k)
    ctx.translate(-12, -12)
    ctx.strokeStyle = s.color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = s.figureLineWidth ? s.figureLineWidth * 24 / s.baseWidth : 1.75
    s.paths.forEach(function (d) {
      try { ctx.stroke(new Path2D(d)) } catch (e) { /* skip bad path data */ }
    })
    ctx.restore()
  }

  function drawStroke(ctx, s, W, H, scale, scratchFactory) {
    var P = s.points.map(function (p) { return { px: p.x * W, py: p.y * H, pressure: p.pressure } })
    if (s.stamp) { drawStamp(ctx, s, P, scale); return }
    var passes = BRUSH_PASSES[s.brush]
    var translucent = s.art && s.brush !== 'spray' && (s.opacity < 0.999 || passes.some(function (p) { return p.a * s.opacity < 0.999 }))
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (s.colorEffect === 'neon') {
      ctx.shadowColor = s.color
      ctx.shadowBlur = Math.max(4, s.baseWidth * scale * 0.85)
    }
    if (s.brush === 'spray') {
      spray(ctx, s, P, scale, makePaint(ctx, s, W, H))
    } else if (s.brush === 'calligraphy') {
      calligraphy(ctx, s, P, scale, makePaint(ctx, s, W, H))
    } else if (!translucent) {
      passes.forEach(function (pass, i) { strokePass(ctx, s, P, scale, pass, makePaint(ctx, s, W, H), i) })
    } else {
      var maxNib = s.baseWidth * 1.6 * 1.6 * scale + 4
      var minX = Infinity; var minY = Infinity; var maxX = -Infinity; var maxY = -Infinity
      P.forEach(function (p) { minX = Math.min(minX, p.px); minY = Math.min(minY, p.py); maxX = Math.max(maxX, p.px); maxY = Math.max(maxY, p.py) })
      var ox = Math.max(0, Math.floor(minX - maxNib))
      var oy = Math.max(0, Math.floor(minY - maxNib))
      var sw = Math.min(Math.ceil(W), Math.ceil(maxX + maxNib)) - ox
      var sh = Math.min(Math.ceil(H), Math.ceil(maxY + maxNib)) - oy
      if (sw > 0 && sh > 0) {
        passes.forEach(function (pass, i) {
          var scratch = scratchFactory(sw, sh)
          var sctx = scratch.getContext('2d')
          sctx.clearRect(0, 0, sw, sh)
          sctx.translate(-ox, -oy)
          var Q = P.map(function (p) { return { px: p.px, py: p.py, pressure: p.pressure } })
          var opaquePass = { w: pass.w, a: 1, j: pass.j, cap: s.brush === 'highlighter' && !s.pressureEnabled ? 'butt' : 'round' }
          // One opaque pass on the scratch layer so overlaps inside a stroke do not band.
          strokePass(sctx, s, Q, scale, opaquePass, makePaint(sctx, s, W, H), i)
          ctx.globalAlpha = s.opacity * pass.a
          if (s.brush === 'highlighter') ctx.globalCompositeOperation = 'multiply'
          ctx.drawImage(scratch, 0, 0, sw, sh, ox, oy, sw, sh)
          ctx.globalCompositeOperation = 'source-over'
          ctx.globalAlpha = 1
        })
      }
    }
    ctx.restore()
  }

  /**
   * Paints paper and strokes of one drawing document into `canvas`.
   * options: { cssWidth, paper, dpr } - cssWidth is the displayed width in CSS px.
   * Returns { strokes, width, height } (page units).
   */
  function renderPage(canvas, doc, options) {
    options = options || {}
    var W0 = Number(doc.sourceWidth) > 0 ? Number(doc.sourceWidth) : 900
    var H0 = Number(doc.sourceHeight) > 0 ? Number(doc.sourceHeight) : 1273
    var cssWidth = options.cssWidth || W0
    var dpr = options.dpr || 1
    var wb = Math.max(1, Math.round(cssWidth * dpr))
    var hb = Math.max(1, Math.round(wb * H0 / W0))
    var shrink = Math.min(1, MAX_SIDE / Math.max(wb, hb), Math.sqrt(MAX_PIXELS / (wb * hb)))
    wb = Math.max(1, Math.round(wb * shrink))
    hb = Math.max(1, Math.round(hb * shrink))
    canvas.width = wb
    canvas.height = hb
    canvas.style.width = cssWidth + 'px'
    canvas.style.height = (cssWidth * H0 / W0) + 'px'
    var ctx = canvas.getContext('2d')
    var known = function (v) { return ['blank', 'dots', 'squares', 'grid', 'lines', 'millimeter'].indexOf(v) >= 0 ? v : null }
    // The payload's paperStyle (passed as options.paper) wins over the drawing's own, as in the app.
    var style = known(options.paper) || known(doc.paperStyle) || 'blank'
    drawPaper(ctx, wb, hb, style)
    var scale = wb / W0
    var scratch = null
    var factory = function (w, h) {
      if (!scratch) scratch = document.createElement('canvas')
      scratch.width = w
      scratch.height = h
      return scratch
    }
    var count = 0
    var raw = Array.isArray(doc.strokes) ? doc.strokes : []
    for (var i = 0; i < raw.length; i += 1) {
      var s = normalizeStroke(raw[i])
      if (!s) continue
      count += 1
      try { drawStroke(ctx, s, wb, hb, scale, factory) } catch (e) { /* one bad stroke must not stop the page */ }
    }
    return { strokes: count, width: W0, height: H0 }
  }

  root.FamdInk = { renderPage: renderPage }
})(window)
