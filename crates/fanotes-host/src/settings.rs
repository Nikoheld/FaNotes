//! Settings defaults and validation from `sanitizeSettings` in `electron/main.cjs`.

use serde_json::{json, Map, Value};

enum Rule {
    Bool,
    Enum(&'static [&'static str]),
    IntEnum(&'static [i64]),
    Number { min: f64, max: f64 },
    String { max: usize },
    Color,
    Relative { max: usize },
    Tablet,
}

const TABLET_IDS: &[&str] = &[
    "pen-tip",
    "pen-barrel",
    "pen-upper",
    "pen-eraser",
    "tablet-1",
    "tablet-2",
];
const TABLET_ACTIONS: &[&str] = &["ink", "eraser", "undo", "redo", "pan", "none", "os"];

/// Matches `/-beta\.\d+$/` on the desktop app version.
pub(crate) fn is_beta_release(version: &str) -> bool {
    let Some((_, suffix)) = version.rsplit_once("-beta.") else {
        return false;
    };
    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn defaults() -> Map<String, Value> {
    json!({
        "uiLanguage": "system",
        "theme": "light",
        "workspaceBackground": "clean",
        "accent": "#2a6f97",
        "accentSecondary": "#6b7280",
        "uiFont": "Inter, ui-sans-serif, system-ui",
        "editorFont": "JetBrains Mono, ui-monospace, monospace",
        "editorFontSize": 16,
        "previewFontSize": 17,
        "lineHeight": 1.72,
        "readableLineLength": true,
        "contentWidth": 820,
        "showLineNumbers": false,
        "spellcheck": true,
        "autocorrect": true,
        "vimMode": false,
        "autosaveDelay": 750,
        "sidebarWidth": 286,
        "rightPanelWidth": 286,
        "compactMode": false,
        "glassEffects": false,
        "reduceMotion": false,
        "viewZoomSpeed": 5,
        "viewZoomMax": 325,
        "addonSource": "Nikoheld/FaNotes-Addons#main",
        "addonsAutoUpdate": true,
        "syncAutomatic": true,
        "syncDeviceName": "",
        "syncExcludedFolders": "",
        "syncHandwritingModel": false,
        "syncNoteHistory": false,
        "marginTranscript": true,
        "showWordCount": true,
        "showOutline": true,
        "defaultFolder": "Eingang",
        "dailyNotesFolder": "Tagesnotizen",
        "dateFormat": "YYYY-MM-DD",
        "paperStyle": "dots",
        "penColor": "#202333",
        "penWidth": 3.5,
        "pressureEnabled": true,
        "penOnly": cfg!(windows),
        "tabletButtons": {
            "pen-tip": "ink",
            "pen-barrel": "eraser",
            "pen-upper": "pan",
            "pen-eraser": "eraser",
            "tablet-1": "undo",
            "tablet-2": "redo"
        },
        "smoothing": 0.68,
        "scribbleEraseSensitivity": 50,
        "shapeSnapSensitivity": 50,
        "recognitionMode": "auto",
        "lastRecognitionMode": "text",
        "recognitionLanguage": "de",
        "autoOpenConversion": false,
        "keepDrawingAfterInsert": true,
        "autoCheckUpdates": true,
        "autoDownloadUpdates": true,
        "installUpdatesOnQuit": true,
        "updateChannel": "stable",
        "memoryBudgetMb": 0,
        "ocrThreadLimit": 0,
        "desktopOcrModel": "extended",
        "enhancedMathRecognition": false,
        "enhancedMathLicenseAccepted": false,
        "qwenVisionRecognition": false,
        "qwenVisionLicenseAccepted": false,
        "experimentalHandwritingToText": false,
        "experimentalHandwritingToTextSeenVersion": "",
        "experimentalHomeworkApi": false,
        "experimentalRemoteSupport": false,
        "experimentalNoteBackup": false,
        "experimentalSendData": false,
        "lastOpenNotePath": "",
        "homeworkApiChannelId": "",
        "homeworkApiSecret": "",
        "ocrModelKeepAliveSeconds": 120,
        "backgroundTaskLimit": 0,
        "lmStudioBaseUrl": "http://127.0.0.1:1234",
        "lmStudioModel": "",
        "lmStudioApiToken": "",
        "aiProvider": "lmstudio",
        "ollamaBaseUrl": "http://127.0.0.1:11434",
        "ollamaModel": "",
        "ollamaApiToken": "",
        "openAiModel": "",
        "openAiApiKey": "",
        "geminiModel": "",
        "geminiApiKey": "",
        "anthropicModel": "",
        "anthropicApiKey": "",
        "openCodeBaseUrl": "http://127.0.0.1:4096",
        "openCodeModel": "",
        "openCodeUsername": "opencode",
        "openCodePassword": "",
        "customCss": ""
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}

/// An upgraded app turns the experimental handwriting toggle off once.
pub(crate) fn gate_experimental_handwriting(
    settings: &mut Map<String, Value>,
    version: &str,
) -> bool {
    let seen = settings
        .get("experimentalHandwritingToTextSeenVersion")
        .and_then(Value::as_str)
        .unwrap_or("");
    if seen == version {
        return false;
    }
    settings.insert(
        "experimentalHandwritingToText".to_owned(),
        Value::Bool(false),
    );
    settings.insert(
        "experimentalHandwritingToTextSeenVersion".to_owned(),
        Value::String(version.to_owned()),
    );
    true
}

pub(crate) fn sanitize(candidate: &Value, base: &Map<String, Value>) -> Map<String, Value> {
    let mut result = defaults();
    for (key, value) in base {
        if result.contains_key(key) {
            result.insert(key.clone(), value.clone());
        }
    }
    let Some(object) = candidate.as_object() else {
        if let Some(css) = result.get("customCss").and_then(Value::as_str) {
            result.insert("customCss".to_owned(), Value::String(sanitize_css(css)));
        }
        return result;
    };
    for (key, rule) in schema() {
        let Some(value) = object.get(*key) else {
            continue;
        };
        if let Some(cleaned) = apply_rule(rule, value) {
            result.insert((*key).to_owned(), cleaned);
        }
    }
    if let Some(css) = result.get("customCss").and_then(Value::as_str) {
        result.insert("customCss".to_owned(), Value::String(sanitize_css(css)));
    }
    result
}

fn schema() -> &'static [(&'static str, Rule)] {
    &[
        ("uiLanguage", Rule::Enum(&["system", "de", "en"])),
        (
            "theme",
            Rule::Enum(&[
                "dark", "light", "system", "midnight", "forest", "aurora", "sepia",
            ]),
        ),
        (
            "workspaceBackground",
            Rule::Enum(&["clean", "gradient", "mesh", "paper"]),
        ),
        ("accent", Rule::Color),
        ("accentSecondary", Rule::Color),
        ("uiFont", Rule::String { max: 240 }),
        ("editorFont", Rule::String { max: 240 }),
        (
            "editorFontSize",
            Rule::Number {
                min: 10.0,
                max: 40.0,
            },
        ),
        (
            "previewFontSize",
            Rule::Number {
                min: 10.0,
                max: 48.0,
            },
        ),
        ("lineHeight", Rule::Number { min: 1.0, max: 3.0 }),
        ("readableLineLength", Rule::Bool),
        (
            "contentWidth",
            Rule::Number {
                min: 420.0,
                max: 1800.0,
            },
        ),
        ("showLineNumbers", Rule::Bool),
        ("spellcheck", Rule::Bool),
        ("autocorrect", Rule::Bool),
        ("vimMode", Rule::Bool),
        (
            "autosaveDelay",
            Rule::Number {
                min: 100.0,
                max: 10000.0,
            },
        ),
        (
            "sidebarWidth",
            Rule::Number {
                min: 180.0,
                max: 620.0,
            },
        ),
        (
            "rightPanelWidth",
            Rule::Number {
                min: 220.0,
                max: 720.0,
            },
        ),
        ("compactMode", Rule::Bool),
        ("glassEffects", Rule::Bool),
        ("reduceMotion", Rule::Bool),
        (
            "viewZoomSpeed",
            Rule::Number {
                min: 1.0,
                max: 10.0,
            },
        ),
        (
            "viewZoomMax",
            Rule::Number {
                min: 50.0,
                max: 600.0,
            },
        ),
        ("addonSource", Rule::String { max: 400 }),
        ("addonsAutoUpdate", Rule::Bool),
        ("syncAutomatic", Rule::Bool),
        ("syncDeviceName", Rule::String { max: 80 }),
        ("syncExcludedFolders", Rule::String { max: 4000 }),
        ("syncHandwritingModel", Rule::Bool),
        ("syncNoteHistory", Rule::Bool),
        ("marginTranscript", Rule::Bool),
        ("showWordCount", Rule::Bool),
        ("showOutline", Rule::Bool),
        ("defaultFolder", Rule::Relative { max: 480 }),
        ("dailyNotesFolder", Rule::Relative { max: 480 }),
        ("dateFormat", Rule::String { max: 80 }),
        (
            "paperStyle",
            Rule::Enum(&["blank", "dots", "squares", "grid", "lines", "millimeter"]),
        ),
        ("penColor", Rule::Color),
        (
            "penWidth",
            Rule::Number {
                min: 0.5,
                max: 40.0,
            },
        ),
        ("pressureEnabled", Rule::Bool),
        ("penOnly", Rule::Bool),
        ("tabletButtons", Rule::Tablet),
        ("smoothing", Rule::Number { min: 0.0, max: 1.0 }),
        (
            "scribbleEraseSensitivity",
            Rule::Number {
                min: 0.0,
                max: 100.0,
            },
        ),
        (
            "shapeSnapSensitivity",
            Rule::Number {
                min: 0.0,
                max: 100.0,
            },
        ),
        ("recognitionMode", Rule::Enum(&["auto", "math", "text"])),
        ("lastRecognitionMode", Rule::Enum(&["math", "text"])),
        ("recognitionLanguage", Rule::Enum(&["de", "en", "fr"])),
        ("autoOpenConversion", Rule::Bool),
        ("keepDrawingAfterInsert", Rule::Bool),
        ("autoCheckUpdates", Rule::Bool),
        ("autoDownloadUpdates", Rule::Bool),
        ("installUpdatesOnQuit", Rule::Bool),
        ("updateChannel", Rule::Enum(&["stable", "beta"])),
        (
            "memoryBudgetMb",
            Rule::IntEnum(&[0, 1536, 2048, 3072, 4096, 6144, 8192]),
        ),
        ("ocrThreadLimit", Rule::IntEnum(&[0, 1, 2, 3, 4])),
        ("desktopOcrModel", Rule::Enum(&["compact", "extended"])),
        ("enhancedMathRecognition", Rule::Bool),
        ("enhancedMathLicenseAccepted", Rule::Bool),
        ("qwenVisionRecognition", Rule::Bool),
        ("qwenVisionLicenseAccepted", Rule::Bool),
        ("experimentalHandwritingToText", Rule::Bool),
        (
            "experimentalHandwritingToTextSeenVersion",
            Rule::String { max: 40 },
        ),
        ("experimentalHomeworkApi", Rule::Bool),
        ("experimentalRemoteSupport", Rule::Bool),
        ("experimentalNoteBackup", Rule::Bool),
        ("experimentalSendData", Rule::Bool),
        ("lastOpenNotePath", Rule::String { max: 1024 }),
        ("homeworkApiChannelId", Rule::String { max: 32 }),
        ("homeworkApiSecret", Rule::String { max: 256 }),
        (
            "ocrModelKeepAliveSeconds",
            Rule::IntEnum(&[0, 30, 120, 300, 600]),
        ),
        (
            "backgroundTaskLimit",
            Rule::IntEnum(&[0, 1, 2, 4, 8, 16, 24]),
        ),
        ("lmStudioBaseUrl", Rule::String { max: 2048 }),
        ("lmStudioModel", Rule::String { max: 500 }),
        ("lmStudioApiToken", Rule::String { max: 4096 }),
        (
            "aiProvider",
            Rule::Enum(&[
                "lmstudio",
                "ollama",
                "openai",
                "gemini",
                "anthropic",
                "opencode",
            ]),
        ),
        ("ollamaBaseUrl", Rule::String { max: 2048 }),
        ("ollamaModel", Rule::String { max: 500 }),
        ("ollamaApiToken", Rule::String { max: 4096 }),
        ("openAiModel", Rule::String { max: 500 }),
        ("openAiApiKey", Rule::String { max: 4096 }),
        ("geminiModel", Rule::String { max: 500 }),
        ("geminiApiKey", Rule::String { max: 4096 }),
        ("anthropicModel", Rule::String { max: 500 }),
        ("anthropicApiKey", Rule::String { max: 4096 }),
        ("openCodeBaseUrl", Rule::String { max: 2048 }),
        ("openCodeModel", Rule::String { max: 500 }),
        ("openCodeUsername", Rule::String { max: 200 }),
        ("openCodePassword", Rule::String { max: 4096 }),
        ("customCss", Rule::String { max: 100_000 }),
    ]
}

fn apply_rule(rule: &Rule, value: &Value) -> Option<Value> {
    match rule {
        Rule::Bool => value.as_bool().map(Value::Bool),
        Rule::Enum(options) => value
            .as_str()
            .filter(|text| options.contains(text))
            .map(|text| Value::String(text.to_owned())),
        Rule::IntEnum(options) => integer(value)
            .filter(|number| options.contains(number))
            .map(Value::from),
        Rule::Number { min, max } => number(value)
            .filter(|number| number.is_finite() && *number >= *min && *number <= *max)
            .map(|number| json!(number)),
        Rule::String { max } => value
            .as_str()
            .filter(|text| crate::vault::utf16_len(text) <= *max && !text.contains('\0'))
            .map(|text| Value::String(text.to_owned())),
        Rule::Color => value
            .as_str()
            .filter(|text| color_hex(text))
            .map(|text| Value::String(text.to_owned())),
        Rule::Relative { max } => clean_relative(value.as_str()?, *max).map(Value::String),
        Rule::Tablet => Some(sanitize_tablet(value)),
    }
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|number| number as f64))
        .or_else(|| value.as_u64().map(|number| number as f64))
}

fn integer(value: &Value) -> Option<i64> {
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

fn color_hex(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() == 7 || bytes.len() == 9)
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

fn clean_relative(value: &str, max: usize) -> Option<String> {
    if crate::vault::utf16_len(value) > max || value.contains('\0') {
        return None;
    }
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Some(String::new());
    }
    if normalized.starts_with('/') {
        return None;
    }
    let segments: Vec<&str> = normalized.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return None;
    }
    Some(segments.join("/"))
}

fn sanitize_tablet(value: &Value) -> Value {
    let mut next = json!({
        "pen-tip": "ink",
        "pen-barrel": "eraser",
        "pen-upper": "pan",
        "pen-eraser": "eraser",
        "tablet-1": "undo",
        "tablet-2": "redo"
    });
    let Some(object) = value.as_object() else {
        return next;
    };
    for id in TABLET_IDS {
        if let Some(action) = object.get(*id).and_then(Value::as_str) {
            if TABLET_ACTIONS.contains(&action) {
                next[*id] = json!(action);
            }
        }
    }
    next
}

fn sanitize_css(value: &str) -> String {
    if value.trim().is_empty() {
        return String::new();
    }
    let without_comments = comment_pattern().replace_all(value, "");
    let without_hex = hex_escape_pattern().replace_all(&without_comments, "");
    let normalized = without_hex.replace('\\', "");
    if dangerous_css_pattern().is_match(&normalized) {
        return String::new();
    }
    if crate::vault::utf16_len(value) > 100_000 {
        crate::vault::truncate_utf16(value, 100_000)
    } else {
        value.to_owned()
    }
}

fn comment_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"/\*[\s\S]*?\*/").expect("css comment pattern"))
}

fn hex_escape_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?i)\\[0-9a-f]{1,6}\s?").expect("css hex escape pattern")
    })
}

#[cfg(test)]
mod tests {
    use super::is_beta_release;

    #[test]
    fn a_beta_version_selects_the_beta_update_channel() {
        assert!(is_beta_release("2026.10.2-beta.1"));
        assert!(is_beta_release("1.0.0-beta.12"));
        assert!(!is_beta_release("2026.10.2"));
        assert!(!is_beta_release("2026.10.2-beta."));
        assert!(!is_beta_release("2026.10.2-beta.1a"));
    }
}

fn dangerous_css_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(?:@import|@charset|@namespace|@font-face|expression\s*\(|url\s*\(|-moz-binding|behavior\s*:|javascript\s*:|vbscript\s*:|</)",
        )
        .expect("css danger pattern")
    })
}
