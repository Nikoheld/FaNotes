//! XInput2 translator. The I/O layer converts `XIDeviceEvent`s and the device's
//! valuator classes into these plain structs.
//!
//! XI2 has no proximity event for tablets, so range is inferred: a gap longer than
//! [`PROXIMITY_TIMEOUT_MS`] between events of one device (or `tick`) means the tool left.

use std::collections::HashMap;

use crate::sample::{button, PenPhase, PenSample, PhaseTracker, TimeUnwrap, ToolKind};

pub const PROXIMITY_TIMEOUT_MS: f64 = 250.0;
/// Wacom devices report tilt in -64..63 device units that map to +-60 degrees.
pub const X11_MAX_TILT_DEG: f64 = 60.0;

#[derive(Clone, Debug, PartialEq)]
pub struct XiAxis {
    /// Valuator number (index in the valuator mask).
    pub number: u16,
    /// Atom name of the label, e.g. "Abs Pressure".
    pub label: String,
    pub min: f64,
    pub max: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct XiDevice {
    /// Slave device id.
    pub id: u16,
    pub name: String,
    pub axes: Vec<XiAxis>,
}

impl XiDevice {
    fn axis(&self, label: &str) -> Option<&XiAxis> {
        self.axes
            .iter()
            .find(|a| a.label.eq_ignore_ascii_case(label))
    }
    /// Pen, eraser or other, from the device name the Wacom driver registers
    /// ("... Pen stylus", "... Pen eraser", "... Pad pad", "... Finger touch").
    pub fn tool(&self) -> ToolKind {
        let n = self.name.to_ascii_lowercase();
        if n.ends_with("eraser") {
            ToolKind::Eraser
        } else if n.ends_with("cursor") {
            ToolKind::Mouse
        } else if n.ends_with("touch") {
            ToolKind::Finger
        } else {
            ToolKind::Pen
        }
    }
    /// Pads and touch panes carry no pen data; a device is a pen source when it has a pressure axis.
    pub fn is_pen_source(&self) -> bool {
        let n = self.name.to_ascii_lowercase();
        !n.ends_with("pad") && self.axis("Abs Pressure").is_some()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum XiKind {
    Motion,
    ButtonPress(u8),
    ButtonRelease(u8),
}

#[derive(Clone, Debug, PartialEq)]
pub struct XiEvent {
    pub source: u16,
    pub time: u32,
    pub kind: XiKind,
    /// Window-relative, fp16.16 already converted.
    pub x: f64,
    pub y: f64,
    /// XI2 button state: bit n set = button n down.
    pub button_mask: u32,
    /// Only the valuators present in the event.
    pub valuators: Vec<(u16, f64)>,
}

/// X button number to the W3C bit layout (X1 tip, X2 middle, X3 right, X8 back, X9 forward).
pub fn x_button_bit(n: u8) -> u32 {
    match n {
        1 => button::TIP,
        2 => button::UPPER,
        3 => button::BARREL,
        8 => button::BACK,
        9 => button::FORWARD,
        _ => 0,
    }
}

fn mask_to_bits(mask: u32) -> u32 {
    (1..=9u8)
        .filter(|n| mask & (1 << n) != 0)
        .fold(0, |acc, n| acc | x_button_bit(n))
}

#[derive(Default)]
struct DeviceState {
    axes: HashMap<u16, f64>,
    last_ms: Option<f64>,
    last_pos: (f64, f64),
    time: TimeUnwrap,
}

#[derive(Default)]
pub struct X11Translator {
    devices: HashMap<u16, XiDevice>,
    state: HashMap<u16, DeviceState>,
    phases: PhaseTracker,
}

impl X11Translator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_device(&mut self, dev: XiDevice) {
        self.state.remove(&dev.id);
        self.devices.insert(dev.id, dev);
    }

    pub fn push(&mut self, ev: &XiEvent, out: &mut Vec<PenSample>) {
        let Some(dev) = self.devices.get(&ev.source) else {
            return;
        };
        if !dev.is_pen_source() {
            return;
        }
        let tool = dev.tool();
        let st = self.state.entry(ev.source).or_default();
        let ms = st.time.feed(ev.time);
        let id = ev.source as u64;
        if let Some(prev) = st.last_ms {
            if ms - prev > PROXIMITY_TIMEOUT_MS {
                let phase = self.phases.step(id, false, false, false);
                out.push(sample(phase, st, tool, id, prev, 0, false));
                st.axes.clear();
            }
        }
        st.last_ms = Some(ms);
        for (n, v) in &ev.valuators {
            st.axes.insert(*n, *v);
        }
        st.last_pos = (ev.x, ev.y);

        let mut mask = mask_to_bits(ev.button_mask);
        match ev.kind {
            XiKind::ButtonPress(n) => mask |= x_button_bit(n),
            XiKind::ButtonRelease(n) => mask &= !x_button_bit(n),
            XiKind::Motion => {}
        }
        let contact = mask & button::TIP != 0;
        let phase = self.phases.step(id, true, contact, false);
        let mut buttons = mask & !button::TIP;
        if contact {
            buttons |= if tool == ToolKind::Eraser {
                button::ERASER
            } else {
                button::TIP
            };
        }
        let mut s = sample(phase, st, tool, id, ms, buttons, contact);
        let dev = &self.devices[&ev.source];
        let norm = |a: &XiAxis, v: f64| (v - a.min) / (a.max - a.min).max(f64::EPSILON);
        if let Some(a) = dev.axis("Abs Pressure") {
            let v = st.axes.get(&a.number).copied().unwrap_or(a.min);
            s.pressure = if contact {
                norm(a, v).clamp(0.0, 1.0) as f32
            } else {
                0.0
            };
        }
        let tilt = |label: &str| {
            dev.axis(label).map_or(0.0, |a| {
                let v = st
                    .axes
                    .get(&a.number)
                    .copied()
                    .unwrap_or((a.min + a.max) / 2.0);
                ((norm(a, v) - 0.5) * 2.0 * X11_MAX_TILT_DEG).clamp(-90.0, 90.0) as f32
            })
        };
        s.tilt_x = tilt("Abs Tilt X");
        s.tilt_y = tilt("Abs Tilt Y");
        if let Some(a) = dev.axis("Abs Rotation Z") {
            let v = st.axes.get(&a.number).copied().unwrap_or(a.min);
            s.rotation = (norm(a, v) * 360.0).rem_euclid(360.0) as f32;
        }
        out.push(s);
    }

    /// Emits `Leave` for devices that went quiet. `now_ms` must use the X server time base.
    pub fn tick(&mut self, now_ms: f64, out: &mut Vec<PenSample>) {
        let mut ids: Vec<u16> = self.state.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let Some(dev) = self.devices.get(&id) else {
                continue;
            };
            let tool = dev.tool();
            let st = self.state.get_mut(&id).unwrap();
            let Some(last) = st.last_ms else { continue };
            if now_ms - last > PROXIMITY_TIMEOUT_MS {
                let phase = self.phases.step(id as u64, false, false, false);
                out.push(sample(phase, st, tool, id as u64, now_ms, 0, false));
                st.last_ms = None;
                st.axes.clear();
            }
        }
    }
}

fn sample(
    phase: PenPhase,
    st: &DeviceState,
    tool: ToolKind,
    id: u64,
    ms: f64,
    buttons: u32,
    _contact: bool,
) -> PenSample {
    PenSample {
        phase,
        x: st.last_pos.0,
        y: st.last_pos.1,
        pressure: 0.0,
        tilt_x: 0.0,
        tilt_y: 0.0,
        rotation: 0.0,
        buttons,
        tool,
        eraser: tool == ToolKind::Eraser,
        timestamp_ms: ms,
        device_id: id,
    }
}
