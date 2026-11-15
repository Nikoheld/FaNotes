//! Lays the manuscript out on pages (`layout/paginate.ts`): paragraph layouts
//! cached between passes, widows and orphans, keep-with-next, chapter starts
//! (optionally on a right-hand page, with a blank page), footnotes at the page
//! bottom, header and footer templates, mirror margins, and incremental
//! re-pagination that restarts at the changed page and stops when page starts
//! line up with the previous layout again.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::hyphen::Hyphenate;
use super::linebreak::{layout_paragraph, resolve_style, LayoutInput, ParagraphLayout};
use super::measure::{mm_to_px, Measurer};
use crate::json::{JsValue, ObjectBuilder, ToJs};
use crate::model::defaults::default_styles;
use crate::model::flow::{BlockRef, FlowBlock};
use crate::model::types::{
    Align, HeaderFooter, Marks, PageSetup, ParagraphStyle, Run, StoryLanguage, StoryManifest,
};

#[derive(Clone, Debug, PartialEq)]
pub struct PlacedLine {
    pub block_key: Arc<str>,
    pub block_index: usize,
    pub line_index: usize,
    /// Top-left of the line box on the page, in px from the page's top-left.
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlacedFootnote {
    pub id: String,
    pub number: String,
    pub layout: Arc<ParagraphLayout>,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlacedDropCap {
    pub block_index: usize,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Left => "left",
            Side::Right => "right",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContentBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub index: usize,
    /// Printed page number.
    pub number: String,
    pub side: Side,
    pub lines: Vec<PlacedLine>,
    /// Drop caps whose first line is on this page.
    pub drop_caps: Vec<PlacedDropCap>,
    pub footnotes: Vec<PlacedFootnote>,
    pub header: Option<HeaderFooter>,
    pub footer: Option<HeaderFooter>,
    pub chapter_title: String,
    /// Inserted so that a chapter starts on a right-hand page.
    pub blank: bool,
    /// Content box in px.
    pub content: ContentBox,
}

impl Page {
    /// The page as JSON; footnote layouts in full or (`brief`) as their height only.
    pub fn to_js_with(&self, brief: bool) -> JsValue {
        let lines = self
            .lines
            .iter()
            .map(|line| {
                ObjectBuilder::new()
                    .set("blockKey", &*line.block_key)
                    .set("blockIndex", line.block_index)
                    .set("lineIndex", line.line_index)
                    .set("x", line.x)
                    .set("y", line.y)
                    .build()
            })
            .collect();
        let caps = self
            .drop_caps
            .iter()
            .map(|cap| {
                ObjectBuilder::new()
                    .set("blockIndex", cap.block_index)
                    .set("x", cap.x)
                    .set("y", cap.y)
                    .build()
            })
            .collect();
        let notes = self
            .footnotes
            .iter()
            .map(|note| {
                let layout = if brief {
                    JsValue::Number(note.layout.height)
                } else {
                    note.layout.to_js()
                };
                ObjectBuilder::new()
                    .set("id", note.id.as_str())
                    .set("number", note.number.as_str())
                    .set("layout", layout)
                    .set("x", note.x)
                    .set("y", note.y)
                    .build()
            })
            .collect();
        let hf =
            |part: &Option<HeaderFooter>| part.as_ref().map(ToJs::to_js).unwrap_or(JsValue::Null);
        ObjectBuilder::new()
            .set("index", self.index)
            .set("number", self.number.as_str())
            .set("side", self.side.as_str())
            .set("lines", JsValue::Array(lines))
            .set("dropCaps", JsValue::Array(caps))
            .set("footnotes", JsValue::Array(notes))
            .set("header", hf(&self.header))
            .set("footer", hf(&self.footer))
            .set("chapterTitle", self.chapter_title.as_str())
            .flag("blank", self.blank)
            .set(
                "content",
                ObjectBuilder::new()
                    .set("x", self.content.x)
                    .set("y", self.content.y)
                    .set("width", self.content.width)
                    .set("height", self.content.height)
                    .build(),
            )
            .build()
    }
}

impl ToJs for Page {
    fn to_js(&self) -> JsValue {
        self.to_js_with(false)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayoutStats {
    pub lines: usize,
    pub layout_ms: f64,
    pub paginate_ms: f64,
    pub measured: usize,
    pub repaginated_pages: usize,
}

#[derive(Clone, Debug)]
pub struct ManuscriptLayout {
    pub pages: Vec<Arc<Page>>,
    pub blocks: Arc<Vec<FlowBlock>>,
    pub layouts: Vec<Arc<ParagraphLayout>>,
    /// The page on which each block starts.
    pub block_pages: Vec<usize>,
    pub page_width: f64,
    pub page_height: f64,
    pub content_width: f64,
    /// Footnote numbers in reading order.
    pub footnote_numbers: Vec<(String, String)>,
    /// The page setup this layout was made with (incremental reuse needs the same one).
    pub setup: PageSetup,
    /// Title, subtitle, author and page count the headers were filled with.
    pub header_key: String,
    pub stats: LayoutStats,
}

/// Hyphenators per language (`LayoutOptions.hyphenators`).
#[derive(Clone, Default)]
pub struct Hyphenators {
    entries: Vec<(StoryLanguage, Arc<dyn Hyphenate>)>,
}

impl Hyphenators {
    pub fn new() -> Hyphenators {
        Hyphenators::default()
    }

    /// The bundled patterns for every language.
    pub fn bundled() -> Hyphenators {
        let mut out = Hyphenators::new();
        for &language in StoryLanguage::ALL {
            out.set(language, super::hyphen::Hyphenator::for_language(language));
        }
        out
    }

    pub fn set(&mut self, language: StoryLanguage, hyphenator: Arc<dyn Hyphenate>) {
        self.entries.retain(|(existing, _)| *existing != language);
        self.entries.push((language, hyphenator));
    }

    pub fn get(&self, language: StoryLanguage) -> Option<&Arc<dyn Hyphenate>> {
        self.entries
            .iter()
            .find(|(existing, _)| *existing == language)
            .map(|(_, hyphenator)| hyphenator)
    }
}

/// Looks up a footnote body by id.
pub type FootnoteRuns<'a> = dyn Fn(&str) -> Option<Vec<Run>> + 'a;

pub struct LayoutOptions<'a> {
    pub measurer: &'a dyn Measurer,
    pub hyphenators: Option<&'a Hyphenators>,
    /// Footnote bodies by id.
    pub footnote_runs: Option<&'a FootnoteRuns<'a>>,
}

struct CacheEntry {
    runs: Arc<Vec<Run>>,
    style: ParagraphStyle,
    width: f64,
    after_break: bool,
    align: Option<Align>,
    hyphenate: bool,
    numbers: String,
    layout: Arc<ParagraphLayout>,
}

/// Keeps paragraph layouts between passes (`LayoutCache`). One per open project.
#[derive(Default)]
pub struct LayoutCache {
    entries: HashMap<Arc<str>, CacheEntry>,
    pub measured: usize,
}

impl LayoutCache {
    pub fn new() -> LayoutCache {
        LayoutCache::default()
    }

    /// The cached layout when nothing it depends on changed. The runs are
    /// compared by pointer first, then by value (TypeScript compares identity
    /// only; equal values give equal layouts, so the pages are the same).
    fn get(
        &mut self,
        block: &FlowBlock,
        style: &ParagraphStyle,
        width: f64,
        hyphenate: bool,
        numbers: &str,
        compute: impl FnOnce() -> ParagraphLayout,
    ) -> Arc<ParagraphLayout> {
        if let Some(entry) = self.entries.get(&block.key) {
            if (Arc::ptr_eq(&entry.runs, &block.runs) || entry.runs == block.runs)
                && entry.style == *style
                && entry.width == width
                && entry.after_break == block.after_break
                && entry.align == block.align
                && entry.hyphenate == hyphenate
                && entry.numbers == numbers
            {
                return entry.layout.clone();
            }
        }
        let layout = Arc::new(compute());
        self.measured += 1;
        self.entries.insert(
            block.key.clone(),
            CacheEntry {
                runs: block.runs.clone(),
                style: style.clone(),
                width,
                after_break: block.after_break,
                align: block.align,
                hyphenate,
                numbers: numbers.to_string(),
                layout: layout.clone(),
            },
        );
        layout
    }

    /// Drops layouts of blocks that no longer exist.
    pub fn prune(&mut self, keys: &HashSet<&str>) {
        self.entries.retain(|key, _| keys.contains(&**key));
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// `fillTemplate`: `{title}`, `{chapter}`, `{page}`, `{pages}`, `{author}`, `{subtitle}`.
pub fn fill_template(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let field = ["title", "chapter", "page", "pages", "author", "subtitle"]
            .iter()
            .find(|name| after.starts_with(*name) && after[name.len()..].starts_with('}'));
        match field {
            Some(name) => {
                out.push_str(
                    values
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| *value)
                        .unwrap_or(""),
                );
                rest = &after[name.len() + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

struct Geometry {
    width: f64,
    height: f64,
    side: Side,
    content: ContentBox,
}

fn page_geometry(page: &PageSetup, index: usize, first_number: f64) -> Geometry {
    let width = mm_to_px(page.width);
    let height = mm_to_px(page.height);
    let number = first_number + index as f64;
    let right = number % 2.0 == 1.0;
    let inner = mm_to_px(page.margins.inner);
    let outer = mm_to_px(page.margins.outer);
    let left = if page.mirror {
        if right {
            inner
        } else {
            outer
        }
    } else {
        inner
    };
    let content_width = width - inner - outer;
    Geometry {
        width,
        height,
        side: if right { Side::Right } else { Side::Left },
        content: ContentBox {
            x: left,
            y: mm_to_px(page.margins.top),
            width: content_width,
            height: height - mm_to_px(page.margins.top) - mm_to_px(page.margins.bottom),
        },
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    0.0
}

fn js_string(number: f64) -> String {
    crate::json::js_number(number)
}

const FOOTNOTE_SEPARATOR: f64 = 10.0;

struct Pager<'a> {
    setup: &'a PageSetup,
    blocks: &'a [FlowBlock],
    layouts: &'a [Arc<ParagraphLayout>],
    previous: Option<&'a ManuscriptLayout>,
    incremental: bool,
    delta: i64,
    last_changed: i64,
    footnote_numbers: &'a HashMap<String, String>,
    footnote_layout: &'a mut dyn FnMut(&str) -> Arc<ParagraphLayout>,
    pages: Vec<Arc<Page>>,
    page: Page,
    block_pages: Vec<usize>,
    y: f64,
    footnote_height: f64,
    chapter_title: String,
    reused_from: Option<usize>,
}

impl Pager<'_> {
    fn new_page(&self, blank: bool) -> Page {
        let index = self.pages.len();
        let geometry = page_geometry(self.setup, index, self.setup.page_number_start);
        Page {
            index,
            number: js_string(self.setup.page_number_start + index as f64),
            side: geometry.side,
            lines: Vec::new(),
            drop_caps: Vec::new(),
            footnotes: Vec::new(),
            header: None,
            footer: None,
            chapter_title: self.chapter_title.clone(),
            blank,
            content: geometry.content,
        }
    }

    /// `openPage()`: the current page is finished, a new one starts.
    fn open_page(&mut self) {
        let next = self.new_page_after_current();
        let done = std::mem::replace(&mut self.page, next);
        self.pages.push(Arc::new(done));
        self.y = 0.0;
        self.footnote_height = 0.0;
    }

    fn new_page_after_current(&self) -> Page {
        // `pages.length` counts the current page too.
        let index = self.pages.len() + 1;
        let geometry = page_geometry(self.setup, index, self.setup.page_number_start);
        Page {
            index,
            number: js_string(self.setup.page_number_start + index as f64),
            side: geometry.side,
            lines: Vec::new(),
            drop_caps: Vec::new(),
            footnotes: Vec::new(),
            header: None,
            footer: None,
            chapter_title: self.chapter_title.clone(),
            blank: false,
            content: geometry.content,
        }
    }

    fn room(&self) -> f64 {
        self.page.content.height
            - self.y
            - if self.footnote_height != 0.0 {
                self.footnote_height + FOOTNOTE_SEPARATOR
            } else {
                0.0
            }
    }

    fn page_empty(&self) -> bool {
        self.page.lines.is_empty()
    }

    fn place_lines(&mut self, block_index: usize, from: usize, to: usize) {
        let layout = self.layouts[block_index].clone();
        for line in from..to {
            let line_box = &layout.lines[line];
            self.page.lines.push(PlacedLine {
                block_key: self.blocks[block_index].key.clone(),
                block_index,
                line_index: line,
                x: self.page.content.x + line_box.x,
                y: self.page.content.y + self.y,
            });
            if line == 0 {
                if let Some(cap) = &layout.drop_cap {
                    self.page.drop_caps.push(PlacedDropCap {
                        block_index,
                        x: self.page.content.x + cap.x,
                        y: self.page.content.y + self.y,
                    });
                }
            }
            for note in &layout.footnotes {
                if note.line != line {
                    continue;
                }
                let note_layout = (self.footnote_layout)(&note.id);
                self.footnote_height += note_layout.height + note_layout.style.space_after;
                let number = self
                    .footnote_numbers
                    .get(&note.id)
                    .cloned()
                    .unwrap_or_else(|| "*".into());
                self.page.footnotes.push(PlacedFootnote {
                    id: note.id.clone(),
                    number,
                    layout: note_layout,
                    x: self.page.content.x,
                    y: 0.0,
                });
            }
            self.y += line_box.height;
        }
    }

    /// Height of lines plus the footnotes they bring along.
    fn lines_height(&mut self, block_index: usize, from: usize, to: usize) -> (f64, f64) {
        let layout = self.layouts[block_index].clone();
        let mut height = 0.0;
        let mut notes = 0.0;
        for line in from..to {
            height += layout.lines[line].height;
            for note in &layout.footnotes {
                if note.line == line {
                    notes += (self.footnote_layout)(&note.id).height + 2.0;
                }
            }
        }
        (height, notes)
    }

    fn fits(&mut self, block_index: usize, from: usize, to: usize) -> bool {
        let (height, notes) = self.lines_height(block_index, from, to);
        let extra_separator = if notes != 0.0 && self.footnote_height == 0.0 {
            FOOTNOTE_SEPARATOR
        } else {
            0.0
        };
        height + notes + extra_separator <= self.room() + 0.5
    }

    /// After opening a page for (block, line): the old layout from here on is still right.
    fn aligned(&mut self, block_index: usize, line: usize) -> bool {
        let Some(previous) = self.previous else {
            return false;
        };
        if !self.incremental
            || self.delta != 0
            || block_index as i64 <= self.last_changed
            || self.page.blank
        {
            return false;
        }
        let Some(old) = previous.pages.get(self.page.index) else {
            return false;
        };
        let Some(first) = old.lines.first() else {
            return false;
        };
        if old.blank
            || first.block_index != block_index
            || first.line_index != line
            || old.chapter_title != self.page.chapter_title
        {
            return false;
        }
        // `pages.pop()`: the current page is replaced by the old ones.
        self.reused_from = Some(self.pages.len());
        self.pages
            .extend(previous.pages[self.page.index..].iter().cloned());
        let start = if line == 0 {
            block_index
        } else {
            block_index + 1
        };
        for index in start..self.blocks.len() {
            self.block_pages[index] = previous.block_pages[index];
        }
        true
    }
}

/// `layoutManuscript(manifest, blocks, cache, options, previous)`.
pub fn layout_manuscript(
    manifest: &StoryManifest,
    blocks: Arc<Vec<FlowBlock>>,
    cache: &mut LayoutCache,
    options: &LayoutOptions,
    previous: Option<&ManuscriptLayout>,
) -> ManuscriptLayout {
    let started = now_ms();
    let measured_before = cache.measured;
    let setup = &manifest.page;
    let first = page_geometry(setup, 0, setup.page_number_start);
    let content_width = first.content.width;
    // Footnotes are numbered through the manuscript in reading order.
    let mut footnote_numbers: Vec<(String, String)> = Vec::new();
    let mut number_of: HashMap<String, String> = HashMap::new();
    for block in blocks.iter() {
        for run in block.runs.iter() {
            if let Some(id) = run.footnote().filter(|id| !id.is_empty()) {
                if !number_of.contains_key(id) {
                    let number = (footnote_numbers.len() + 1).to_string();
                    number_of.insert(id.to_string(), number.clone());
                    footnote_numbers.push((id.to_string(), number));
                }
            }
        }
    }
    let defaults;
    let fallback_style: &ParagraphStyle = match manifest.styles.get("body") {
        Some(style) => style,
        None => {
            defaults = default_styles(false);
            defaults.get("body").expect("body")
        }
    };
    let numbers_text = |id: &str| number_of.get(id).cloned().unwrap_or_else(|| "*".into());
    let layouts: Vec<Arc<ParagraphLayout>> = blocks
        .iter()
        .map(|block| {
            let style = manifest.styles.get(&block.style).unwrap_or(fallback_style);
            let language = block.lang.unwrap_or(manifest.language);
            let hyphenator = options
                .hyphenators
                .and_then(|all| all.get(language))
                .cloned();
            let hyphenate = setup.hyphenate
                && hyphenator.is_some()
                && matches!(block.reference, BlockRef::Para { .. });
            let numbers = if block
                .runs
                .iter()
                .any(|run| run.footnote().is_some_and(|id| !id.is_empty()))
            {
                block
                    .runs
                    .iter()
                    .filter_map(|run| run.footnote().filter(|id| !id.is_empty()))
                    .map(|id| number_of.get(id).cloned().unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join(",")
            } else {
                String::new()
            };
            cache.get(block, style, content_width, hyphenate, &numbers, || {
                let resolved = resolve_style(style, block.align, block.after_break);
                layout_paragraph(&LayoutInput {
                    runs: &block.runs,
                    style: &resolved,
                    width: content_width,
                    measurer: options.measurer,
                    hyphenator: hyphenator.as_deref(),
                    hyphenate,
                    footnote_number: Some(&numbers_text),
                })
            })
        })
        .collect();
    cache.prune(&blocks.iter().map(|block| &*block.key).collect());
    let layout_done = now_ms();

    let footnote_style = match manifest.styles.get("footnote") {
        Some(style) => style.clone(),
        None => ParagraphStyle {
            size: crate::js::max(7.0, fallback_style.size - 2.0),
            line_height: 1.3,
            indent_first: 0.0,
            space_before: 0.0,
            space_after: 2.0,
            align: Align::Left,
            ..fallback_style.clone()
        },
    };
    let footnote_resolved = resolve_style(&footnote_style, None, false);
    let mut footnote_layouts: HashMap<String, Arc<ParagraphLayout>> = HashMap::new();
    let mut footnote_layout = |id: &str| -> Arc<ParagraphLayout> {
        if let Some(cached) = footnote_layouts.get(id) {
            return cached.clone();
        }
        let runs = options
            .footnote_runs
            .and_then(|lookup| lookup(id))
            .unwrap_or_default();
        let number = number_of.get(id).cloned().unwrap_or_else(|| "*".into());
        let mut all = vec![Run::with_marks(
            format!("{number} "),
            Marks {
                sup: true,
                ..Marks::default()
            },
        )];
        all.extend(runs);
        let layout = Arc::new(layout_paragraph(&LayoutInput {
            runs: &all,
            style: &footnote_resolved,
            width: content_width,
            measurer: options.measurer,
            hyphenator: None,
            hyphenate: false,
            footnote_number: None,
        }));
        footnote_layouts.insert(id.to_string(), layout.clone());
        layout
    };

    // Incremental: pages before the first changed paragraph are kept, and as
    // soon as a new page starts where the previous layout had one, the rest of
    // the old pages are reused.
    let changed_at = |index: usize| -> bool {
        let Some(previous) = previous else {
            return true;
        };
        let Some(before) = previous.blocks.get(index) else {
            return true;
        };
        let now = &blocks[index];
        before.key != now.key
            || !Arc::ptr_eq(&previous.layouts[index], &layouts[index])
            || before.chapter_start != now.chapter_start
            || before.break_before != now.break_before
            || before.chapter_title != now.chapter_title
    };
    let incremental = previous.is_some_and(|previous| {
        previous.setup == *setup
            && !previous.pages.is_empty()
            && previous.block_pages.len() == previous.blocks.len()
    });
    let delta = blocks.len() as i64
        - previous
            .map(|previous| previous.blocks.len() as i64)
            .unwrap_or(0);
    let mut first_changed = 0usize;
    if incremental {
        let limit = blocks
            .len()
            .min(previous.map(|previous| previous.blocks.len()).unwrap_or(0));
        while first_changed < limit && !changed_at(first_changed) {
            first_changed += 1;
        }
    }
    let mut last_changed = blocks.len() as i64 - 1;
    if incremental && delta == 0 {
        while last_changed >= first_changed as i64 && !changed_at(last_changed as usize) {
            last_changed -= 1;
        }
    }
    let unchanged = incremental && delta == 0 && first_changed == blocks.len();

    let mut kept_pages: Vec<Arc<Page>> = Vec::new();
    let mut block_pages: Vec<usize> = vec![0; blocks.len()];
    let mut chapter_title = String::new();
    let mut resume_block = 0usize;
    let mut resume_line = 0usize;
    let mut rebuilt_from = 0usize;
    if let (true, false, Some(previous)) = (incremental, unchanged, previous) {
        // Restart at the page holding the paragraph before the change (a heading kept with it may move).
        let anchor = first_changed.min(previous.blocks.len()).saturating_sub(1);
        let at = |index: usize| previous.block_pages.get(index).copied().unwrap_or(0);
        let mut start_page = at(anchor).min(at(
            first_changed.min(previous.block_pages.len().saturating_sub(1))
        ));
        while start_page > 0
            && (previous.pages[start_page].blank || previous.pages[start_page].lines.is_empty())
        {
            start_page -= 1;
        }
        if let Some(first_line) = previous
            .pages
            .get(start_page)
            .and_then(|page| page.lines.first())
        {
            if first_line.block_index <= first_changed {
                kept_pages.extend(previous.pages[..start_page].iter().cloned());
                // A paragraph resumed in the middle started on an earlier (kept) page.
                let kept = (first_line.block_index + usize::from(first_line.line_index > 0))
                    .min(blocks.len())
                    .min(previous.block_pages.len());
                block_pages[..kept].copy_from_slice(&previous.block_pages[..kept]);
                resume_block = first_line.block_index;
                resume_line = first_line.line_index;
                chapter_title = previous.pages[start_page].chapter_title.clone();
                rebuilt_from = start_page;
            }
        }
    }

    let mut pages: Vec<Arc<Page>>;
    let mut reused_from: Option<usize> = None;
    if unchanged {
        let previous = previous.expect("unchanged implies a previous layout");
        pages = previous.pages.clone();
        block_pages = previous.block_pages.clone();
        reused_from = Some(0);
    } else {
        let mut pager = Pager {
            setup,
            blocks: &blocks,
            layouts: &layouts,
            previous,
            incremental,
            delta,
            last_changed,
            footnote_numbers: &number_of,
            footnote_layout: &mut footnote_layout,
            pages: kept_pages,
            page: Page {
                index: 0,
                number: String::new(),
                side: Side::Right,
                lines: Vec::new(),
                drop_caps: Vec::new(),
                footnotes: Vec::new(),
                header: None,
                footer: None,
                chapter_title: String::new(),
                blank: false,
                content: first.content,
            },
            block_pages,
            y: 0.0,
            footnote_height: 0.0,
            chapter_title,
            reused_from: None,
        };
        pager.page = pager.new_page(false);
        let mut first_block = true;
        let mut finished_by_reuse = false;
        'outer: for block_index in resume_block..blocks.len() {
            let block = &blocks[block_index];
            let layout = layouts[block_index].clone();
            let style = &layout.style;
            if block.chapter_start {
                pager.chapter_title = block.chapter_title.clone();
            }
            let resuming = first_block && resume_line > 0;
            first_block = false;
            if !resuming {
                let break_before =
                    block.break_before || style.page_break_before || block.chapter_start;
                if break_before && !(pager.pages.is_empty() && pager.page_empty()) {
                    if !pager.page_empty() || pager.y > 0.0 {
                        pager.open_page();
                        if pager.aligned(block_index, 0) {
                            finished_by_reuse = true;
                            break 'outer;
                        }
                    }
                    if block.chapter_start
                        && setup.chapter_starts_right
                        && pager.page.side != Side::Right
                    {
                        pager.page.blank = true;
                        pager.open_page();
                        if pager.aligned(block_index, 0) {
                            finished_by_reuse = true;
                            break 'outer;
                        }
                    }
                }
                if block.chapter_start {
                    pager.page.chapter_title = pager.chapter_title.clone();
                }
                // Space before collapses at the top of a page, except for a chapter title.
                let before = if pager.page_empty() && !block.chapter_start {
                    0.0
                } else {
                    style.space_before
                };
                if before != 0.0 {
                    if before >= pager.room() {
                        pager.open_page();
                        if pager.aligned(block_index, 0) {
                            finished_by_reuse = true;
                            break 'outer;
                        }
                    } else {
                        pager.y += before;
                    }
                }
                // Keep with next: the heading moves with the first two lines of what follows.
                if style.keep_with_next && block_index + 1 < blocks.len() && !pager.page_empty() {
                    let next = layouts[block_index + 1].clone();
                    let own = pager.lines_height(block_index, 0, layout.lines.len()).0;
                    let following = pager
                        .lines_height(block_index + 1, 0, next.lines.len().min(2))
                        .0;
                    let needed = own + style.space_after + next.style.space_before + following;
                    if needed > pager.room() {
                        pager.open_page();
                        if pager.aligned(block_index, 0) {
                            finished_by_reuse = true;
                            break 'outer;
                        }
                    }
                }
                pager.block_pages[block_index] = pager.page.index;
            }
            let mut line = if resuming { resume_line } else { 0 };
            let total = layout.lines.len();
            while line < total {
                let mut count = 0;
                while line + count < total && pager.fits(block_index, line, line + count + 1) {
                    count += 1;
                }
                if line + count >= total {
                    pager.place_lines(block_index, line, total);
                    break;
                }
                if setup.widows_orphans && total >= 2 {
                    // No single first line at the bottom (orphan), no single last line at the top (widow).
                    if line == 0 && count == 1 && !pager.page_empty() {
                        count = 0;
                    }
                    if total - (line + count) == 1 && count >= 2 && total >= 3 {
                        count -= 1;
                    }
                }
                if count == 0 && pager.page_empty() {
                    count = 1;
                }
                if count > 0 {
                    pager.place_lines(block_index, line, line + count);
                }
                line += count;
                pager.open_page();
                if line == 0 {
                    pager.block_pages[block_index] = pager.page.index;
                }
                if pager.aligned(block_index, line) {
                    finished_by_reuse = true;
                    break 'outer;
                }
            }
            pager.y += style.space_after;
        }
        if !finished_by_reuse {
            let shell = pager.page.clone_shallow();
            let done = std::mem::replace(&mut pager.page, shell);
            pager.pages.push(Arc::new(done));
        }
        reused_from = pager.reused_from.or(reused_from);
        pages = pager.pages;
        block_pages = pager.block_pages;
    }

    // Footnotes sit at the bottom of their page; headers and footers get their fields.
    let total_pages = js_string(pages.len() as f64 + setup.page_number_start - 1.0);
    let header_key = format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        manifest.title,
        manifest.subtitle.as_deref().unwrap_or(""),
        manifest.author.as_deref().unwrap_or(""),
        total_pages
    );
    let refill_all =
        !incremental || previous.is_none_or(|previous| previous.header_key != header_key);
    let rebuilt_to = reused_from.unwrap_or(pages.len());
    let rebuilt_start = if unchanged { pages.len() } else { rebuilt_from };
    #[allow(clippy::needless_range_loop)]
    for index in 0..pages.len() {
        let rebuilt = index >= rebuilt_start && index < rebuilt_to;
        if !rebuilt && !refill_all {
            continue;
        }
        let current = Arc::make_mut(&mut pages[index]);
        if rebuilt {
            let mut bottom = current.content.y + current.content.height;
            for placed in current.footnotes.iter_mut().rev() {
                bottom -= placed.layout.height + placed.layout.style.space_after;
                placed.y = bottom;
            }
        }
        let chapter_start = current.lines.first().is_some_and(|line| {
            blocks
                .get(line.block_index)
                .is_some_and(|block| block.chapter_start)
                && line.line_index == 0
        });
        let hide = current.blank || (setup.hide_on_chapter_start && chapter_start);
        let subtitle = manifest.subtitle.clone().unwrap_or_default();
        let author = manifest.author.clone().unwrap_or_default();
        let values = [
            ("title", manifest.title.as_str()),
            ("subtitle", subtitle.as_str()),
            ("author", author.as_str()),
            ("chapter", current.chapter_title.as_str()),
            ("page", current.number.as_str()),
            ("pages", total_pages.as_str()),
        ];
        let mirror = setup.mirror && current.side == Side::Left;
        let fill = |part: &HeaderFooter| {
            let filled = HeaderFooter {
                left: fill_template(&part.left, &values),
                center: fill_template(&part.center, &values),
                right: fill_template(&part.right, &values),
            };
            if mirror {
                HeaderFooter {
                    left: filled.right,
                    center: filled.center,
                    right: filled.left,
                }
            } else {
                filled
            }
        };
        let header = if hide {
            None
        } else {
            Some(fill(&setup.header))
        };
        let footer = if current.blank {
            None
        } else if setup.hide_on_chapter_start && chapter_start {
            Some(HeaderFooter {
                left: String::new(),
                center: fill_template(&setup.footer.center, &values),
                right: String::new(),
            })
        } else {
            Some(fill(&setup.footer))
        };
        current.header = header;
        current.footer = footer;
    }
    let done = now_ms();
    let lines = layouts.iter().map(|layout| layout.lines.len()).sum();
    ManuscriptLayout {
        pages,
        blocks: blocks.clone(),
        layouts,
        block_pages,
        page_width: first.width,
        page_height: first.height,
        content_width,
        footnote_numbers,
        setup: setup.clone(),
        header_key,
        stats: LayoutStats {
            lines,
            layout_ms: layout_done - started,
            paginate_ms: done - layout_done,
            measured: cache.measured - measured_before,
            repaginated_pages: if unchanged {
                0
            } else {
                rebuilt_to.saturating_sub(rebuilt_from)
            },
        },
    }
}

impl Page {
    fn clone_shallow(&self) -> Page {
        Page {
            index: self.index,
            number: String::new(),
            side: self.side,
            lines: Vec::new(),
            drop_caps: Vec::new(),
            footnotes: Vec::new(),
            header: None,
            footer: None,
            chapter_title: String::new(),
            blank: false,
            content: self.content,
        }
    }
}

impl ManuscriptLayout {
    /// The layout as JSON, shaped like the TypeScript `ManuscriptLayout`
    /// (without `blocks`, `setup` and timing). `brief` replaces footnote and
    /// paragraph layouts by their heights.
    pub fn to_js_with(&self, brief: bool) -> JsValue {
        let numbers = JsValue::Array(
            self.footnote_numbers
                .iter()
                .map(|(id, number)| {
                    JsValue::Array(vec![
                        JsValue::from(id.as_str()),
                        JsValue::from(number.as_str()),
                    ])
                })
                .collect(),
        );
        ObjectBuilder::new()
            .set(
                "pages",
                JsValue::Array(
                    self.pages
                        .iter()
                        .map(|page| page.to_js_with(brief))
                        .collect(),
                ),
            )
            .set(
                "layouts",
                JsValue::Array(
                    self.layouts
                        .iter()
                        .map(|layout| {
                            if brief {
                                JsValue::Number(layout.height)
                            } else {
                                layout.to_js()
                            }
                        })
                        .collect(),
                ),
            )
            .set(
                "blockPages",
                JsValue::Array(
                    self.block_pages
                        .iter()
                        .map(|&page| JsValue::from(page))
                        .collect(),
                ),
            )
            .set("pageWidth", self.page_width)
            .set("pageHeight", self.page_height)
            .set("contentWidth", self.content_width)
            .set("footnoteNumbers", numbers)
            .set("headerKey", self.header_key.as_str())
            .build()
    }
}
