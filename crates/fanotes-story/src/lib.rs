//! FaNotes writing mode ("Schreiben") in Rust: a port of `fanotes/src/writing`
//! (model, sanitize, paragraph merge, line breaking, hyphenation, pagination).
//!
//! The TypeScript engine is the specification. Parity fixtures produced by
//! `fanotes/scripts/gen-story-fixtures.mjs` (`tests/fixtures/`) pin the
//! results: `cargo test -p fanotes-story` reproduces each one exactly.
//!
//! Entry points:
//! - files: [`model::sanitize::read_scene`], [`model::sanitize::read_manifest`],
//!   [`model::types::Scene::to_file`], [`model::types::StoryManifest::to_file`];
//! - sync: [`model::merge::merge_scene_json`] (and [`model::merge::merge_scenes`],
//!   [`model::merge::stamp_edits`] on typed scenes);
//! - layout: [`model::flow::build_flow`], [`layout::paginate::layout_manuscript`]
//!   with a [`layout::measure::Measurer`] ([`layout::measure::FixedMeasurer`] for
//!   tests, `layout::fonts::FontMeasurer` for the bundled fonts).

pub mod js;
pub mod json;
pub mod layout;
pub mod model;

pub use layout::hyphen::{Hyphenate, Hyphenator};
pub use layout::linebreak::{layout_paragraph, resolve_style, LayoutInput, ParagraphLayout};
pub use layout::measure::{FixedMeasurer, FontMetrics, FontSpec, Measurer};
pub use layout::paginate::{
    layout_manuscript, Hyphenators, LayoutCache, LayoutOptions, ManuscriptLayout, Page,
};
pub use model::flow::{build_flow, FlowBlock};
#[cfg(feature = "os-random")]
pub use model::merge::merge_scene_json;
pub use model::merge::{
    merge_scene_json_with, merge_scenes, stamp_edits, MergedSceneJson, SceneMerge,
};
pub use model::types::{Paragraph, Run, Scene, StoryManifest};
