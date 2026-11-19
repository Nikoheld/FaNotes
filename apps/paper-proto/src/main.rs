//! Standalone paper surface on the `fanotes-gpu` page engine.
//!
//! Left drag draws. The wheel zooms around the cursor. Middle drag pans.
//! Backspace erases the last stroke. Ctrl+Z undoes, Ctrl+Y redoes, Ctrl+S saves.
//! A page grow remaps the point arena, including strokes that only undo still holds.
//!
//! ```text
//! paper-proto [FILE.json] [--cpu | --softbuffer] [--headless-frames N] [--out frame.png] [--size WxH]
//! ```
//! - default: vello_hybrid on a wgpu surface; falls back to vello_cpu if no GPU works.
//! - `--cpu`: vello_cpu, presented through softbuffer.
//! - `--softbuffer`: the original one-pixel softbuffer painter.
//! - `--headless-frames N`: no window. Draws a scripted pen session for N
//!   frames offscreen, prints frame times, optionally writes the last frame.

mod headless;
mod legacy;
mod session;

use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::Arc;

use fanotes_gpu::{CpuRenderer, GpuContext, HybridRenderer, PageScene, PaperStyle, Renderer};
use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::{Window, WindowAttributes, WindowId};

use session::Session;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Gpu,
    Cpu,
    Softbuffer,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub file: Option<PathBuf>,
    pub mode: Mode,
    pub headless_frames: Option<usize>,
    pub out: Option<PathBuf>,
    pub size: (u32, u32),
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut options = Options {
        file: None,
        mode: Mode::Gpu,
        headless_frames: None,
        out: None,
        size: (1280, 800),
    };
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cpu" => options.mode = Mode::Cpu,
            "--softbuffer" => options.mode = Mode::Softbuffer,
            "--gpu" => options.mode = Mode::Gpu,
            "--headless-frames" => {
                let value = args.next().ok_or("--headless-frames needs a count")?;
                options.headless_frames = Some(
                    value
                        .parse()
                        .map_err(|_| format!("bad frame count {value:?}"))?,
                );
            }
            "--out" => options.out = Some(PathBuf::from(args.next().ok_or("--out needs a path")?)),
            "--size" => {
                let value = args.next().ok_or("--size needs WxH")?;
                let (w, h) = value.split_once('x').ok_or(format!("bad size {value:?}"))?;
                options.size = (
                    w.parse().map_err(|_| format!("bad width {w:?}"))?,
                    h.parse().map_err(|_| format!("bad height {h:?}"))?,
                );
            }
            flag if flag.starts_with("--") => return Err(format!("unknown flag {flag}")),
            path => options.file = Some(PathBuf::from(path)),
        }
    }
    Ok(options)
}

fn load_session(file: Option<&PathBuf>) -> Session {
    match file {
        Some(path) if path.is_file() => match Session::open(path) {
            Ok(session) => session,
            Err(error) => {
                eprintln!("could not load {}: {error}", path.display());
                std::process::exit(1);
            }
        },
        Some(path) => {
            let mut session = Session::new();
            session.set_path(path.clone());
            session
        }
        None => Session::new(),
    }
}

fn main() {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let session = load_session(options.file.as_ref());
    if let Some(frames) = options.headless_frames {
        match headless::run(session, frames, &options) {
            Ok(report) if report.frames > 0 && report.strokes + 1 > 0 && report.ink_pixels == 0 => {
                eprintln!("headless run drew no visible ink");
                std::process::exit(1);
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!("headless run failed: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    let event_loop = EventLoop::new().expect("event loop");
    event_loop.set_control_flow(ControlFlow::Wait);
    let mut app = App {
        mode: options.mode,
        window: None,
        presenter: None,
        scene: new_scene(&session),
        session,
        modifiers: ModifiersState::empty(),
        cursor: (0.0, 0.0),
        panning: false,
        last_pan: None,
    };
    event_loop.run_app(&mut app).expect("window");
}

pub fn new_scene(session: &Session) -> PageScene {
    let mut scene = PageScene::new(session.doc().page_width(), session.doc().page_height());
    scene.paper = PaperStyle::Lines;
    scene
}

type SoftContext = Context<Arc<Window>>;
type SoftSurface = Surface<Arc<Window>, Arc<Window>>;

enum Presenter {
    Gpu(Box<HybridRenderer>),
    Cpu {
        renderer: Box<CpuRenderer>,
        surface: SoftSurface,
        _context: SoftContext,
    },
    Softbuffer {
        surface: SoftSurface,
        _context: SoftContext,
    },
}

fn softbuffer_surface(window: &Arc<Window>) -> (SoftContext, SoftSurface) {
    let context = Context::new(window.clone()).expect("softbuffer context");
    let surface = Surface::new(&context, window.clone()).expect("softbuffer surface");
    (context, surface)
}

fn gpu_presenter(window: &Arc<Window>) -> Result<Presenter, String> {
    let instance = GpuContext::instance();
    let surface = instance
        .create_surface(window.clone())
        .map_err(|error| error.to_string())?;
    let gpu = GpuContext::new(instance, Some(&surface)).map_err(|error| error.to_string())?;
    let size = window.inner_size();
    let renderer = HybridRenderer::with_surface(gpu, surface, size.width, size.height)
        .map_err(|error| error.to_string())?;
    eprintln!("paper-proto: vello_hybrid on {}", renderer.adapter_name());
    Ok(Presenter::Gpu(Box::new(renderer)))
}

struct App {
    mode: Mode,
    window: Option<Arc<Window>>,
    presenter: Option<Presenter>,
    scene: PageScene,
    session: Session,
    modifiers: ModifiersState,
    cursor: (f64, f64),
    panning: bool,
    last_pan: Option<(f64, f64)>,
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attributes = WindowAttributes::default()
            .with_title("FaNotes paper — draw, wheel zoom, middle pan, Ctrl+Z undo, Ctrl+S save")
            .with_inner_size(LogicalSize::new(1100.0, 800.0));
        let window = Arc::new(event_loop.create_window(attributes).expect("window"));
        let presenter = match self.mode {
            Mode::Gpu => gpu_presenter(&window).unwrap_or_else(|error| {
                eprintln!("paper-proto: no GPU ({error}); using vello_cpu");
                let (context, surface) = softbuffer_surface(&window);
                Presenter::Cpu {
                    renderer: Box::new(CpuRenderer::new(None)),
                    surface,
                    _context: context,
                }
            }),
            Mode::Cpu => {
                let (context, surface) = softbuffer_surface(&window);
                Presenter::Cpu {
                    renderer: Box::new(CpuRenderer::new(None)),
                    surface,
                    _context: context,
                }
            }
            Mode::Softbuffer => {
                let (context, surface) = softbuffer_surface(&window);
                Presenter::Softbuffer {
                    surface,
                    _context: context,
                }
            }
        };
        self.window = Some(window);
        self.presenter = Some(presenter);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::CursorMoved { position, .. } => {
                let next = (position.x, position.y);
                if self.panning {
                    if let Some(previous) = self.last_pan {
                        self.session
                            .pan_screen(next.0 - previous.0, next.1 - previous.1);
                    }
                    self.last_pan = Some(next);
                } else if self.session_drawing() {
                    let (x, y) = self.session.screen_to_page(next.0, next.1);
                    self.session.pen_move_page(x, y);
                }
                self.cursor = next;
                self.request_redraw();
            }
            WindowEvent::MouseInput { state, button, .. } => {
                if button == MouseButton::Middle {
                    self.panning = state == ElementState::Pressed;
                    self.last_pan = self.panning.then_some(self.cursor);
                }
                if button == MouseButton::Left {
                    let (x, y) = self.session.screen_to_page(self.cursor.0, self.cursor.1);
                    if state == ElementState::Pressed {
                        self.session.pen_down_page(x, y);
                    } else {
                        self.session.pen_up();
                    }
                    self.request_redraw();
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let lines = match delta {
                    MouseScrollDelta::LineDelta(_, y) => f64::from(y),
                    MouseScrollDelta::PixelDelta(position) => position.y / 40.0,
                };
                if lines != 0.0 {
                    let factor = (1.0 + lines * 0.1).clamp(0.5, 1.5);
                    self.session.zoom_at(self.cursor.0, self.cursor.1, factor);
                    self.request_redraw();
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if event.state != ElementState::Pressed {
                    return;
                }
                let ctrl = self.modifiers.control_key();
                match event.logical_key {
                    Key::Character(ref text) if ctrl && text.eq_ignore_ascii_case("z") => {
                        if self.modifiers.shift_key() {
                            self.session.redo();
                        } else {
                            self.session.undo();
                        }
                        self.request_redraw();
                    }
                    Key::Character(ref text) if ctrl && text.eq_ignore_ascii_case("y") => {
                        self.session.redo();
                        self.request_redraw();
                    }
                    Key::Character(ref text) if ctrl && text.eq_ignore_ascii_case("s") => {
                        if let Err(error) = self.session.save() {
                            eprintln!("save failed: {error}");
                        }
                    }
                    Key::Named(NamedKey::Backspace) => {
                        self.session.erase_last();
                        self.request_redraw();
                    }
                    _ => {}
                }
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                self.request_redraw()
            }
            WindowEvent::RedrawRequested => self.redraw(),
            _ => {}
        }
    }
}

impl App {
    fn session_drawing(&self) -> bool {
        self.session.active_points().is_some()
    }

    fn request_redraw(&self) {
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }

    fn redraw(&mut self) {
        let (Some(window), Some(presenter)) = (self.window.as_ref(), self.presenter.as_mut())
        else {
            return;
        };
        let size = window.inner_size();
        let (Some(width), Some(height)) =
            (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
        else {
            return;
        };
        window.set_title(&format!(
            "FaNotes paper — {:.0}% — draw, wheel zoom, middle pan, Ctrl+Z undo, Ctrl+S save",
            self.session.zoom() * 100.0
        ));
        // One camera per frame drives ink, ruling and tiles.
        let camera = self.session.camera(size.width, size.height);
        match presenter {
            Presenter::Gpu(renderer) => {
                self.scene
                    .sync_ink(self.session.doc(), camera.device_scale());
                renderer.resize(size.width, size.height);
                if let Err(error) = renderer.render(&self.scene, &camera) {
                    eprintln!("frame failed: {error}");
                }
            }
            Presenter::Cpu {
                renderer, surface, ..
            } => {
                self.scene
                    .sync_ink(self.session.doc(), camera.device_scale());
                if surface.resize(width, height).is_err() {
                    return;
                }
                if renderer.render(&self.scene, &camera).is_err() {
                    return;
                }
                let Ok(frame) = renderer.read_rgba() else {
                    return;
                };
                let Ok(mut buffer) = surface.buffer_mut() else {
                    return;
                };
                for (pixel, rgba) in buffer.iter_mut().zip(frame.data.as_chunks::<4>().0) {
                    *pixel = (rgba[0] as u32) << 16 | (rgba[1] as u32) << 8 | rgba[2] as u32;
                }
                let _ = buffer.present();
            }
            Presenter::Softbuffer { surface, .. } => {
                if surface.resize(width, height).is_err() {
                    return;
                }
                let Ok(mut buffer) = surface.buffer_mut() else {
                    return;
                };
                legacy::paint(
                    &mut buffer,
                    size.width as i32,
                    size.height as i32,
                    &self.session,
                );
                let _ = buffer.present();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_parse() {
        let args = [
            "doc.json",
            "--cpu",
            "--headless-frames",
            "12",
            "--out",
            "f.png",
            "--size",
            "640x480",
        ];
        let options = parse_args(args.iter().map(|arg| arg.to_string())).expect("options");
        assert_eq!(options.mode, Mode::Cpu);
        assert_eq!(options.headless_frames, Some(12));
        assert_eq!(options.size, (640, 480));
        assert_eq!(options.file, Some(PathBuf::from("doc.json")));
        assert!(parse_args(["--nope".to_string()].into_iter()).is_err());
    }

    #[test]
    fn headless_frames_render_through_the_cpu_engine() {
        let options = Options {
            file: None,
            mode: Mode::Cpu,
            headless_frames: Some(60),
            out: None,
            size: (320, 240),
        };
        let report = headless::run(Session::new(), 60, &options).expect("headless");
        assert_eq!(report.frames, 60);
        assert!(report.strokes >= 1, "the script drew ink");
        assert!(report.ink_pixels > 0, "the last frame shows ink");
    }
}
