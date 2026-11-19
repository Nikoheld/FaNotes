//! The production fetcher: `reqwest` (blocking, rustls). Redirects are left to
//! [`crate::fetch::fetch_github`], which only follows allow-listed hosts.
//! Run it on a worker thread, never on a UI or async executor thread.

use std::io::Read;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use crate::error::{ErrorKind, Result, UpdateError};
use crate::fetch::{Fetcher, Request, Response};

pub struct ReqwestFetcher {
    client: reqwest::blocking::Client,
    idle_timeout: Duration,
}

/// Reads the body on a helper thread so a stalled connection surfaces as
/// `TimedOut` after `idle` instead of blocking forever (reqwest's blocking
/// client has no per-read timeout).
struct IdleReader {
    chunks: Receiver<std::io::Result<Vec<u8>>>,
    pending: Vec<u8>,
    position: usize,
    idle: Duration,
}

impl IdleReader {
    fn spawn(mut body: reqwest::blocking::Response, idle: Duration) -> Self {
        let (sender, chunks) = mpsc::sync_channel(4);
        std::thread::spawn(move || loop {
            let mut buffer = vec![0u8; 64 * 1024];
            match body.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    buffer.truncate(read);
                    if sender.send(Ok(buffer)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        });
        Self {
            chunks,
            pending: Vec::new(),
            position: 0,
            idle,
        }
    }
}

impl Read for IdleReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.position >= self.pending.len() {
            match self.chunks.recv_timeout(self.idle) {
                Ok(Ok(chunk)) => {
                    self.pending = chunk;
                    self.position = 0;
                }
                Ok(Err(error)) => return Err(error),
                Err(RecvTimeoutError::Timeout) => return Err(std::io::ErrorKind::TimedOut.into()),
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let count = out.len().min(self.pending.len() - self.position);
        out[..count].copy_from_slice(&self.pending[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }
}

impl ReqwestFetcher {
    /// `idle_timeout`: a body read that stalls this long fails with `TimedOut`,
    /// which the downloader treats as a retryable stall.
    pub fn new(idle_timeout: Duration) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            // The blocking client defaults to a 30 s total timeout; transfers set their own.
            .timeout(None)
            .build()
            .map_err(|e| UpdateError::new(ErrorKind::Network, e.to_string()))?;
        Ok(Self {
            client,
            idle_timeout,
        })
    }
}

impl Default for ReqwestFetcher {
    fn default() -> Self {
        Self::new(crate::download::DOWNLOAD_IDLE).expect("reqwest client")
    }
}

impl Fetcher for ReqwestFetcher {
    fn fetch(&self, request: &Request) -> Result<Response> {
        let mut builder = self.client.get(&request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(timeout) = request.timeout {
            builder = builder.timeout(timeout);
        }
        let response = builder.send().map_err(|error| {
            let code = if error.is_timeout() {
                "ETIMEDOUT"
            } else if error.is_connect() {
                "ECONNREFUSED"
            } else {
                "ECONNRESET"
            };
            UpdateError::new(ErrorKind::Network, error.to_string()).with_code(code)
        })?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                Some((
                    name.as_str().to_lowercase(),
                    value.to_str().ok()?.to_owned(),
                ))
            })
            .collect();
        Ok(Response {
            status,
            headers,
            body: Box::new(IdleReader::spawn(response, self.idle_timeout)),
        })
    }
}
