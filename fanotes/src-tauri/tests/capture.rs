#[test]
fn a_window_snapshot_is_a_small_jpeg() {
    let image = fanotes_tauri::capture_html(
        "<html><body style='background:#123456;color:white'><h1>FaNotes</h1></body></html>",
    )
    .unwrap();
    assert!(image.starts_with("data:image/jpeg;base64,/9j/"));
    assert!(image.len() < 250_000);
}
