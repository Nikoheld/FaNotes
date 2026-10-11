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
