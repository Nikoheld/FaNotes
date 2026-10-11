//! Local and cloud model calls for the AI panels.
//!
//! Ollama and LM Studio stay on localhost or the private LAN. The list commands
//! return the model array the panels render.

use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use ureq::Agent;

use crate::policy::local_ai_origin;

const ACTIONS: &[&str] = &[
    "instruction",
    "spelling",
    "links",
    "facts",
    "style",
    "structure",
    "expand",
    "summary",
    "study",
];

pub fn list_lm_studio(base_url: &str, api_token: &str) -> Result<Value, String> {
    let origin = local_ai_origin(base_url, "lmstudio")?;
    let connection = json!({
        "provider": "lmstudio",
        "baseUrl": origin,
        "apiKey": api_token,
        "model": "",
    });
    list_provider(&connection)
}

pub fn list_models(connection: &Value) -> Result<Value, String> {
    list_provider(connection)
}

pub fn transform(payload: &Value) -> Result<Value, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "Der AI-Auftrag ist ungültig.".to_owned())?;
    let connection = object
        .get("connection")
        .ok_or_else(|| "Der AI-Auftrag ist ungültig.".to_owned())?;
    let provider = provider_name(connection)?;
    let model = required_model(connection)?;
    let markdown = required_markdown(object.get("markdown"))?;
    let actions = required_actions(object.get("actions"))?;
    let instruction = object
        .get("instruction")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(12_000)
        .collect::<String>();
    if actions.iter().any(|action| action == "instruction") && instruction.is_empty() {
        return Err("Schreibe zuerst den freien Auftrag in das Textfeld.".to_owned());
    }
    let prompt = format!("Bearbeite die Notiz.\n\nNOTIZ_START\n{markdown}\nNOTIZ_ENDE");
    let text = match provider {
        "ollama" => ollama_chat(connection, &model, &prompt)?,
        "lmstudio" => chat_completions(connection, &model, &prompt)?,
        "openai" => chat_completions(
            &json!({
                "provider": "openai",
                "baseUrl": "https://api.openai.com",
                "apiKey": connection.get("apiKey").and_then(Value::as_str).unwrap_or(""),
            }),
            &model,
            &prompt,
        )?,
        "gemini" => gemini_generate(connection, &model, &prompt)?,
        "anthropic" => anthropic_message(connection, &model, &prompt)?,
        "opencode" => opencode_message(connection, &model, &prompt)?,
        _ => return Err("Wähle einen unterstützten AI-Anbieter.".to_owned()),
    };
    Ok(json!({
        "markdown": unwrap_markdown(&text)?,
        "model": model,
        "provider": provider,
        "stats": {},
    }))
}

pub fn transform_lm_studio(payload: &Value) -> Result<Value, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "Der LM-Studio-Auftrag ist ungültig.".to_owned())?;
    let base_url = object.get("baseUrl").and_then(Value::as_str).unwrap_or("");
    let origin = local_ai_origin(base_url, "lmstudio")?;
    let model = required_model(payload)?;
    let markdown = required_markdown(object.get("markdown"))?;
    let _actions = required_actions(object.get("actions"))?;
    let connection = json!({
        "provider": "lmstudio",
        "baseUrl": origin,
        "apiKey": object.get("apiToken").and_then(Value::as_str).unwrap_or(""),
    });
    let text = chat_completions(
        &connection,
        &model,
        &format!("Bearbeite die Notiz.\n\nNOTIZ_START\n{markdown}\nNOTIZ_ENDE"),
    )?;
    Ok(json!({
        "markdown": unwrap_markdown(&text)?,
        "model": model,
        "stats": {},
    }))
}

fn list_provider(connection: &Value) -> Result<Value, String> {
    let provider = provider_name(connection)?;
    let models = match provider {
        "ollama" => ollama_models(connection)?,
        "lmstudio" => lmstudio_models(connection)?,
        "openai" => openai_models(connection)?,
        "gemini" => gemini_models(connection)?,
        "anthropic" => anthropic_models(connection)?,
        "opencode" => opencode_models(connection)?,
        _ => return Err("Wähle einen unterstützten AI-Anbieter.".to_owned()),
    };
    Ok(Value::Array(models))
}

fn ollama_models(connection: &Value) -> Result<Vec<Value>, String> {
    let origin = origin(connection, "ollama")?;
    let body = request_json(
        "GET",
        &format!("{origin}/api/tags"),
        connection,
        None,
        Duration::from_secs(20),
    )?;
    let models = body
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "Ollama hat keine Modellliste geliefert.".to_owned())?;
    Ok(models
        .iter()
        .filter_map(|entry| {
            let name = entry
                .get("model")
                .and_then(Value::as_str)
                .or_else(|| entry.get("name").and_then(Value::as_str))?;
            Some(model_record(
                "ollama",
                name,
                entry.get("name").and_then(Value::as_str).unwrap_or(name),
            ))
        })
        .take(1000)
        .collect())
}

fn lmstudio_models(connection: &Value) -> Result<Vec<Value>, String> {
    let origin = origin(connection, "lmstudio")?;
    let native = request_json(
        "GET",
        &format!("{origin}/api/v1/models"),
        connection,
        None,
        Duration::from_secs(20),
    );
    if let Ok(body) = native {
        if let Some(models) = body.get("models").and_then(Value::as_array) {
            return Ok(models
                .iter()
                .filter_map(|entry| {
                    if entry.get("type").and_then(Value::as_str) != Some("llm") {
                        return None;
                    }
                    let key = entry.get("key").and_then(Value::as_str)?;
                    Some(model_record(
                        "lmstudio",
                        key,
                        entry
                            .get("display_name")
                            .and_then(Value::as_str)
                            .unwrap_or(key),
                    ))
                })
                .take(1000)
                .collect());
        }
    }
    let legacy = request_json(
        "GET",
        &format!("{origin}/v1/models"),
        connection,
        None,
        Duration::from_secs(20),
    )?;
    let models = legacy
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "LM Studio hat keine Modellliste geliefert.".to_owned())?;
    Ok(models
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?;
            Some(model_record("lmstudio", id, id))
        })
        .take(1000)
        .collect())
}

fn openai_models(connection: &Value) -> Result<Vec<Value>, String> {
    require_key(connection)?;
    parse_openai_models(&request_json(
        "GET",
        "https://api.openai.com/v1/models",
        connection,
        None,
        Duration::from_secs(20),
    )?)
}

fn parse_openai_models(body: &Value) -> Result<Vec<Value>, String> {
    let models = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "OpenAI hat keine Modellliste geliefert.".to_owned())?;
    Ok(models
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?;
            let mut record = model_record("openai", id, id);
            if let Some(object) = record.as_object_mut() {
                object.insert(
                    "publisher".into(),
                    Value::String(
                        entry
                            .get("owned_by")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                    ),
                );
            }
            Some(record)
        })
        .take(1000)
        .collect())
}

fn gemini_models(connection: &Value) -> Result<Vec<Value>, String> {
    require_key(connection)?;
    parse_gemini_models(&request_json(
        "GET",
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        connection,
        None,
        Duration::from_secs(20),
    )?)
}

fn parse_gemini_models(body: &Value) -> Result<Vec<Value>, String> {
    let models = body
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "Gemini hat keine Modellliste geliefert.".to_owned())?;
    Ok(models
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name").and_then(Value::as_str)?;
            let methods = entry
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)?;
            if !methods
                .iter()
                .any(|method| method.as_str() == Some("generateContent"))
            {
                return None;
            }
            let key = name.trim_start_matches("models/");
            let display = entry
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or(key);
            let mut record = model_record("gemini", key, display);
            if let Some(object) = record.as_object_mut() {
                object.insert("publisher".into(), Value::String("Google".to_owned()));
            }
            Some(record)
        })
        .take(1000)
        .collect())
}

fn anthropic_models(connection: &Value) -> Result<Vec<Value>, String> {
    require_key(connection)?;
    parse_anthropic_models(&request_json(
        "GET",
        "https://api.anthropic.com/v1/models?limit=1000",
        connection,
        None,
        Duration::from_secs(20),
    )?)
}

fn parse_anthropic_models(body: &Value) -> Result<Vec<Value>, String> {
    let models = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic hat keine Modellliste geliefert.".to_owned())?;
    Ok(models
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?;
            let display = entry
                .get("display_name")
                .and_then(Value::as_str)
                .unwrap_or(id);
            let mut record = model_record("anthropic", id, display);
            if let Some(object) = record.as_object_mut() {
                object.insert("publisher".into(), Value::String("Anthropic".to_owned()));
            }
            Some(record)
        })
        .take(1000)
        .collect())
}

fn opencode_models(connection: &Value) -> Result<Vec<Value>, String> {
    let origin = origin(connection, "opencode")?;
    request_json(
        "GET",
        &format!("{origin}/global/health"),
        connection,
        None,
        Duration::from_secs(20),
    )?;
    parse_opencode_models(&request_json(
        "GET",
        &format!("{origin}/provider"),
        connection,
        None,
        Duration::from_secs(20),
    )?)
}

fn parse_opencode_models(body: &Value) -> Result<Vec<Value>, String> {
    let providers = body
        .get("all")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut models = Vec::new();
    for provider in providers {
        let Some(provider_id) = provider.get("id").and_then(Value::as_str) else {
            continue;
        };
        let provider_name = provider
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(provider_id);
        let entries = match provider.get("models") {
            Some(Value::Object(object)) => object
                .iter()
                .map(|(id, entry)| (id.clone(), entry.clone()))
                .collect::<Vec<_>>(),
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|entry| {
                    let id = entry.get("id").and_then(Value::as_str)?;
                    Some((id.to_owned(), entry.clone()))
                })
                .collect(),
            _ => Vec::new(),
        };
        for (id, entry) in entries {
            if id.is_empty() {
                continue;
            }
            let display = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id.as_str());
            let mut record = model_record(
                "opencode",
                &format!("{provider_id}/{id}"),
                &format!("{provider_name} · {display}"),
            );
            if let Some(object) = record.as_object_mut() {
                object.insert("publisher".into(), Value::String(provider_name.to_owned()));
            }
            models.push(record);
            if models.len() == 1000 {
                return Ok(models);
            }
        }
    }
    Ok(models)
}

fn gemini_generate(connection: &Value, model: &str, prompt: &str) -> Result<String, String> {
    require_key(connection)?;
    let body = request_json(
        "POST",
        &format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
            urlencoding_encode(model)
        ),
        connection,
        Some(json!({
            "systemInstruction": { "parts": [{ "text": "Du bist der Markdown-Assistent von FaNotes." }] },
            "contents": [{ "role": "user", "parts": [{ "text": prompt }] }]
        })),
        Duration::from_secs(120),
    )?;
    body["candidates"][0]["content"]["parts"]
        .as_array()
        .and_then(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .next()
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            "Der AI-Anbieter hat kein verwendbares Markdown-Dokument zurückgegeben.".to_owned()
        })
}

fn anthropic_message(connection: &Value, model: &str, prompt: &str) -> Result<String, String> {
    require_key(connection)?;
    let body = request_json(
        "POST",
        "https://api.anthropic.com/v1/messages",
        connection,
        Some(json!({
            "model": model,
            "max_tokens": 2048,
            "system": "Du bist der Markdown-Assistent von FaNotes.",
            "messages": [{ "role": "user", "content": prompt }]
        })),
        Duration::from_secs(120),
    )?;
    body["content"]
        .as_array()
        .and_then(|parts| {
            parts.iter().find_map(|part| {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    part.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            "Der AI-Anbieter hat kein verwendbares Markdown-Dokument zurückgegeben.".to_owned()
        })
}

fn opencode_message(connection: &Value, model: &str, prompt: &str) -> Result<String, String> {
    let Some((provider_id, model_id)) = model.split_once('/') else {
        return Err("Das OpenCode-Modell besitzt keine gültige Anbieterkennung.".to_owned());
    };
    if provider_id.is_empty() || model_id.is_empty() {
        return Err("Das OpenCode-Modell besitzt keine gültige Anbieterkennung.".to_owned());
    }
    let origin = origin(connection, "opencode")?;
    let session = request_json(
        "POST",
        &format!("{origin}/session"),
        connection,
        Some(json!({ "title": "FaNotes" })),
        Duration::from_secs(20),
    )?;
    let Some(session_id) = session.get("id").and_then(Value::as_str) else {
        return Err("OpenCode konnte keine kurzlebige Sitzung erstellen.".to_owned());
    };
    let response = request_json(
        "POST",
        &format!(
            "{origin}/session/{}/message",
            urlencoding_encode(session_id)
        ),
        connection,
        Some(json!({
            "model": { "providerID": provider_id, "modelID": model_id },
            "system": "Du bist der Markdown-Assistent von FaNotes.",
            "parts": [{ "type": "text", "text": prompt }]
        })),
        Duration::from_secs(120),
    );
    let _ = request_json(
        "DELETE",
        &format!("{origin}/session/{session_id}"),
        connection,
        None,
        Duration::from_secs(20),
    );
    let response = response?;
    response
        .get("parts")
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts.iter().find_map(|part| {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    part.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            "Der AI-Anbieter hat kein verwendbares Markdown-Dokument zurückgegeben.".to_owned()
        })
}

fn ollama_chat(connection: &Value, model: &str, prompt: &str) -> Result<String, String> {
    let origin = origin(connection, "ollama")?;
    let body = request_json(
        "POST",
        &format!("{origin}/api/chat"),
        connection,
        Some(json!({
            "model": model,
            "messages": [
                {"role": "system", "content": "Du bist der Markdown-Assistent von FaNotes."},
                {"role": "user", "content": prompt}
            ],
            "stream": false
        })),
        Duration::from_secs(120),
    )?;
    body.get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Ollama hat kein verwendbares Markdown-Dokument zurückgegeben.".to_owned())
}

fn chat_completions(connection: &Value, model: &str, prompt: &str) -> Result<String, String> {
    let provider = provider_name(connection)?;
    let origin = if provider == "openai" {
        "https://api.openai.com".to_owned()
    } else {
        origin(connection, provider)?
    };
    let body = request_json(
        "POST",
        &format!("{origin}/v1/chat/completions"),
        connection,
        Some(json!({
            "model": model,
            "messages": [
                {"role": "system", "content": "Du bist der Markdown-Assistent von FaNotes."},
                {"role": "user", "content": prompt}
            ],
            "stream": false
        })),
        Duration::from_secs(120),
    )?;
    body["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| {
            "Der AI-Anbieter hat kein verwendbares Markdown-Dokument zurückgegeben.".to_owned()
        })
}

fn request_json(
    method: &str,
    url: &str,
    connection: &Value,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let agent: Agent = Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(timeout))
        .http_status_as_error(true)
        .build()
        .into();
    let headers = auth_headers(connection);
    let request = if method == "POST" {
        let body = body.unwrap_or(Value::Null);
        let mut request = agent.post(url).header("Accept", "application/json");
        for (name, value) in &headers {
            request = request.header(name, value);
        }
        request.send_json(body)
    } else if method == "DELETE" {
        let mut request = agent.delete(url).header("Accept", "application/json");
        for (name, value) in &headers {
            request = request.header(name, value);
        }
        request.call()
    } else {
        let mut request = agent.get(url).header("Accept", "application/json");
        for (name, value) in &headers {
            request = request.header(name, value);
        }
        request.call()
    };
    let mut response =
        request.map_err(|error| format!("Der AI-Dienst ist nicht erreichbar: {error}"))?;
    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|_| "Der AI-Dienst hat keine gültige JSON-Antwort geliefert.".to_owned())?;
    if text.len() > 8 * 1024 * 1024 {
        return Err("Der AI-Dienst hat eine unerwartet große Antwort geliefert.".to_owned());
    }
    serde_json::from_str(&text)
        .map_err(|_| "Der AI-Dienst hat keine gültige JSON-Antwort geliefert.".to_owned())
}

fn auth_headers(connection: &Value) -> Vec<(String, String)> {
    let provider = connection
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("");
    let key = connection
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    if key.is_empty() {
        return Vec::new();
    }
    match provider {
        "gemini" => vec![("x-goog-api-key".to_owned(), key.to_owned())],
        "anthropic" => vec![
            ("x-api-key".to_owned(), key.to_owned()),
            ("anthropic-version".to_owned(), "2023-06-01".to_owned()),
        ],
        "opencode" => {
            let user = connection
                .get("username")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("opencode");
            let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{key}"));
            vec![("Authorization".to_owned(), format!("Basic {token}"))]
        }
        _ => vec![("Authorization".to_owned(), format!("Bearer {key}"))],
    }
}

fn urlencoding_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn model_record(provider: &str, key: &str, display_name: &str) -> Value {
    json!({
        "provider": provider,
        "key": key,
        "displayName": display_name,
        "publisher": "",
        "quantization": null,
        "params": null,
        "loaded": true,
        "maxContextLength": null,
        "description": null,
    })
}

fn provider_name(connection: &Value) -> Result<&str, String> {
    connection
        .get("provider")
        .and_then(Value::as_str)
        .filter(|provider| {
            matches!(
                *provider,
                "lmstudio" | "ollama" | "openai" | "gemini" | "anthropic" | "opencode"
            )
        })
        .ok_or_else(|| "Wähle einen unterstützten AI-Anbieter.".to_owned())
}

fn origin(connection: &Value, provider: &str) -> Result<String, String> {
    local_ai_origin(
        connection
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or(""),
        provider,
    )
}

fn require_key(connection: &Value) -> Result<(), String> {
    let key = connection
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    if key.is_empty() {
        Err("Gib zuerst den API-Schlüssel dieses Anbieters ein.".to_owned())
    } else {
        Ok(())
    }
}

fn required_model(value: &Value) -> Result<String, String> {
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("connection")
                .and_then(|connection| connection.get("model"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .trim();
    if model.is_empty()
        || model.len() > 500
        || model.chars().any(|character| character.is_control())
    {
        Err("Wähle zuerst ein gültiges AI-Modell.".to_owned())
    } else {
        Ok(model.to_owned())
    }
}

fn required_markdown(value: Option<&Value>) -> Result<String, String> {
    let markdown = value.and_then(Value::as_str).unwrap_or("");
    if markdown.len() > 1_500_000 {
        Err("Die Notiz ist für einen einzelnen AI-Auftrag zu groß.".to_owned())
    } else {
        Ok(markdown.to_owned())
    }
}

fn required_actions(value: Option<&Value>) -> Result<Vec<String>, String> {
    let actions = value
        .and_then(Value::as_array)
        .ok_or_else(|| "Wähle mindestens eine AI-Aktion.".to_owned())?;
    if actions.is_empty() {
        return Err("Wähle mindestens eine AI-Aktion.".to_owned());
    }
    let mut unique = Vec::new();
    for action in actions {
        let name = action
            .as_str()
            .filter(|name| ACTIONS.contains(name))
            .ok_or_else(|| "Die ausgewählten AI-Aktionen sind ungültig.".to_owned())?;
        if !unique.iter().any(|existing: &String| existing == name) {
            unique.push(name.to_owned());
        }
    }
    if unique.len() != actions.len() {
        return Err("Die ausgewählten AI-Aktionen sind ungültig.".to_owned());
    }
    Ok(unique)
}

fn unwrap_markdown(value: &str) -> Result<String, String> {
    let mut output = value.trim().to_owned();
    if let Some(rest) = output
        .strip_prefix("```markdown")
        .or_else(|| output.strip_prefix("```md"))
        .or_else(|| output.strip_prefix("```"))
    {
        if let Some(end) = rest.rfind("```") {
            output = rest[..end].trim().to_owned();
        }
    }
    if output.is_empty() || output.len() > 4 * 1024 * 1024 {
        Err("Der AI-Anbieter hat kein verwendbares Markdown-Dokument zurückgegeben.".to_owned())
    } else {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_anthropic_models, parse_gemini_models, parse_openai_models};
    use serde_json::json;

    #[test]
    fn cloud_lists_keep_the_provider_shape() {
        let openai = parse_openai_models(&json!({
            "data": [{ "id": "gpt-4.1", "owned_by": "openai" }]
        }))
        .unwrap();
        assert_eq!(openai[0]["provider"], "openai");
        assert_eq!(openai[0]["key"], "gpt-4.1");
        assert_eq!(openai[0]["publisher"], "openai");

        let gemini = parse_gemini_models(&json!({
            "models": [
                {
                    "name": "models/gemini-2.5-flash",
                    "displayName": "Gemini Flash",
                    "supportedGenerationMethods": ["generateContent"]
                },
                {
                    "name": "models/embedding",
                    "displayName": "Embed",
                    "supportedGenerationMethods": ["embedContent"]
                }
            ]
        }))
        .unwrap();
        assert_eq!(gemini.len(), 1);
        assert_eq!(gemini[0]["key"], "gemini-2.5-flash");
        assert_eq!(gemini[0]["displayName"], "Gemini Flash");
        assert_eq!(gemini[0]["publisher"], "Google");

        let anthropic = parse_anthropic_models(&json!({
            "data": [{ "id": "claude-sonnet", "display_name": "Claude Sonnet" }]
        }))
        .unwrap();
        assert_eq!(anthropic[0]["provider"], "anthropic");
        assert_eq!(anthropic[0]["displayName"], "Claude Sonnet");
        assert_eq!(anthropic[0]["publisher"], "Anthropic");
    }
}
