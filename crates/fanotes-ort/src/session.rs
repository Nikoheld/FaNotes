use std::fmt::Display;

use ort::{
    ep,
    session::{builder::GraphOptimizationLevel, Session},
    value::TensorRef,
};

use crate::{valid_threads, valid_width, Error, INPUT_NAME, MODEL_HEIGHT, OUTPUT_NAME};

/// One line's CTC probabilities, `[1, T, 81]` for PyLaia IAM.
#[derive(Debug, Clone, PartialEq)]
pub struct Prediction {
    pub probabilities: Vec<f32>,
    pub dims: Vec<i64>,
}

/// A PyLaia session with the options `native-ocr-worker.cjs` passed to onnxruntime-node.
pub struct PylaiaSession {
    session: Session,
    threads: usize,
}

impl PylaiaSession {
    /// `model` must already have passed [`crate::verify_model_file`].
    ///
    /// | worker option                     | here                                   |
    /// | --------------------------------- | -------------------------------------- |
    /// | `executionProviders: ['cpu']`     | `ep::CPU`                              |
    /// | `enableCpuMemArena: true`         | `with_arena_allocator(true)`           |
    /// | `executionMode: 'sequential'`     | `with_parallel_execution(false)`       |
    /// | `graphOptimizationLevel: 'all'`   | `GraphOptimizationLevel::All`          |
    /// | `enableMemPattern: true`          | `with_memory_pattern(true)`            |
    /// | `intraOpNumThreads: threads`      | `with_intra_threads(threads)`, 1–4     |
    /// | `interOpNumThreads: 1`            | `with_inter_threads(1)`                |
    pub fn new(model: &[u8], threads: usize) -> Result<Self, Error> {
        if !valid_threads(threads) {
            return Err(Error::InvalidInput);
        }
        let session = Session::builder()?
            .with_execution_providers([ep::CPU::default().with_arena_allocator(true).build()])
            .map_err(runtime_error)?
            .with_parallel_execution(false)
            .map_err(runtime_error)?
            .with_optimization_level(GraphOptimizationLevel::All)
            .map_err(runtime_error)?
            .with_memory_pattern(true)
            .map_err(runtime_error)?
            .with_intra_threads(threads)
            .map_err(runtime_error)?
            .with_inter_threads(1)
            .map_err(runtime_error)?
            .commit_from_memory(model)?;
        Ok(Self { session, threads })
    }

    pub fn threads(&self) -> usize {
        self.threads
    }

    /// Runs one grayscale line, `input` row-major `128 × width`.
    pub fn run(&mut self, width: usize, input: &[f32]) -> Result<Prediction, Error> {
        if !valid_width(width) || input.len() != MODEL_HEIGHT * width {
            return Err(Error::InvalidInput);
        }
        let fallback = self.session.outputs().first().map(|outlet| outlet.name().to_owned());
        let tensor = TensorRef::from_array_view(([1usize, 1, MODEL_HEIGHT, width], input))?;
        let outputs = self.session.run(ort::inputs![INPUT_NAME => tensor])?;
        let value = outputs
            .get(OUTPUT_NAME)
            .or_else(|| fallback.and_then(|name| outputs.get(name)))
            .ok_or(Error::UnreadableOutput)?;
        let (shape, data) = value.try_extract_tensor::<f32>().map_err(|_| Error::UnreadableOutput)?;
        let dims: Vec<i64> = shape.iter().copied().collect();
        if dims.len() != 3 || data.is_empty() {
            return Err(Error::UnreadableOutput);
        }
        Ok(Prediction { probabilities: data.to_vec(), dims })
    }
}

fn runtime_error(error: impl Display) -> Error {
    Error::Runtime(error.to_string())
}
