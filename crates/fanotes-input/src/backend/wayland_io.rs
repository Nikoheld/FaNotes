//! `zwp_tablet_manager_v2` I/O (feature `wayland`). Binds the tablet seat of a given
//! `wl_seat` on its own event queue and forwards the events of tools that enter the
//! given `wl_surface` into [`WaylandTranslator`].

use std::collections::HashMap;
use std::time::Duration;

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_registry, wl_seat::WlSeat, wl_surface::WlSurface};
use wayland_client::{
    event_created_child, Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum,
};
use wayland_protocols::wp::tablet::zv2::client::{
    zwp_tablet_manager_v2::ZwpTabletManagerV2,
    zwp_tablet_pad_dial_v2::{self, ZwpTabletPadDialV2},
    zwp_tablet_pad_group_v2::{self, ZwpTabletPadGroupV2},
    zwp_tablet_pad_ring_v2::{self, ZwpTabletPadRingV2},
    zwp_tablet_pad_strip_v2::{self, ZwpTabletPadStripV2},
    zwp_tablet_pad_v2::{self, ZwpTabletPadV2},
    zwp_tablet_seat_v2::{self, ZwpTabletSeatV2},
    zwp_tablet_tool_v2::{self, ZwpTabletToolV2},
    zwp_tablet_v2::{self, ZwpTabletV2},
};

use super::wayland::{WaylandTranslator, WlToolEvent, WlToolType};
use crate::{PenError, PenSample, PenSource};

struct State {
    surface: WlSurface,
    translator: WaylandTranslator,
    tools: HashMap<wayland_client::backend::ObjectId, u64>,
    next_tool: u64,
    out: Vec<PenSample>,
}

pub struct WaylandPen {
    _conn: Connection,
    queue: EventQueue<State>,
    state: State,
    _manager: ZwpTabletManagerV2,
    _seat: ZwpTabletSeatV2,
}

impl WaylandPen {
    /// Reads tablet tools for `seat` while they are over `surface`. The compositor only
    /// sends tablet events to the surface that has tablet focus, so the surface must be
    /// mapped and focused by the caller. `conn` is the application's connection.
    pub fn new(conn: &Connection, seat: &WlSeat, surface: &WlSurface) -> Result<Self, PenError> {
        let (globals, queue) =
            registry_queue_init::<State>(conn).map_err(|e| PenError::Unavailable(e.to_string()))?;
        let qh = queue.handle();
        let manager: ZwpTabletManagerV2 = globals
            .bind(&qh, 1..=2, ())
            .map_err(|_| PenError::Unavailable("compositor has no zwp_tablet_manager_v2".into()))?;
        let tablet_seat = manager.get_tablet_seat(seat, &qh, ());
        let mut me = Self {
            _conn: conn.clone(),
            queue,
            state: State {
                surface: surface.clone(),
                translator: WaylandTranslator::new(),
                tools: HashMap::new(),
                next_tool: 1,
                out: Vec::new(),
            },
            _manager: manager,
            _seat: tablet_seat,
        };
        me.queue
            .roundtrip(&mut me.state)
            .map_err(|e| PenError::Io(e.to_string()))?;
        Ok(me)
    }
}

impl PenSource for WaylandPen {
    fn backend(&self) -> &'static str {
        "wayland-tablet-v2"
    }

    fn poll(
        &mut self,
        timeout: Option<Duration>,
        out: &mut Vec<PenSample>,
    ) -> Result<usize, PenError> {
        let io = |e: &dyn std::fmt::Display| PenError::Io(e.to_string());
        self.queue
            .dispatch_pending(&mut self.state)
            .map_err(|e| io(&e))?;
        if self.state.out.is_empty() {
            if let Some(t) = timeout {
                self.queue.flush().map_err(|e| io(&e))?;
                if let Some(guard) = self.queue.prepare_read() {
                    let fd = guard.connection_fd();
                    let mut fds = [rustix::event::PollFd::new(
                        &fd,
                        rustix::event::PollFlags::IN,
                    )];
                    let ts = rustix::event::Timespec {
                        tv_sec: t.as_secs() as i64,
                        tv_nsec: t.subsec_nanos() as i64,
                    };
                    rustix::event::poll(&mut fds, Some(&ts)).map_err(|e| io(&e))?;
                    if !fds[0].revents().is_empty() {
                        guard.read().map_err(|e| io(&e))?;
                    }
                }
                self.queue
                    .dispatch_pending(&mut self.state)
                    .map_err(|e| io(&e))?;
            }
        }
        let n = self.state.out.len();
        out.append(&mut self.state.out);
        Ok(n)
    }
}

impl State {
    fn tool_id(&mut self, tool: &ZwpTabletToolV2) -> u64 {
        let key = tool.id();
        if let Some(id) = self.tools.get(&key) {
            return *id;
        }
        let id = self.next_tool;
        self.next_tool += 1;
        self.tools.insert(key, id);
        id
    }
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<ZwpTabletManagerV2, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwpTabletManagerV2,
        _: <ZwpTabletManagerV2 as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwpTabletSeatV2, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwpTabletSeatV2,
        _: zwp_tablet_seat_v2::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
    event_created_child!(State, ZwpTabletSeatV2, [
        zwp_tablet_seat_v2::EVT_TABLET_ADDED_OPCODE => (ZwpTabletV2, ()),
        zwp_tablet_seat_v2::EVT_TOOL_ADDED_OPCODE => (ZwpTabletToolV2, ()),
        zwp_tablet_seat_v2::EVT_PAD_ADDED_OPCODE => (ZwpTabletPadV2, ()),
    ]);
}

impl Dispatch<ZwpTabletV2, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwpTabletV2,
        _: zwp_tablet_v2::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<ZwpTabletPadV2, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwpTabletPadV2,
        _: zwp_tablet_pad_v2::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
    event_created_child!(State, ZwpTabletPadV2, [
        zwp_tablet_pad_v2::EVT_GROUP_OPCODE => (ZwpTabletPadGroupV2, ()),
    ]);
}
impl Dispatch<ZwpTabletPadGroupV2, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwpTabletPadGroupV2,
        _: zwp_tablet_pad_group_v2::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
    event_created_child!(State, ZwpTabletPadGroupV2, [
        zwp_tablet_pad_group_v2::EVT_RING_OPCODE => (ZwpTabletPadRingV2, ()),
        zwp_tablet_pad_group_v2::EVT_STRIP_OPCODE => (ZwpTabletPadStripV2, ()),
        zwp_tablet_pad_group_v2::EVT_DIAL_OPCODE => (ZwpTabletPadDialV2, ()),
    ]);
}
impl Dispatch<ZwpTabletPadRingV2, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwpTabletPadRingV2,
        _: zwp_tablet_pad_ring_v2::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<ZwpTabletPadStripV2, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwpTabletPadStripV2,
        _: zwp_tablet_pad_strip_v2::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<ZwpTabletPadDialV2, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwpTabletPadDialV2,
        _: zwp_tablet_pad_dial_v2::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwpTabletToolV2, ()> for State {
    fn event(
        state: &mut Self,
        tool: &ZwpTabletToolV2,
        event: zwp_tablet_tool_v2::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use zwp_tablet_tool_v2::Event as E;
        let id = state.tool_id(tool);
        let ev = match event {
            E::Type { tool_type } => match tool_type {
                WEnum::Value(v) => match WlToolType::from_wire(v as u32) {
                    Some(t) => WlToolEvent::Type(t),
                    None => return,
                },
                WEnum::Unknown(_) => return,
            },
            E::ProximityIn { surface, .. } => WlToolEvent::ProximityIn {
                on_surface: surface == state.surface,
            },
            E::ProximityOut => WlToolEvent::ProximityOut,
            E::Down { .. } => WlToolEvent::Down,
            E::Up => WlToolEvent::Up,
            E::Motion { x, y } => WlToolEvent::Motion { x, y },
            E::Pressure { pressure } => WlToolEvent::Pressure(pressure),
            E::Distance { distance } => WlToolEvent::Distance(distance),
            E::Tilt { tilt_x, tilt_y } => WlToolEvent::Tilt {
                x: tilt_x,
                y: tilt_y,
            },
            E::Rotation { degrees } => WlToolEvent::Rotation(degrees),
            E::Slider { position } => WlToolEvent::Slider(position),
            E::Button {
                button, state: s, ..
            } => WlToolEvent::Button {
                code: button,
                pressed: matches!(s, WEnum::Value(zwp_tablet_tool_v2::ButtonState::Pressed)),
            },
            E::Frame { time } => WlToolEvent::Frame { time },
            E::Removed => {
                state.tools.remove(&tool.id());
                WlToolEvent::Removed
            }
            _ => return,
        };
        let State {
            translator, out, ..
        } = state;
        translator.push(id, &ev, out);
    }
}
