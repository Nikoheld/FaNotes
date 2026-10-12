use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

fn host() -> Host {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-ai-{}-{id}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("vault")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(dir.join("vault")).unwrap();
    host
}

fn serve_ollama() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for _ in 0..2 {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            let request = String::from_utf8_lossy(&buffer);
            let body = if request.starts_with("POST /api/chat") {
                r##"{"message":{"content":"# Fertig"}}"##
            } else {
                r#"{"models":[{"name":"llama3"}]}"#
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    format!("http://127.0.0.1:{port}")
}

#[test]
fn an_advertised_ai_response_above_the_desktop_limit_is_refused() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer);
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 9000000\r\nConnection: close\r\n\r\n{}";
        let _ = stream.write_all(response.as_bytes());
    });
    let mut host = host();
    let error = host
        .dispatch(
            "fanotes:ai-list-models",
            &[json!({
                "provider": "ollama",
                "baseUrl": format!("http://127.0.0.1:{port}"),
                "apiKey": "",
                "model": "",
            })],
        )
        .unwrap_err();
    assert!(error.contains("unerwartet große"), "{error}");
}

#[test]
fn an_empty_ollama_reply_uses_the_desktop_message() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer);
        let body = r#"{"message":{"content":""}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
    });
    let mut host = host();
    let error = host
        .dispatch(
            "fanotes:ai-transform",
            &[json!({
                "connection": {
                    "provider": "ollama",
                    "baseUrl": format!("http://127.0.0.1:{port}"),
                    "apiKey": "",
                    "model": "llama3",
                },
                "markdown": "Hallo",
                "actions": ["spelling"],
                "instruction": "",
            })],
        )
        .unwrap_err();
    assert_eq!(
        error,
        "Der AI-Anbieter hat kein verwendbares Markdown-Dokument zurückgegeben."
    );
}

#[test]
fn ollama_lists_a_model_and_returns_markdown() {
    let origin = serve_ollama();
    let mut host = host();
    let models = host
        .dispatch(
            "fanotes:ai-list-models",
            &[json!({
                "provider": "ollama",
                "baseUrl": origin,
                "apiKey": "",
                "model": "",
            })],
        )
        .unwrap();
    assert_eq!(models[0]["key"], "llama3");
    assert_eq!(models[0]["provider"], "ollama");

    let result = host
        .dispatch(
            "fanotes:ai-transform",
            &[json!({
                "connection": {
                    "provider": "ollama",
                    "baseUrl": origin,
                    "apiKey": "",
                    "model": "llama3",
                },
                "markdown": "Hallo",
                "actions": ["spelling"],
                "instruction": "",
            })],
        )
        .unwrap();
    assert_eq!(result["markdown"], "# Fertig");
    assert_eq!(result["provider"], "ollama");
    assert_eq!(result["model"], "llama3");
}

#[test]
fn opencode_lists_models_from_its_local_provider_api() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for _ in 0..2 {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let mut buffer = [0u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut buffer);
            let request = String::from_utf8_lossy(&buffer);
            let body = if request.contains("GET /provider") {
                r#"{"all":[{"id":"openai","name":"OpenAI","models":{"gpt":{"name":"GPT"}}}]}"#
            } else {
                r#"{"healthy":true}"#
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
        }
    });
    let mut host = host();
    let models = host
        .dispatch(
            "fanotes:ai-list-models",
            &[json!({
                "provider": "opencode",
                "baseUrl": format!("http://127.0.0.1:{port}"),
                "apiKey": "",
                "model": "",
            })],
        )
        .unwrap();
    assert_eq!(models[0]["key"], "openai/gpt");
    assert_eq!(models[0]["displayName"], "OpenAI · GPT");
    assert!(host
        .dispatch(
            "fanotes:ai-list-models",
            &[json!({ "provider": "openai", "apiKey": "", "model": "" })],
        )
        .is_err());
}
