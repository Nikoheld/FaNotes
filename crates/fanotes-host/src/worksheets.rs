//! Worksheet documents under `.fanotes/worksheets`, matching the Electron host.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Map, Value};

use crate::Host;

const MAX_WORKSHEET_JSON_BYTES: usize = 4 * 1024 * 1024;

struct Format {
    kind: &'static str,
    mime: &'static str,
    max_bytes: u64,
}

pub fn read_worksheet(host: &Host, raw_id: &str) -> Result<Value, String> {
    let id = worksheet_id(raw_id)?;
    let directory = worksheets_dir(vault_root(host)?)?;
    let path = directory.join(format!("{id}.json"));
    // Desktop `readRegularFileNoFollow`: a missing file is not found, a
    // non-file is reported before the size, and an oversized file is too big.
    let raw = read_worksheet_json(&path)?;
    let candidate: Value = serde_json::from_str(&raw)
        .map_err(|_| "Die Arbeitsblattdaten sind beschädigt.".to_owned())?;
    let document = validate_document(&candidate, &id)?;
    let source = directory.join(file_name(
        document["sourceRelativePath"].as_str().unwrap_or(""),
    ));
    let format = format_for(document["sourceRelativePath"].as_str().unwrap_or(""))?;
    stat_regular(&source, format.max_bytes)?;
    if document["kind"] == "html" {
        // The desktop reads only the first 8 KiB before looking for the marker.
        // A failed open is that open error, not a missing safety marker.
        let header = read_prefix(&source, 8192)?;
        if !header.contains("fanotes-onenote-safe-v1") {
            return Err(
                "Die importierte OneNote-Seite hat ihre Sicherheitsmarkierung verloren.".to_owned(),
            );
        }
    }
    Ok(document)
}

pub fn save_worksheet(host: &Host, candidate: &Value) -> Result<Value, String> {
    let id = worksheet_id(candidate.get("id").and_then(Value::as_str).unwrap_or(""))?;
    let mut next = candidate.clone();
    if let Value::Object(object) = &mut next {
        object.insert("updatedAt".into(), Value::String(now_iso()));
    }
    let document = validate_document(&next, &id)?;
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(&document).unwrap_or_default()
    );
    if serialized.len() > MAX_WORKSHEET_JSON_BYTES {
        return Err("Die Arbeitsblattdaten sind zu groß.".to_owned());
    }
    let directory = worksheets_dir(vault_root(host)?)?;
    let source = directory.join(file_name(
        document["sourceRelativePath"].as_str().unwrap_or(""),
    ));
    let format = format_for(document["sourceRelativePath"].as_str().unwrap_or(""))?;
    stat_regular(&source, format.max_bytes)?;
    crate::notes::atomic_write(
        &directory.join(format!("{id}.json")),
        serialized.as_bytes(),
        0o600,
    )
    .map_err(|_| "Das Arbeitsblatt konnte nicht gespeichert werden.".to_owned())?;
    Ok(document)
}

pub fn delete_worksheet(host: &Host, raw_id: &str) -> Result<Value, String> {
    let id = worksheet_id(raw_id)?;
    let directory = worksheets_dir(vault_root(host)?)?;
    let data_path = directory.join(format!("{id}.json"));
    let source_name = worksheet_source_name(&data_path, &id)?;
    if source_name.starts_with(&format!("{id}.")) {
        unlink_regular(&directory.join(&source_name))?;
    }
    unlink_regular(&data_path)?;
    Ok(json!({ "id": id }))
}

fn worksheet_source_name(data_path: &Path, id: &str) -> Result<String, String> {
    match fs::symlink_metadata(data_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(_) => return Err("Das Arbeitsblatt konnte nicht gelesen werden.".to_owned()),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err("Die Datei ist keine reguläre Datei.".to_owned());
        }
        Ok(meta) if meta.len() as usize > MAX_WORKSHEET_JSON_BYTES => {
            return Err("Die Datei ist zu groß.".to_owned());
        }
        Ok(_) => {}
    }
    let raw = fs::read(data_path)
        .map(lossy_utf8)
        .map_err(|error| crate::notes::node_open_error(data_path, &error))?;
    let candidate = serde_json::from_str::<Value>(&raw)
        .map_err(|_| "Die Arbeitsblattdaten sind beschädigt.".to_owned())?;
    let document = validate_document(&candidate, id)?;
    Ok(file_name(
        document["sourceRelativePath"].as_str().unwrap_or(""),
    ))
}

pub fn import_from_data(host: &Host, payload: &Value) -> Result<Value, String> {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Bild.png");
    let mime = payload
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("");
    let extension = worksheet_extension(name, mime)?;
    let format = format_for(&extension)
        .map_err(|_| "Dieses Bildformat kann nicht auf das Blatt gelegt werden.".to_owned())?;
    let bytes = decode_bytes(
        payload.get("bytesBase64").or_else(|| payload.get("bytes")),
        format.max_bytes as usize,
    )?;
    import_named_bytes(host, name, &extension, &bytes)
}

pub(crate) fn import_picked_worksheet(
    host: &Host,
    path: &Path,
    name: &str,
) -> Result<Value, String> {
    let extension = crate::vault::posix_extname_en_us(name);
    let format = format_for(&extension).map_err(|_| {
        "Es werden PDF-, PNG-, JPEG-, WebP- und GIF-Arbeitsblätter unterstützt.".to_owned()
    })?;
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Die Datei ist keine reguläre Datei.".to_owned());
    }
    if meta.len() > format.max_bytes {
        return Err("Die Datei ist zu groß.".to_owned());
    }
    if meta.len() == 0 {
        return Err("Das ausgewählte Arbeitsblatt ist leer.".to_owned());
    }
    let bytes = fs::read(path).map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())?;
    import_named_bytes(host, name, &extension, &bytes)
}

pub(crate) fn import_named_bytes(
    host: &Host,
    name: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<Value, String> {
    let format = format_for(extension)
        .map_err(|_| "Dieses Bildformat kann nicht auf das Blatt gelegt werden.".to_owned())?;
    if bytes.is_empty() || bytes.len() as u64 > format.max_bytes {
        return Err("Das Bild ist leer oder zu groß.".to_owned());
    }
    validate_bytes(bytes, extension)?;
    let id = random_id()?;
    // An empty dropped name is falsy, so the title uses the new image id.
    let hint = if name.is_empty() {
        format!("Bild-{}", &id[..8])
    } else {
        name.to_owned()
    };
    let title = safe_title(file_stem(&hint), "Arbeitsblatt")?;
    let directory = worksheets_dir(vault_root(host)?)?;
    let source_relative = format!(".fanotes/worksheets/{id}{extension}");
    let data_relative = format!(".fanotes/worksheets/{id}.json");
    let created = now_iso();
    let document = validate_document(
        &json!({
            "schemaVersion": 1,
            "id": id,
            "title": title,
            "kind": format.kind,
            "mimeType": format.mime,
            "sourceRelativePath": source_relative,
            "dataRelativePath": data_relative,
            "createdAt": created,
            "updatedAt": created,
            "textBoxes": [],
            "highlights": [],
        }),
        &id,
    )?;
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(&document).unwrap_or_default()
    );
    let source_path = directory.join(format!("{id}{extension}"));
    let data_path = directory.join(format!("{id}.json"));
    if crate::notes::atomic_write(&source_path, &bytes, 0o600).is_err() {
        let _ = fs::remove_file(&source_path);
        return Err("Das Arbeitsblatt konnte nicht gespeichert werden.".to_owned());
    }
    if crate::notes::atomic_write(&data_path, serialized.as_bytes(), 0o600).is_err() {
        let _ = fs::remove_file(&source_path);
        let _ = fs::remove_file(&data_path);
        return Err("Das Arbeitsblatt konnte nicht gespeichert werden.".to_owned());
    }
    Ok(document)
}

fn worksheet_extension(name: &str, mime: &str) -> Result<String, String> {
    let extension = extension_of(name);
    let extension = if extension.is_empty() {
        match mime {
            "application/pdf" => ".pdf".to_owned(),
            "image/jpeg" => ".jpg".to_owned(),
            "image/webp" => ".webp".to_owned(),
            "image/gif" => ".gif".to_owned(),
            _ => ".png".to_owned(),
        }
    } else {
        extension
    };
    format_for(&extension)
        .map_err(|_| "Dieses Bildformat kann nicht auf das Blatt gelegt werden.".to_owned())?;
    Ok(extension)
}

pub(crate) fn decode_payload_bytes(payload: &Value, max_bytes: usize) -> Result<Vec<u8>, String> {
    decode_bytes(
        payload.get("bytesBase64").or_else(|| payload.get("bytes")),
        max_bytes,
    )
}

fn decode_bytes(value: Option<&Value>, max_bytes: usize) -> Result<Vec<u8>, String> {
    let too_big = "Das Bild ist leer oder zu groß.";
    let Some(value) = value else {
        return Err(too_big.to_owned());
    };
    let bytes = if let Some(text) = value.as_str() {
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(|_| too_big.to_owned())?
    } else if let Some(items) = value.as_array() {
        if items.len() > max_bytes {
            return Err(too_big.to_owned());
        }
        items.iter().map(worksheet_byte).collect()
    } else {
        return Err(too_big.to_owned());
    };
    if bytes.is_empty() || bytes.len() > max_bytes {
        Err(too_big.to_owned())
    } else {
        Ok(bytes)
    }
}

/// `Buffer.from(array)` converts each value with `ToUint8`.
///
/// `1.0` and `1.5` become 1, `256` becomes 0, and `-1` becomes 255.
/// A nested `[80]` is 80. `[1, 2]` is `NaN`, which becomes 0.
fn worksheet_byte(value: &Value) -> u8 {
    to_uint8(fanotes_famd::js_number(Some(value)))
}

fn to_uint8(number: f64) -> u8 {
    if !number.is_finite() || number == 0.0 {
        return 0;
    }
    number.trunc().rem_euclid(256.0) as u8
}

fn validate_bytes(bytes: &[u8], extension: &str) -> Result<(), String> {
    let ok = match extension {
        ".pdf" => bytes.starts_with(b"%PDF-"),
        ".png" => bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ".jpg" | ".jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        ".webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        ".gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(
            "Die ausgewählte Datei stimmt nicht mit ihrem Bild- oder PDF-Format überein."
                .to_owned(),
        )
    }
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Ungültige Arbeitsblatt-ID.".to_owned())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn safe_title(value: &str, fallback: &str) -> Result<String, String> {
    super::safe_entry_name_or(value, fallback)
}

/// `splitName(titleHint)` uses `path.extname` on the whole hint.
///
/// `Ordner/Foto.png` keeps the slash in the stem. The title check then
/// refuses that name.
fn file_stem(name: &str) -> &str {
    let extension = crate::vault::posix_extname(name);
    if extension.is_empty() {
        name
    } else {
        &name[..name.len() - extension.len()]
    }
}

fn validate_document(candidate: &Value, expected_id: &str) -> Result<Value, String> {
    let object = candidate
        .as_object()
        .ok_or_else(|| "Die Arbeitsblattdaten sind ungültig.".to_owned())?;
    let id = worksheet_id(expected_id)?;
    if object.get("id").and_then(Value::as_str) != Some(id.as_str())
        || object.get("schemaVersion").and_then(json_integer) != Some(1)
    {
        return Err("Die Arbeitsblattdatei hat ein ungültiges Format.".to_owned());
    }
    let raw_title = object.get("title").and_then(Value::as_str).unwrap_or("");
    let title = crate::vault::js_trim(raw_title);
    if title.is_empty()
        || crate::vault::utf16_len(raw_title) > 180
        || crate::vault::has_c0_or_del(raw_title)
    {
        return Err("Der Arbeitsblatttitel ist ungültig.".to_owned());
    }
    let source = object
        .get("sourceRelativePath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let format = format_for(source)?;
    let extension = extension_of(source);
    let expected_source = format!(".fanotes/worksheets/{id}{extension}");
    let expected_data = format!(".fanotes/worksheets/{id}.json");
    let legacy_source = format!(".lernwerk/worksheets/{id}{extension}");
    let legacy_data = format!(".lernwerk/worksheets/{id}.json");
    let data_path = object
        .get("dataRelativePath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let current = source == expected_source && data_path == expected_data;
    let legacy = source == legacy_source && data_path == legacy_data;
    if object.get("kind").and_then(Value::as_str) != Some(format.kind)
        || object.get("mimeType").and_then(Value::as_str) != Some(format.mime)
        || (!current && !legacy)
    {
        return Err("Die Arbeitsblattquelle ist ungültig.".to_owned());
    }
    let created = object
        .get("createdAt")
        .and_then(Value::as_str)
        .and_then(crate::drawings::canonical_iso)
        .ok_or_else(|| "Die Arbeitsblatt-Zeitangaben sind ungültig.".to_owned())?;
    let updated = object
        .get("updatedAt")
        .and_then(Value::as_str)
        .and_then(crate::drawings::canonical_iso)
        .ok_or_else(|| "Die Arbeitsblatt-Zeitangaben sind ungültig.".to_owned())?;
    let text_boxes = boxes(object.get("textBoxes"))?;
    let highlights = highlights(object.get("highlights"))?;
    let mut document = Map::new();
    document.insert("schemaVersion".into(), json!(1));
    document.insert("id".into(), Value::String(id));
    document.insert("title".into(), Value::String(title.to_owned()));
    document.insert("kind".into(), Value::String(format.kind.to_owned()));
    document.insert("mimeType".into(), Value::String(format.mime.to_owned()));
    document.insert("sourceRelativePath".into(), Value::String(expected_source));
    document.insert("dataRelativePath".into(), Value::String(expected_data));
    document.insert("createdAt".into(), Value::String(created));
    document.insert("updatedAt".into(), Value::String(updated));
    if format.kind == "html" {
        let page_width = page_extent(object.get("pageWidth"));
        let page_height = page_extent(object.get("pageHeight"));
        if !(320.0..=3000.0).contains(&page_width) || !(320.0..=30_000.0).contains(&page_height) {
            return Err("Die Größe der importierten OneNote-Seite ist ungültig.".to_owned());
        }
        document.insert("pageWidth".into(), json!(page_width.round() as i64));
        document.insert("pageHeight".into(), json!(page_height.round() as i64));
    }
    document.insert("textBoxes".into(), Value::Array(text_boxes));
    document.insert("highlights".into(), Value::Array(highlights));
    Ok(Value::Object(document))
}

fn boxes(value: Option<&Value>) -> Result<Vec<Value>, String> {
    let items = value
        .and_then(Value::as_array)
        .ok_or_else(|| "Das Arbeitsblatt enthält zu viele Textfelder.".to_owned())?;
    if items.len() > 2000 {
        return Err("Das Arbeitsblatt enthält zu viele Textfelder.".to_owned());
    }
    items
        .iter()
        .map(|box_value| {
            let object = box_value
                .as_object()
                .ok_or_else(|| "Ein Arbeitsblatt-Textfeld ist ungültig.".to_owned())?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| matches_record_id(id))
                .ok_or_else(|| "Ein Arbeitsblatt-Textfeld ist ungültig.".to_owned())?;
            let page = object
                .get("page")
                .and_then(json_integer)
                .ok_or_else(|| "Eine Textfeldseite ist ungültig.".to_owned())?;
            if !(1..=2000).contains(&page) {
                return Err("Eine Textfeldseite ist ungültig.".to_owned());
            }
            let x = number(object, "x", "Eine Textfeldposition ist ungültig.")?;
            let y = number(object, "y", "Eine Textfeldposition ist ungültig.")?;
            let width = number(object, "width", "Eine Textfeldposition ist ungültig.")?;
            let font_size = number(object, "fontSize", "Eine Textfeldposition ist ungültig.")?;
            if !(0.0..=1.0).contains(&x)
                || !(0.0..=1.0).contains(&y)
                || !(0.05..=1.0).contains(&width)
                || !(8.0..=96.0).contains(&font_size)
            {
                return Err("Eine Textfeldposition liegt außerhalb des Arbeitsblatts.".to_owned());
            }
            let text = object
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "Ein Arbeitsblatt-Text ist ungültig.".to_owned())?;
            if crate::vault::utf16_len(text) > 20_000 || text.contains('\0') {
                return Err("Ein Arbeitsblatt-Text ist ungültig.".to_owned());
            }
            Ok(json!({
                "id": id,
                "page": page,
                "x": fanotes_famd::js_json_number(x),
                "y": fanotes_famd::js_json_number(y),
                "width": fanotes_famd::js_json_number(width),
                "text": text,
                "fontSize": fanotes_famd::js_json_number(font_size),
            }))
        })
        .collect()
}

fn highlights(value: Option<&Value>) -> Result<Vec<Value>, String> {
    // The desktop keeps a missing or non-array list as no marks.
    let Some(items) = value.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    if items.len() > 4000 {
        return Err("Das Arbeitsblatt enthält zu viele Markierungen.".to_owned());
    }
    items
        .iter()
        .map(|mark| {
            let object = mark
                .as_object()
                .ok_or_else(|| "Eine PDF-Markierung ist ungültig.".to_owned())?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| matches_record_id(id))
                .ok_or_else(|| "Eine PDF-Markierung ist ungültig.".to_owned())?;
            let page = object
                .get("page")
                .and_then(json_integer)
                .ok_or_else(|| "Eine Markierungsseite ist ungültig.".to_owned())?;
            if !(1..=2000).contains(&page) {
                return Err("Eine Markierungsseite ist ungültig.".to_owned());
            }
            let x = number(object, "x", "Eine Markierungsposition ist ungültig.")?;
            let y = number(object, "y", "Eine Markierungsposition ist ungültig.")?;
            let width = number(object, "width", "Eine Markierungsposition ist ungültig.")?;
            let height = number(object, "height", "Eine Markierungsposition ist ungültig.")?;
            if !(0.0..=1.0).contains(&x)
                || !(0.0..=1.0).contains(&y)
                || !(0.004..=1.0).contains(&width)
                || !(0.004..=1.0).contains(&height)
            {
                return Err("Eine Markierung liegt außerhalb des Arbeitsblatts.".to_owned());
            }
            let color = object
                .get("color")
                .and_then(Value::as_str)
                .filter(|value| {
                    value.len() == 7
                        && value.as_bytes()[0] == b'#'
                        && value.as_bytes()[1..]
                            .iter()
                            .all(|byte| byte.is_ascii_hexdigit())
                })
                .unwrap_or("#ffe566")
                .to_ascii_lowercase();
            Ok(json!({
                "id": id,
                "page": page,
                "x": fanotes_famd::js_json_number(x),
                "y": fanotes_famd::js_json_number(y),
                "width": fanotes_famd::js_json_number(width),
                "height": fanotes_famd::js_json_number(height),
                "color": color,
            }))
        })
        .collect()
}

/// `Number.isInteger`: a whole JSON number, including `1.0`.
fn json_integer(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    let number = value.as_f64()?;
    if number.is_finite() && number.fract() == 0.0 {
        Some(number as i64)
    } else {
        None
    }
}

/// Desktop `Number(pageWidth)` / `Number(pageHeight)`, then `Math.round`.
fn page_extent(value: Option<&Value>) -> f64 {
    fanotes_famd::js_number(value)
}

fn number(object: &Map<String, Value>, name: &str, error: &str) -> Result<f64, String> {
    object
        .get(name)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| error.to_owned())
}

fn format_for(source: &str) -> Result<Format, String> {
    match worksheet_suffix(source).as_str() {
        ".png" => Ok(Format {
            kind: "image",
            mime: "image/png",
            max_bytes: 32 * 1024 * 1024,
        }),
        ".jpg" | ".jpeg" => Ok(Format {
            kind: "image",
            mime: "image/jpeg",
            max_bytes: 32 * 1024 * 1024,
        }),
        ".webp" => Ok(Format {
            kind: "image",
            mime: "image/webp",
            max_bytes: 32 * 1024 * 1024,
        }),
        ".gif" => Ok(Format {
            kind: "image",
            mime: "image/gif",
            max_bytes: 32 * 1024 * 1024,
        }),
        ".pdf" => Ok(Format {
            kind: "pdf",
            mime: "application/pdf",
            max_bytes: 96 * 1024 * 1024,
        }),
        ".html" => Ok(Format {
            kind: "html",
            mime: "text/html",
            max_bytes: 128 * 1024 * 1024,
        }),
        _ => Err("Die Arbeitsblattquelle ist ungültig.".to_owned()),
    }
}

fn extension_of(source: &str) -> String {
    // Linux `path.extname` keeps a backslash inside the extension.
    // Windows `path.win32.extname` treats `\` as a separator.
    let base = if cfg!(windows) {
        source.rsplit(['/', '\\']).next().unwrap_or(source)
    } else {
        source.rsplit('/').next().unwrap_or(source)
    };
    crate::vault::posix_extname_en_us(base)
}

/// A path uses `path.posix.extname`. A suffix that was already chosen, such as
/// `.png`, is the same string as a one-dot filename, which has no extension.
fn worksheet_suffix(source: &str) -> String {
    if let Some(rest) = source.strip_prefix('.') {
        if !rest.is_empty()
            && !rest.contains('.')
            && !source.contains('/')
            && !source.contains('\\')
        {
            return source.to_ascii_lowercase();
        }
    }
    extension_of(source)
}

fn file_name(source: &str) -> String {
    source
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(source)
        .to_owned()
}

/// Shared desktop id pattern. A text box or mark that fails it reports that field.
fn matches_record_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn worksheet_id(value: &str) -> Result<String, String> {
    if matches_record_id(value) {
        Ok(value.to_owned())
    } else {
        Err("Ungültige Arbeitsblatt-ID.".to_owned())
    }
}

fn worksheets_dir(vault_root: &Path) -> Result<PathBuf, String> {
    // A bad `.fanotes` folder keeps its own message. Only the worksheets
    // directory itself uses the worksheet-folder message.
    let internal = crate::vault::ensure_internal_directory(vault_root)?;
    let worksheets = internal.join("worksheets");
    ensure_private_dir(&worksheets)?;
    let root_real = fs::canonicalize(vault_root)
        .map_err(|_| "Der interne Arbeitsblatt-Ordner verlässt den Vault.".to_owned())?;
    let real = fs::canonicalize(&worksheets)
        .map_err(|_| "Der interne Arbeitsblatt-Ordner verlässt den Vault.".to_owned())?;
    if !crate::vault::is_inside_root(&root_real, &real) {
        return Err("Der interne Arbeitsblatt-Ordner verlässt den Vault.".to_owned());
    }
    Ok(worksheets)
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    let unsafe_dir = || "Der interne Arbeitsblatt-Ordner ist unsicher.".to_owned();
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => Err(unsafe_dir()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| unsafe_dir())?;
            // Desktop `mkdir` uses mode `0o700`, then checks the created directory.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                    .map_err(|_| unsafe_dir())?;
            }
            let created = fs::symlink_metadata(path).map_err(|_| unsafe_dir())?;
            if created.file_type().is_symlink() || !created.is_dir() {
                return Err(unsafe_dir());
            }
            Ok(())
        }
        Err(_) => Err(unsafe_dir()),
    }
}

fn vault_root(host: &Host) -> Result<&Path, String> {
    host.vault
        .as_deref()
        .ok_or_else(|| "Der Vault ist noch nicht initialisiert.".to_owned())
}

fn stat_regular(path: &Path, max: u64) -> Result<(), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "Das Arbeitsblatt wurde nicht gefunden.".to_owned())?;
    // Desktop `statRegularFileNoFollow`: a non-file fails before the size check.
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Die Datei ist keine reguläre Datei.".to_owned());
    }
    if meta.len() > max {
        return Err("Die Datei ist zu groß.".to_owned());
    }
    Ok(())
}

fn read_prefix(path: &Path, limit: usize) -> Result<String, String> {
    use std::io::Read;
    let mut file =
        fs::File::open(path).map_err(|error| crate::notes::node_open_error(path, &error))?;
    let mut bytes = vec![0u8; limit];
    let mut read = 0;
    while read < limit {
        match file.read(&mut bytes[read..]) {
            Ok(0) => break,
            Ok(count) => read += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(crate::notes::node_open_error(path, &error)),
        }
    }
    bytes.truncate(read);
    Ok(lossy_utf8(bytes))
}

fn read_worksheet_json(path: &Path) -> Result<String, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("Das Arbeitsblatt wurde nicht gefunden.".to_owned());
        }
        Err(_) => return Err("Das Arbeitsblatt konnte nicht gelesen werden.".to_owned()),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err("Die Datei ist keine reguläre Datei.".to_owned());
        }
        Ok(meta) if meta.len() as usize > MAX_WORKSHEET_JSON_BYTES => {
            return Err("Die Datei ist zu groß.".to_owned());
        }
        Ok(_) => {}
    }
    fs::read(path)
        .map(lossy_utf8)
        .map_err(|error| crate::notes::node_open_error(path, &error))
}

/// Node `Buffer.toString('utf8')`: invalid bytes become U+FFFD and the rest stays.
fn lossy_utf8(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

fn unlink_regular(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
            fs::remove_file(path).map_err(|_| "Die Arbeitsblattdatei ist unsicher.".to_owned())
        }
        _ => Err("Die Arbeitsblattdatei ist unsicher.".to_owned()),
    }
}

fn now_iso() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = elapsed.as_secs();
    let millis = elapsed.subsec_millis();
    let days = secs / 86_400;
    let time = secs % 86_400;
    let (year, month, day) = civil_date(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

fn civil_date(mut days: u64) -> (i32, u32, u32) {
    let mut year = 1970i32;
    loop {
        let year_days = if is_leap(year) { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let months = [
        31,
        if is_leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    for length in months {
        if days < length {
            return (year, month, days as u32 + 1);
        }
        days -= length;
        month += 1;
    }
    (year, 12, 31)
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}
