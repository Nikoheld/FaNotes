//! Local and cloud model calls for the AI panels.
//!
//! Ollama and LM Studio stay on localhost or the private LAN. The list commands
//! return the model array the panels render.

use std::time::Duration;

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
        "openai" | "gemini" | "anthropic" => {
            require_key(connection)?;
            Vec::new()
        }
        "opencode" => Vec::new(),
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
    let token = connection
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    let request = if method == "POST" {
        let body = body.unwrap_or(Value::Null);
        agent
            .post(url)
            .header("Accept", "application/json")
            .header("Authorization", &format!("Bearer {token}"))
            .send_json(body)
    } else {
        let request = agent.get(url).header("Accept", "application/json");
        if token.is_empty() {
            request.call()
        } else {
            request
                .header("Authorization", &format!("Bearer {token}"))
                .call()
        }
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
