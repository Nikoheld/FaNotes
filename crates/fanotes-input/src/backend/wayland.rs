//! `zwp_tablet_v2` translator. Events of one tool are accumulated until `frame`,
//! then emitted as one sample (the protocol's frame grouping).

use std::collections::HashMap;

use crate::sample::{button, PenPhase, PenSample, PhaseTracker, TimeUnwrap, ToolKind};

/// `zwp_tablet_tool_v2.type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WlToolType {
    Pen,
    Eraser,
    Brush,
    Pencil,
    Airbrush,
    Finger,
    Mouse,
    Lens,
}

impl WlToolType {
    pub fn from_wire(v: u32) -> Option<Self> {
        Some(match v {
            0x140 => Self::Pen,
            0x141 => Self::Eraser,
            0x142 => Self::Brush,
            0x143 => Self::Pencil,
            0x144 => Self::Airbrush,
            0x145 => Self::Finger,
            0x146 => Self::Mouse,
            0x147 => Self::Lens,
            _ => return None,
        })
    }
    fn kind(self) -> ToolKind {
        match self {
            Self::Pen => ToolKind::Pen,
            Self::Eraser => ToolKind::Eraser,
            Self::Brush => ToolKind::Brush,
            Self::Pencil => ToolKind::Pencil,
            Self::Airbrush => ToolKind::Airbrush,
            Self::Finger => ToolKind::Finger,
            Self::Mouse => ToolKind::Mouse,
            Self::Lens => ToolKind::Lens,
        }
    }
}

pub const BTN_LEFT: u32 = 0x110;
pub const BTN_RIGHT: u32 = 0x111;
pub const BTN_MIDDLE: u32 = 0x112;
pub const BTN_SIDE: u32 = 0x113;
pub const BTN_EXTRA: u32 = 0x114;
pub const BTN_STYLUS3: u32 = 0x149;
pub const BTN_TOUCH: u32 = 0x14a;
pub const BTN_STYLUS: u32 = 0x14b;
pub const BTN_STYLUS2: u32 = 0x14c;

/// Max of `zwp_tablet_tool_v2.pressure` (0..65535).
pub const WL_PRESSURE_MAX: f64 = 65535.0;

/// One event of `zwp_tablet_tool_v2`, with the tool identified by the glue's id.
#[derive(Clone, Debug, PartialEq)]
pub enum WlToolEvent {
    /// `type` (and optionally hardware serial, for logging).
    Type(WlToolType),
    /// `proximity_in`; `on_surface` is whether the entered surface is the bound one.
    ProximityIn {
        on_surface: bool,
    },
    ProximityOut,
    Down,
    Up,
    /// Surface-local coordinates.
    Motion {
        x: f64,
        y: f64,
    },
    Pressure(u32),
    Distance(u32),
    /// Degrees, -90..=90.
    Tilt {
        x: f64,
        y: f64,
    },
    /// Degrees.
    Rotation(f64),
    Slider(i32),
    Button {
        code: u32,
        pressed: bool,
    },
    /// Protocol `frame`, with the 32-bit millisecond timestamp.
    Frame {
        time: u32,
    },
    /// The tool object was removed.
    Removed,
}

#[derive(Default)]
struct Tool {
    kind: Option<WlToolType>,
    in_surface: bool,
    in_range: bool,
    contact: bool,
    x: f64,
    y: f64,
    pressure: f64,
    tilt: (f64, f64),
    rotation: f64,
    buttons: u32,
    dirty: bool,
    entered: bool,
    left: bool,
    time: TimeUnwrap,
    last_ms: f64,
}

#[derive(Default)]
pub struct WaylandTranslator {
    tools: HashMap<u64, Tool>,
    phases: PhaseTracker,
}

pub fn wl_button_bit(code: u32) -> u32 {
    match code {
        BTN_LEFT => button::TIP,
        BTN_RIGHT | BTN_STYLUS => button::BARREL,
        BTN_MIDDLE | BTN_STYLUS2 => button::UPPER,
        BTN_SIDE | BTN_STYLUS3 => button::BACK,
        BTN_EXTRA => button::FORWARD,
        _ => 0,
    }
}

impl WaylandTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, tool_id: u64, ev: &WlToolEvent, out: &mut Vec<PenSample>) {
        let t = self.tools.entry(tool_id).or_default();
        match ev {
            WlToolEvent::Type(k) => t.kind = Some(*k),
            WlToolEvent::ProximityIn { on_surface } => {
                t.in_surface = *on_surface;
                t.in_range = *on_surface;
                t.entered = *on_surface;
                t.contact = false;
                t.dirty = true;
            }
            WlToolEvent::ProximityOut => {
                if t.in_range {
                    t.left = true;
                    t.dirty = true;
                }
                t.in_range = false;
                t.contact = false;
                t.buttons = 0;
            }
            _ if !t.in_surface
                && !matches!(ev, WlToolEvent::Removed | WlToolEvent::Frame { .. }) => {}
            WlToolEvent::Down => {
                t.contact = true;
                t.dirty = true;
            }
            WlToolEvent::Up => {
                t.contact = false;
                t.dirty = true;
            }
            WlToolEvent::Motion { x, y } => {
                t.x = *x;
                t.y = *y;
                t.dirty = true;
            }
            WlToolEvent::Pressure(p) => {
                t.pressure = (*p as f64 / WL_PRESSURE_MAX).clamp(0.0, 1.0);
                t.dirty = true;
            }
            WlToolEvent::Tilt { x, y } => {
                t.tilt = (*x, *y);
                t.dirty = true;
            }
            WlToolEvent::Rotation(r) => {
                t.rotation = r.rem_euclid(360.0);
                t.dirty = true;
            }
            WlToolEvent::Distance(_) | WlToolEvent::Slider(_) => {}
            WlToolEvent::Button { code, pressed } => {
                // BTN_TOUCH duplicates down/up; tip contact comes from those.
                let bit = wl_button_bit(*code);
                if bit != 0 && bit != button::TIP {
                    if *pressed {
                        t.buttons |= bit;
                    } else {
                        t.buttons &= !bit;
                    }
                    t.dirty = true;
                }
            }
            WlToolEvent::Frame { time } => {
                let ms = t.time.feed(*time);
                t.last_ms = ms;
                if !t.dirty {
                    return;
                }
                t.dirty = false;
                let kind = t.kind.map(WlToolType::kind).unwrap_or(ToolKind::Unknown);
                let eraser = kind == ToolKind::Eraser;
                let left = std::mem::take(&mut t.left);
                let entered = std::mem::take(&mut t.entered);
                if !t.in_surface && !left {
                    return;
                }
                if entered {
                    self.phases.forget(tool_id);
                }
                let phase = self.phases.step(tool_id, t.in_range, t.contact, false);
                let mut buttons = t.buttons;
                if t.contact {
                    buttons |= if eraser { button::ERASER } else { button::TIP };
                }
                if left {
                    t.in_surface = false;
                }
                out.push(PenSample {
                    phase,
                    x: t.x,
                    y: t.y,
                    pressure: if t.contact { t.pressure as f32 } else { 0.0 },
                    tilt_x: t.tilt.0 as f32,
                    tilt_y: t.tilt.1 as f32,
                    rotation: t.rotation as f32,
                    buttons,
                    tool: kind,
                    eraser,
                    timestamp_ms: ms,
                    device_id: tool_id,
                });
            }
            WlToolEvent::Removed => {
                if t.contact {
                    out.push(PenSample {
                        phase: PenPhase::Cancel,
                        x: t.x,
                        y: t.y,
                        pressure: 0.0,
                        tilt_x: 0.0,
                        tilt_y: 0.0,
                        rotation: 0.0,
                        buttons: 0,
                        tool: t.kind.map(WlToolType::kind).unwrap_or(ToolKind::Unknown),
                        eraser: t.kind == Some(WlToolType::Eraser),
                        timestamp_ms: t.last_ms,
                        device_id: tool_id,
                    });
                }
                self.tools.remove(&tool_id);
                self.phases.forget(tool_id);
            }
        }
    }
}
