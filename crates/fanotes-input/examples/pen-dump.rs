//! Prints pen samples from the native backend. For real-device testing on Linux:
//!
//!   cargo run -p fanotes-input --example pen-dump --features wayland,x11 -- [--backend auto|wayland|x11] [--policy] [--json]
//!
//! Opens a small window, then prints one line per `PenSample` (all of them, including
//! the hover samples). `--policy` also runs the shared pen policy and prints its verdict.

#[cfg(not(all(unix, any(feature = "wayland", feature = "x11"))))]
fn main() {
    eprintln!("pen-dump needs Linux and `--features wayland,x11` (or one of them)");
    std::process::exit(2);
}

#[cfg(all(unix, any(feature = "wayland", feature = "x11")))]
mod app {
    use fanotes_input::{
        PaperSurface, PenOutput, PenPolicy, PenPolicyConfig, PenSample, PenSource,
    };
    use std::time::Duration;

    pub struct Args {
        pub backend: String,
        pub policy: bool,
        pub json: bool,
    }

    pub fn args() -> Args {
        let mut a = Args {
            backend: "auto".into(),
            policy: false,
            json: false,
        };
        let mut it = std::env::args().skip(1);
        while let Some(x) = it.next() {
            match x.as_str() {
                "--backend" => a.backend = it.next().unwrap_or_default(),
                "--policy" => a.policy = true,
                "--json" => a.json = true,
                other => {
                    eprintln!("unknown argument {other}");
                    std::process::exit(2);
                }
            }
        }
        a
    }

    pub fn fmt(s: &PenSample, json: bool) -> String {
        if json {
            format!(
                "{{\"t\":{:.3},\"dev\":{},\"phase\":\"{:?}\",\"x\":{:.2},\"y\":{:.2},\"p\":{:.4},\"tx\":{:.1},\"ty\":{:.1},\"rot\":{:.1},\"buttons\":{},\"tool\":\"{:?}\",\"eraser\":{}}}",
                s.timestamp_ms, s.device_id, s.phase, s.x, s.y, s.pressure, s.tilt_x, s.tilt_y, s.rotation, s.buttons, s.tool, s.eraser
            )
        } else {
            format!(
                "{:>12.3} dev={} {:<6?} {:?}{} x={:8.2} y={:8.2} p={:.3} tilt=({:5.1},{:5.1}) rot={:5.1} buttons={:#04x}",
                s.timestamp_ms, s.device_id, s.phase, s.tool, if s.eraser { "(eraser)" } else { "" },
                s.x, s.y, s.pressure, s.tilt_x, s.tilt_y, s.rotation, s.buttons
            )
        }
    }

    pub fn run(mut src: Box<dyn PenSource>, a: &Args, keep_alive: &mut dyn FnMut() -> bool) {
        eprintln!(
            "backend: {}; move a pen over the window (Ctrl-C to quit)",
            src.backend()
        );
        let mut policy = a.policy.then(|| {
            PenPolicy::new(PenPolicyConfig {
                surface: Some(PaperSurface {
                    left: 0.0,
                    top: 0.0,
                    width: 640.0,
                    height: 480.0,
                    offset_width: None,
                    offset_height: None,
                }),
                ..Default::default()
            })
        });
        let mut buf = Vec::new();
        while keep_alive() {
            buf.clear();
            if let Err(e) = src.poll(Some(Duration::from_millis(50)), &mut buf) {
                eprintln!("error: {e}");
                return;
            }
            for s in &buf {
                println!("{}", fmt(s, a.json));
                if let Some(p) = policy.as_mut() {
                    for PenOutput {
                        kind,
                        action,
                        point,
                        ..
                    } in p.push(s.clone())
                    {
                        println!(
                            "    -> {kind:?} action={action:?} point={:?}",
                            point.map(|p| (p.x, p.y))
                        );
                    }
                }
            }
        }
    }
}

#[cfg(all(unix, any(feature = "wayland", feature = "x11")))]
fn main() {
    let a = app::args();
    let use_wayland = match a.backend.as_str() {
        "wayland" => true,
        "x11" => false,
        _ => std::env::var_os("WAYLAND_DISPLAY").is_some(),
    };
    if use_wayland {
        #[cfg(feature = "wayland")]
        return wl::main(&a);
        #[cfg(not(feature = "wayland"))]
        {
            eprintln!("built without the `wayland` feature");
            std::process::exit(2);
        }
    }
    #[cfg(feature = "x11")]
    return x::main(&a);
    #[cfg(not(feature = "x11"))]
    {
        eprintln!("built without the `x11` feature");
        std::process::exit(2);
    }
}

#[cfg(all(unix, feature = "x11"))]
mod x {
    use fanotes_input::backend::x11_io::X11Pen;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        AtomEnum, ConnectionExt, CreateWindowAux, EventMask, PropMode, WindowClass,
    };
    use x11rb::wrapper::ConnectionExt as _;
    use x11rb::COPY_DEPTH_FROM_PARENT;

    pub fn main(a: &super::app::Args) {
        let (conn, screen_num) = x11rb::connect(None).expect("connect to X11");
        let screen = &conn.setup().roots[screen_num];
        let win = conn.generate_id().unwrap();
        conn.create_window(
            COPY_DEPTH_FROM_PARENT,
            win,
            screen.root,
            0,
            0,
            640,
            480,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new()
                .background_pixel(screen.white_pixel)
                .event_mask(EventMask::EXPOSURE | EventMask::STRUCTURE_NOTIFY),
        )
        .unwrap();
        conn.change_property8(
            PropMode::REPLACE,
            win,
            AtomEnum::WM_NAME,
            AtomEnum::STRING,
            b"fanotes pen-dump",
        )
        .unwrap();
        conn.map_window(win).unwrap();
        conn.flush().unwrap();
        let pen = X11Pen::connect(win).expect("XInput2 pen backend");
        let mut alive = || {
            while let Ok(Some(_)) = conn.poll_for_event() {}
            true
        };
        super::app::run(Box::new(pen), a, &mut alive);
    }
}

#[cfg(all(unix, feature = "wayland"))]
mod wl {
    use std::io::Write;
    use std::os::fd::AsFd;

    use fanotes_input::backend::wayland_io::WaylandPen;
    use wayland_client::globals::{registry_queue_init, GlobalListContents};
    use wayland_client::protocol::{
        wl_buffer, wl_compositor, wl_registry, wl_seat, wl_shm, wl_shm_pool, wl_surface,
    };
    use wayland_client::{Connection, Dispatch, QueueHandle};
    use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

    const W: i32 = 640;
    const H: i32 = 480;

    struct Win {
        surface: wl_surface::WlSurface,
        buffer: wl_buffer::WlBuffer,
        configured: bool,
        closed: bool,
    }

    macro_rules! noop {
        ($($t:ty),*) => {$(
            impl Dispatch<$t, ()> for Win {
                fn event(_: &mut Self, _: &$t, _: <$t as wayland_client::Proxy>::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
            }
        )*};
    }
    noop!(
        wl_compositor::WlCompositor,
        wl_shm::WlShm,
        wl_shm_pool::WlShmPool,
        wl_buffer::WlBuffer,
        wl_seat::WlSeat,
        wl_surface::WlSurface
    );

    impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Win {
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
    impl Dispatch<xdg_wm_base::XdgWmBase, ()> for Win {
        fn event(
            _: &mut Self,
            base: &xdg_wm_base::XdgWmBase,
            e: xdg_wm_base::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let xdg_wm_base::Event::Ping { serial } = e {
                base.pong(serial);
            }
        }
    }
    impl Dispatch<xdg_surface::XdgSurface, ()> for Win {
        fn event(
            s: &mut Self,
            xs: &xdg_surface::XdgSurface,
            e: xdg_surface::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let xdg_surface::Event::Configure { serial } = e {
                xs.ack_configure(serial);
                s.surface.attach(Some(&s.buffer), 0, 0);
                s.surface.commit();
                s.configured = true;
            }
        }
    }
    impl Dispatch<xdg_toplevel::XdgToplevel, ()> for Win {
        fn event(
            s: &mut Self,
            _: &xdg_toplevel::XdgToplevel,
            e: xdg_toplevel::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let xdg_toplevel::Event::Close = e {
                s.closed = true;
            }
        }
    }

    pub fn main(a: &super::app::Args) {
        let conn = Connection::connect_to_env().expect("connect to Wayland");
        let (globals, mut queue) = registry_queue_init::<Win>(&conn).unwrap();
        let qh = queue.handle();
        let compositor: wl_compositor::WlCompositor = globals.bind(&qh, 1..=4, ()).unwrap();
        let shm: wl_shm::WlShm = globals.bind(&qh, 1..=1, ()).unwrap();
        let wm: xdg_wm_base::XdgWmBase = globals.bind(&qh, 1..=1, ()).unwrap();
        let seat: wl_seat::WlSeat = globals.bind(&qh, 1..=1, ()).unwrap();

        let dir = std::env::var_os("XDG_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = dir.join(format!("fanotes-pen-dump-{}", std::process::id()));
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let _ = std::fs::remove_file(&path);
        let px = 0xFFF4_F1EAu32.to_le_bytes();
        let row: Vec<u8> = (0..W).flat_map(|_| px).collect();
        for _ in 0..H {
            file.write_all(&row).unwrap();
        }
        let size = W * H * 4;
        let pool = shm.create_pool(file.as_fd(), size, &qh, ());
        let buffer = pool.create_buffer(0, W, H, W * 4, wl_shm::Format::Argb8888, &qh, ());

        let surface = compositor.create_surface(&qh, ());
        let xs = wm.get_xdg_surface(&surface, &qh, ());
        let top = xs.get_toplevel(&qh, ());
        top.set_title("fanotes pen-dump".into());
        top.set_app_id("fanotes-pen-dump".into());
        surface.commit();
        let mut win = Win {
            surface: surface.clone(),
            buffer,
            configured: false,
            closed: false,
        };
        while !win.configured {
            queue.blocking_dispatch(&mut win).unwrap();
        }
        let pen = WaylandPen::new(&conn, &seat, &surface).expect("tablet-v2 backend");
        let mut alive = || {
            let _ = queue.dispatch_pending(&mut win);
            !win.closed
        };
        super::app::run(Box::new(pen), a, &mut alive);
    }
}
