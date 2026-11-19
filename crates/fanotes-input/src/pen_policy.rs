//! Runs the shared pen policy (tip vs hover, idle lift, post-pen ignore, jump filter,
//! button mapping) over `PenSample`s from any backend.

use std::collections::HashMap;

use crate::jump::{classify_ink_jump_append, JumpAction};
use crate::map::{map_client_to_paper_point, MappedInkPoint, PaperSurface, PointerEvent};
use crate::policy::{should_ignore_pointer_after_pen, should_reject_non_pen_ink};
use crate::sample::{button, PenPhase, PenSample};
use crate::session::{
    ink_pointer_session_from_sample, is_ink_tip_down, is_ink_tip_up, should_allow_new_ink_pointer,
    should_hard_end_ink_pointer_session, touch_ink_pointer_session, InkPointerSample,
    InkPointerSession,
};
use crate::tablet_buttons::{
    tablet_button_identity, TabletButtonAction, TabletButtonId, TabletButtonMap,
};
use crate::ToolKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    PenUp,
    /// No contact for `INK_POINTER_IDLE_MS` while the button state still said "down".
    IdleLift,
    /// The eraser end and the tip swapped mid-stroke.
    ToolFlip,
    /// Another pointer legitimately took over.
    Superseded,
    Leave,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IgnoreReason {
    PostPenMouse,
    PenOnly,
    OffSurface,
    OtherPointer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PenEventKind {
    Hover,
    StrokeStart,
    StrokeAppend,
    /// The first point was a corridor leap; the stroke restarts at this point.
    StrokeRestart,
    /// Jump filter dropped this point.
    StrokeSkip,
    StrokeEnd(EndReason),
    Ignored(IgnoreReason),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PenOutput {
    pub kind: PenEventKind,
    /// The sample with sanitised buttons.
    pub sample: PenSample,
    /// Mapped document point (0..1 paper space) when one applies.
    pub point: Option<MappedInkPoint>,
    pub action: TabletButtonAction,
}

#[derive(Clone, Debug)]
pub struct PenPolicyConfig {
    pub surface: Option<PaperSurface>,
    pub rotation: f64,
    pub pen_only: bool,
    pub buttons: TabletButtonMap,
}

impl Default for PenPolicyConfig {
    fn default() -> Self {
        Self {
            surface: None,
            rotation: 0.0,
            pen_only: false,
            buttons: TabletButtonMap::default(),
        }
    }
}

/// Drops button bits a driver left stuck.
///
/// A non-tip bit that is already set when a tool enters proximity was not pressed in
/// this session, so it is ignored until it has been released once. The eraser bit is
/// only valid on the eraser tool in contact (Wacom drivers leave it set after an
/// eraser/tip flip).
#[derive(Clone, Debug, Default)]
pub struct ButtonSanitizer {
    inherited: HashMap<u64, u32>,
    active: HashMap<u64, ()>,
}

const SIDE_BITS: u32 = button::BARREL | button::UPPER | button::BACK | button::FORWARD;

impl ButtonSanitizer {
    pub fn sanitize(&mut self, s: &PenSample) -> u32 {
        if matches!(s.phase, PenPhase::Leave | PenPhase::Cancel) {
            self.inherited.remove(&s.device_id);
            self.active.remove(&s.device_id);
            return 0;
        }
        let fresh = self.active.insert(s.device_id, ()).is_none() || s.phase == PenPhase::Enter;
        let inherited = self.inherited.entry(s.device_id).or_insert(0);
        if fresh {
            *inherited = s.buttons & SIDE_BITS;
        } else {
            *inherited &= s.buttons;
        }
        let mut b = s.buttons & !*inherited;
        let eraser_ok = s.tool == ToolKind::Eraser && s.phase.in_contact();
        if !eraser_ok {
            b &= !button::ERASER;
        }
        b
    }
}

#[derive(Clone, Debug)]
struct Active {
    session: InkPointerSession,
    tool: ToolKind,
    last: Option<(f64, f64)>,
    count: usize,
}

pub struct PenPolicy {
    pub config: PenPolicyConfig,
    sanitizer: ButtonSanitizer,
    active: Option<Active>,
    last_pen_at: f64,
}

impl PenPolicy {
    pub fn new(config: PenPolicyConfig) -> Self {
        Self {
            config,
            sanitizer: ButtonSanitizer::default(),
            active: None,
            last_pen_at: 0.0,
        }
    }

    pub fn push(&mut self, mut s: PenSample) -> Vec<PenOutput> {
        let now = s.timestamp_ms;
        s.buttons = self.sanitizer.sanitize(&s);
        let ptype = s.tool.pointer_type();
        let identity = tablet_button_identity(ptype, -1, s.buttons, false);
        let action = self.config.buttons.action(identity);
        let mut out = Vec::new();
        let mk = |kind, s: &PenSample, point| PenOutput {
            kind,
            sample: s.clone(),
            point,
            action,
        };

        if ptype != "pen" {
            // A mapped stylus/pad button labelled "mouse" is not leftover trackpad.
            let mapped = tablet_button_identity(ptype, -1, s.buttons, true).is_some();
            let live = self
                .active
                .as_ref()
                .is_some_and(|a| a.session.pointer_id == s.device_id as f64);
            let reason =
                if !mapped && should_ignore_pointer_after_pen(Some(ptype), self.last_pen_at, now) {
                    Some(IgnoreReason::PostPenMouse)
                } else if !live && should_reject_non_pen_ink(Some(ptype), self.config.pen_only) {
                    Some(IgnoreReason::PenOnly)
                } else {
                    None
                };
            if let Some(r) = reason {
                out.push(mk(PenEventKind::Ignored(r), &s, None));
                return out;
            }
        } else {
            self.last_pen_at = now.max(f64::MIN_POSITIVE);
        }

        let id = s.device_id as f64;
        let incoming = InkPointerSample {
            pointer_id: id,
            pointer_type: Some(ptype.into()),
            buttons: s.buttons as f64,
            pressure: Some(s.pressure as f64),
        };

        if let Some(active) = &self.active {
            let same = active.session.pointer_id == id;
            let flip = s.tool.is_pen_like()
                && active.tool != s.tool
                && !matches!(s.phase, PenPhase::Leave | PenPhase::Cancel);
            if same && matches!(s.phase, PenPhase::Leave | PenPhase::Cancel) {
                let reason = if s.phase == PenPhase::Leave {
                    EndReason::Leave
                } else {
                    EndReason::Cancel
                };
                self.active = None;
                out.push(mk(PenEventKind::StrokeEnd(reason), &s, None));
                return out;
            }
            if flip
                && (same
                    || s.phase.in_contact()
                    || is_ink_tip_down(Some(ptype), s.buttons as f64, Some(s.pressure as f64)))
            {
                self.active = None;
                out.push(mk(PenEventKind::StrokeEnd(EndReason::ToolFlip), &s, None));
            } else if same {
                if should_hard_end_ink_pointer_session(Some(&active.session), now, Some(&incoming))
                {
                    let reason = if is_ink_tip_up(s.buttons as f64) {
                        EndReason::PenUp
                    } else {
                        EndReason::IdleLift
                    };
                    let point = self.map(&s).filter(|_| s.phase == PenPhase::Up);
                    self.active = None;
                    out.push(mk(PenEventKind::StrokeEnd(reason), &s, point));
                    if s.phase != PenPhase::Up {
                        out.push(mk(PenEventKind::Hover, &s, None));
                    }
                    return out;
                }
            } else if should_allow_new_ink_pointer(Some(&active.session), id, Some(ptype), now) {
                self.active = None;
                out.push(mk(PenEventKind::StrokeEnd(EndReason::Superseded), &s, None));
            } else {
                out.push(mk(
                    PenEventKind::Ignored(IgnoreReason::OtherPointer),
                    &s,
                    None,
                ));
                return out;
            }
        }

        let down = !matches!(s.phase, PenPhase::Leave | PenPhase::Cancel | PenPhase::Up)
            && is_ink_tip_down(Some(ptype), s.buttons as f64, Some(s.pressure as f64));
        if !down {
            if let Some(active) = &mut self.active {
                active.session = touch_ink_pointer_session(&active.session, &incoming, now);
            }
            out.push(mk(PenEventKind::Hover, &s, None));
            return out;
        }

        let Some(point) = self.map(&s) else {
            out.push(mk(
                PenEventKind::Ignored(IgnoreReason::OffSurface),
                &s,
                None,
            ));
            return out;
        };
        match &mut self.active {
            None => {
                self.active = Some(Active {
                    session: ink_pointer_session_from_sample(&incoming, now),
                    tool: s.tool,
                    last: Some((point.x, point.y)),
                    count: 1,
                });
                out.push(mk(PenEventKind::StrokeStart, &s, Some(point)));
            }
            Some(a) => {
                a.session = touch_ink_pointer_session(&a.session, &incoming, now);
                match classify_ink_jump_append(a.last, point.x, point.y, a.count) {
                    JumpAction::Start | JumpAction::Append => {
                        a.last = Some((point.x, point.y));
                        a.count += 1;
                        out.push(mk(PenEventKind::StrokeAppend, &s, Some(point)));
                    }
                    JumpAction::Restart => {
                        a.last = Some((point.x, point.y));
                        a.count = 1;
                        out.push(mk(PenEventKind::StrokeRestart, &s, Some(point)));
                    }
                    JumpAction::Skip => out.push(mk(PenEventKind::StrokeSkip, &s, None)),
                }
            }
        }
        out
    }

    /// Call periodically with the current clock; lifts an idle stroke without new samples.
    pub fn tick(&mut self, now_ms: f64) -> Option<EndReason> {
        let a = self.active.as_ref()?;
        if should_hard_end_ink_pointer_session(Some(&a.session), now_ms, None) {
            self.active = None;
            return Some(EndReason::IdleLift);
        }
        None
    }

    pub fn stroke_active(&self) -> bool {
        self.active.is_some()
    }

    fn map(&self, s: &PenSample) -> Option<MappedInkPoint> {
        let ev = PointerEvent {
            kind: None,
            client_x: Some(s.x),
            client_y: Some(s.y),
            time_stamp: Some(s.timestamp_ms),
            pressure: Some(s.pressure as f64),
            pointer_type: Some(s.tool.pointer_type().into()),
            tilt_x: Some(s.tilt_x as f64),
            tilt_y: Some(s.tilt_y as f64),
            predicted: false,
        };
        map_client_to_paper_point(&ev, self.config.surface.as_ref(), self.config.rotation)
    }
}

/// Identity of the active button on a sample, for callers that only want the id.
pub fn sample_button_identity(s: &PenSample) -> Option<TabletButtonId> {
    tablet_button_identity(s.tool.pointer_type(), -1, s.buttons, false)
}
