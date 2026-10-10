pub const POST_PEN_IGNORE_MS: f64 = 850.0;

#[derive(Clone, Debug, PartialEq)]
pub struct InkInputSession {
    pub active_pointer_id: Option<f64>,
    pub capture_id: Option<f64>,
    pub last_contact_at: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WheelPolicy {
    pub session: InkInputSession,
    pub prevent_default: bool,
    pub allow_pan: bool,
    pub pinch: bool,
}

pub fn default_pen_only_for_platform(platform: Option<&str>) -> bool {
    platform.unwrap_or("") == "win32"
}

pub fn should_reject_non_pen_ink(pointer_type: Option<&str>, pen_only: bool) -> bool {
    pen_only && pointer_type != Some("pen")
}

pub fn empty_ink_input_session() -> InkInputSession {
    InkInputSession {
        active_pointer_id: None,
        capture_id: None,
        last_contact_at: 0.0,
    }
}

pub fn should_ignore_pointer_after_pen(
    pointer_type: Option<&str>,
    last_pen_at: f64,
    now: f64,
) -> bool {
    if pointer_type == Some("pen") {
        return false;
    }
    if !last_pen_at.is_finite() || last_pen_at <= 0.0 {
        return false;
    }
    now - last_pen_at < POST_PEN_IGNORE_MS
}

pub fn apply_wheel_ink_policy(wheel_ctrl: bool, wheel_meta: bool) -> WheelPolicy {
    let pinch = wheel_ctrl || wheel_meta;
    WheelPolicy {
        session: empty_ink_input_session(),
        prevent_default: pinch,
        allow_pan: !pinch,
        pinch,
    }
}

pub fn apply_pen_up_ink_cleanup(session: &InkInputSession) -> (InkInputSession, bool) {
    let release = session.capture_id.is_some() || session.active_pointer_id.is_some();
    (empty_ink_input_session(), release)
}
