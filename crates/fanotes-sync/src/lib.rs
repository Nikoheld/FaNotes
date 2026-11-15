//! FaNotes sync engine: a port of `fanotes/src/lib/sync/engine.ts`.
//! See `DESIGN.md` for the protocol, the invariants and the parity harness.

#![allow(
    clippy::result_large_err,
    clippy::type_complexity,
    clippy::too_many_arguments,
    clippy::should_implement_trait
)]

pub mod api;
pub mod conflicts;
pub mod crypto;
pub mod engine;
pub mod famd;
pub mod famd_v2;
pub mod harness;
pub mod homework;
pub mod host;
pub mod jsjson;
pub mod notemeta;
pub mod paths;
pub mod state;

pub use api::{SyncApi, SyncApiError, SyncError};
pub use engine::{story_content_merge, ContentMerge, EngineOptions, SyncEngine};
pub use host::{FsHost, MemoryHost, ScanEntry, SyncHost};
