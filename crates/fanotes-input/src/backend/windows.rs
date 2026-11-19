//! WM_POINTER translator. `windows_io` fills [`WinPointerRaw`] from `POINTER_PEN_INFO`
//! (full-rate history, oldest first) and this module turns them into `PenSample`s.
//! Pure Rust so the replay tests run on every host.

use std::collections::HashMap;

use crate::sample::{button, PenSample, PhaseTracker, TimeUnwrap, ToolKind};

// POINTER_FLAGS
pub const POINTER_FLAG_INRANGE: u32 = 0x0000_0002;
pub const POINTER_FLAG_INCONTACT: u32 = 0x0000_0004;
pub const POINTER_FLAG_FIRSTBUTTON: u32 = 0x0000_0010;
pub const POINTER_FLAG_SECONDBUTTON: u32 = 0x0000_0020;
pub const POINTER_FLAG_THIRDBUTTON: u32 = 0x0000_0040;
pub const POINTER_FLAG_FOURTHBUTTON: u32 = 0x0000_0080;
pub const POINTER_FLAG_FIFTHBUTTON: u32 = 0x0000_0100;
pub const POINTER_FLAG_CANCELED: u32 = 0x0000_8000;
// PEN_FLAGS
pub const PEN_FLAG_BARREL: u32 = 0x1;
pub const PEN_FLAG_INVERTED: u32 = 0x2;
pub const PEN_FLAG_ERASER: u32 = 0x4;
// PEN_MASK
pub const PEN_MASK_PRESSURE: u32 = 0x1;
pub const PEN_MASK_ROTATION: u32 = 0x2;
pub const PEN_MASK_TILT_X: u32 = 0x4;
pub const PEN_MASK_TILT_Y: u32 = 0x8;
/// `POINTER_PEN_INFO.pressure` range.
pub const WIN_PRESSURE_MAX: f64 = 1024.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WinPointerKind {
    Pen,
    Touch,
    Mouse,
}

/// Rects from `GetPointerDeviceRects`: digitizer extent and the display area it maps to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WinRects {
    pub device: [i32; 4],
    pub display: [i32; 4],
}

#[derive(Clone, Debug, PartialEq)]
pub struct WinPointerRaw {
    pub kind: WinPointerKind,
    pub pointer_id: u32,
    /// `sourceDevice` handle value; stable per digitizer.
    pub device: u64,
    pub flags: u32,
    pub pen_flags: u32,
    pub pen_mask: u32,
    pub pressure: u32,
    pub rotation: u32,
    pub tilt_x: i32,
    pub tilt_y: i32,
    pub time_ms: u32,
    /// `PerformanceCount` (microseconds), 0 if absent.
    pub perf_us: u64,
    pub pixel: (i32, i32),
    pub himetric_raw: (i32, i32),
    pub rects: Option<WinRects>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WinMsg {
    Enter,
    Down,
    Update,
    Up,
    Leave,
    CaptureChanged,
}

#[derive(Default)]
pub struct WindowsTranslator {
    phases: PhaseTracker,
    time: HashMap<u64, TimeUnwrap>,
    last: HashMap<u64, PenSample>,
    /// Screen position of the client area origin.
    pub client_origin: (f64, f64),
}

impl WindowsTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    /// `history` is oldest first and includes the message's own sample as the last entry.
    pub fn push(
        &mut self,
        msg: WinMsg,
        history: &[WinPointerRaw],
        device: u64,
        out: &mut Vec<PenSample>,
    ) {
        match msg {
            WinMsg::Leave | WinMsg::CaptureChanged => {
                let cancel = msg == WinMsg::CaptureChanged;
                if let Some(mut last) = self.last.remove(&device) {
                    last.phase = self.phases.step(device, false, false, cancel);
                    last.pressure = 0.0;
                    last.buttons = 0;
                    out.push(last);
                }
                self.phases.forget(device);
            }
            _ => {
                for raw in history {
                    let s = self.translate(raw);
                    self.last.insert(raw.device, s.clone());
                    out.push(s);
                }
            }
        }
    }

    fn translate(&mut self, r: &WinPointerRaw) -> PenSample {
        let in_range = r.flags & POINTER_FLAG_INRANGE != 0;
        let contact = r.flags & POINTER_FLAG_INCONTACT != 0;
        let canceled = r.flags & POINTER_FLAG_CANCELED != 0;
        let phase = self.phases.step(r.device, in_range, contact, canceled);
        let pen = r.kind == WinPointerKind::Pen;
        let eraser = pen && r.pen_flags & (PEN_FLAG_INVERTED | PEN_FLAG_ERASER) != 0;
        let tool = match r.kind {
            WinPointerKind::Pen if eraser => ToolKind::Eraser,
            WinPointerKind::Pen => ToolKind::Pen,
            WinPointerKind::Touch => ToolKind::Finger,
            WinPointerKind::Mouse => ToolKind::Mouse,
        };
        let mut buttons = 0;
        if (pen && r.pen_flags & PEN_FLAG_BARREL != 0) || r.flags & POINTER_FLAG_SECONDBUTTON != 0 {
            buttons |= button::BARREL;
        }
        if r.flags & POINTER_FLAG_THIRDBUTTON != 0 {
            buttons |= button::UPPER;
        }
        if r.flags & POINTER_FLAG_FOURTHBUTTON != 0 {
            buttons |= button::BACK;
        }
        if r.flags & POINTER_FLAG_FIFTHBUTTON != 0 {
            buttons |= button::FORWARD;
        }
        if contact {
            buttons |= if eraser { button::ERASER } else { button::TIP };
        }
        let pressure = if !contact {
            0.0
        } else if pen && r.pen_mask & PEN_MASK_PRESSURE != 0 {
            (r.pressure as f64 / WIN_PRESSURE_MAX).clamp(0.0, 1.0) as f32
        } else {
            // No pressure axis (or a mouse): report a nominal contact pressure.
            0.5
        };
        let (sx, sy) = self.screen_position(r);
        let ms = if r.perf_us != 0 {
            r.perf_us as f64 / 1000.0
        } else {
            self.time.entry(r.device).or_default().feed(r.time_ms)
        };
        PenSample {
            phase,
            x: sx - self.client_origin.0,
            y: sy - self.client_origin.1,
            pressure,
            tilt_x: if r.pen_mask & PEN_MASK_TILT_X != 0 {
                r.tilt_x as f32
            } else {
                0.0
            },
            tilt_y: if r.pen_mask & PEN_MASK_TILT_Y != 0 {
                r.tilt_y as f32
            } else {
                0.0
            },
            rotation: if r.pen_mask & PEN_MASK_ROTATION != 0 {
                (r.rotation % 360) as f32
            } else {
                0.0
            },
            buttons,
            tool,
            eraser,
            timestamp_ms: ms,
            device_id: r.device,
        }
    }

    /// Sub-pixel screen position from the raw digitizer coordinates when the device
    /// rects are known, else the integer pixel location.
    fn screen_position(&self, r: &WinPointerRaw) -> (f64, f64) {
        if let Some(rc) = r.rects {
            let dw = (rc.device[2] - rc.device[0]) as f64;
            let dh = (rc.device[3] - rc.device[1]) as f64;
            if dw > 0.0 && dh > 0.0 {
                let w = (rc.display[2] - rc.display[0]) as f64;
                let h = (rc.display[3] - rc.display[1]) as f64;
                return (
                    rc.display[0] as f64 + (r.himetric_raw.0 - rc.device[0]) as f64 * w / dw,
                    rc.display[1] as f64 + (r.himetric_raw.1 - rc.device[1]) as f64 * h / dh,
                );
            }
        }
        (r.pixel.0 as f64, r.pixel.1 as f64)
    }
}
