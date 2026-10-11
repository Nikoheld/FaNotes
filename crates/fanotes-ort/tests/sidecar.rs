//! The `fanotes-ocr` sidecar against the real ONNX Runtime 1.21.0 and the shipped FP32 PyLaia model.

mod common;

use std::{
    io::{BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

use common::{line, max_difference, model, runtime};
use fanotes_ort::{
    protocol::{read_frame, write_frame, Frame, Reply, Request},
    Prediction, ENGINE, ONNXRUNTIME_VERSION,
};

struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Sidecar {
    fn start(size: u64, sha256: &str) -> Self {
        let (path, _) = model();
        let mut child = Command::new(env!("CARGO_BIN_EXE_fanotes-ocr"))
            .arg("--model")
            .arg(&path)
            .args(["--size", &size.to_string(), "--sha256", sha256])
            .arg("--runtime")
            .arg(runtime())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, stdin, stdout }
    }

    fn send(&mut self, frame: &Frame) -> Reply {
        let stdin = self.stdin.as_mut().unwrap();
        write_frame(stdin, &frame.header, &frame.payload).unwrap();
        stdin.flush().unwrap();
        Reply::parse(&read_frame(&mut self.stdout).unwrap().expect("a reply")).unwrap()
    }

    fn ask(&mut self, id: &str, width: usize, threads: usize) -> Reply {
        self.send(&Request { id: id.to_owned(), width, threads, input: line(width) }.encode())
    }

    /// Linux: whether the given ONNX Runtime file is mapped, and the resident size, from `/proc`.
    #[cfg(target_os = "linux")]
    fn footprint(&self) -> (bool, u64) {
        let pid = self.child.id();
        let maps = std::fs::read_to_string(format!("/proc/{pid}/maps")).unwrap();
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
        let rss = status
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:"))
            .and_then(|value| value.split_whitespace().next()?.parse().ok())
            .unwrap();
        let library = runtime().canonicalize().unwrap();
        (maps.contains(library.to_str().unwrap()), rss)
    }

    fn finish(mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        self.child.wait().unwrap()
    }
}

fn prediction(reply: Reply, id: &str) -> Prediction {
    match reply {
        Reply::Prediction { id: got, prediction, engine } => {
            assert_eq!((got.as_str(), engine.as_str()), (id, ENGINE));
            prediction
        }
        Reply::Error { message, .. } => panic!("{id}: {message}"),
    }
}

fn error(reply: Reply, id: &str) -> String {
    match reply {
        Reply::Error { id: got, message } => {
            assert_eq!(got, id);
            message
        }
        other => panic!("{id}: expected an error, got {other:?}"),
    }
}

#[test]
fn the_sidecar_loads_nothing_until_the_first_line() {
    let (_, descriptor) = model();
    let mut sidecar = Sidecar::start(descriptor.size(), &descriptor.sha256_hex());
    std::thread::sleep(std::time::Duration::from_millis(300));
    #[cfg(target_os = "linux")]
    let (mapped, idle_rss) = sidecar.footprint();
    #[cfg(target_os = "linux")]
    assert!(!mapped && idle_rss < 16 * 1024, "idle sidecar: runtime mapped {mapped}, {idle_rss} kB resident");

    let refused = sidecar.send(&Frame {
        header: br#"{"id":"short","width":32,"height":64,"threads":2}"#.to_vec(),
        payload: vec![0; 32 * 64 * 4],
    });
    assert_eq!(error(refused, "short"), "Die native OCR-Eingabe ist ungültig.");
    #[cfg(target_os = "linux")]
    assert!(!sidecar.footprint().0, "a refused request must not load the runtime");

    let two = prediction(sidecar.ask("first", 333, 2), "first");
    assert_eq!(two.dims, [1, 41, 81]);
    #[cfg(target_os = "linux")]
    {
        let (mapped, rss) = sidecar.footprint();
        assert!(mapped && rss > idle_rss + 20 * 1024, "after the first line: runtime mapped {mapped}, {rss} kB resident");
    }
    let one = prediction(sidecar.ask("rebuilt", 333, 1), "rebuilt");
    assert!(max_difference(&one, &two) < 1e-4);
    let again = prediction(sidecar.ask("again", 333, 1), "again");
    assert_eq!(again, one, "the same session gives the same bits");
    assert!(sidecar.finish().success(), "closing stdin ends the sidecar cleanly");
}

#[test]
fn the_sidecar_refuses_weights_that_do_not_match_the_manifest() {
    let (_, descriptor) = model();
    let digest = descriptor.sha256_hex();
    let tampered = format!("{}{}", if digest.starts_with('0') { '1' } else { '0' }, &digest[1..]);
    let mut sidecar = Sidecar::start(descriptor.size(), &tampered);
    for attempt in ["first", "second"] {
        assert_eq!(error(sidecar.ask(attempt, 32, 2), attempt), "Das native Handschriftmodell ist beschädigt.");
    }
    #[cfg(target_os = "linux")]
    assert!(!sidecar.footprint().0, "a tampered model must stop before ONNX Runtime is loaded");
    assert!(sidecar.finish().success());

    let mut sidecar = Sidecar::start(descriptor.size() - 1, &digest);
    assert_eq!(error(sidecar.ask("short", 32, 2), "short"), "Das native Handschriftmodell ist unvollständig.");
    assert!(sidecar.finish().success());
}

#[test]
fn bad_arguments_exit_with_usage_and_version_names_the_engine() {
    let binary = env!("CARGO_BIN_EXE_fanotes-ocr");
    let usage = Command::new(binary).args(["--model", "pylaia-iam.onnx"]).output().unwrap();
    assert_eq!(usage.status.code(), Some(64));
    let unknown = Command::new(binary).args(["--threads", "2"]).output().unwrap();
    assert_eq!(unknown.status.code(), Some(64));
    let version = Command::new(binary).arg("--version").output().unwrap();
    let text = String::from_utf8(version.stdout).unwrap();
    assert!(version.status.success() && text.contains(ENGINE) && text.contains(ONNXRUNTIME_VERSION), "{text}");
}

#[test]
fn a_broken_frame_stream_ends_the_sidecar_with_an_error() {
    let (_, descriptor) = model();
    let mut sidecar = Sidecar::start(descriptor.size(), &descriptor.sha256_hex());
    let stdin = sidecar.stdin.as_mut().unwrap();
    stdin.write_all(&u32::MAX.to_le_bytes()).unwrap();
    stdin.flush().unwrap();
    assert_eq!(sidecar.finish().code(), Some(65));
}
