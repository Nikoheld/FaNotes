//! Win32 `WM_POINTER*` I/O (feature `windows`, `cfg(windows)`). Subclasses a given HWND,
//! reads the full-rate sample history with `GetPointerPenInfoHistory` and feeds
//! [`WindowsTranslator`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Input::Pointer::{
    EnableMouseInPointer, GetPointerDeviceRects, GetPointerInfo, GetPointerPenInfoHistory,
    GetPointerType, POINTER_FLAG_CANCELED, POINTER_FLAG_FIFTHBUTTON, POINTER_FLAG_FOURTHBUTTON,
    POINTER_FLAG_INCONTACT, POINTER_FLAG_INRANGE, POINTER_FLAG_SECONDBUTTON,
    POINTER_FLAG_THIRDBUTTON, POINTER_INFO, POINTER_PEN_INFO,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    PEN_FLAG_BARREL, PEN_FLAG_ERASER, PEN_FLAG_INVERTED, PEN_MASK_PRESSURE, PEN_MASK_ROTATION,
    PEN_MASK_TILT_X, PEN_MASK_TILT_Y, POINTER_INPUT_TYPE, PT_MOUSE, PT_PEN, PT_TOUCH,
    WM_POINTERCAPTURECHANGED, WM_POINTERDOWN, WM_POINTERENTER, WM_POINTERLEAVE, WM_POINTERUP,
    WM_POINTERUPDATE,
};

use super::windows::*;
use crate::{PenError, PenSample, PenSource};

// The translator's constants are written out so it compiles everywhere; check them here.
const _: () = {
    assert!(POINTER_FLAG_INRANGE.0 == super::windows::POINTER_FLAG_INRANGE);
    assert!(POINTER_FLAG_INCONTACT.0 == super::windows::POINTER_FLAG_INCONTACT);
    assert!(POINTER_FLAG_SECONDBUTTON.0 == super::windows::POINTER_FLAG_SECONDBUTTON);
    assert!(POINTER_FLAG_THIRDBUTTON.0 == super::windows::POINTER_FLAG_THIRDBUTTON);
    assert!(POINTER_FLAG_FOURTHBUTTON.0 == super::windows::POINTER_FLAG_FOURTHBUTTON);
    assert!(POINTER_FLAG_FIFTHBUTTON.0 == super::windows::POINTER_FLAG_FIFTHBUTTON);
    assert!(POINTER_FLAG_CANCELED.0 == super::windows::POINTER_FLAG_CANCELED);
    assert!(PEN_FLAG_BARREL == super::windows::PEN_FLAG_BARREL);
    assert!(PEN_FLAG_INVERTED == super::windows::PEN_FLAG_INVERTED);
    assert!(PEN_FLAG_ERASER == super::windows::PEN_FLAG_ERASER);
    assert!(PEN_MASK_PRESSURE == super::windows::PEN_MASK_PRESSURE);
    assert!(PEN_MASK_ROTATION == super::windows::PEN_MASK_ROTATION);
    assert!(PEN_MASK_TILT_X == super::windows::PEN_MASK_TILT_X);
    assert!(PEN_MASK_TILT_Y == super::windows::PEN_MASK_TILT_Y);
};

#[derive(Clone, Copy, Debug, Default)]
pub struct WindowsPenOptions {
    /// Swallow handled pointer messages instead of forwarding them to the window's
    /// original procedure. Swallowing stops Windows from synthesising legacy mouse
    /// messages from the pen.
    pub consume: bool,
    /// Call `EnableMouseInPointer(true)` so mice also arrive as pointer messages (process-wide).
    pub mouse_in_pointer: bool,
}

struct Shared {
    translator: WindowsTranslator,
    queue: Vec<PenSample>,
    devices: HashMap<u32, u64>,
    consume: bool,
}

pub struct WindowsPen {
    hwnd: HWND,
    shared: Arc<Mutex<Shared>>,
    raw: *mut Arc<Mutex<Shared>>,
}

// The subclass id; one per process is enough for this crate.
const SUBCLASS_ID: usize = 0xFA_5E_17;

unsafe impl Send for WindowsPen {}

impl WindowsPen {
    /// Attach to `hwnd`. Must be called on the thread that owns the window; samples are
    /// produced from that thread's message loop and drained with [`PenSource::poll`].
    pub fn attach(hwnd: isize, options: WindowsPenOptions) -> Result<Self, PenError> {
        let hwnd = HWND(hwnd as *mut _);
        if options.mouse_in_pointer {
            unsafe { EnableMouseInPointer(true) }
                .map_err(|e| PenError::Unavailable(e.to_string()))?;
        }
        let shared = Arc::new(Mutex::new(Shared {
            translator: WindowsTranslator::new(),
            queue: Vec::new(),
            devices: HashMap::new(),
            consume: options.consume,
        }));
        let raw = Box::into_raw(Box::new(shared.clone()));
        let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, raw as usize) };
        if !ok.as_bool() {
            drop(unsafe { Box::from_raw(raw) });
            return Err(PenError::Unavailable("SetWindowSubclass failed".into()));
        }
        Ok(Self { hwnd, shared, raw })
    }
}

impl Drop for WindowsPen {
    fn drop(&mut self) {
        unsafe {
            let _ = RemoveWindowSubclass(self.hwnd, Some(subclass_proc), SUBCLASS_ID);
            drop(Box::from_raw(self.raw));
        }
    }
}

impl PenSource for WindowsPen {
    fn backend(&self) -> &'static str {
        "windows-wm-pointer"
    }
    /// Never blocks: the window's message loop produces the samples.
    fn poll(
        &mut self,
        _timeout: Option<Duration>,
        out: &mut Vec<PenSample>,
    ) -> Result<usize, PenError> {
        let mut s = self
            .shared
            .lock()
            .map_err(|_| PenError::Io("poisoned".into()))?;
        let n = s.queue.len();
        out.append(&mut s.queue);
        Ok(n)
    }
}

fn kind_of(t: POINTER_INPUT_TYPE) -> Option<WinPointerKind> {
    if t == PT_PEN {
        Some(WinPointerKind::Pen)
    } else if t == PT_TOUCH {
        Some(WinPointerKind::Touch)
    } else if t == PT_MOUSE {
        Some(WinPointerKind::Mouse)
    } else {
        None
    }
}

fn raw_from(
    info: &POINTER_INFO,
    pen: Option<&POINTER_PEN_INFO>,
    kind: WinPointerKind,
    rects: Option<WinRects>,
) -> WinPointerRaw {
    WinPointerRaw {
        kind,
        pointer_id: info.pointerId,
        device: info.sourceDevice.0 as usize as u64,
        flags: info.pointerFlags.0,
        pen_flags: pen.map_or(0, |p| p.penFlags),
        pen_mask: pen.map_or(0, |p| p.penMask),
        pressure: pen.map_or(0, |p| p.pressure),
        rotation: pen.map_or(0, |p| p.rotation),
        tilt_x: pen.map_or(0, |p| p.tiltX),
        tilt_y: pen.map_or(0, |p| p.tiltY),
        time_ms: info.dwTime,
        perf_us: info.PerformanceCount,
        pixel: (info.ptPixelLocation.x, info.ptPixelLocation.y),
        himetric_raw: (info.ptHimetricLocationRaw.x, info.ptHimetricLocationRaw.y),
        rects,
    }
}

unsafe fn device_rects(device: HANDLE) -> Option<WinRects> {
    let (mut d, mut s) = (RECT::default(), RECT::default());
    GetPointerDeviceRects(device, &mut d, &mut s).ok()?;
    Some(WinRects {
        device: [d.left, d.top, d.right, d.bottom],
        display: [s.left, s.top, s.right, s.bottom],
    })
}

/// Pen history, oldest first. `GetPointerPenInfoHistory` returns newest first.
unsafe fn pen_history(id: u32) -> Vec<POINTER_PEN_INFO> {
    let mut count = 0u32;
    if GetPointerPenInfoHistory(id, &mut count, None).is_err() || count == 0 {
        return Vec::new();
    }
    let mut buf = vec![POINTER_PEN_INFO::default(); count as usize];
    if GetPointerPenInfoHistory(id, &mut count, Some(buf.as_mut_ptr())).is_err() {
        return Vec::new();
    }
    buf.truncate(count as usize);
    buf.reverse();
    buf
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    refdata: usize,
) -> LRESULT {
    let msg_kind = match msg {
        WM_POINTERENTER => Some(WinMsg::Enter),
        WM_POINTERDOWN => Some(WinMsg::Down),
        WM_POINTERUPDATE => Some(WinMsg::Update),
        WM_POINTERUP => Some(WinMsg::Up),
        WM_POINTERLEAVE => Some(WinMsg::Leave),
        WM_POINTERCAPTURECHANGED => Some(WinMsg::CaptureChanged),
        _ => None,
    };
    let Some(wm) = msg_kind else {
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    };
    let shared = &*(refdata as *const Arc<Mutex<Shared>>);
    let Ok(mut sh) = shared.lock() else {
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    };
    let pointer_id = (wparam.0 & 0xFFFF) as u32;
    let Shared {
        translator,
        queue,
        devices,
        consume,
    } = &mut *sh;

    if matches!(wm, WinMsg::Leave | WinMsg::CaptureChanged) {
        if let Some(device) = devices.remove(&pointer_id) {
            translator.push(wm, &[], device, queue);
        }
    } else {
        let mut ty = POINTER_INPUT_TYPE::default();
        if let (true, Some(kind)) = (GetPointerType(pointer_id, &mut ty).is_ok(), kind_of(ty)) {
            let mut origin = POINT::default();
            let _ = ScreenToClient(hwnd, &mut origin);
            translator.client_origin = (-(origin.x as f64), -(origin.y as f64));
            let mut history = Vec::new();
            if kind == WinPointerKind::Pen {
                let pens = pen_history(pointer_id);
                let rects = pens
                    .first()
                    .and_then(|p| device_rects(p.pointerInfo.sourceDevice));
                history.extend(
                    pens.iter()
                        .map(|p| raw_from(&p.pointerInfo, Some(p), kind, rects)),
                );
            } else {
                let mut info = POINTER_INFO::default();
                if GetPointerInfo(pointer_id, &mut info).is_ok() {
                    history.push(raw_from(&info, None, kind, None));
                }
            }
            if let Some(last) = history.last() {
                devices.insert(pointer_id, last.device);
                let device = last.device;
                translator.push(wm, &history, device, queue);
            }
        }
    }
    if *consume {
        LRESULT(0)
    } else {
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}
