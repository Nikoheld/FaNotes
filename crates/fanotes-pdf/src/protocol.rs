//! Frames between `fanotes/electron/pdfium.cjs` and the `fanotes-pdfium` sidecar.
//!
//! A frame is a little-endian `u32` header length, a JSON header, a little-endian
//! `u32` payload length, and the payload. `open` carries the PDF bytes. `render`
//! returns tightly packed RGBA.

use std::io::{self, Read, Write};

pub const MAX_HEADER_BYTES: usize = 8_192;
pub const MAX_PAYLOAD_BYTES: usize = 96 * 1024 * 1024;

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
    if payload_length > 0 {
        reader.read_exact(&mut payload)?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn a_frame_roundtrips() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, br#"{"op":"open"}"#, b"%PDF").unwrap();
        let frame = read_frame(&mut Cursor::new(buffer)).unwrap().unwrap();
        assert_eq!(frame.header, br#"{"op":"open"}"#);
        assert_eq!(frame.payload, b"%PDF");
    }
}
