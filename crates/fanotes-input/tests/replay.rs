//! Replay tests: synthesized raw event sequences per backend become expected
//! `PenSample` streams, and the shared policy runs over them.

use fanotes_input::backend::wayland::*;
use fanotes_input::backend::windows::*;
use fanotes_input::backend::x11::*;
use fanotes_input::{
    button, EndReason, IgnoreReason, PaperSurface, PenEventKind as K, PenPhase as P, PenPolicy,
    PenPolicyConfig, PenSample, TabletButtonAction as A, ToolKind,
};

fn policy() -> PenPolicy {
    PenPolicy::new(PenPolicyConfig {
        surface: Some(PaperSurface {
            left: 0.0,
            top: 0.0,
            width: 1000.0,
            height: 1000.0,
            offset_width: None,
            offset_height: None,
        }),
        ..Default::default()
    })
}

fn kinds(p: &mut PenPolicy, samples: &[PenSample]) -> Vec<K> {
    samples
        .iter()
        .flat_map(|s| p.push(s.clone()))
        .map(|o| o.kind)
        .collect()
}

fn phases(s: &[PenSample]) -> Vec<P> {
    s.iter().map(|s| s.phase).collect()
}

// ---------------------------------------------------------------- Wayland

fn wl_run(events: &[(u64, WlToolEvent)]) -> Vec<PenSample> {
    let mut t = WaylandTranslator::new();
    let mut out = Vec::new();
    for (id, e) in events {
        t.push(*id, e, &mut out);
    }
    out
}

fn wl_stroke(tool: u64, ty: WlToolType, t0: u32) -> Vec<(u64, WlToolEvent)> {
    use WlToolEvent::*;
    vec![
        (tool, Type(ty)),
        (tool, ProximityIn { on_surface: true }),
        (tool, Motion { x: 100.0, y: 100.0 }),
        (tool, Frame { time: t0 }),
        (tool, Down),
        (tool, Pressure(32768)),
        (tool, Tilt { x: 20.0, y: -10.0 }),
        (tool, Motion { x: 101.0, y: 100.0 }),
        (tool, Frame { time: t0 + 4 }),
        (tool, Motion { x: 102.0, y: 100.5 }),
        (tool, Pressure(65535)),
        (tool, Frame { time: t0 + 8 }),
        (tool, Up),
        (tool, Pressure(0)),
        (tool, Frame { time: t0 + 12 }),
        (tool, ProximityOut),
        (tool, Frame { time: t0 + 16 }),
    ]
}

#[test]
fn wayland_frame_grouping_and_axes() {
    let s = wl_run(&wl_stroke(7, WlToolType::Pen, 1000));
    // Events between frames collapse into one sample per frame.
    assert_eq!(phases(&s), [P::Enter, P::Down, P::Move, P::Up, P::Leave]);
    assert_eq!(s[1].timestamp_ms, 1004.0);
    assert!((s[1].pressure - 0.5).abs() < 1e-4);
    assert_eq!((s[1].tilt_x, s[1].tilt_y), (20.0, -10.0));
    assert_eq!((s[1].x, s[1].y), (101.0, 100.0));
    assert_eq!(s[1].buttons, button::TIP);
    assert_eq!(s[2].pressure, 1.0);
    assert_eq!(s[3].pressure, 0.0);
    assert_eq!(s[3].buttons, 0);
    assert!(s
        .iter()
        .all(|x| x.tool == ToolKind::Pen && !x.eraser && x.device_id == 7));
}

#[test]
fn wayland_no_frame_no_sample_and_other_surface_ignored() {
    use WlToolEvent::*;
    let s = wl_run(&[
        (1, Type(WlToolType::Pen)),
        (1, ProximityIn { on_surface: true }),
        (1, Motion { x: 1.0, y: 2.0 }),
    ]);
    assert!(s.is_empty());
    let s = wl_run(&[
        (1, Type(WlToolType::Pen)),
        (1, ProximityIn { on_surface: false }),
        (1, Down),
        (1, Motion { x: 1.0, y: 2.0 }),
        (1, Frame { time: 5 }),
        (1, ProximityOut),
        (1, Frame { time: 9 }),
    ]);
    assert!(s.is_empty());
}

#[test]
fn wayland_timestamp_wraps() {
    use WlToolEvent::*;
    let s = wl_run(&[
        (1, Type(WlToolType::Pen)),
        (1, ProximityIn { on_surface: true }),
        (1, Motion { x: 1.0, y: 1.0 }),
        (1, Frame { time: u32::MAX - 2 }),
        (1, Motion { x: 2.0, y: 1.0 }),
        (1, Frame { time: 3 }),
    ]);
    assert!(s[1].timestamp_ms > s[0].timestamp_ms);
    assert_eq!(s[1].timestamp_ms - s[0].timestamp_ms, 6.0);
}

#[test]
fn wayland_barrel_held_while_moving() {
    use WlToolEvent::*;
    let ev = vec![
        (1, Type(WlToolType::Pen)),
        (1, ProximityIn { on_surface: true }),
        (1, Motion { x: 500.0, y: 500.0 }),
        (1, Frame { time: 0 }),
        (1, Down),
        (1, Pressure(30000)),
        (1, Frame { time: 4 }),
        (
            1,
            Button {
                code: BTN_STYLUS,
                pressed: true,
            },
        ),
        (1, Frame { time: 8 }),
        (1, Motion { x: 510.0, y: 500.0 }),
        (1, Frame { time: 12 }),
        (1, Motion { x: 520.0, y: 500.0 }),
        (1, Frame { time: 16 }),
        (
            1,
            Button {
                code: BTN_STYLUS,
                pressed: false,
            },
        ),
        (1, Frame { time: 20 }),
        (1, Up),
        (1, Frame { time: 24 }),
    ];
    let s = wl_run(&ev);
    let b: Vec<u32> = s.iter().map(|s| s.buttons).collect();
    let held = button::TIP | button::BARREL;
    assert_eq!(b, [0, button::TIP, held, held, held, button::TIP, 0]);
    // Policy: the stroke keeps running while the barrel is held; its action is the default (eraser).
    let mut p = policy();
    let outs: Vec<_> = s.iter().flat_map(|x| p.push(x.clone())).collect();
    let k: Vec<K> = outs.iter().map(|o| o.kind).collect();
    assert_eq!(
        k,
        [
            K::Hover,
            K::StrokeStart,
            K::StrokeAppend,
            K::StrokeAppend,
            K::StrokeAppend,
            K::StrokeAppend,
            K::StrokeEnd(EndReason::PenUp)
        ]
    );
    assert_eq!(outs[2].action, A::Eraser);
    assert_eq!(outs[3].action, A::Eraser);
    assert_eq!(outs[1].action, A::Ink);
}

#[test]
fn wayland_eraser_end_flip() {
    // Pen tip stroke, leave, then the eraser tool (a second tool object) enters.
    let mut ev = wl_stroke(1, WlToolType::Pen, 0);
    ev.extend(wl_stroke(2, WlToolType::Eraser, 100));
    let s = wl_run(&ev);
    let er: Vec<_> = s.iter().filter(|x| x.device_id == 2).collect();
    assert!(er.iter().all(|x| x.tool == ToolKind::Eraser && x.eraser));
    assert_eq!(er[1].buttons, button::ERASER);
    let mut p = policy();
    let k = kinds(&mut p, &s);
    let starts = k.iter().filter(|k| **k == K::StrokeStart).count();
    assert_eq!(starts, 2);
    let ends = k.iter().filter(|k| matches!(k, K::StrokeEnd(_))).count();
    assert_eq!(ends, 2);
}

#[test]
fn eraser_flip_without_leave_ends_stroke() {
    // Drivers that swap ends without a proximity out: same stroke must not continue.
    let base = PenSample {
        phase: P::Down,
        x: 400.0,
        y: 400.0,
        pressure: 0.5,
        tilt_x: 0.0,
        tilt_y: 0.0,
        rotation: 0.0,
        buttons: button::TIP,
        tool: ToolKind::Pen,
        eraser: false,
        timestamp_ms: 10.0,
        device_id: 1,
    };
    let mut p = policy();
    let a = p.push(base.clone());
    assert_eq!(a[0].kind, K::StrokeStart);
    let flipped = PenSample {
        phase: P::Move,
        tool: ToolKind::Eraser,
        eraser: true,
        buttons: button::ERASER,
        timestamp_ms: 14.0,
        x: 401.0,
        ..base
    };
    let b = p.push(flipped);
    assert_eq!(b[0].kind, K::StrokeEnd(EndReason::ToolFlip));
    assert_eq!(b[1].kind, K::StrokeStart);
    assert_eq!(b[1].action, A::Eraser);
}

// -------------------------------------------------------------------- X11

fn wacom() -> Vec<XiDevice> {
    let axes = |_: ()| {
        vec![
            XiAxis {
                number: 0,
                label: "Abs X".into(),
                min: 0.0,
                max: 44800.0,
            },
            XiAxis {
                number: 1,
                label: "Abs Y".into(),
                min: 0.0,
                max: 29600.0,
            },
            XiAxis {
                number: 2,
                label: "Abs Pressure".into(),
                min: 0.0,
                max: 2047.0,
            },
            XiAxis {
                number: 3,
                label: "Abs Tilt X".into(),
                min: -64.0,
                max: 63.0,
            },
            XiAxis {
                number: 4,
                label: "Abs Tilt Y".into(),
                min: -64.0,
                max: 63.0,
            },
        ]
    };
    vec![
        XiDevice {
            id: 10,
            name: "Wacom Intuos Pro M Pen stylus".into(),
            axes: axes(()),
        },
        XiDevice {
            id: 11,
            name: "Wacom Intuos Pro M Pen eraser".into(),
            axes: axes(()),
        },
        XiDevice {
            id: 12,
            name: "Wacom Intuos Pro M Pad pad".into(),
            axes: vec![],
        },
    ]
}

fn xi(
    source: u16,
    time: u32,
    kind: XiKind,
    x: f64,
    y: f64,
    mask: u32,
    v: &[(u16, f64)],
) -> XiEvent {
    XiEvent {
        source,
        time,
        kind,
        x,
        y,
        button_mask: mask,
        valuators: v.to_vec(),
    }
}
const B1: u32 = 1 << 1;
const B3: u32 = 1 << 3;

fn x_run(events: &[XiEvent]) -> Vec<PenSample> {
    let mut t = X11Translator::new();
    for d in wacom() {
        t.add_device(d);
    }
    let mut out = Vec::new();
    for e in events {
        t.push(e, &mut out);
    }
    out
}

#[test]
fn x11_valuators_sparse_and_tilt_mapping() {
    use XiKind::*;
    let s = x_run(&[
        xi(
            10,
            100,
            Motion,
            50.0,
            60.0,
            0,
            &[(2, 0.0), (3, -64.0), (4, 63.0)],
        ),
        xi(10, 104, ButtonPress(1), 50.0, 60.0, B1, &[(2, 1023.5)]),
        // Only x changed in valuators; pressure and tilt persist from earlier events.
        xi(10, 108, Motion, 52.0, 60.0, B1, &[(0, 1.0)]),
        xi(10, 112, ButtonRelease(1), 52.0, 60.0, 0, &[(2, 0.0)]),
    ]);
    assert_eq!(phases(&s), [P::Enter, P::Down, P::Move, P::Up]);
    assert_eq!(s[0].pressure, 0.0);
    assert!((s[1].pressure - 0.5).abs() < 1e-3);
    assert!((s[2].pressure - 0.5).abs() < 1e-3);
    assert_eq!(s[3].pressure, 0.0);
    assert!((s[0].tilt_x + 60.0).abs() < 1e-3, "{}", s[0].tilt_x);
    assert!((s[0].tilt_y - 60.0).abs() < 1.0, "{}", s[0].tilt_y);
    assert_eq!(s[1].buttons, button::TIP);
    assert_eq!(s[2].x, 52.0);
}

#[test]
fn x11_barrel_held_while_moving_and_eraser_device() {
    use XiKind::*;
    let s = x_run(&[
        xi(10, 0, Motion, 10.0, 10.0, 0, &[(2, 0.0)]),
        xi(10, 4, ButtonPress(1), 10.0, 10.0, B1, &[(2, 900.0)]),
        xi(10, 8, ButtonPress(3), 11.0, 10.0, B1 | B3, &[]),
        xi(10, 12, Motion, 12.0, 10.0, B1 | B3, &[(2, 1000.0)]),
        xi(10, 16, Motion, 13.0, 10.0, B1 | B3, &[]),
        xi(10, 20, ButtonRelease(3), 13.0, 10.0, B1, &[]),
        xi(11, 400, Motion, 20.0, 20.0, 0, &[(2, 0.0)]),
        xi(11, 404, ButtonPress(1), 20.0, 20.0, B1, &[(2, 500.0)]),
    ]);
    let barrel: Vec<bool> = s[..6]
        .iter()
        .map(|x| x.buttons & button::BARREL != 0)
        .collect();
    assert_eq!(barrel, [false, false, true, true, true, false]);
    assert_eq!(
        phases(&s[..6]),
        [P::Enter, P::Down, P::Move, P::Move, P::Move, P::Move]
    );
    // The eraser slave: gap leave for the pen (device 10), then eraser samples.
    let er: Vec<_> = s.iter().filter(|x| x.device_id == 11).collect();
    assert!(er.iter().all(|x| x.eraser && x.tool == ToolKind::Eraser));
    assert_eq!(er[1].buttons, button::ERASER);
}

#[test]
fn x11_pad_device_ignored_and_time_gap_leaves() {
    use XiKind::*;
    let s = x_run(&[
        xi(12, 1, ButtonPress(1), 0.0, 0.0, B1, &[]),
        xi(10, 100, Motion, 1.0, 1.0, 0, &[(2, 0.0)]),
        xi(10, 700, Motion, 2.0, 1.0, 0, &[(2, 0.0)]),
    ]);
    assert_eq!(phases(&s), [P::Enter, P::Leave, P::Enter]);
    let mut t = X11Translator::new();
    for d in wacom() {
        t.add_device(d);
    }
    let mut out = Vec::new();
    t.push(&xi(10, 100, Motion, 1.0, 1.0, 0, &[(2, 0.0)]), &mut out);
    t.tick(100.0 + PROXIMITY_TIMEOUT_MS + 1.0, &mut out);
    assert_eq!(phases(&out), [P::Enter, P::Leave]);
}

/// The Wacom stuck-bit case: the barrel release was lost when the pen left, so the
/// next proximity reports the bit as held. It must not count as pressed until released
/// once, and a stuck eraser bit on the pen end must not turn into tip-down.
#[test]
fn x11_stuck_button_bit_is_masked_until_released() {
    use XiKind::*;
    let mut ev = vec![
        xi(10, 0, Motion, 100.0, 100.0, 0, &[(2, 0.0)]),
        xi(10, 4, ButtonPress(1), 100.0, 100.0, B1, &[(2, 800.0)]),
        xi(10, 8, ButtonPress(3), 101.0, 100.0, B1 | B3, &[]),
        xi(10, 12, Motion, 102.0, 100.0, B1 | B3, &[]),
        xi(10, 16, ButtonRelease(1), 102.0, 100.0, B3, &[(2, 0.0)]),
        // Pen leaves; the server never delivers the barrel release.
        // Back 2 s later with the stale bit.
        xi(10, 2000, Motion, 300.0, 300.0, B3, &[(2, 0.0)]),
        xi(
            10,
            2004,
            ButtonPress(1),
            300.0,
            300.0,
            B1 | B3,
            &[(2, 700.0)],
        ),
        xi(10, 2008, Motion, 301.0, 300.0, B1 | B3, &[]),
        xi(10, 2012, ButtonRelease(1), 301.0, 300.0, B3, &[(2, 0.0)]),
        xi(10, 2016, Motion, 301.0, 300.0, 0, &[]),
        // Now genuinely pressed again.
        xi(10, 2020, Motion, 301.0, 300.0, B3, &[]),
    ];
    let s = x_run(&ev);
    let mut p = policy();
    let outs: Vec<_> = s.iter().flat_map(|x| p.push(x.clone())).collect();
    let in_second: Vec<_> = outs
        .iter()
        .filter(|o| o.sample.timestamp_ms >= 2000.0)
        .collect();
    // While stale, the barrel does not reach the policy: action stays Ink.
    assert!(in_second[..in_second.len() - 1]
        .iter()
        .all(|o| o.sample.buttons & button::BARREL == 0));
    assert!(in_second[1..4]
        .iter()
        .all(|o| o.action == A::Ink || o.action == A::Os));
    // The stroke in the second proximity starts normally.
    assert!(in_second.iter().any(|o| o.kind == K::StrokeStart));
    // After release and a fresh press the bit is honoured.
    assert!(in_second.last().unwrap().sample.buttons & button::BARREL != 0);
    ev.clear();
}

#[test]
fn stuck_eraser_bit_on_pen_tool_does_not_force_tip_down() {
    let mut p = policy();
    let mut s = PenSample {
        phase: P::Hover,
        x: 500.0,
        y: 500.0,
        pressure: 0.0,
        tilt_x: 0.0,
        tilt_y: 0.0,
        rotation: 0.0,
        buttons: button::ERASER,
        tool: ToolKind::Pen,
        eraser: false,
        timestamp_ms: 1.0,
        device_id: 3,
    };
    assert_eq!(p.push(s.clone())[0].kind, K::Hover);
    s.timestamp_ms = 5.0;
    s.x = 501.0;
    assert_eq!(p.push(s)[0].kind, K::Hover);
    assert!(!p.stroke_active());
}

// ---------------------------------------------------------------- Windows

fn win(flags: u32, pen_flags: u32, pressure: u32, t: u32, x: i32) -> WinPointerRaw {
    WinPointerRaw {
        kind: WinPointerKind::Pen,
        pointer_id: 1,
        device: 0xD1,
        flags,
        pen_flags,
        pen_mask: PEN_MASK_PRESSURE | PEN_MASK_TILT_X | PEN_MASK_TILT_Y | PEN_MASK_ROTATION,
        pressure,
        rotation: 370,
        tilt_x: 25,
        tilt_y: -30,
        time_ms: t,
        perf_us: 0,
        pixel: (x, 200),
        himetric_raw: (0, 0),
        rects: None,
    }
}
const IN: u32 = POINTER_FLAG_INRANGE;
const CT: u32 = POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_FIRSTBUTTON;

#[test]
fn windows_history_full_rate_hover_and_contact() {
    let mut t = WindowsTranslator::new();
    t.client_origin = (100.0, 50.0);
    let mut out = Vec::new();
    t.push(WinMsg::Enter, &[win(IN, 0, 0, 1000, 300)], 0xD1, &mut out);
    t.push(WinMsg::Update, &[win(IN, 0, 0, 1008, 301)], 0xD1, &mut out);
    t.push(WinMsg::Down, &[win(CT, 0, 512, 1016, 302)], 0xD1, &mut out);
    // One frame delivered four 2 ms samples; all of them survive, oldest first.
    let hist: Vec<_> = (0..4)
        .map(|i| win(CT, 0, 600 + i * 100, 1020 + i * 2, 310 + i as i32))
        .collect();
    t.push(WinMsg::Update, &hist, 0xD1, &mut out);
    t.push(WinMsg::Up, &[win(IN, 0, 0, 1030, 320)], 0xD1, &mut out);
    t.push(WinMsg::Leave, &[], 0xD1, &mut out);
    assert_eq!(
        phases(&out),
        [
            P::Enter,
            P::Hover,
            P::Down,
            P::Move,
            P::Move,
            P::Move,
            P::Move,
            P::Up,
            P::Leave
        ]
    );
    assert_eq!(out[0].x, 200.0);
    assert_eq!(out[0].y, 150.0);
    assert_eq!(out[0].pressure, 0.0);
    assert!((out[2].pressure - 0.5).abs() < 1e-6);
    assert_eq!(out[2].buttons, button::TIP);
    assert_eq!(out[0].buttons, 0);
    let ts: Vec<f64> = out[3..7].iter().map(|s| s.timestamp_ms).collect();
    assert_eq!(ts, [1020.0, 1022.0, 1024.0, 1026.0]);
    assert_eq!(
        (out[2].tilt_x, out[2].tilt_y, out[2].rotation),
        (25.0, -30.0, 10.0)
    );
}

#[test]
fn windows_barrel_held_inverted_and_eraser_flip() {
    let mut t = WindowsTranslator::new();
    let mut out = Vec::new();
    let pen_down = [
        win(CT, PEN_FLAG_BARREL, 400, 10, 10),
        win(CT, PEN_FLAG_BARREL, 450, 14, 12),
    ];
    t.push(WinMsg::Down, &pen_down[..1], 0xD1, &mut out);
    t.push(WinMsg::Update, &pen_down[1..], 0xD1, &mut out);
    // Flip: the eraser end arrives with INVERTED, no leave in between.
    t.push(
        WinMsg::Update,
        &[win(CT, PEN_FLAG_INVERTED, 300, 18, 14)],
        0xD1,
        &mut out,
    );
    assert!(out[..2]
        .iter()
        .all(|s| s.buttons == (button::TIP | button::BARREL) && !s.eraser));
    assert!(out[2].eraser && out[2].tool == ToolKind::Eraser);
    assert_eq!(out[2].buttons, button::ERASER);
    let mut p = policy();
    let k = kinds(&mut p, &out);
    assert_eq!(k[0], K::StrokeStart);
    assert_eq!(k[1], K::StrokeAppend);
    assert_eq!(k[2], K::StrokeEnd(EndReason::ToolFlip));
    assert_eq!(k[3], K::StrokeStart);
}

#[test]
fn windows_subpixel_position_perf_clock_and_cancel() {
    let mut t = WindowsTranslator::new();
    let mut out = Vec::new();
    let mut r = win(IN, 0, 0, 0, 0);
    r.perf_us = 5_000_000;
    r.himetric_raw = (5000, 2500);
    r.rects = Some(WinRects {
        device: [0, 0, 10000, 5000],
        display: [0, 0, 1920, 1080],
    });
    t.push(WinMsg::Update, &[r.clone()], 0xD1, &mut out);
    assert!((out[0].x - 960.0).abs() < 1e-9 && (out[0].y - 540.0).abs() < 1e-9);
    assert_eq!(out[0].timestamp_ms, 5000.0);
    let mut c = r;
    c.flags = CT;
    t.push(WinMsg::Down, &[c], 0xD1, &mut out);
    t.push(WinMsg::CaptureChanged, &[], 0xD1, &mut out);
    assert_eq!(out.last().unwrap().phase, P::Cancel);
    // No pressure axis in the mask: nominal contact pressure, not zero.
    let mut np = win(CT, 0, 0, 1, 1);
    np.pen_mask = 0;
    let mut t2 = WindowsTranslator::new();
    let mut o2 = Vec::new();
    t2.push(WinMsg::Down, &[np], 0xD1, &mut o2);
    assert_eq!(o2[0].pressure, 0.5);
}

// ------------------------------------------------------------ shared policy

fn s(phase: P, x: f64, y: f64, pressure: f32, buttons: u32, t: f64) -> PenSample {
    PenSample {
        phase,
        x,
        y,
        pressure,
        tilt_x: 0.0,
        tilt_y: 0.0,
        rotation: 0.0,
        buttons,
        tool: ToolKind::Pen,
        eraser: false,
        timestamp_ms: t,
        device_id: 1,
    }
}

#[test]
fn policy_zero_pressure_contact_is_hover_then_idle_lift() {
    let mut p = policy();
    assert_eq!(
        p.push(s(P::Down, 500.0, 500.0, 0.4, button::TIP, 1.0))[0].kind,
        K::StrokeStart
    );
    // Contact bit set but pressure 0: not tip-down, stroke stays open.
    assert_eq!(
        p.push(s(P::Move, 501.0, 500.0, 0.0, button::TIP, 400.0))[0].kind,
        K::Hover
    );
    assert!(p.stroke_active());
    assert_eq!(p.tick(1500.0), None);
    // 1600 ms after the last real contact the stroke lifts.
    assert_eq!(p.tick(1.0 + 1600.0), Some(EndReason::IdleLift));
    assert!(!p.stroke_active());
    // Same via a sample instead of a tick.
    let mut p = policy();
    p.push(s(P::Down, 500.0, 500.0, 0.4, button::TIP, 1.0));
    let o = p.push(s(P::Move, 501.0, 500.0, 0.0, button::TIP, 1700.0));
    assert_eq!(o[0].kind, K::StrokeEnd(EndReason::IdleLift));
}

#[test]
fn policy_hover_never_starts_a_stroke() {
    let mut p = policy();
    for (i, ph) in [P::Enter, P::Hover, P::Hover].into_iter().enumerate() {
        assert_eq!(
            p.push(s(ph, 500.0, 500.0, 0.0, 0, i as f64))[0].kind,
            K::Hover
        );
    }
}

#[test]
fn policy_post_pen_mouse_ignore_window() {
    let mut p = policy();
    p.push(s(P::Hover, 500.0, 500.0, 0.0, 0, 1000.0));
    let mut mouse = s(P::Down, 500.0, 500.0, 0.5, button::TIP, 1849.0);
    mouse.tool = ToolKind::Mouse;
    mouse.device_id = 99;
    assert_eq!(
        p.push(mouse.clone())[0].kind,
        K::Ignored(IgnoreReason::PostPenMouse)
    );
    mouse.timestamp_ms = 1850.0;
    assert_eq!(p.push(mouse.clone())[0].kind, K::StrokeStart);
    // A mapped stylus button labelled mouse (pad key 1) is not dropped inside the window.
    let mut p = policy();
    p.push(s(P::Hover, 500.0, 500.0, 0.0, 0, 1000.0));
    let mut pad = s(P::Hover, 500.0, 500.0, 0.0, 0, 1090.0);
    pad.tool = ToolKind::Mouse;
    pad.device_id = 99;
    assert_eq!(
        p.push(pad.clone())[0].kind,
        K::Ignored(IgnoreReason::PostPenMouse)
    );
    pad.buttons = button::BACK;
    pad.timestamp_ms = 1100.0;
    assert_ne!(p.push(pad)[0].kind, K::Ignored(IgnoreReason::PostPenMouse));
}

#[test]
fn policy_pen_only_rejects_mouse() {
    let mut p = policy();
    p.config.pen_only = true;
    let mut m = s(P::Down, 500.0, 500.0, 0.5, button::TIP, 5000.0);
    m.tool = ToolKind::Mouse;
    assert_eq!(p.push(m)[0].kind, K::Ignored(IgnoreReason::PenOnly));
}

#[test]
fn policy_jump_filter() {
    let mut p = policy();
    let k = kinds(
        &mut p,
        &[
            s(P::Down, 500.0, 500.0, 0.5, button::TIP, 1.0),
            s(P::Move, 510.0, 500.0, 0.5, button::TIP, 5.0),
            // 300 px = 0.3 of the paper: corridor leap, skipped.
            s(P::Move, 510.0, 800.0, 0.5, button::TIP, 9.0),
            s(P::Move, 520.0, 500.0, 0.5, button::TIP, 13.0),
        ],
    );
    assert_eq!(
        k,
        [
            K::StrokeStart,
            K::StrokeAppend,
            K::StrokeSkip,
            K::StrokeAppend
        ]
    );
}

#[test]
fn policy_button_map_is_data() {
    use fanotes_input::TabletButtonMap;
    let mut p = policy();
    p.config.buttons = TabletButtonMap::from_pairs([("pen-barrel", "undo"), ("junk", "pan")]);
    // A button already down on the first sample is stale; the press must be seen in range.
    p.push(s(P::Enter, 500.0, 500.0, 0.0, 0, 0.5));
    let o = p.push(s(
        P::Down,
        500.0,
        500.0,
        0.5,
        button::TIP | button::BARREL,
        1.0,
    ));
    assert_eq!(o[0].action, A::Undo);
}
