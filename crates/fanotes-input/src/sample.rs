//! The backend-neutral pen sample and the `PenSource` trait.

use std::time::Duration;

/// W3C `PointerEvent.buttons` bit layout, as used by `tabletButtons.ts`.
pub mod button {
    /// Tip contact (left button).
    pub const TIP: u32 = 1;
    /// Barrel / side button (right button, DOM button 2).
    pub const BARREL: u32 = 2;
    /// Upper button (middle, DOM button 1).
    pub const UPPER: u32 = 4;
    /// Tablet key 1 / back.
    pub const BACK: u32 = 8;
    /// Tablet key 2 / forward.
    pub const FORWARD: u32 = 16;
    /// Eraser end in contact.
    pub const ERASER: u32 = 32;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PenPhase {
    /// Tool entered proximity (hover begins).
    Enter,
    /// In range, not touching.
    Hover,
    /// Tip or eraser touched down.
    Down,
    /// Contact continues.
    Move,
    /// Contact ended, tool still in range.
    Up,
    /// Tool left proximity.
    Leave,
    /// Backend lost the contact (capture lost, device removed).
    Cancel,
}

impl PenPhase {
    pub fn in_contact(self) -> bool {
        matches!(self, PenPhase::Down | PenPhase::Move)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ToolKind {
    Pen,
    Eraser,
    Brush,
    Pencil,
    Airbrush,
    Finger,
    Mouse,
    Lens,
    Unknown,
}

impl ToolKind {
    /// The Pointer Events `pointerType` string the shared policy expects.
    pub fn pointer_type(self) -> &'static str {
        match self {
            ToolKind::Mouse | ToolKind::Lens => "mouse",
            ToolKind::Finger => "touch",
            _ => "pen",
        }
    }
    pub fn is_pen_like(self) -> bool {
        self.pointer_type() == "pen"
    }
}

/// One pen sample from any backend.
#[derive(Clone, Debug, PartialEq)]
pub struct PenSample {
    pub phase: PenPhase,
    /// Client pixels, relative to the surface the backend was bound to.
    pub x: f64,
    pub y: f64,
    /// Normalised 0..=1. 0 while hovering.
    pub pressure: f32,
    /// Degrees, -90..=90, positive tilts toward +x / +y (Pointer Events convention).
    pub tilt_x: f32,
    pub tilt_y: f32,
    /// Barrel rotation in degrees 0..360, 0 when the device has no rotation axis.
    pub rotation: f32,
    /// [`button`] bits. Bit 1 is tip contact, bit 32 eraser contact.
    pub buttons: u32,
    pub tool: ToolKind,
    /// The eraser end of the stylus is the active end (hovering or touching).
    pub eraser: bool,
    /// Milliseconds on a monotonic, backend-specific clock. Unwrapped, never decreases per device.
    pub timestamp_ms: f64,
    pub device_id: u64,
}

impl PenSample {
    pub fn in_contact(&self) -> bool {
        self.phase.in_contact()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PenError {
    #[error("pen backend unavailable: {0}")]
    Unavailable(String),
    #[error("pen backend I/O error: {0}")]
    Io(String),
}

/// A source of pen samples (a native backend or a replay).
pub trait PenSource {
    fn backend(&self) -> &'static str;
    /// Wait up to `timeout` (`None` = do not wait) for events and append the
    /// resulting samples in order. Returns how many were appended.
    fn poll(
        &mut self,
        timeout: Option<Duration>,
        out: &mut Vec<PenSample>,
    ) -> Result<usize, PenError>;
}

/// Replays a fixed sample list. Used by tests and tools.
pub struct ReplaySource {
    samples: std::collections::VecDeque<PenSample>,
}

impl ReplaySource {
    pub fn new(samples: Vec<PenSample>) -> Self {
        Self {
            samples: samples.into(),
        }
    }
}

impl PenSource for ReplaySource {
    fn backend(&self) -> &'static str {
        "replay"
    }
    fn poll(&mut self, _t: Option<Duration>, out: &mut Vec<PenSample>) -> Result<usize, PenError> {
        let n = self.samples.len();
        out.extend(self.samples.drain(..));
        Ok(n)
    }
}

/// Unwraps a 32-bit millisecond counter into a monotonic f64.
#[derive(Clone, Debug, Default)]
pub struct TimeUnwrap {
    last: Option<u32>,
    epochs: u64,
}

impl TimeUnwrap {
    pub fn feed(&mut self, t: u32) -> f64 {
        if let Some(last) = self.last {
            // A backwards jump larger than half the range is a wrap.
            if t < last && last - t > u32::MAX / 2 {
                self.epochs += 1;
            }
        }
        self.last = Some(t);
        (self.epochs << 32) as f64 + t as f64
    }
}

/// Tracks hover/contact/range per device and names the phase of each sample.
#[derive(Clone, Debug, Default)]
pub struct PhaseTracker {
    state: std::collections::HashMap<u64, (bool, bool)>,
}

impl PhaseTracker {
    /// `in_range` false means the tool left. Returns the phase for this sample.
    pub fn step(&mut self, device: u64, in_range: bool, contact: bool, cancel: bool) -> PenPhase {
        let prev = self.state.get(&device).copied().unwrap_or((false, false));
        let contact = contact && in_range;
        let phase = if cancel {
            PenPhase::Cancel
        } else if !in_range {
            if prev.1 {
                PenPhase::Cancel
            } else {
                PenPhase::Leave
            }
        } else {
            match (prev.0, prev.1, contact) {
                (false, _, false) => PenPhase::Enter,
                (false, _, true) | (true, false, true) => PenPhase::Down,
                (true, true, true) => PenPhase::Move,
                (true, true, false) => PenPhase::Up,
                (true, false, false) => PenPhase::Hover,
            }
        };
        if in_range && !cancel {
            self.state.insert(device, (true, contact));
        } else {
            self.state.remove(&device);
        }
        phase
    }
    pub fn forget(&mut self, device: u64) {
        self.state.remove(&device);
    }
}
