//! Small PDFs written by hand, so no binary fixture is needed for the input.
#![allow(dead_code)]

/// A PDF with one page per content stream, `width`×`height` pt each, with
/// Helvetica as `/F1` and Helvetica-Bold as `/F2`.
pub fn pdf_with_pages(width: u32, height: u32, streams: &[String]) -> Vec<u8> {
    let count = streams.len();
    // 1 catalog, 2 pages, 3 F1, 4 F2, then page/content pairs.
    let kids: Vec<String> = (0..count)
        .map(|index| format!("{} 0 R", 5 + index * 2))
        .collect();
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        format!(
            "<< /Type /Pages /Count {count} /Kids [{}] >>",
            kids.join(" ")
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_owned(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
            .to_owned(),
    ];
    for (index, stream) in streams.iter().enumerate() {
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents {} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>",
            6 + index * 2
        ));
        objects.push(format!(
            "<< /Length {} >>\nstream\n{stream}\nendstream",
            stream.len()
        ));
    }
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

/// A worksheet-like page (300×200 pt): a bold title, body text, ruled
/// answer lines, a filled box, a stroked circle, and a thin grid.
pub fn worksheet_stream(page: usize) -> String {
    let mut stream = String::new();
    stream.push_str("0.94 0.96 1 rg 12 12 276 40 re f\n");
    stream.push_str("0.1 0.2 0.6 RG 1.5 w 12 12 276 40 re S\n");
    stream.push_str(&format!(
        "BT /F2 16 Tf 0.1 0.1 0.15 rg 16 176 Td (Arbeitsblatt {page}: Br\\374che) Tj ET\n"
    ));
    stream.push_str("BT /F1 9 Tf 0 0 0 rg 16 160 Td (Berechne die Summe und k\\374rze das Ergebnis.) Tj 0 -12 Td (a\\) 3/4 + 1/8 =        b\\) 2/3 + 5/6 =) Tj ET\n");
    stream.push_str("0.6 0.6 0.6 RG 0.5 w\n");
    for line in 0..4 {
        let y = 120 - line * 16;
        stream.push_str(&format!("16 {y} m 200 {y} l S\n"));
    }
    stream.push_str("0.85 0.2 0.1 RG 2 w 250 100 m 250 116.6 236.6 130 220 130 c 203.4 130 190 116.6 190 100 c 190 83.4 203.4 70 220 70 c 236.6 70 250 83.4 250 100 c S\n");
    stream.push_str("0.2 0.6 0.3 rg 236 140 40 24 re f\n");
    stream.push_str(
        "BT /F1 7 Tf 0.3 0.3 0.3 rg 20 28 Td (Name: ______________   Klasse: ____) Tj ET\n",
    );
    stream
}
