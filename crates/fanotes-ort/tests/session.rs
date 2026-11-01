//! In-process checks of [`PylaiaSession`]. Runs without libtest: once ONNX Runtime is loaded, the process
//! has to end through [`exit_process`], which libtest cannot do between tests.

mod common;

use std::panic;

use common::{line, max_difference, model, runtime};
use fanotes_ort::{exit_process, load_runtime, verify_model_file, PylaiaSession};

fn checks() {
    load_runtime(&runtime()).unwrap();
    let (path, descriptor) = model();
    let weights = verify_model_file(&path, &descriptor).unwrap();
    let mut session = PylaiaSession::new(&weights, 2).unwrap();
    assert_eq!(session.threads(), 2);
    for (width, steps) in [(32, 4), (100, 12), (333, 41), (4096, 512)] {
        let prediction = session
            .run(width, 128, "x", "probabilities", &line(width))
            .unwrap();
        assert_eq!(prediction.dims, [1, steps, 81], "width {width}");
        for step in prediction.probabilities.chunks(81) {
            assert!(step.iter().all(|p| p.is_finite() && *p >= 0.0));
            assert!((step.iter().sum::<f32>() - 1.0).abs() < 1e-3);
        }
    }
    let one = PylaiaSession::new(&weights, 1)
        .unwrap()
        .run(333, 128, "x", "probabilities", &line(333))
        .unwrap();
    let four = PylaiaSession::new(&weights, 4)
        .unwrap()
        .run(333, 128, "x", "probabilities", &line(333))
        .unwrap();
    assert!(max_difference(&one, &four) < 1e-4);
    assert!(PylaiaSession::new(&weights, 0).is_err());
    assert!(PylaiaSession::new(&weights, 5).is_err());
    assert!(session
        .run(15, 128, "x", "probabilities", &line(15))
        .is_err());
    assert!(session
        .run(32, 128, "x", "probabilities", &line(33))
        .is_err());
    assert!(session
        .run(4097, 128, "x", "probabilities", &line(4097))
        .is_err());
}

fn main() {
    let passed = panic::catch_unwind(checks).is_ok();
    println!("session: {}", if passed { "ok" } else { "FAILED" });
    exit_process(if passed { 0 } else { 101 })
}
