//! PDF page textures (feature `pdf`): PDFium pixels under ink, one camera.
#![cfg(feature = "pdf")]

use fanotes_gpu::pdf::{open_pdf, pdf_page_image};
use fanotes_gpu::{
    Camera, CpuRenderer, InkPoint, InkStroke, PageScene, PaperStyle, ReferenceRenderer, Renderer,
};
use kurbo::Rect;

/// One page, 200 × 100 pt. The left half is filled black (same file as fanotes-pdf's test).
fn left_half_black_pdf() -> Vec<u8> {
    let stream = "0 0 0 rg\n0 0 100 100 re\nf";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /ProcSet [/PDF] >> >>"
            .to_owned(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", index + 1).as_bytes());
    }
    let xref = out.len();
    let mut trailer = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
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

#[test]
fn a_pdf_page_moves_with_the_ink_under_one_camera() {
    let opened = open_pdf(left_half_black_pdf(), "").expect("pdf");
    let rect = Rect::new(50.0, 40.0, 450.0, 240.0);
    let page = pdf_page_image(&opened, 0, rect, 1.0, 7).expect("raster");
    assert_eq!((page.image.width, page.image.height), (400, 200));
    let mut scene = PageScene::new(900.0, 1273.0);
    scene.paper = PaperStyle::Blank;
    scene.set_images(vec![page]);
    scene.add_stroke(InkStroke::pen(
        vec![
            InkPoint {
                x: 300.0,
                y: 140.0,
                pressure: 0.5,
            },
            InkPoint {
                x: 420.0,
                y: 140.0,
                pressure: 0.5,
            },
        ],
        6.0,
        0xc0392b,
    ));
    for zoom in [1.0, 1.5] {
        let mut camera = Camera::new(500, 300);
        camera.zoom = zoom;
        camera.scroll_x = 20.0;
        let mut cpu = CpuRenderer::new(None);
        cpu.render(&scene, &camera).expect("cpu");
        let frame = cpu.read_rgba().expect("frame");
        // Left half of the PDF page is black, right half white, ink red on top.
        let at = |x: f64, y: f64| {
            let p = camera.page_to_device_point(x, y);
            assert!(
                p.x >= 0.0 && p.y >= 0.0 && p.x < 500.0 && p.y < 300.0,
                "({x}, {y}) is off screen"
            );
            frame.pixel(p.x as u32, p.y as u32)
        };
        assert!(at(100.0, 100.0)[0] < 30, "black PDF half");
        assert!(at(320.0, 80.0)[0] > 225, "white PDF half");
        let ink = at(320.0, 140.0);
        assert!(
            ink[0] > 150 && ink[1] < 90,
            "red ink over the page: {ink:?}"
        );
        let mut reference = ReferenceRenderer::new();
        reference.render(&scene, &camera).expect("reference");
        let diff = reference.read_rgba().unwrap().diff(&frame);
        assert!(diff.mean < 1.5, "zoom {zoom}: {diff:?}");
    }
}
