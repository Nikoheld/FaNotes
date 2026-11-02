"""Reference implementation of the FaNotes ink line image (spec `fanotes-ink-line-v1`).

The app (Rust/WASM), the Android client (Kotlin) and the training data all render pen
strokes through this exact procedure. Keep the constants in sync with
`crates/fanotes-recog/src/ink.rs`.
"""
import math

import numba
import numpy as np

HEIGHT = 64
MARGIN_Y = 6.0
MARGIN_X = 8.0
PEN_WIDTH = 2.6
MAX_WIDTH = 2048
MIN_WIDTH = 16
MIN_CONTENT_HEIGHT = 6.0
MAX_SKEW = 0.2
MAX_SLANT = 0.6


def _skew(points, widths_ok):
    if not widths_ok or len(points) < 3:
        return 0.0
    x = points[:, 0]
    y = points[:, 1]
    vx = x - x.mean()
    denominator = float((vx * vx).sum())
    if denominator <= 1e-9:
        return 0.0
    slope = float((vx * (y - y.mean())).sum()) / denominator
    return max(-MAX_SKEW, min(MAX_SKEW, math.atan(slope)))


def _slant(strokes):
    sum_dx = 0.0
    sum_dy = 0.0
    for stroke in strokes:
        if len(stroke) < 2:
            continue
        d = np.diff(stroke, axis=0)
        dx = d[:, 0]
        dy = d[:, 1]
        flip = dy < 0
        dx = np.where(flip, -dx, dx)
        dy = np.abs(dy)
        keep = (dy > 0) & (np.abs(dx) <= dy) & ((dx * dx + dy * dy) >= 0.25)
        if not keep.any():
            continue
        weight = dy[keep]
        sum_dx += float((weight * dx[keep]).sum())
        sum_dy += float((weight * dy[keep]).sum())
    if sum_dy <= 1e-9:
        return 0.0
    return max(-MAX_SLANT, min(MAX_SLANT, math.atan2(sum_dx, sum_dy)))


def normalize(strokes, ref_height=0.0, extra_rotation=0.0, extra_shear=0.0, scale_jitter=1.0,
              height=HEIGHT, margin_y=MARGIN_Y, margin_x=MARGIN_X, max_width=MAX_WIDTH):
    """Returns (strokes in image pixels, width) or None."""
    strokes = [np.asarray(s, dtype=np.float64).reshape(-1, 2) for s in strokes if len(s)]
    if not strokes:
        return None
    points = np.concatenate(strokes)
    span_x = points[:, 0].max() - points[:, 0].min()
    span_y = points[:, 1].max() - points[:, 1].min()
    angle = -_skew(points, span_x > 2.5 * max(span_y, 1e-6)) + extra_rotation
    if angle != 0.0:
        center = points.mean(axis=0)
        c, s = math.cos(angle), math.sin(angle)
        rotate = np.array([[c, s], [-s, c]])
        strokes = [(stroke - center) @ rotate + center for stroke in strokes]
        points = np.concatenate(strokes)
    shear = math.tan(_slant(strokes)) - extra_shear
    if shear != 0.0:
        center_y = (points[:, 1].min() + points[:, 1].max()) / 2
        strokes = [np.column_stack([stroke[:, 0] - (stroke[:, 1] - center_y) * shear, stroke[:, 1]]) for stroke in strokes]
        points = np.concatenate(strokes)
    min_x, min_y = points.min(axis=0)
    max_x, max_y = points.max(axis=0)
    content = max(max_y - min_y, 0.8 * ref_height, MIN_CONTENT_HEIGHT)
    scale = (height - 2 * margin_y) / content * scale_jitter
    width_needed = (max_x - min_x) * scale + 2 * margin_x
    if width_needed > max_width:
        scale *= (max_width - 2 * margin_x) / max(1e-6, (max_x - min_x) * scale)
        width_needed = max_width
    width = int(math.ceil(max(MIN_WIDTH, width_needed) / 4.0) * 4)
    middle = (min_y + max_y) / 2
    mapped = [np.column_stack([(stroke[:, 0] - min_x) * scale + margin_x,
                               (stroke[:, 1] - middle) * scale + height / 2]) for stroke in strokes]
    return mapped, min(width, max_width)


@numba.njit(cache=True)
def _raster(xs, ys, starts, width, height, pen):
    ink = np.zeros((height, width), dtype=np.float32)
    radius = pen / 2.0 + 0.5
    for s in range(len(starts) - 1):
        a = starts[s]
        b = starts[s + 1]
        count = b - a
        for i in range(count if count == 1 else count - 1):
            x0 = xs[a + i]
            y0 = ys[a + i]
            x1 = xs[a + i + 1] if count > 1 else x0
            y1 = ys[a + i + 1] if count > 1 else y0
            left = int(math.floor(min(x0, x1) - radius))
            right = int(math.ceil(max(x0, x1) + radius))
            top = int(math.floor(min(y0, y1) - radius))
            bottom = int(math.ceil(max(y0, y1) + radius))
            if left < 0:
                left = 0
            if top < 0:
                top = 0
            if right > width - 1:
                right = width - 1
            if bottom > height - 1:
                bottom = height - 1
            dx = x1 - x0
            dy = y1 - y0
            length2 = dx * dx + dy * dy
            for py in range(top, bottom + 1):
                cy = py + 0.5
                for px in range(left, right + 1):
                    cx = px + 0.5
                    if length2 > 1e-12:
                        t = ((cx - x0) * dx + (cy - y0) * dy) / length2
                        if t < 0.0:
                            t = 0.0
                        elif t > 1.0:
                            t = 1.0
                    else:
                        t = 0.0
                    ex = cx - (x0 + t * dx)
                    ey = cy - (y0 + t * dy)
                    coverage = radius - math.sqrt(ex * ex + ey * ey)
                    if coverage > 1.0:
                        coverage = 1.0
                    if coverage > ink[py, px]:
                        ink[py, px] = coverage
    return ink


def rasterize(mapped, width, height=HEIGHT, pen=PEN_WIDTH):
    xs = np.concatenate([s[:, 0] for s in mapped]).astype(np.float64)
    ys = np.concatenate([s[:, 1] for s in mapped]).astype(np.float64)
    starts = np.zeros(len(mapped) + 1, dtype=np.int64)
    starts[1:] = np.cumsum([len(s) for s in mapped])
    return 1.0 - _raster(xs, ys, starts, width, height, float(pen))


def render(strokes, pen=PEN_WIDTH, **kwargs):
    normalized = normalize(strokes, **kwargs)
    if normalized is None:
        return None
    mapped, width = normalized
    return rasterize(mapped, width, pen=pen)
