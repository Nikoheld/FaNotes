pub const INK_POINTER_IDLE_MS: f64 = 1600.0;

#[derive(Clone, Debug, PartialEq)]
pub struct InkPointerSample {
    pub pointer_id: f64,
    pub pointer_type: Option<String>,
    pub buttons: f64,
    pub pressure: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InkPointerSession {
    pub pointer_id: f64,
    pub pointer_type: String,
    pub last_buttons: f64,
    pub last_pressure: f64,
    pub last_contact_at: f64,
}

pub fn is_ink_tip_down(pointer_type: Option<&str>, buttons: f64, pressure: Option<f64>) -> bool {
    let buttons = finite_or_zero(buttons);
    if (buttons as i64 & 32) != 0 {
        return true;
    }
    if (buttons as i64 & 1) == 0 {
        return false;
    }
    if pointer_type.unwrap_or("") == "pen" {
        if let Some(pressure) = pressure {
            if pressure <= 0.0 {
                return false;
            }
        }
    }
    true
}

pub fn is_ink_tip_up(buttons: f64) -> bool {
    let buttons = finite_or_zero(buttons) as i64;
    if (buttons & 32) != 0 {
        return false;
    }
    (buttons & 1) == 0
}

pub fn ink_pointer_session_from_sample(sample: &InkPointerSample, at: f64) -> InkPointerSession {
    InkPointerSession {
        pointer_id: sample.pointer_id,
        pointer_type: sample
            .pointer_type
            .clone()
            .unwrap_or_else(|| "mouse".into()),
        last_buttons: finite_or_zero(sample.buttons),
        last_pressure: sample.pressure.unwrap_or(0.5),
        last_contact_at: at,
    }
}

pub fn touch_ink_pointer_session(
    session: &InkPointerSession,
    sample: &InkPointerSample,
    at: f64,
) -> InkPointerSession {
    if sample.pointer_id != session.pointer_id {
        return session.clone();
    }
    let pointer_type = sample
        .pointer_type
        .as_deref()
        .unwrap_or(session.pointer_type.as_str());
    let contact = is_ink_tip_down(Some(pointer_type), sample.buttons, sample.pressure);
    InkPointerSession {
        pointer_id: session.pointer_id,
        pointer_type: session.pointer_type.clone(),
        last_buttons: finite_or_zero(sample.buttons),
        last_pressure: sample.pressure.unwrap_or(session.last_pressure),
        last_contact_at: if contact { at } else { session.last_contact_at },
    }
}

pub fn should_hard_end_ink_pointer_session(
    session: Option<&InkPointerSession>,
    now: f64,
    incoming: Option<&InkPointerSample>,
) -> bool {
    let Some(session) = session else {
        return false;
    };
    if let Some(incoming) = incoming {
        if incoming.pointer_id == session.pointer_id {
            if is_ink_tip_up(incoming.buttons) {
                return true;
            }
            let pointer_type = incoming
                .pointer_type
                .as_deref()
                .unwrap_or(session.pointer_type.as_str());
            if is_ink_tip_down(Some(pointer_type), incoming.buttons, incoming.pressure) {
                return false;
            }
            return now - session.last_contact_at >= INK_POINTER_IDLE_MS;
        }
    }
    now - session.last_contact_at >= INK_POINTER_IDLE_MS
}

pub fn should_allow_new_ink_pointer(
    session: Option<&InkPointerSession>,
    incoming_id: f64,
    incoming_type: Option<&str>,
    now: f64,
) -> bool {
    let Some(session) = session else {
        return true;
    };
    if session.pointer_id == incoming_id {
        return false;
    }
    if should_hard_end_ink_pointer_session(Some(session), now, None) {
        return true;
    }
    session.pointer_type == "pen" && incoming_type == Some("mouse")
}

fn finite_or_zero(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}
