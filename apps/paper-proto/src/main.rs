//! Standalone paper surface.
//!
//! Left drag draws. The wheel zooms around the cursor. Middle drag pans.
//! Backspace erases the last stroke. Ctrl+Z undoes, Ctrl+Y redoes, Ctrl+S saves.
//! A page grow remaps the point arena, including strokes that only undo still holds.

mod session;

use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::Arc;

use fanotes_ink::StrokePoint;
use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::{Window, WindowAttributes, WindowId};

use session::Session;

fn main() {
    let mut session = match std::env::args().nth(1) {
        Some(path) => {
            let path = PathBuf::from(path);
            if path.is_file() {
                match Session::open(&path) {
                    Ok(session) => session,
                    Err(error) => {
                        eprintln!("could not load {}: {error}", path.display());
                        std::process::exit(1);
                    }
                }
            } else {
                let mut session = Session::new();
                session.set_path(path);
                session
            }
        }
        None => Session::new(),
    };
    let event_loop = EventLoop::new().expect("event loop");
    event_loop.set_control_flow(ControlFlow::Wait);
    let mut app = App {
        window: None,
        context: None,
        surface: None,
        session: std::mem::take(&mut session),
        modifiers: ModifiersState::empty(),
        cursor: (0.0, 0.0),
        panning: false,
        last_pan: None,
    };
    event_loop.run_app(&mut app).expect("window");
}

struct App {
    window: Option<Arc<Window>>,
    context: Option<Context<Arc<Window>>>,
    surface: Option<Surface<Arc<Window>, Arc<Window>>>,
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
        let context = Context::new(window.clone()).expect("softbuffer context");
        let surface = Surface::new(&context, window.clone()).expect("softbuffer surface");
        self.window = Some(window);
        self.context = Some(context);
        self.surface = Some(surface);
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
        let (Some(window), Some(surface)) = (self.window.as_ref(), self.surface.as_mut()) else {
            return;
        };
        let size = window.inner_size();
        let (Some(width), Some(height)) =
            (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
        else {
            return;
        };
        if surface.resize(width, height).is_err() {
            return;
        }
        window.set_title(&format!(
            "FaNotes paper — {:.0}% — draw, wheel zoom, middle pan, Ctrl+Z undo, Ctrl+S save",
            self.session.zoom() * 100.0
        ));
        let mut buffer = match surface.buffer_mut() {
            Ok(buffer) => buffer,
            Err(_) => return,
        };
        let pixel_width = size.width as i32;
        let pixel_height = size.height as i32;
        buffer.fill(0x00FF_FFFF);
        draw_ruling(&mut buffer, pixel_width, pixel_height, &self.session);
        for id in self.session.live_ids().to_vec() {
            if let Some(points) = self.session.stroke_points(id) {
                let color = parse_color(self.session.stroke_color(id).unwrap_or("#1a1a1a"));
                draw_stroke(
                    &mut buffer,
                    pixel_width,
                    pixel_height,
                    &self.session,
                    points,
                    color,
                );
            }
        }
        if let Some(points) = self.session.active_points() {
            draw_stroke(
                &mut buffer,
                pixel_width,
                pixel_height,
                &self.session,
                points,
                0x001A_1A1A,
            );
        }
        let _ = buffer.present();
    }
}

fn draw_ruling(buffer: &mut [u32], width: i32, height: i32, session: &Session) {
    let step = 32.0;
    let mut y = 0.0;
    while y < session.page_height() {
        let screen = session.page_to_screen(0.0, y / session.page_height());
        hline(buffer, width, height, screen.1.round() as i32, 0x00EE_E8DE);
        y += step;
    }
}

fn draw_stroke(
    buffer: &mut [u32],
    width: i32,
    height: i32,
    session: &Session,
    points: &[StrokePoint],
    color: u32,
) {
    let screen: Vec<(i32, i32)> = points
        .iter()
        .map(|point| {
            let (x, y) = session.page_to_screen(point.x, point.y);
            (x.round() as i32, y.round() as i32)
        })
        .collect();
    if screen.len() == 1 {
        put(buffer, width, height, screen[0].0, screen[0].1, color);
        return;
    }
    for pair in screen.windows(2) {
        line(
            buffer, width, height, pair[0].0, pair[0].1, pair[1].0, pair[1].1, color,
        );
    }
}

fn hline(buffer: &mut [u32], width: i32, height: i32, y: i32, color: u32) {
    if y < 0 || y >= height {
        return;
    }
    for x in 0..width {
        put(buffer, width, height, x, y, color);
    }
}

#[allow(clippy::too_many_arguments)]
fn line(
    buffer: &mut [u32],
    width: i32,
    height: i32,
    mut x0: i32,
    mut y0: i32,
    x1: i32,
    y1: i32,
    color: u32,
) {
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;
    loop {
        put(buffer, width, height, x0, y0, color);
        if x0 == x1 && y0 == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x0 += sx;
        }
        if e2 <= dx {
            err += dx;
            y0 += sy;
        }
    }
}

fn put(buffer: &mut [u32], width: i32, height: i32, x: i32, y: i32, color: u32) {
    if x < 0 || y < 0 || x >= width || y >= height {
        return;
    }
    buffer[(y as u32 * width as u32 + x as u32) as usize] = color;
}

fn parse_color(text: &str) -> u32 {
    let bytes = text.as_bytes();
    if bytes.len() == 7 && bytes[0] == b'#' {
        if let Ok(value) = u32::from_str_radix(&text[1..], 16) {
            return value;
        }
    }
    0x001A_1A1A
}
