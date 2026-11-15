//! The story document model (`model/types.ts`): `story.json`
//! (`fanotes-story-v1`) and `scenes/<id>.json` (`fanotes-story-scene-v1`).
//! Lengths in millimetres, font sizes in points.
//!
//! Every type writes the fields in the order the TypeScript sanitizer creates
//! them, so `JSON.stringify` of a sanitized value and [`ToJs::to_json`] give
//! the same bytes. Optional fields are `Option` (absent = `undefined`).

use crate::json::{JsMap, JsValue, ObjectBuilder, ToJs};

pub const STORY_FORMAT: &str = "fanotes-story-v1";
pub const SCENE_FORMAT: &str = "fanotes-story-scene-v1";
pub const STORY_EXTENSION: &str = ".story";

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name { $($variant),+ }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }

            #[allow(clippy::should_implement_trait)]
            pub fn from_str(text: &str) -> Option<$name> {
                match text { $($text => Some($name::$variant),)+ _ => None }
            }

            /// The value of a JSON field, when it is one of the names.
            pub fn from_js(value: Option<&JsValue>) -> Option<$name> {
                value.and_then(JsValue::as_str).and_then($name::from_str)
            }
        }

        impl From<$name> for JsValue {
            fn from(value: $name) -> JsValue {
                JsValue::String(value.as_str().to_string())
            }
        }
    };
}

string_enum!(
    /// `StoryLanguage`.
    StoryLanguage { De = "de", DeCh = "de-CH", EnUs = "en-US", EnGb = "en-GB" }
);
string_enum!(Align { Left = "left", Center = "center", Right = "right", Justify = "justify" });
string_enum!(FontFamily { Literata = "literata", Garamond = "garamond", Courier = "courier", Atkinson = "atkinson" });
string_enum!(PageSize { A4 = "A4", A5 = "A5", Letter = "Letter", Pocket = "pocket", Trade = "trade", Manuscript = "manuscript", Custom = "custom" });
string_enum!(BinderKind { Part = "part", Chapter = "chapter", Scene = "scene", Folder = "folder" });
string_enum!(SceneStatus { Idea = "idea", Draft = "draft", Revised = "revised", Final = "final" });

impl StoryLanguage {
    /// `language.startsWith('de')`.
    pub fn is_german(self) -> bool {
        matches!(self, StoryLanguage::De | StoryLanguage::DeCh)
    }

    pub fn is_english(self) -> bool {
        !self.is_german()
    }
}

/// Inline formatting of a run (`Marks`). Absent means "as the paragraph style says".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Marks {
    pub b: bool,
    pub i: bool,
    pub u: bool,
    pub s: bool,
    /// Small capitals.
    pub sc: bool,
    pub sup: bool,
    pub sub: bool,
    pub font: Option<FontFamily>,
    /// Points.
    pub size: Option<f64>,
    pub color: Option<String>,
    /// Highlight colour.
    pub hl: Option<String>,
    pub link: Option<String>,
    /// Footnote reference: the footnote id.
    pub fn_: Option<String>,
    /// Comment anchor: the comment id.
    pub cm: Option<String>,
    pub lang: Option<StoryLanguage>,
}

impl Marks {
    pub fn is_empty(&self) -> bool {
        *self == Marks::default()
    }
}

impl ToJs for Marks {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .flag("b", self.b)
            .flag("i", self.i)
            .flag("u", self.u)
            .flag("s", self.s)
            .flag("sc", self.sc)
            .flag("sup", self.sup)
            .flag("sub", self.sub)
            .opt("font", self.font)
            .opt("size", self.size)
            .opt("color", self.color.as_ref())
            .opt("hl", self.hl.as_ref())
            .opt("link", self.link.as_ref())
            .opt("fn", self.fn_.as_ref())
            .opt("cm", self.cm.as_ref())
            .opt("lang", self.lang)
            .build()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Run {
    pub text: String,
    pub m: Option<Marks>,
}

impl Run {
    pub fn new(text: impl Into<String>) -> Run {
        Run {
            text: text.into(),
            m: None,
        }
    }

    pub fn with_marks(text: impl Into<String>, marks: Marks) -> Run {
        Run {
            text: text.into(),
            m: Some(marks),
        }
    }

    /// The footnote id when this run is a footnote reference.
    pub fn footnote(&self) -> Option<&str> {
        self.m.as_ref().and_then(|marks| marks.fn_.as_deref())
    }
}

impl ToJs for Run {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("text", self.text.as_str())
            .opt("m", self.m.as_ref().map(ToJs::to_js))
            .build()
    }
}

/// Version vector: device id → edit counter (JavaScript numbers).
pub type Vector = JsMap<f64>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Paragraph {
    pub id: String,
    /// Order key within the scene (fractional index).
    pub key: String,
    pub v: Vector,
    pub style: String,
    pub runs: Vec<Run>,
    pub lang: Option<StoryLanguage>,
    pub align: Option<Align>,
    /// `breakBefore: 'page'`.
    pub break_before: bool,
    /// Tombstone.
    pub deleted: bool,
    /// The other device's concurrent version of this paragraph id.
    pub conflict_of: Option<String>,
}

impl ToJs for Paragraph {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("id", self.id.as_str())
            .set("key", self.key.as_str())
            .set("v", self.v.to_js())
            .set("style", self.style.as_str())
            .set("runs", self.runs.to_js())
            .opt("lang", self.lang)
            .opt("align", self.align)
            .opt("breakBefore", self.break_before.then_some("page"))
            .flag("deleted", self.deleted)
            .opt("conflictOf", self.conflict_of.as_ref())
            .build()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Footnote {
    pub id: String,
    pub runs: Vec<Run>,
}

impl ToJs for Footnote {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("id", self.id.as_str())
            .set("runs", self.runs.to_js())
            .build()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub at: String,
    pub text: String,
    pub resolved: bool,
}

impl ToJs for Comment {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("id", self.id.as_str())
            .set("author", self.author.as_str())
            .set("at", self.at.as_str())
            .set("text", self.text.as_str())
            .flag("resolved", self.resolved)
            .build()
    }
}

/// `scenes/<id>.json`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scene {
    pub id: String,
    pub paragraphs: Vec<Paragraph>,
    pub footnotes: Option<JsMap<Footnote>>,
    pub comments: Option<JsMap<Comment>>,
}

impl ToJs for Scene {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("format", SCENE_FORMAT)
            .set("id", self.id.as_str())
            .set("paragraphs", self.paragraphs.to_js())
            .opt("footnotes", self.footnotes.as_ref().map(ToJs::to_js))
            .opt("comments", self.comments.as_ref().map(ToJs::to_js))
            .build()
    }
}

impl Scene {
    /// The file content the TypeScript storage writes: `${JSON.stringify(scene)}\n`.
    pub fn to_file(&self) -> String {
        format!("{}\n", self.to_json())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LocalName {
    pub de: String,
    pub en: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParagraphStyle {
    pub id: String,
    pub name: LocalName,
    pub font: FontFamily,
    /// Points.
    pub size: f64,
    /// Multiple of the font size.
    pub line_height: f64,
    /// Points.
    pub space_before: f64,
    pub space_after: f64,
    /// Millimetres.
    pub indent_first: f64,
    pub indent_left: f64,
    pub indent_right: f64,
    pub align: Align,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub small_caps: Option<bool>,
    pub uppercase: Option<bool>,
    pub keep_with_next: Option<bool>,
    pub page_break_before: Option<bool>,
    pub no_indent_after_break: Option<bool>,
    pub color: Option<String>,
    /// Lines a drop cap spans (0 = none).
    pub drop_cap: Option<f64>,
    /// Style of the paragraph Enter creates after this one.
    pub next: Option<String>,
    pub list_marker: Option<String>,
    pub outline_level: Option<f64>,
}

impl ToJs for ParagraphStyle {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("id", self.id.as_str())
            .set(
                "name",
                ObjectBuilder::new()
                    .set("de", self.name.de.as_str())
                    .set("en", self.name.en.as_str())
                    .build(),
            )
            .set("font", self.font)
            .set("size", self.size)
            .set("lineHeight", self.line_height)
            .set("spaceBefore", self.space_before)
            .set("spaceAfter", self.space_after)
            .set("indentFirst", self.indent_first)
            .set("indentLeft", self.indent_left)
            .set("indentRight", self.indent_right)
            .set("align", self.align)
            .opt("bold", self.bold)
            .opt("italic", self.italic)
            .opt("smallCaps", self.small_caps)
            .opt("uppercase", self.uppercase)
            .opt("keepWithNext", self.keep_with_next)
            .opt("pageBreakBefore", self.page_break_before)
            .opt("noIndentAfterBreak", self.no_indent_after_break)
            .opt("color", self.color.as_ref())
            .opt("dropCap", self.drop_cap)
            .opt("next", self.next.as_ref())
            .opt("listMarker", self.list_marker.as_ref())
            .opt("outlineLevel", self.outline_level)
            .build()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct HeaderFooter {
    pub left: String,
    pub center: String,
    pub right: String,
}

impl HeaderFooter {
    pub fn new(left: &str, center: &str, right: &str) -> HeaderFooter {
        HeaderFooter {
            left: left.into(),
            center: center.into(),
            right: right.into(),
        }
    }
}

impl ToJs for HeaderFooter {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("left", self.left.as_str())
            .set("center", self.center.as_str())
            .set("right", self.right.as_str())
            .build()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Margins {
    pub top: f64,
    pub bottom: f64,
    pub inner: f64,
    pub outer: f64,
}

impl ToJs for Margins {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("top", self.top)
            .set("bottom", self.bottom)
            .set("inner", self.inner)
            .set("outer", self.outer)
            .build()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageSetup {
    pub size: PageSize,
    /// Millimetres.
    pub width: f64,
    pub height: f64,
    pub margins: Margins,
    /// Inner/outer margins alternate (books).
    pub mirror: bool,
    pub header: HeaderFooter,
    pub footer: HeaderFooter,
    pub hide_on_chapter_start: bool,
    pub chapter_starts_right: bool,
    pub page_number_start: f64,
    pub header_offset: f64,
    pub footer_offset: f64,
    pub widows_orphans: bool,
    pub hyphenate: bool,
    pub scene_break: String,
}

impl ToJs for PageSetup {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("size", self.size)
            .set("width", self.width)
            .set("height", self.height)
            .set("margins", self.margins.to_js())
            .set("mirror", self.mirror)
            .set("header", self.header.to_js())
            .set("footer", self.footer.to_js())
            .set("hideOnChapterStart", self.hide_on_chapter_start)
            .set("chapterStartsRight", self.chapter_starts_right)
            .set("pageNumberStart", self.page_number_start)
            .set("headerOffset", self.header_offset)
            .set("footerOffset", self.footer_offset)
            .set("widowsOrphans", self.widows_orphans)
            .set("hyphenate", self.hyphenate)
            .set("sceneBreak", self.scene_break.as_str())
            .build()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BinderNode {
    pub id: String,
    pub kind: BinderKind,
    pub title: String,
    pub children: Option<Vec<BinderNode>>,
    pub synopsis: Option<String>,
    pub status: Option<SceneStatus>,
    /// Label colour (hex).
    pub label: Option<String>,
    /// Point-of-view character id.
    pub pov: Option<String>,
    /// Left out of the manuscript and exports.
    pub exclude: bool,
    pub goal: Option<f64>,
}

impl BinderNode {
    pub fn new(id: impl Into<String>, kind: BinderKind, title: impl Into<String>) -> BinderNode {
        BinderNode {
            id: id.into(),
            kind,
            title: title.into(),
            children: None,
            synopsis: None,
            status: None,
            label: None,
            pov: None,
            exclude: false,
            goal: None,
        }
    }
}

impl ToJs for BinderNode {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("id", self.id.as_str())
            .set("kind", self.kind)
            .set("title", self.title.as_str())
            .opt(
                "children",
                self.children.as_ref().map(|children| children.to_js()),
            )
            .opt("synopsis", self.synopsis.as_ref())
            .opt("status", self.status)
            .opt("label", self.label.as_ref())
            .opt("pov", self.pov.as_ref())
            .flag("exclude", self.exclude)
            .opt("goal", self.goal)
            .build()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StoryGoals {
    pub project: Option<f64>,
    /// ISO date.
    pub deadline: Option<String>,
    pub session: Option<f64>,
    pub daily: Option<f64>,
}

impl ToJs for StoryGoals {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .opt("project", self.project)
            .opt("deadline", self.deadline.as_ref())
            .opt("session", self.session)
            .opt("daily", self.daily)
            .build()
    }
}

/// `story.json`.
#[derive(Clone, Debug, PartialEq)]
pub struct StoryManifest {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub language: StoryLanguage,
    pub page: PageSetup,
    pub styles: JsMap<ParagraphStyle>,
    pub binder: Vec<BinderNode>,
    pub goals: Option<StoryGoals>,
    /// Words that are correct in this project.
    pub dictionary: Option<Vec<String>>,
    /// Assistant findings the writer ignored (`rule:text`).
    pub ignored: Option<Vec<String>>,
    pub created_at: String,
    pub updated_at: String,
}

impl ToJs for StoryManifest {
    fn to_js(&self) -> JsValue {
        let strings = |list: &Vec<String>| JsValue::Array(list.iter().map(JsValue::from).collect());
        ObjectBuilder::new()
            .set("format", STORY_FORMAT)
            .set("id", self.id.as_str())
            .set("title", self.title.as_str())
            .opt("subtitle", self.subtitle.as_ref())
            .opt("author", self.author.as_ref())
            .set("language", self.language)
            .set("page", self.page.to_js())
            .set("styles", self.styles.to_js())
            .set("binder", self.binder.to_js())
            .opt("goals", self.goals.as_ref().map(ToJs::to_js))
            .opt("dictionary", self.dictionary.as_ref().map(strings))
            .opt("ignored", self.ignored.as_ref().map(strings))
            .set("createdAt", self.created_at.as_str())
            .set("updatedAt", self.updated_at.as_str())
            .build()
    }
}

impl StoryManifest {
    /// The file content the TypeScript storage writes: `${JSON.stringify(manifest, null, 1)}\n`.
    pub fn to_file(&self) -> String {
        format!("{}\n", crate::json::stringify(&self.to_js(), Some(1)))
    }
}
