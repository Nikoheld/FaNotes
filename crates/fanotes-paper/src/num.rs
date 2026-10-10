//! JavaScript `Math` / `Number` behavior the stay-put reducer depends on.
//!
//! `f64::max` ignores NaN. `Math.max` returns NaN if either argument is NaN.
//! The fixture numbers are finite; the helpers keep the port honest anyway.

pub fn finite_positive(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

pub fn finite_origin_px(value: f64) -> f64 {
    js_max(0.0, if value.is_finite() { value } else { 0.0 })
}

pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `!(left > right)`. NaN makes this true, matching JavaScript.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn js_not_gt(left: f64, right: f64) -> bool {
    !(left > right)
}

pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    value.round()
}
