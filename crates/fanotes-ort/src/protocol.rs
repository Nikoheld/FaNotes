//! Frames between `fanotes/electron/native-ocr.cjs` and the `fanotes-ocr` sidecar on its stdin/stdout.
//!
//! A frame is a little-endian `u32` header length, a JSON header, a little-endian `u32` payload length
//! and the payload.
//!
//! - Request: `{"id","width","height","threads"}`, payload the `128 × width` line as little-endian `f32`.
//! - Reply: `{"id","dims","engine"}`, payload the probabilities as little-endian `f32`; or
//!   `{"id","error"}` with an empty payload. Replies come in request order.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    valid_height, valid_tensor_name, valid_threads, valid_width, Error, Prediction, ENGINE,
    INPUT_NAME, OUTPUT_NAME,
};

pub const MAX_HEADER_BYTES: usize = 4096;
/// The host refuses larger replies (`main.cjs` capped worker results at 32 MiB).
pub const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_ID_UNITS: usize = 96;
const MAX_ERROR_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub header: Vec<u8>,
    pub payload: Vec<u8>,
}

/// `Ok(None)` when the stream ends cleanly between frames.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut length = [0u8; 4];
    if !read_exact_or_eof(reader, &mut length)? {
        return Ok(None);
    }
    let header_length = u32::from_le_bytes(length) as usize;
    if header_length == 0 || header_length > MAX_HEADER_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame header length out of range",
        ));
    }
    let mut header = vec![0u8; header_length];
    reader.read_exact(&mut header)?;
    reader.read_exact(&mut length)?;
    let payload_length = u32::from_le_bytes(length) as usize;
    if payload_length > MAX_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame payload length out of range",
        ));
    }
    let mut payload = vec![0u8; payload_length];
    reader.read_exact(&mut payload)?;
    Ok(Some(Frame { header, payload }))
}

pub fn write_frame(writer: &mut impl Write, header: &[u8], payload: &[u8]) -> io::Result<()> {
    if header.is_empty() || header.len() > MAX_HEADER_BYTES || payload.len() > MAX_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "frame out of range",
        ));
    }
    writer.write_all(&(header.len() as u32).to_le_bytes())?;
    writer.write_all(header)?;
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

fn read_exact_or_eof(reader: &mut impl Read, buffer: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

fn default_input_name() -> String {
    INPUT_NAME.to_owned()
}

fn default_output_name() -> String {
    OUTPUT_NAME.to_owned()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestHeader {
    id: String,
    width: u64,
    height: u64,
    threads: u64,
    /// Input tensor name; defaults to PyLaia's `x` so old hosts need no change.
    #[serde(default = "default_input_name")]
    input_name: String,
    /// Output tensor name; defaults to PyLaia's `probabilities`.
    #[serde(default = "default_output_name")]
    output_name: String,
}

/// One validated line, held to the checks the worker made.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: String,
    pub width: usize,
    pub height: usize,
    pub threads: usize,
    pub input_name: String,
    pub output_name: String,
    pub input: Vec<f32>,
}

impl Request {
    /// On failure, the error comes with the request's id (or an empty id) so the host can match it.
    pub fn parse(frame: &Frame) -> Result<Self, (String, Error)> {
        let header: RequestHeader = serde_json::from_slice(&frame.header)
            .map_err(|_| (id_hint(&frame.header), Error::InvalidInput))?;
        let width = usize::try_from(header.width).unwrap_or(0);
        let height = usize::try_from(header.height).unwrap_or(0);
        let threads = usize::try_from(header.threads).unwrap_or(0);
        if header.id.encode_utf16().count() > MAX_ID_UNITS
            || !valid_width(width)
            || !valid_height(height)
            || !valid_threads(threads)
            || !valid_tensor_name(&header.input_name)
            || !valid_tensor_name(&header.output_name)
            || frame.payload.len() != width * height * size_of::<f32>()
        {
            return Err((header.id, Error::InvalidInput));
        }
        let (chunks, _) = frame.payload.as_chunks::<4>();
        let input = chunks
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk))
            .collect();
        Ok(Self {
            id: header.id,
            width,
            height,
            threads,
            input_name: header.input_name,
            output_name: header.output_name,
            input,
        })
    }

    pub fn encode(&self) -> Frame {
        let header = RequestHeader {
            id: self.id.clone(),
            width: self.width as u64,
            height: self.height as u64,
            threads: self.threads as u64,
            input_name: self.input_name.clone(),
            output_name: self.output_name.clone(),
        };
        Frame {
            header: serde_json::to_vec(&header).expect("request header serializes"),
            payload: self
                .input
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect(),
        }
    }
}

fn id_hint(header: &[u8]) -> String {
    serde_json::from_slice::<Value>(header)
        .ok()
        .and_then(|value| value["id"].as_str().map(str::to_owned))
        .filter(|id| id.encode_utf16().count() <= MAX_ID_UNITS)
        .unwrap_or_default()
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ReplyHeader {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dims: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// A decoded reply.
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Prediction {
        id: String,
        prediction: Prediction,
        engine: String,
    },
    Error {
        id: String,
        message: String,
    },
}

impl Reply {
    pub fn prediction(id: &str, prediction: &Prediction) -> Frame {
        let header = ReplyHeader {
            id: id.to_owned(),
            dims: Some(prediction.dims.clone()),
            engine: Some(ENGINE.to_owned()),
            error: None,
        };
        Frame {
            header: serde_json::to_vec(&header).expect("reply header serializes"),
            payload: prediction
                .probabilities
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect(),
        }
    }

    pub fn error(id: &str, error: &Error) -> Frame {
        let header = ReplyHeader {
            id: id.to_owned(),
            error: Some(error.to_string().chars().take(MAX_ERROR_CHARS).collect()),
            ..ReplyHeader::default()
        };
        Frame {
            header: serde_json::to_vec(&header).expect("reply header serializes"),
            payload: Vec::new(),
        }
    }

    pub fn parse(frame: &Frame) -> Result<Self, String> {
        let header: ReplyHeader =
            serde_json::from_slice(&frame.header).map_err(|error| error.to_string())?;
        if let Some(message) = header.error {
            return Ok(Reply::Error {
                id: header.id,
                message,
            });
        }
        let dims = header.dims.ok_or("reply without dims")?;
        let count = dims.iter().try_fold(1usize, |total, &dim| {
            usize::try_from(dim)
                .ok()
                .and_then(|dim| total.checked_mul(dim))
        });
        if count.is_none_or(|count| count * size_of::<f32>() != frame.payload.len()) {
            return Err("reply payload does not match dims".to_owned());
        }
        let (chunks, _) = frame.payload.as_chunks::<4>();
        Ok(Reply::Prediction {
            id: header.id,
            prediction: Prediction {
                probabilities: chunks
                    .iter()
                    .map(|chunk| f32::from_le_bytes(*chunk))
                    .collect(),
                dims,
            },
            engine: header.engine.unwrap_or_default(),
        })
    }
}
