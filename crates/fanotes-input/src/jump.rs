use crate::map::MappedInkPoint;

pub const INK_JUMP_DY: f64 = 0.08;
pub const INK_JUMP_HYPOT: f64 = 0.12;
pub const INK_FIRST_POINT_RESTART_Y: f64 = 0.05;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JumpAction {
    Start,
    Append,
    Restart,
    Skip,
}

pub fn is_ink_corridor_leap(previous: Option<(f64, f64)>, next_x: f64, next_y: f64) -> bool {
    let Some((previous_x, previous_y)) = previous else {
        return false;
    };
    if previous_y >= INK_FIRST_POINT_RESTART_Y && next_y < INK_FIRST_POINT_RESTART_Y {
        return true;
    }
    if previous_x >= 0.5
        && next_x >= 0.45
        && next_y < INK_FIRST_POINT_RESTART_Y
        && previous_y >= 0.08
    {
        return true;
    }
    let dy = (next_y - previous_y).abs();
    dy > INK_JUMP_DY || hypot(next_x - previous_x, next_y - previous_y) > INK_JUMP_HYPOT
}

pub fn classify_ink_jump_append(
    previous: Option<(f64, f64)>,
    next_x: f64,
    next_y: f64,
    existing_count: usize,
) -> JumpAction {
    if previous.is_none() || existing_count == 0 {
        return JumpAction::Start;
    }
    if !is_ink_corridor_leap(previous, next_x, next_y) {
        return JumpAction::Append;
    }
    if existing_count == 1 && previous.is_some_and(|(_, y)| y < INK_FIRST_POINT_RESTART_Y) {
        return JumpAction::Restart;
    }
    JumpAction::Skip
}

pub fn resolve_ink_jump_append(
    points: &mut Vec<MappedInkPoint>,
    next: MappedInkPoint,
) -> JumpAction {
    let previous = points.last().map(|point| (point.x, point.y));
    let action = classify_ink_jump_append(previous, next.x, next.y, points.len());
    match action {
        JumpAction::Start | JumpAction::Append => points.push(next),
        JumpAction::Restart => {
            points.clear();
            points.push(next);
        }
        JumpAction::Skip => {}
    }
    action
}

fn hypot(x: f64, y: f64) -> f64 {
    x.hypot(y)
}
