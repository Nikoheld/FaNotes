use fanotes_input::{
    append_accepted_ink_point, apply_wheel_ink_policy, classify_ink_jump_append,
    default_pen_only_for_platform, ink_pointer_session_from_sample, is_ink_corridor_leap,
    is_ink_tip_down, is_ink_tip_up, resolve_ink_finish_sample, resolve_ink_jump_append,
    resolve_ink_pointer_down, should_allow_new_ink_pointer, should_hard_end_ink_pointer_session,
    should_ignore_pointer_after_pen, should_reject_non_pen_ink, touch_ink_pointer_session,
    InkPointerSample, JumpAction, MappedInkPoint, PaperSurface, PointerEvent, INK_POINTER_IDLE_MS,
    POST_PEN_IGNORE_MS,
};

fn sample(
    pointer_id: f64,
    pointer_type: &str,
    buttons: f64,
    pressure: Option<f64>,
) -> InkPointerSample {
    InkPointerSample {
        pointer_id,
        pointer_type: Some(pointer_type.into()),
        buttons,
        pressure,
    }
}

fn pen(x: f64, y: f64) -> MappedInkPoint {
    MappedInkPoint {
        x,
        y,
        t: 0.0,
        pressure: 0.5,
        tilt_x: 0.0,
        tilt_y: 0.0,
        pointer_type: "pen".into(),
    }
}

fn surface(height: f64) -> PaperSurface {
    PaperSurface {
        left: 0.0,
        top: 0.0,
        width: 600.0,
        height: 800.0,
        offset_width: Some(900.0),
        offset_height: Some(height),
    }
}

fn client_at(surface: &PaperSurface, nx: f64, ny: f64, time_stamp: f64) -> PointerEvent {
    PointerEvent {
        kind: Some("pointermove".into()),
        client_x: Some(surface.left + nx * surface.width),
        client_y: Some(surface.top + ny * surface.height),
        time_stamp: Some(time_stamp),
        pressure: Some(0.5),
        pointer_type: Some("pen".into()),
        tilt_x: None,
        tilt_y: None,
        predicted: false,
    }
}

#[test]
fn tip_hover_idle_and_new_pointer_match_the_wacom_check() {
    let now = 10_000.0;
    let pen_down = ink_pointer_session_from_sample(&sample(7.0, "pen", 1.0, Some(0.55)), now);
    assert!(is_ink_tip_down(Some("pen"), 1.0, Some(0.55)));
    assert!(!is_ink_tip_down(Some("pen"), 0.0, Some(0.0)));
    assert!(
        !is_ink_tip_down(Some("pen"), 1.0, Some(0.0)),
        "stuck button hover is not tip-down"
    );
    assert!(is_ink_tip_down(Some("mouse"), 1.0, None));
    assert!(is_ink_tip_up(0.0));
    assert!(!is_ink_tip_up(1.0));
    assert!(!is_ink_tip_up(32.0));
    assert_eq!(INK_POINTER_IDLE_MS, 1600.0);

    assert!(should_hard_end_ink_pointer_session(
        Some(&pen_down),
        now + 16.0,
        Some(&sample(7.0, "pen", 0.0, Some(0.0))),
    ));
    assert!(should_hard_end_ink_pointer_session(
        Some(&pen_down),
        now + INK_POINTER_IDLE_MS + 1.0,
        None
    ));
    assert!(!should_hard_end_ink_pointer_session(
        Some(&pen_down),
        now + 40.0,
        Some(&sample(7.0, "pen", 1.0, Some(0.4))),
    ));
    assert!(!should_hard_end_ink_pointer_session(
        Some(&pen_down),
        now + 80.0,
        Some(&sample(7.0, "pen", 1.0, Some(0.0))),
    ));

    let mut writing = pen_down.clone();
    let mut elapsed = 16.0;
    while elapsed <= 4_800.0 {
        let pressure = if elapsed % 96.0 == 0.0 { 0.0 } else { 0.42 };
        let incoming = sample(7.0, "pen", 1.0, Some(pressure));
        writing = touch_ink_pointer_session(&writing, &incoming, now + elapsed);
        assert!(!should_hard_end_ink_pointer_session(
            Some(&writing),
            now + elapsed,
            Some(&incoming)
        ));
        elapsed += 16.0;
    }
    assert!(writing.last_contact_at > now);

    assert!(should_allow_new_ink_pointer(
        None,
        3.0,
        Some("mouse"),
        now + 30.0
    ));
    assert!(should_allow_new_ink_pointer(
        Some(&pen_down),
        3.0,
        Some("mouse"),
        now + 80.0
    ));
    assert!(!should_allow_new_ink_pointer(
        Some(&pen_down),
        9.0,
        Some("touch"),
        now + 80.0
    ));
    assert!(should_allow_new_ink_pointer(
        Some(&pen_down),
        9.0,
        Some("touch"),
        now + INK_POINTER_IDLE_MS + 5.0
    ));

    let hovered =
        touch_ink_pointer_session(&pen_down, &sample(7.0, "pen", 1.0, Some(0.0)), now + 12.0);
    assert_eq!(hovered.last_contact_at, now);
    assert!(!should_hard_end_ink_pointer_session(
        Some(&hovered),
        now + 12.0,
        Some(&sample(7.0, "pen", 1.0, Some(0.0)))
    ));
    assert!(should_hard_end_ink_pointer_session(
        Some(&hovered),
        now + INK_POINTER_IDLE_MS + 20.0,
        Some(&sample(7.0, "pen", 1.0, Some(0.0))),
    ));

    let pan = apply_wheel_ink_policy(false, false);
    assert!(pan.session.active_pointer_id.is_none());
    assert!(pan.allow_pan);

    let panned = PaperSurface {
        left: -80.0,
        top: -220.0,
        width: 600.0,
        height: 800.0,
        offset_width: Some(900.0),
        offset_height: Some(1273.0),
    };
    let ghost = PointerEvent {
        kind: Some("pointerdown".into()),
        client_x: Some(0.0),
        client_y: Some(0.0),
        time_stamp: Some(0.0),
        pressure: Some(0.45),
        pointer_type: Some("pen".into()),
        tilt_x: None,
        tilt_y: None,
        predicted: false,
    };
    let ghost_down = resolve_ink_pointer_down(&ghost, Some(&panned), 0.0);
    assert!(ghost_down.first_point.is_none());
    assert!(ghost_down.open_stroke);
    let mut after_ghost = Vec::new();
    append_accepted_ink_point(
        &mut after_ghost,
        &client_at(&panned, 0.22, 0.28, 130.0),
        Some(&panned),
        900.0,
        1273.0,
        0.0,
    );
    assert_eq!(after_ghost.len(), 1);
    assert!(after_ghost[0].y > 0.2);

    assert_eq!(
        resolve_ink_finish_sample(Some("pointermove"), Some(142.0), Some(388.0)),
        Some((142.0, 388.0))
    );
    assert_eq!(
        resolve_ink_finish_sample(Some("pointercancel"), Some(450.0), Some(636.0)),
        None
    );
    assert_eq!(
        resolve_ink_finish_sample(Some("lostpointercapture"), Some(450.0), Some(636.0)),
        None
    );
    assert_eq!(
        resolve_ink_finish_sample(Some("pointercancel"), None, None),
        None
    );
    assert_eq!(resolve_ink_finish_sample(None, None, None), None);
}

#[test]
fn jump_filter_and_post_pen_ignore_match_the_check() {
    let a4 = surface(1273.0);
    let mut points = Vec::new();
    append_accepted_ink_point(
        &mut points,
        &client_at(&a4, 0.2, 0.3, 16.0),
        Some(&a4),
        900.0,
        1273.0,
        0.0,
    );
    append_accepted_ink_point(
        &mut points,
        &client_at(&a4, 0.22, 0.31, 32.0),
        Some(&a4),
        900.0,
        1273.0,
        0.0,
    );
    assert_eq!(points.len(), 2);
    let jump = (points[1].x, points[1].y + 0.15);
    assert!(is_ink_corridor_leap(
        Some((points[1].x, points[1].y)),
        jump.0,
        jump.1
    ));
    let before = points.len();
    append_accepted_ink_point(
        &mut points,
        &client_at(&a4, 0.22, 0.31 + 0.15, 48.0),
        Some(&a4),
        900.0,
        1273.0,
        0.0,
    );
    assert_eq!(points.len(), before);

    let tall = surface(5_000.0);
    let mut mid = Vec::new();
    append_accepted_ink_point(
        &mut mid,
        &client_at(&tall, 0.4, 0.55, 80.0),
        Some(&tall),
        900.0,
        5_000.0,
        0.0,
    );
    assert_eq!(mid.len(), 1);
    assert!(mid[0].y > 0.5);
    append_accepted_ink_point(
        &mut mid,
        &client_at(&tall, 0.41, 0.01, 96.0),
        Some(&tall),
        900.0,
        5_000.0,
        0.0,
    );
    assert_eq!(mid.len(), 1);
    assert!(mid[0].y > 0.5);

    let mut restart = Vec::new();
    resolve_ink_jump_append(&mut restart, pen(0.2, 0.02));
    let action = resolve_ink_jump_append(&mut restart, pen(0.4, 0.4));
    assert_eq!(action, JumpAction::Restart);
    assert_eq!(restart.len(), 1);
    assert_eq!(restart[0].y, 0.4);
    assert_eq!(
        classify_ink_jump_append(Some((0.2, 0.02)), 0.4, 0.4, 1),
        JumpAction::Restart
    );

    let pen_at = 1_000.0;
    assert!(should_ignore_pointer_after_pen(
        Some("mouse"),
        pen_at,
        pen_at + 100.0
    ));
    assert!(should_ignore_pointer_after_pen(
        Some("touch"),
        pen_at,
        pen_at + 100.0
    ));
    assert!(!should_ignore_pointer_after_pen(
        Some("mouse"),
        pen_at,
        pen_at + 900.0
    ));
    assert!(!should_ignore_pointer_after_pen(
        Some("pen"),
        pen_at,
        pen_at + 100.0
    ));
    assert_eq!(POST_PEN_IGNORE_MS, 850.0);

    assert!(default_pen_only_for_platform(Some("win32")));
    assert!(!default_pen_only_for_platform(Some("linux")));
    assert!(should_reject_non_pen_ink(Some("touch"), true));
    assert!(!should_reject_non_pen_ink(Some("pen"), true));
}
