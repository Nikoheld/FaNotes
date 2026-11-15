//! Snappy raw-format decompression (LevelDB table blocks and Chromium's
//! compressed IndexedDB values). Only decompression is needed.

const MAX_OUTPUT: usize = 512 * 1024 * 1024;

pub fn decompress(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut position = 0usize;
    let mut expected = 0usize;
    let mut shift = 0u32;
    loop {
        let byte = *input
            .get(position)
            .ok_or_else(|| "snappy: missing length".to_owned())?;
        position += 1;
        if shift > 28 {
            return Err("snappy: length is too long".to_owned());
        }
        expected |= usize::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    if expected > MAX_OUTPUT {
        return Err("snappy: output is too large".to_owned());
    }
    let mut out = Vec::with_capacity(expected);
    while position < input.len() {
        let tag = input[position];
        position += 1;
        match tag & 3 {
            0 => {
                let mut length = usize::from(tag >> 2);
                if length >= 60 {
                    let extra = length - 59;
                    let bytes = input
                        .get(position..position + extra)
                        .ok_or_else(|| "snappy: literal length is cut off".to_owned())?;
                    length = bytes
                        .iter()
                        .rev()
                        .fold(0usize, |value, byte| (value << 8) | usize::from(*byte));
                    position += extra;
                }
                let length = length + 1;
                let literal = input
                    .get(position..position + length)
                    .ok_or_else(|| "snappy: literal is cut off".to_owned())?;
                out.extend_from_slice(literal);
                position += length;
            }
            kind => {
                let (length, offset) = match kind {
                    1 => {
                        let next = *input
                            .get(position)
                            .ok_or_else(|| "snappy: copy is cut off".to_owned())?;
                        position += 1;
                        (
                            usize::from((tag >> 2) & 7) + 4,
                            (usize::from(tag >> 5) << 8) | usize::from(next),
                        )
                    }
                    2 => {
                        let bytes = input
                            .get(position..position + 2)
                            .ok_or_else(|| "snappy: copy is cut off".to_owned())?;
                        position += 2;
                        (
                            usize::from(tag >> 2) + 1,
                            usize::from(u16::from_le_bytes([bytes[0], bytes[1]])),
                        )
                    }
                    _ => {
                        let bytes = input
                            .get(position..position + 4)
                            .ok_or_else(|| "snappy: copy is cut off".to_owned())?;
                        position += 4;
                        (
                            usize::from(tag >> 2) + 1,
                            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize,
                        )
                    }
                };
                if offset == 0 || offset > out.len() {
                    return Err("snappy: copy offset is outside the output".to_owned());
                }
                if out.len() + length > expected {
                    return Err("snappy: output is longer than declared".to_owned());
                }
                let start = out.len() - offset;
                for index in 0..length {
                    let byte = out[start + index];
                    out.push(byte);
                }
            }
        }
        if out.len() > expected {
            return Err("snappy: output is longer than declared".to_owned());
        }
    }
    if out.len() != expected {
        return Err("snappy: output is shorter than declared".to_owned());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::decompress;

    #[test]
    fn literals_and_overlapping_copies() {
        // "abcabcabcabc": literal "abc" then a 9-byte copy at offset 3 (1-byte offset form).
        let compressed = [12u8, 0b0000_1000, b'a', b'b', b'c', 0b0001_0101, 3];
        assert_eq!(decompress(&compressed).unwrap(), b"abcabcabcabc");
    }

    #[test]
    fn two_byte_offset_copy_and_bad_input() {
        let compressed = [8u8, 0b0000_1100, b'w', b'x', b'y', b'z', 0b0000_1110, 4, 0];
        assert_eq!(decompress(&compressed).unwrap(), b"wxyzwxyz");
        assert!(decompress(&[5u8, 0b0000_0100, b'a', 0b0001_0101, 9]).is_err());
        assert!(decompress(&[3u8, 0]).is_err());
    }
}
