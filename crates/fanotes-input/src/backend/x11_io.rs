//! XInput2 I/O (feature `x11`): selects slave tablet devices on a window, converts
//! `XIDeviceEvent`s into [`XiEvent`]s and runs them through [`X11Translator`].

use std::collections::HashSet;
use std::os::fd::AsFd;
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xinput::{
    ConnectionExt as _, DeviceClassData, DeviceType, EventMask, Fp3232, XIEventMask,
};
use x11rb::protocol::xproto::{ConnectionExt as _, Window};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

use super::x11::{X11Translator, XiAxis, XiDevice, XiEvent, XiKind, PROXIMITY_TIMEOUT_MS};
use crate::{PenError, PenSample, PenSource};

fn fp3232(v: &Fp3232) -> f64 {
    v.integral as f64 + v.frac as f64 / 4_294_967_296.0
}

fn io(e: impl std::fmt::Display) -> PenError {
    PenError::Io(e.to_string())
}

pub struct X11Pen {
    conn: RustConnection,
    window: Window,
    root: Window,
    translator: X11Translator,
    selected: HashSet<u16>,
    last_event_ms: f64,
    last_recv: Instant,
}

impl X11Pen {
    /// Opens `$DISPLAY` and reads tablet events delivered to `window` (any client's window).
    pub fn connect(window: Window) -> Result<Self, PenError> {
        let (conn, screen) =
            RustConnection::connect(None).map_err(|e| PenError::Unavailable(e.to_string()))?;
        let root = conn.setup().roots[screen].root;
        Self::with_connection(conn, root, window)
    }

    pub fn with_connection(
        conn: RustConnection,
        root: Window,
        window: Window,
    ) -> Result<Self, PenError> {
        let v = conn
            .xinput_xi_query_version(2, 2)
            .map_err(io)?
            .reply()
            .map_err(io)?;
        if v.major_version < 2 {
            return Err(PenError::Unavailable("XInput 2 is not available".into()));
        }
        conn.xinput_xi_select_events(
            root,
            &[EventMask {
                deviceid: 0,
                mask: vec![XIEventMask::HIERARCHY],
            }],
        )
        .map_err(io)?;
        let mut me = Self {
            conn,
            window,
            root,
            translator: X11Translator::new(),
            selected: HashSet::new(),
            last_event_ms: 0.0,
            last_recv: Instant::now(),
        };
        me.refresh_devices()?;
        Ok(me)
    }

    /// Devices that carry a pressure axis, with their valuator classes resolved.
    pub fn enumerate(&self) -> Result<Vec<XiDevice>, PenError> {
        let reply = self
            .conn
            .xinput_xi_query_device(0u16)
            .map_err(io)?
            .reply()
            .map_err(io)?;
        let mut out = Vec::new();
        for info in reply.infos {
            if info.type_ != DeviceType::SLAVE_POINTER && info.type_ != DeviceType::FLOATING_SLAVE {
                continue;
            }
            let mut axes = Vec::new();
            for class in &info.classes {
                if let DeviceClassData::Valuator(v) = &class.data {
                    let label = if v.label == 0 {
                        String::new()
                    } else {
                        let r = self
                            .conn
                            .get_atom_name(v.label)
                            .map_err(io)?
                            .reply()
                            .map_err(io)?;
                        String::from_utf8_lossy(&r.name).into_owned()
                    };
                    axes.push(XiAxis {
                        number: v.number,
                        label,
                        min: fp3232(&v.min),
                        max: fp3232(&v.max),
                    });
                }
            }
            let dev = XiDevice {
                id: info.deviceid,
                name: String::from_utf8_lossy(&info.name).into_owned(),
                axes,
            };
            if dev.is_pen_source() {
                out.push(dev);
            }
        }
        Ok(out)
    }

    fn refresh_devices(&mut self) -> Result<(), PenError> {
        for dev in self.enumerate()? {
            if self.selected.insert(dev.id) {
                self.conn
                    .xinput_xi_select_events(
                        self.window,
                        &[EventMask {
                            deviceid: dev.id,
                            mask: vec![
                                XIEventMask::MOTION
                                    | XIEventMask::BUTTON_PRESS
                                    | XIEventMask::BUTTON_RELEASE,
                            ],
                        }],
                    )
                    .map_err(io)?;
            }
            self.translator.add_device(dev);
        }
        self.conn.flush().map_err(io)?;
        let _ = self.root;
        Ok(())
    }

    fn convert(&mut self, ev: Event, out: &mut Vec<PenSample>) -> Result<(), PenError> {
        let (e, kind) = match ev {
            Event::XinputMotion(e) => (e, XiKind::Motion),
            Event::XinputButtonPress(e) => {
                let k = XiKind::ButtonPress(e.detail as u8);
                (e, k)
            }
            Event::XinputButtonRelease(e) => {
                let k = XiKind::ButtonRelease(e.detail as u8);
                (e, k)
            }
            Event::XinputHierarchy(_) => return self.refresh_devices(),
            _ => return Ok(()),
        };
        let mut valuators = Vec::new();
        let mut values = e.axisvalues.iter();
        for (word_i, word) in e.valuator_mask.iter().enumerate() {
            for bit in 0..32u16 {
                if word & (1 << bit) != 0 {
                    if let Some(v) = values.next() {
                        valuators.push((word_i as u16 * 32 + bit, fp3232(v)));
                    }
                }
            }
        }
        let raw = XiEvent {
            source: e.sourceid,
            time: e.time,
            kind,
            x: e.event_x as f64 / 65536.0,
            y: e.event_y as f64 / 65536.0,
            button_mask: e.button_mask.first().copied().unwrap_or(0),
            valuators,
        };
        let before = out.len();
        self.translator.push(&raw, out);
        if out.len() > before {
            self.last_event_ms = out.last().map_or(self.last_event_ms, |s| s.timestamp_ms);
            self.last_recv = Instant::now();
        }
        Ok(())
    }
}

impl PenSource for X11Pen {
    fn backend(&self) -> &'static str {
        "x11-xi2"
    }

    fn poll(
        &mut self,
        timeout: Option<Duration>,
        out: &mut Vec<PenSample>,
    ) -> Result<usize, PenError> {
        let start = out.len();
        let mut waited = false;
        loop {
            while let Some(ev) = self.conn.poll_for_event().map_err(io)? {
                self.convert(ev, out)?;
            }
            if out.len() > start || waited {
                break;
            }
            let Some(t) = timeout else { break };
            // Wake in time to synthesize `Leave` when the tool goes quiet.
            let wait = t.min(Duration::from_millis(PROXIMITY_TIMEOUT_MS as u64 / 2));
            let fd = self.conn.stream().as_fd();
            let mut fds = [rustix::event::PollFd::new(
                &fd,
                rustix::event::PollFlags::IN,
            )];
            let ts = rustix::event::Timespec {
                tv_sec: wait.as_secs() as i64,
                tv_nsec: wait.subsec_nanos() as i64,
            };
            rustix::event::poll(&mut fds, Some(&ts)).map_err(io)?;
            waited = wait >= t;
            if fds[0].revents().is_empty() {
                let idle = self.last_recv.elapsed().as_secs_f64() * 1000.0;
                self.translator.tick(self.last_event_ms + idle, out);
            }
        }
        Ok(out.len() - start)
    }
}
