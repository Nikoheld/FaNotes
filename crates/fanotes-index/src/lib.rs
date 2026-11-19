//! Full-text index of a FaNotes vault for the desktop host.
//!
//! The ranking, folding and snippets are a port of the TypeScript document
//! search (`fanotes/src/lib/docSearch/{text,docIndex}.ts`) and give the same
//! hits in the same order on the parity fixtures
//! (`fanotes/scripts/fixtures/search-parity`).

#![allow(clippy::type_complexity)]

pub mod collate;
pub mod index;
pub mod jsmath;
pub mod text;

pub use index::{
    DocIndex, IndexUnit, PreparedUnit, SearchResult, UnitKind, UnitSource, MAX_RESULTS,
};
pub use text::Snippet;
pub mod famd;
pub mod service;
pub mod vault;

pub use service::{cache_file, Engine, IndexService, Options};
pub use vault::{extract, list_sources, DocKind, DocSource, DocStatus, Extracted};
