//! `fanotes-ocr`: the native line-OCR sidecar. `fanotes/electron/native-ocr.cjs` starts it on the first
//! conversion and exchanges [`fanotes_ort::protocol`] frames with it over stdin/stdout. ONNX Runtime and
//! the model are not touched before the first line arrives. The process exits when stdin closes.
//!
//! ```text
//! fanotes-ocr --model <path> --size <bytes> --sha256 <hex> [--runtime <onnxruntime library>]
//! ```
//!
//! Without `--runtime`, the ONNX Runtime library is expected next to this executable.

use std::{
    env,
    io::{self, BufReader, BufWriter},
    path::PathBuf,
    process::ExitCode,
};

use fanotes_ort::{
    default_runtime_file, exit_process, load_runtime,
    protocol::{read_frame, write_frame, Frame, Reply, Request},
    verify_model_file, Error, ModelDescriptor, PylaiaSession, ENGINE, ONNXRUNTIME_VERSION,
};

const USAGE: &str =
    "usage: fanotes-ocr --model <path> --size <bytes> --sha256 <hex> [--runtime <library>]";

struct Options {
    model: PathBuf,
    descriptor: ModelDescriptor,
    runtime: PathBuf,
}

fn parse_options(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    let (mut model, mut size, mut sha256, mut runtime) = (None, None, None, None);
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--model" => model = Some(PathBuf::from(value)),
            "--size" => {
                size = Some(
                    value
                        .parse::<u64>()
                        .map_err(|_| "--size must be a byte count".to_owned())?,
                )
            }
            "--sha256" => sha256 = Some(value),
            "--runtime" => runtime = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    let model = model.ok_or("--model is required")?;
    let file = model
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("--model must name a file")?
        .to_owned();
    let descriptor = ModelDescriptor::new(
        &file,
        size.ok_or("--size is required")?,
        &sha256.ok_or("--sha256 is required")?,
    )
    .map_err(|error| error.to_string())?;
    let runtime = match runtime {
        Some(runtime) => runtime,
        None => env::current_exe()
            .ok()
            .and_then(|executable| Some(executable.parent()?.join(default_runtime_file())))
            .ok_or("cannot locate the ONNX Runtime library next to fanotes-ocr")?,
    };
    Ok(Options {
        model,
        descriptor,
        runtime,
    })
}

struct Recognizer {
    options: Options,
    session: Option<PylaiaSession>,
}

impl Recognizer {
    /// The first line checks the weights against the manifest digest, then loads the runtime and builds
    /// the session from the checked bytes. A different thread count rebuilds it, as the worker did.
    fn session(&mut self, threads: usize) -> Result<&mut PylaiaSession, Error> {
        if self
            .session
            .as_ref()
            .is_some_and(|session| session.threads() != threads)
        {
            self.session = None;
        }
        if self.session.is_none() {
            let model = verify_model_file(&self.options.model, &self.options.descriptor)?;
            load_runtime(&self.options.runtime)?;
            self.session = Some(PylaiaSession::new(&model, threads)?);
        }
        Ok(self.session.as_mut().expect("session was just created"))
    }

    fn reply(&mut self, frame: &Frame) -> Frame {
        let request = match Request::parse(frame) {
            Ok(request) => request,
            Err((id, error)) => return Reply::error(&id, &error),
        };
        let outcome = self.session(request.threads).and_then(|session| {
            session.run(
                request.width,
                request.height,
                &request.input_name,
                &request.output_name,
                &request.input,
            )
        });
        match outcome {
            Ok(prediction) => Reply::prediction(&request.id, &prediction),
            Err(error) => Reply::error(&request.id, &error),
        }
    }
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1).peekable();
    if args.peek().map(String::as_str) == Some("--version") {
        println!(
            "fanotes-ocr {} ({ENGINE}, ONNX Runtime {ONNXRUNTIME_VERSION})",
            env!("CARGO_PKG_VERSION")
        );
        return ExitCode::SUCCESS;
    }
    let options = match parse_options(args) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("fanotes-ocr: {message}\n{USAGE}");
            return ExitCode::from(64);
        }
    };
    let mut recognizer = Recognizer {
        options,
        session: None,
    };
    let code = serve(&mut recognizer);
    drop(recognizer);
    exit_process(code)
}

/// Answers frames until stdin closes (0), the stream breaks (65) or stdout fails (74). Replies are
/// flushed frame by frame, so nothing is lost when [`exit_process`] skips exit-time destructors.
fn serve(recognizer: &mut Recognizer) -> u8 {
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => return 0,
            Err(error) => {
                eprintln!("fanotes-ocr: {error}");
                return 65;
            }
        };
        let reply = recognizer.reply(&frame);
        if let Err(error) = write_frame(&mut output, &reply.header, &reply.payload) {
            eprintln!("fanotes-ocr: {error}");
            return 74;
        }
    }
}
