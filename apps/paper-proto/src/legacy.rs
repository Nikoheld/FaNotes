//! The original softbuffer painter: one-pixel Bresenham polylines, kept as `--softbuffer`.

use fanotes_ink::StrokePoint;

use crate::session::Session;

/// Paint the session into a 0RGB buffer.
pub fn paint(buffer: &mut [u32], pixel_width: i32, pixel_height: i32, session: &Session) {
    buffer.fill(0x00FF_FFFF);
    draw_ruling(buffer, pixel_width, pixel_height, session);
    for id in session.live_ids().to_vec() {
        if let Some(points) = session.stroke_points(id) {
            let color = parse_color(session.stroke_color(id).unwrap_or("#1a1a1a"));
            draw_stroke(buffer, pixel_width, pixel_height, session, points, color);
        }
    }
    if let Some(points) = session.active_points() {
        draw_stroke(
            buffer,
            pixel_width,
            pixel_height,
            session,
            points,
            0x001A_1A1A,
        );
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
