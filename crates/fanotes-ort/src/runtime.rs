use std::{
    path::Path,
    sync::{Arc, OnceLock},
};

use ort::logging::LogLevel;

use crate::Error;

static RUNTIME: OnceLock<Result<(), String>> = OnceLock::new();

/// File name of the ONNX Runtime library that `onnxruntime-node@1.21.0` ships for this platform. The
/// sidecar expects it next to its own executable.
pub fn default_runtime_file() -> &'static str {
    if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.1.21.0.dylib"
    } else {
        "libonnxruntime.so.1"
    }
}

/// Loads ONNX Runtime from `path` once per process, with telemetry off and only errors logged (the
/// worker set `ort.env.logLevel = 'error'`).
///
/// `ort` refuses a library older than the C API it was built for (`api-21`, ONNX Runtime 1.21). The
/// exact file is pinned by the SHA-256 in `fanotes/native-ocr/<platform>/runtime-manifest.json`.
pub fn load_runtime(path: &Path) -> Result<(), Error> {
    RUNTIME
        .get_or_init(|| {
            let builder = ort::init_from(path).map_err(|error| error.to_string())?;
            builder
                .with_name("fanotes-ort")
                .with_telemetry(false)
                .with_logger(Arc::new(log_errors))
                .commit();
            Ok(())
        })
        .clone()
        .map_err(Error::Runtime)
}

/// Ends a process that has called [`load_runtime`], skipping exit-time destructors.
///
/// `ort` releases its environment from a `.fini_array` / TLS hook in the executable. With a runtime
/// loaded at run time, the loader finalizes ONNX Runtime before that hook, so a regular exit after a
/// session was created crashes inside `ReleaseEnv`. Flush everything that must survive first.
pub fn exit_process(code: u8) -> ! {
    #[cfg(unix)]
    {
        extern "C" {
            fn _exit(status: i32) -> !;
        }
        unsafe { _exit(i32::from(code)) }
    }
    #[cfg(windows)]
    {
        extern "system" {
            fn GetCurrentProcess() -> *mut std::ffi::c_void;
            fn TerminateProcess(process: *mut std::ffi::c_void, code: u32) -> i32;
        }
        unsafe { TerminateProcess(GetCurrentProcess(), u32::from(code)) };
        std::process::abort()
    }
}

fn log_errors(level: LogLevel, category: &str, _id: &str, location: &str, message: &str) {
    if level >= LogLevel::Error {
        eprintln!("[onnxruntime {category}] {location}: {message}");
    }
}
