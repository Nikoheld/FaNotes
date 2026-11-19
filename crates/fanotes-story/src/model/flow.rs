//! The manuscript as the editor and the layout see it (`model/flow.ts`): one
//! ordered list of blocks built from the binder. A chapter or part contributes
//! its title, each scene its paragraphs, and a scene that follows another in
//! the same chapter is preceded by a scene break. Excluded nodes are left out.

use std::collections::HashMap;
use std::sync::Arc;

use super::types::*;
use crate::json::{JsValue, ObjectBuilder, ToJs};

#[derive(Clone, Debug, PartialEq)]
pub enum BlockRef {
    Title {
        node_id: String,
    },
    Break {
        scene_id: String,
    },
    Para {
        scene_id: String,
        paragraph_id: String,
    },
}

impl BlockRef {
    pub fn kind(&self) -> &'static str {
        match self {
            BlockRef::Title { .. } => "title",
            BlockRef::Break { .. } => "break",
            BlockRef::Para { .. } => "para",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FlowBlock {
    /// Unique in the flow: `t:<node>`, `b:<scene>`, `p:<paragraph>`.
    pub key: Arc<str>,
    pub reference: BlockRef,
    pub style: String,
    /// Shared, so the layout cache recognises an unchanged paragraph by pointer first.
    pub runs: Arc<Vec<Run>>,
    pub align: Option<Align>,
    pub lang: Option<StoryLanguage>,
    pub editable: bool,
    /// `breakBefore: 'page'`.
    pub break_before: bool,
    /// The chapter (or part) this block belongs to.
    pub chapter_id: Option<String>,
    pub chapter_title: String,
    pub scene_id: Option<String>,
    /// First paragraph after a title or a scene break.
    pub after_break: bool,
    /// Starts a chapter: page break, header hidden on that page.
    pub chapter_start: bool,
    pub conflict_of: Option<String>,
}

impl ToJs for FlowBlock {
    fn to_js(&self) -> JsValue {
        let reference = match &self.reference {
            BlockRef::Title { node_id } => ObjectBuilder::new()
                .set("kind", "title")
                .set("nodeId", node_id.as_str())
                .build(),
            BlockRef::Break { scene_id } => ObjectBuilder::new()
                .set("kind", "break")
                .set("sceneId", scene_id.as_str())
                .build(),
            BlockRef::Para {
                scene_id,
                paragraph_id,
            } => ObjectBuilder::new()
                .set("kind", "para")
                .set("sceneId", scene_id.as_str())
                .set("paragraphId", paragraph_id.as_str())
                .build(),
        };
        let nullable = |value: &Option<String>| {
            value
                .as_ref()
                .map(|text| JsValue::from(text.as_str()))
                .unwrap_or(JsValue::Null)
        };
        ObjectBuilder::new()
            .set("key", &*self.key)
            .set("ref", reference)
            .set("style", self.style.as_str())
            .set("runs", self.runs.to_js())
            .opt("align", self.align)
            .opt("lang", self.lang)
            .set("editable", self.editable)
            .opt("breakBefore", self.break_before.then_some("page"))
            .set("chapterId", nullable(&self.chapter_id))
            .set("chapterTitle", self.chapter_title.as_str())
            .set("sceneId", nullable(&self.scene_id))
            .set("afterBreak", self.after_break)
            .set("chapterStart", self.chapter_start)
            .opt("conflictOf", self.conflict_of.as_ref())
            .build()
    }
}

pub fn title_key(node_id: &str) -> String {
    format!("t:{node_id}")
}

pub fn break_key(scene_id: &str) -> String {
    format!("b:{scene_id}")
}

pub fn paragraph_key(paragraph_id: &str) -> String {
    format!("p:{paragraph_id}")
}

pub fn visible_paragraphs(scene: &Scene) -> impl Iterator<Item = &Paragraph> {
    scene
        .paragraphs
        .iter()
        .filter(|paragraph| !paragraph.deleted)
}

fn text_runs(text: &str) -> Arc<Vec<Run>> {
    Arc::new(if text.is_empty() {
        Vec::new()
    } else {
        vec![Run::new(text)]
    })
}

/// `buildFlow(manifest, scenes)`.
pub fn build_flow(manifest: &StoryManifest, scenes: &HashMap<String, Scene>) -> Vec<FlowBlock> {
    let mut blocks = Vec::new();
    walk(manifest, scenes, &manifest.binder, None, "", &mut blocks);
    blocks
}

fn walk(
    manifest: &StoryManifest,
    scenes: &HashMap<String, Scene>,
    nodes: &[BinderNode],
    chapter_id: Option<&str>,
    chapter_title: &str,
    blocks: &mut Vec<FlowBlock>,
) {
    let mut scenes_in_chapter = 0;
    for node in nodes {
        if node.exclude {
            continue;
        }
        let children = node.children.as_deref().unwrap_or(&[]);
        match node.kind {
            BinderKind::Part | BinderKind::Chapter => {
                blocks.push(FlowBlock {
                    key: title_key(&node.id).into(),
                    reference: BlockRef::Title {
                        node_id: node.id.clone(),
                    },
                    style: if node.kind == BinderKind::Part && manifest.styles.contains_key("part")
                    {
                        "part"
                    } else {
                        "chapter"
                    }
                    .into(),
                    runs: text_runs(&node.title),
                    align: None,
                    lang: None,
                    editable: true,
                    break_before: false,
                    chapter_id: Some(node.id.clone()),
                    chapter_title: node.title.clone(),
                    scene_id: None,
                    after_break: false,
                    chapter_start: true,
                    conflict_of: None,
                });
                walk(
                    manifest,
                    scenes,
                    children,
                    Some(&node.id),
                    &node.title,
                    blocks,
                );
                scenes_in_chapter = 0;
            }
            BinderKind::Folder => walk(
                manifest,
                scenes,
                children,
                chapter_id,
                chapter_title,
                blocks,
            ),
            BinderKind::Scene => {
                let Some(scene) = scenes.get(&node.id) else {
                    continue;
                };
                if scenes_in_chapter > 0 {
                    blocks.push(FlowBlock {
                        key: break_key(&scene.id).into(),
                        reference: BlockRef::Break {
                            scene_id: scene.id.clone(),
                        },
                        style: "scenebreak".into(),
                        runs: text_runs(&manifest.page.scene_break),
                        align: None,
                        lang: None,
                        editable: false,
                        break_before: false,
                        chapter_id: chapter_id.map(str::to_string),
                        chapter_title: chapter_title.to_string(),
                        scene_id: Some(scene.id.clone()),
                        after_break: false,
                        chapter_start: false,
                        conflict_of: None,
                    });
                }
                scenes_in_chapter += 1;
                let mut first = true;
                for paragraph in visible_paragraphs(scene) {
                    let after_break = first
                        && blocks.last().is_none_or(|previous| {
                            !matches!(previous.reference, BlockRef::Para { .. })
                        });
                    blocks.push(FlowBlock {
                        key: paragraph_key(&paragraph.id).into(),
                        reference: BlockRef::Para {
                            scene_id: scene.id.clone(),
                            paragraph_id: paragraph.id.clone(),
                        },
                        style: paragraph.style.clone(),
                        runs: Arc::new(paragraph.runs.clone()),
                        align: paragraph.align,
                        lang: paragraph.lang,
                        editable: true,
                        break_before: paragraph.break_before,
                        chapter_id: chapter_id.map(str::to_string),
                        chapter_title: chapter_title.to_string(),
                        scene_id: Some(scene.id.clone()),
                        after_break,
                        chapter_start: false,
                        conflict_of: paragraph.conflict_of.clone(),
                    });
                    first = false;
                }
            }
        }
    }
}
