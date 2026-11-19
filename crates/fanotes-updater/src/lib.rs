//! FaNotes updater: a faithful Rust port of `fanotes/electron/updater.cjs`,
//! `delta.cjs`, `releaseVersion.cjs` and `download-hosts.cjs`.
//!
//! Security-critical, so behaviour is ported exactly, including the German
//! error messages (the shared fixtures in `fanotes/scripts/fixtures/updater/`
//! assert on them in both implementations).
//!
//! # Known differences from the JavaScript
//!
//! All of them make the Rust side stricter or are unavoidable; none loosens a check.
//! * Ed25519 uses `verify_strict` (rejects small-order keys and malleable signatures);
//!   OpenSSL, behind Node's `crypto.verify`, does not.
//! * Where JS passes a value to `RegExp.test` or `new URL`, it coerces arrays and
//!   numbers to strings. Rust requires real JSON strings.
//! * `publishedAt` is parsed as ISO-8601 only; V8's legacy `Date.parse` formats
//!   (`Jul 14 2026`) are refused, and a date-time without an offset is read as UTC.
//! * JSON documents with numbers outside the f64 range, or nested deeper than 128
//!   levels, are refused as a whole (`serde_json`); JS would map them to `Infinity`.
//! * Diagnosis does no DNS lookup and ignores `error.cause` chains; the caller may
//!   pass `resolved_address`.
//! * Timers are the fetcher's job: per-request timeouts through `Request::timeout`, the
//!   idle stall as an `io::ErrorKind::TimedOut` from the body reader. The 45 minute
//!   download deadline is checked between chunks and attempts.
//! * Not ported: the Linux/Windows install helper scripts, the desktop launcher, the
//!   UI state machine and timers (`createUpdateManager`); the host wires those in.
//!
//! Layers:
//! * [`version`]: calendar version order, channel visibility, package names.
//! * [`json`], [`manifest`]: canonical JSON, Ed25519 verification, validation.
//! * [`release`], [`fetch`]: channel policy and the manifest check over a [`fetch::Fetcher`].
//! * [`download`], [`delta`]: resumable verified downloads and delta apply.
//! * [`state`], [`client`]: rollback guard, persisted state, check/download flow.
//! * [`release_policy`]: calendar-version rules for publishing a release.
//!
//! The crate is not wired into any application yet.

pub mod client;
pub mod date;
pub mod delta;
pub mod diagnosis;
pub mod download;
pub mod error;
pub mod fetch;
pub mod hosts;
pub mod json;
pub mod manifest;
pub mod platform;
pub mod release;
pub mod release_policy;
pub mod state;
pub mod util;
pub mod version;

#[cfg(feature = "reqwest-fetcher")]
pub mod reqwest_fetcher;

pub use client::{CheckOutcome, StagedUpdate, UpdateClient, UpdaterConfig};
pub use error::{ErrorKind, Result, UpdateError};
pub use fetch::{Fetcher, Request, Response};
pub use manifest::{verify_manifest, VerifiedManifest, EXPECTED_KEY_ID, PRODUCT_PUBLIC_KEY_PEM};
pub use platform::{PackageKind, Platform};
pub use version::{compare_versions, Channel};
