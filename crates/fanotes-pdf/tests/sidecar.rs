use std::io::{BufReader, Read, Write};
use std::process::{Command, Stdio};

use fanotes_pdf::{read_frame, write_frame};

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
        out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend_from_slice(body.as_bytes());
        out.extend_from_slice(b"\nendobj\n");
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

fn exchange(
    child_in: &mut impl Write,
    child_out: &mut impl Read,
    header: &str,
    payload: &[u8],
) -> (serde_json::Value, Vec<u8>) {
    write_frame(child_in, header.as_bytes(), payload).unwrap();
    let frame = read_frame(child_out).unwrap().unwrap();
    let header = serde_json::from_slice(&frame.header).unwrap();
    (header, frame.payload)
}

#[test]
fn sidecar_renders_the_requested_window() {
    let exe = env!("CARGO_BIN_EXE_fanotes-pdfium");
    let mut child = Command::new(exe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn fanotes-pdfium");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let pdf = left_half_black_pdf();
    let (opened, _) = exchange(
        &mut stdin,
        &mut stdout,
        r#"{"id":1,"op":"open","key":"note.pdf"}"#,
        &pdf,
    );
    assert_eq!(opened["ok"], true);

    let (rendered, rgba) = exchange(
        &mut stdin,
        &mut stdout,
        r#"{"id":2,"op":"render","key":"note.pdf","pageIndex":0,"pixelWidth":100,"pixelHeight":100,"pagePixelWidth":200,"pagePixelHeight":100,"originX":0,"originY":0,"rotation":0}"#,
        b"",
    );
    assert_eq!(rendered["ok"], true);
    assert_eq!(rendered["width"], 100);
    assert_eq!(rendered["height"], 100);
    assert_eq!(rgba.len(), 100 * 100 * 4);
    assert!(rgba[0] < 16 && rgba[1] < 16 && rgba[2] < 16);

    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success());
}
