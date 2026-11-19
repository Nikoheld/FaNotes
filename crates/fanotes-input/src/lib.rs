//! Pen and pointer policy shared by every host.
//!
//! The host fills [`PointerSample`]. These functions decide tip versus hover,
//! the 1600 ms idle lift, the 850 ms post-pen ignore window, and whether a
//! sample is a corridor jump.

pub mod backend;
mod jump;
mod map;
mod pen_policy;
mod policy;
mod sample;
mod session;
mod tablet_buttons;

pub use jump::{
    classify_ink_jump_append, is_ink_corridor_leap, resolve_ink_jump_append, JumpAction,
    INK_FIRST_POINT_RESTART_Y, INK_JUMP_DY, INK_JUMP_HYPOT,
};
pub use map::{
    append_accepted_ink_point, map_client_to_paper_point, resolve_ink_finish_sample,
    resolve_ink_pointer_down, MappedInkPoint, PaperSurface, PointerEvent,
};
pub use pen_policy::{
    sample_button_identity, ButtonSanitizer, EndReason, IgnoreReason, PenEventKind, PenOutput,
    PenPolicy, PenPolicyConfig,
};
pub use policy::{
    apply_pen_up_ink_cleanup, apply_wheel_ink_policy, default_pen_only_for_platform,
    empty_ink_input_session, should_ignore_pointer_after_pen, should_reject_non_pen_ink,
    InkInputSession, WheelPolicy, POST_PEN_IGNORE_MS,
};
pub use sample::{
    button, PenError, PenPhase, PenSample, PenSource, PhaseTracker, ReplaySource, TimeUnwrap,
    ToolKind,
};
pub use session::{
    ink_pointer_session_from_sample, is_ink_tip_down, is_ink_tip_up, should_allow_new_ink_pointer,
    should_hard_end_ink_pointer_session, touch_ink_pointer_session, InkPointerSample,
    InkPointerSession, INK_POINTER_IDLE_MS,
};
pub use tablet_buttons::{
    tablet_button_identity, TabletButtonAction, TabletButtonId, TabletButtonMap,
    DEFAULT_TABLET_BUTTON_ACTIONS,
};
