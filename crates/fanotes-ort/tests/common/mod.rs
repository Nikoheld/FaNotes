#![allow(dead_code)]

use std::{fs, path::PathBuf};

use fanotes_ort::{default_runtime_file, ModelDescriptor, Prediction};

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The library `onnxruntime-node@1.21.0` installs; `FANOTES_ORT_RUNTIME` overrides it.
pub fn runtime() -> PathBuf {
    if let Ok(path) = std::env::var("FANOTES_ORT_RUNTIME") {
        return path.into();
    }
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let path = repo()
        .join("fanotes/node_modules/onnxruntime-node/bin/napi-v3")
        .join(platform)
        .join(arch)
        .join(default_runtime_file());
    assert!(path.is_file(), "ONNX Runtime missing at {}; run `npm ci` in fanotes/", path.display());
    path
}

pub fn model() -> (PathBuf, ModelDescriptor) {
    let directory = repo().join("fanotes/public/ocr");
    let descriptor = ModelDescriptor::from_manifest(&fs::read_to_string(directory.join("manifest.json")).unwrap()).unwrap();
    (directory.join(descriptor.file()), descriptor)
}

/// Bright vertical strokes on a dark band, the polarity `lineTensorInput` feeds the model.
pub fn line(width: usize) -> Vec<f32> {
    (0..128 * width)
        .map(|index| {
            let (y, x) = (index / width, index % width);
            if (40..88).contains(&y) && (x / 6) % 3 == 0 { 1.0 } else { 0.0 }
        })
        .collect()
}

pub fn max_difference(a: &Prediction, b: &Prediction) -> f32 {
    assert_eq!(a.dims, b.dims);
    a.probabilities.iter().zip(&b.probabilities).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}
