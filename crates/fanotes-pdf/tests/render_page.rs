use fanotes_pdf::{render_pdf_page, RenderRequest};

/// One page, 200×100 pt. The left half is filled black.
fn left_half_black_pdf() -> Vec<u8> {
    let stream = "0 0 0 rg\n0 0 100 100 re\nf";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /ProcSet [/PDF] >> >>"
            .to_owned(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
    ];
    let mut out = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend_from_slice(body.as_bytes());
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    let mut trailer = format!("xref\n0 {}\n", objects.len() + 1);
    trailer.push_str("0000000000 65535 f \n");
    for offset in &offsets {
        trailer.push_str(&format!("{offset:010} 00000 n \n"));
    }
    trailer.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
    ));
    out.extend_from_slice(trailer.as_bytes());
    out
}

fn request(
    pixel_width: i32,
    pixel_height: i32,
    page_pixel_width: i32,
    page_pixel_height: i32,
    origin_x: i32,
    origin_y: i32,
) -> RenderRequest {
    RenderRequest {
        page_index: 0,
        pixel_width,
        pixel_height,
        page_pixel_width,
        page_pixel_height,
        origin_x,
        origin_y,
        rotation: 0,
        password: String::new(),
    }
}

fn pixel(bitmap: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let index = ((y * width + x) * 4) as usize;
    [
        bitmap[index],
        bitmap[index + 1],
        bitmap[index + 2],
        bitmap[index + 3],
    ]
}

fn black(pixel: [u8; 4]) -> bool {
    pixel[0] < 16 && pixel[1] < 16 && pixel[2] < 16 && pixel[3] == 255
}

fn white(pixel: [u8; 4]) -> bool {
    pixel[0] > 240 && pixel[1] > 240 && pixel[2] > 240 && pixel[3] == 255
}

#[test]
fn renders_a_page_at_the_requested_size_and_crop() {
    let pdf = left_half_black_pdf();
    let full = render_pdf_page(&pdf, &request(200, 100, 200, 100, 0, 0)).expect("full page");
    assert_eq!(
        (full.width, full.height, full.rgba.len()),
        (200, 100, 200 * 100 * 4)
    );
    assert!(
        black(pixel(&full.rgba, full.width, 20, 50)),
        "left half stays black"
    );
    assert!(
        white(pixel(&full.rgba, full.width, 180, 50)),
        "right half stays white"
    );

    let left = render_pdf_page(&pdf, &request(100, 100, 200, 100, 0, 0)).expect("left window");
    assert_eq!((left.width, left.height), (100, 100));
    assert!(black(pixel(&left.rgba, left.width, 10, 50)));

    let right = render_pdf_page(&pdf, &request(100, 100, 200, 100, 100, 0)).expect("right window");
    assert_eq!((right.width, right.height), (100, 100));
    assert!(white(pixel(&right.rgba, right.width, 10, 50)));

    let scaled = render_pdf_page(&pdf, &request(400, 200, 400, 200, 0, 0)).expect("2× page");
    assert_eq!((scaled.width, scaled.height), (400, 200));
    assert!(black(pixel(&scaled.rgba, scaled.width, 40, 100)));
    assert!(white(pixel(&scaled.rgba, scaled.width, 360, 100)));
}

#[test]
fn rotated_page_keeps_the_requested_bitmap_size() {
    let pdf = left_half_black_pdf();
    let mut job = request(100, 200, 100, 200, 0, 0);
    job.rotation = 90;
    let bitmap = render_pdf_page(&pdf, &job).expect("rotated page");
    assert_eq!(
        (bitmap.width, bitmap.height, bitmap.rgba.len()),
        (100, 200, 100 * 200 * 4)
    );
    assert_eq!(
        (bitmap.width, bitmap.height, bitmap.rgba.len()),
        (100, 200, 100 * 200 * 4)
    );
    assert!(
        black(pixel(&bitmap.rgba, bitmap.width, 50, 20)),
        "clockwise rotation moves the black half to the top"
    );
    assert!(
        white(pixel(&bitmap.rgba, bitmap.width, 50, 180)),
        "clockwise rotation moves the white half to the bottom"
    );
}

/// One page, 200×100 pt. The top-left quadrant is red and the bottom-right
/// quadrant is blue, so a turn, a crop, and the channel order all show.
fn quadrant_pdf(page_rotate: i32) -> Vec<u8> {
    let stream = "1 0 0 rg\n0 50 100 50 re\nf\n0 0 1 rg\n100 0 100 50 re\nf";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_owned(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate {page_rotate} /Contents 4 0 R /Resources << /ProcSet [/PDF] >> >>"
        ),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
    ];
    let mut out = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend_from_slice(body.as_bytes());
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    let mut trailer = format!("xref\n0 {}\n", objects.len() + 1);
    trailer.push_str("0000000000 65535 f \n");
    for offset in &offsets {
        trailer.push_str(&format!("{offset:010} 00000 n \n"));
    }
    trailer.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
    ));
    out.extend_from_slice(trailer.as_bytes());
    out
}

fn red(pixel: [u8; 4]) -> bool {
    pixel[0] > 240 && pixel[1] < 16 && pixel[2] < 16 && pixel[3] == 255
}

fn blue(pixel: [u8; 4]) -> bool {
    pixel[0] < 16 && pixel[1] < 16 && pixel[2] > 240 && pixel[3] == 255
}

fn turned(rotation: i32, width: i32, height: i32) -> RenderRequest {
    let (w, h) = if rotation % 180 == 0 { (width, height) } else { (height, width) };
    let mut job = request(w, h, w, h, 0, 0);
    job.rotation = rotation;
    job
}

#[test]
fn each_quarter_turn_moves_the_quadrants_clockwise() {
    let pdf = quadrant_pdf(0);
    // (rotation, red pixel, blue pixel) on a 200×100 page or its 100×200 turn.
    let cases = [
        (0, (50, 25), (150, 75)),
        (90, (75, 50), (25, 150)),
        (180, (150, 75), (50, 25)),
        (270, (25, 150), (75, 50)),
    ];
    for (rotation, (rx, ry), (bx, by)) in cases {
        let bitmap = render_pdf_page(&pdf, &turned(rotation, 200, 100)).expect("turned page");
        assert!(red(pixel(&bitmap.rgba, bitmap.width, rx, ry)), "{rotation}°: red quadrant");
        assert!(blue(pixel(&bitmap.rgba, bitmap.width, bx, by)), "{rotation}°: blue quadrant");
    }
}

#[test]
fn a_window_is_the_same_pixels_as_that_crop_of_the_page() {
    let pdf = quadrant_pdf(0);
    for rotation in [0, 90, 180, 270] {
        let full_job = turned(rotation, 400, 200);
        let full = render_pdf_page(&pdf, &full_job).expect("full page");
        for (x, y, w, h) in [(37, 23, 150, 90), (0, 0, 64, 64), (full.width as i32 - 50, full.height as i32 - 40, 50, 40)] {
            let mut job = full_job.clone();
            job.pixel_width = w;
            job.pixel_height = h;
            job.origin_x = x;
            job.origin_y = y;
            let window = render_pdf_page(&pdf, &job).expect("window");
            assert_eq!((window.width, window.height), (w as u32, h as u32));
            for row in 0..h as u32 {
                let from = (((y as u32 + row) * full.width + x as u32) * 4) as usize;
                let to = (row * w as u32 * 4) as usize;
                assert_eq!(
                    &window.rgba[to..to + w as usize * 4],
                    &full.rgba[from..from + w as usize * 4],
                    "{rotation}°: window at {x},{y} row {row}"
                );
            }
        }
    }
}

#[test]
fn a_toolbar_turn_adds_to_the_page_rotate() {
    let pdf = quadrant_pdf(90);
    let upright = render_pdf_page(&pdf, &request(100, 200, 100, 200, 0, 0)).expect("/Rotate 90");
    assert!(red(pixel(&upright.rgba, upright.width, 75, 50)), "/Rotate 90 alone turns the page clockwise");
    let mut job = request(200, 100, 200, 100, 0, 0);
    job.rotation = 90;
    let half = render_pdf_page(&pdf, &job).expect("/Rotate 90 + toolbar 90");
    assert!(red(pixel(&half.rgba, half.width, 150, 75)), "/Rotate 90 and a 90° toolbar turn make a half turn");
    assert!(blue(pixel(&half.rgba, half.width, 50, 25)));
}

#[test]
fn a_window_past_the_page_edge_is_white() {
    let pdf = quadrant_pdf(0);
    let window = render_pdf_page(&pdf, &request(60, 40, 200, 100, 170, 70)).expect("edge window");
    assert!(blue(pixel(&window.rgba, window.width, 10, 10)), "inside the page");
    assert!(white(pixel(&window.rgba, window.width, 50, 35)), "past the page edge");
}
