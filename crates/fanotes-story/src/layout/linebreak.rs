//! Breaks one paragraph into lines (`layout/linebreak.ts`). Text offsets are
//! UTF-16 offsets into the paragraph's text (the concatenated runs), so the
//! editor can map a caret to a line and back. Each word or space is a piece
//! with its own x position.

use std::sync::{Arc, OnceLock};

use super::hyphen::Hyphenate;
use super::measure::{mm_to_px, pt_to_px, FontMetrics, FontSpec, Measurer};
use crate::js::{self, len16, unit_is_lower, upper};
use crate::json::{JsValue, ObjectBuilder, ToJs};
use crate::model::types::{Align, FontFamily, Marks, ParagraphStyle, Run};

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedStyle {
    pub font: FontFamily,
    /// CSS pixels.
    pub size: f64,
    pub line_height: f64,
    pub space_before: f64,
    pub space_after: f64,
    pub indent_first: f64,
    pub indent_left: f64,
    pub indent_right: f64,
    pub align: Align,
    pub bold: bool,
    pub italic: bool,
    pub small_caps: bool,
    pub uppercase: bool,
    pub color: Option<String>,
    pub keep_with_next: bool,
    pub page_break_before: bool,
    pub drop_cap: f64,
    pub list_marker: Option<String>,
}

impl ToJs for ResolvedStyle {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("font", self.font)
            .set("size", self.size)
            .set("lineHeight", self.line_height)
            .set("spaceBefore", self.space_before)
            .set("spaceAfter", self.space_after)
            .set("indentFirst", self.indent_first)
            .set("indentLeft", self.indent_left)
            .set("indentRight", self.indent_right)
            .set("align", self.align)
            .set("bold", self.bold)
            .set("italic", self.italic)
            .set("smallCaps", self.small_caps)
            .set("uppercase", self.uppercase)
            .opt("color", self.color.as_ref())
            .set("keepWithNext", self.keep_with_next)
            .set("pageBreakBefore", self.page_break_before)
            .set("dropCap", self.drop_cap)
            .opt("listMarker", self.list_marker.as_ref())
            .build()
    }
}

/// `resolveStyle(style, { align, afterBreak })`.
pub fn resolve_style(
    style: &ParagraphStyle,
    align: Option<Align>,
    after_break: bool,
) -> ResolvedStyle {
    ResolvedStyle {
        font: style.font,
        size: pt_to_px(style.size),
        line_height: style.line_height,
        space_before: pt_to_px(style.space_before),
        space_after: pt_to_px(style.space_after),
        indent_first: if after_break && style.indent_first > 0.0 {
            0.0
        } else {
            mm_to_px(style.indent_first)
        },
        indent_left: mm_to_px(style.indent_left),
        indent_right: mm_to_px(style.indent_right),
        align: align.unwrap_or(style.align),
        bold: style.bold == Some(true),
        italic: style.italic == Some(true),
        small_caps: style.small_caps == Some(true),
        uppercase: style.uppercase == Some(true),
        color: style.color.clone().filter(|color| !color.is_empty()),
        keep_with_next: style.keep_with_next == Some(true),
        page_break_before: style.page_break_before == Some(true),
        drop_cap: if after_break {
            style.drop_cap.unwrap_or(0.0)
        } else {
            0.0
        },
        list_marker: style
            .list_marker
            .clone()
            .filter(|marker| !marker.is_empty()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PieceKind {
    Word,
    Space,
    Newline,
    Anchor,
    Marker,
}

impl PieceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PieceKind::Word => "word",
            PieceKind::Space => "space",
            PieceKind::Newline => "newline",
            PieceKind::Anchor => "anchor",
            PieceKind::Marker => "marker",
        }
    }
}

/// A measured piece of a line. `display` is what is drawn.
#[derive(Clone, Debug, PartialEq)]
pub struct Piece {
    pub kind: PieceKind,
    pub from: usize,
    pub to: usize,
    pub text: String,
    pub display: String,
    pub font: FontSpec,
    pub marks: Option<Arc<Marks>>,
    /// Baseline shift in px (positive = up).
    pub shift: f64,
    pub width: f64,
    /// x relative to the line start.
    pub x: f64,
    /// A hyphen drawn at the end of this piece.
    pub hyphen: bool,
    /// A space at the end of a line (soft wrap, before a forced break, end of
    /// the paragraph): it hangs past the text, alignment ignores it and nothing
    /// is drawn, but the caret can sit after it.
    pub hang: bool,
}

impl ToJs for Piece {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("kind", self.kind.as_str())
            .set("from", self.from)
            .set("to", self.to)
            .set("text", self.text.as_str())
            .set("display", self.display.as_str())
            .set("font", self.font.to_js())
            .opt("marks", self.marks.as_ref().map(|marks| marks.to_js()))
            .set("shift", self.shift)
            .set("width", self.width)
            .set("x", self.x)
            .flag("hyphen", self.hyphen)
            .flag("hang", self.hang)
            .build()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LineBox {
    pub from: usize,
    pub to: usize,
    pub pieces: Vec<Piece>,
    /// Offset of the line's start from the content box's left edge.
    pub x: f64,
    /// Width available to the line.
    pub available: f64,
    /// Width the pieces take (after justification).
    pub width: f64,
    pub height: f64,
    /// Baseline from the line's top.
    pub baseline: f64,
    /// The line ends the paragraph or a forced line break.
    pub last: bool,
}

impl ToJs for LineBox {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("from", self.from)
            .set("to", self.to)
            .set("pieces", self.pieces.to_js())
            .set("x", self.x)
            .set("available", self.available)
            .set("width", self.width)
            .set("height", self.height)
            .set("baseline", self.baseline)
            .set("last", self.last)
            .build()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DropCap {
    pub text: String,
    pub font: FontSpec,
    pub width: f64,
    pub lines: f64,
    pub x: f64,
    pub baseline: f64,
}

impl ToJs for DropCap {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("text", self.text.as_str())
            .set("font", self.font.to_js())
            .set("width", self.width)
            .set("lines", self.lines)
            .set("x", self.x)
            .set("baseline", self.baseline)
            .build()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FootnoteRef {
    pub id: String,
    pub line: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParagraphLayout {
    pub lines: Vec<LineBox>,
    pub style: ResolvedStyle,
    pub drop_cap: Option<DropCap>,
    /// Total height of the lines (without space before/after).
    pub height: f64,
    /// Footnote ids referenced, in order, with the line they sit on.
    pub footnotes: Vec<FootnoteRef>,
    pub text_length: usize,
}

impl ToJs for ParagraphLayout {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("lines", self.lines.to_js())
            .set("style", self.style.to_js())
            .opt("dropCap", self.drop_cap.as_ref().map(ToJs::to_js))
            .set("height", self.height)
            .set(
                "footnotes",
                JsValue::Array(
                    self.footnotes
                        .iter()
                        .map(|note| {
                            ObjectBuilder::new()
                                .set("id", note.id.as_str())
                                .set("line", note.line)
                                .build()
                        })
                        .collect(),
                ),
            )
            .set("textLength", self.text_length)
            .build()
    }
}

pub struct LayoutInput<'a> {
    pub runs: &'a [Run],
    pub style: &'a ResolvedStyle,
    /// Width of the page's content box.
    pub width: f64,
    pub measurer: &'a dyn Measurer,
    pub hyphenator: Option<&'a dyn Hyphenate>,
    pub hyphenate: bool,
    /// Number shown for a footnote reference.
    pub footnote_number: Option<&'a dyn Fn(&str) -> String>,
}

const HYPHEN: &str = "-";
const NBSP: u16 = 0xA0;

fn is_space(unit: u16) -> bool {
    unit == b' ' as u16 || unit == b'\t' as u16 || unit == NBSP
}

/// A space that allows a break (not a no-break space).
fn is_break_space(unit: u16) -> bool {
    is_space(unit) && unit != NBSP
}

fn is_break_after(unit: u16) -> bool {
    matches!(unit, 0x2D | 0x2013 | 0x2014 | 0x2F)
}

#[derive(Clone)]
struct Fragment {
    from: usize,
    to: usize,
    text: Vec<u16>,
    display: Vec<u16>,
    font: FontSpec,
    marks: Option<Arc<Marks>>,
    shift: f64,
    anchor: bool,
}

/// `fragmentsOf`: runs split into pieces that share one font (small caps split by letter case).
fn fragments_of(input: &LayoutInput) -> Vec<Fragment> {
    let style = input.style;
    let mut out = Vec::new();
    let mut offset = 0usize;
    for run in input.runs {
        let marks = run.m.as_ref();
        let size = match marks.and_then(|m| m.size) {
            Some(size) if size != 0.0 && !size.is_nan() => pt_to_px(size),
            _ => style.size,
        };
        let footnote = marks
            .and_then(|m| m.fn_.as_deref())
            .filter(|id| !id.is_empty());
        let sup = marks.is_some_and(|m| m.sup);
        let sub = marks.is_some_and(|m| m.sub);
        let scripted = sup || sub || footnote.is_some();
        let font = FontSpec {
            family: marks.and_then(|m| m.font).unwrap_or(style.font),
            bold: marks.is_some_and(|m| m.b) || style.bold,
            italic: marks.is_some_and(|m| m.i) != style.italic,
            size: if scripted { size * 0.65 } else { size },
        };
        let shift = if sup || footnote.is_some() {
            size * 0.35
        } else if sub {
            -size * 0.15
        } else {
            0.0
        };
        let shared = run.m.clone().map(Arc::new);
        if let (Some(id), true) = (footnote, run.text.is_empty()) {
            let display = input
                .footnote_number
                .map(|number| number(id))
                .unwrap_or_else(|| "*".to_string());
            out.push(Fragment {
                from: offset,
                to: offset,
                text: Vec::new(),
                display: display.encode_utf16().collect(),
                font,
                marks: shared,
                shift,
                anchor: true,
            });
            continue;
        }
        let text: Vec<u16> = run.text.encode_utf16().collect();
        let small_caps = marks.is_some_and(|m| m.sc) || style.small_caps;
        if small_caps {
            // Lower-case letters are drawn as capitals at 78 %.
            let mut index = 0;
            while index < text.len() {
                let lower = unit_is_lower(text[index]);
                let mut end = index + 1;
                while end < text.len() && unit_is_lower(text[end]) == lower {
                    end += 1;
                }
                let part = &text[index..end];
                let display: Vec<u16> = upper(&String::from_utf16_lossy(part))
                    .encode_utf16()
                    .collect();
                let part_font = if lower {
                    FontSpec {
                        size: font.size * 0.78,
                        ..font
                    }
                } else {
                    font
                };
                out.push(Fragment {
                    from: offset + index,
                    to: offset + end,
                    text: part.to_vec(),
                    display,
                    font: part_font,
                    marks: shared.clone(),
                    shift,
                    anchor: false,
                });
                index = end;
            }
        } else {
            let display = if style.uppercase {
                upper(&run.text).encode_utf16().collect()
            } else {
                text.clone()
            };
            out.push(Fragment {
                from: offset,
                to: offset + text.len(),
                text: text.clone(),
                display,
                font,
                marks: shared,
                shift,
                anchor: false,
            });
        }
        offset += text.len();
    }
    out
}

struct Token {
    kind: PieceKind,
    pieces: Vec<Piece>,
    width: f64,
    from: usize,
    to: usize,
    break_after: bool,
}

fn slice_units(units: &[u16], start: usize, end: usize) -> &[u16] {
    let start = start.min(units.len());
    let end = end.min(units.len());
    if start >= end {
        &[]
    } else {
        &units[start..end]
    }
}

fn piece_of(
    fragment: &Fragment,
    from: usize,
    to: usize,
    kind: PieceKind,
    measurer: &dyn Measurer,
) -> Piece {
    let (text, display) = if fragment.anchor {
        (String::new(), String::from_utf16_lossy(&fragment.display))
    } else {
        let start = from - fragment.from;
        let end = to - fragment.from;
        (
            String::from_utf16_lossy(slice_units(&fragment.text, start, end)),
            String::from_utf16_lossy(slice_units(&fragment.display, start, end)),
        )
    };
    let width = match kind {
        PieceKind::Newline => 0.0,
        PieceKind::Space => measurer.width(&" ".repeat(len16(&display).max(1)), &fragment.font),
        _ => measurer.width(&display, &fragment.font),
    };
    Piece {
        kind,
        from,
        to,
        text,
        display,
        font: fragment.font,
        marks: fragment.marks.clone(),
        shift: fragment.shift,
        width,
        x: 0.0,
        hyphen: false,
        hang: false,
    }
}

/// `tokenize`: words, spaces and forced breaks; a word may span several fragments.
fn tokenize(fragments: &[Fragment], measurer: &dyn Measurer) -> Vec<Token> {
    let mut tokens: Vec<Token> = Vec::new();
    let mut word: Option<Token> = None;
    for fragment in fragments {
        if fragment.anchor {
            let piece = piece_of(
                fragment,
                fragment.from,
                fragment.to,
                PieceKind::Anchor,
                measurer,
            );
            let current = word.get_or_insert_with(|| Token {
                kind: PieceKind::Word,
                pieces: Vec::new(),
                width: 0.0,
                from: fragment.from,
                to: fragment.to,
                break_after: false,
            });
            current.width += piece.width;
            current.pieces.push(piece);
            continue;
        }
        let text = &fragment.text;
        let mut index = 0;
        while index < text.len() {
            let unit = text[index];
            if unit == b'\n' as u16 {
                if let Some(done) = word.take() {
                    tokens.push(done);
                }
                let from = fragment.from + index;
                tokens.push(Token {
                    kind: PieceKind::Newline,
                    pieces: vec![piece_of(
                        fragment,
                        from,
                        from + 1,
                        PieceKind::Newline,
                        measurer,
                    )],
                    width: 0.0,
                    from,
                    to: from + 1,
                    break_after: true,
                });
                index += 1;
                continue;
            }
            if is_break_space(unit) {
                if let Some(done) = word.take() {
                    tokens.push(done);
                }
                let mut end = index + 1;
                while end < text.len() && is_break_space(text[end]) {
                    end += 1;
                }
                let piece = piece_of(
                    fragment,
                    fragment.from + index,
                    fragment.from + end,
                    PieceKind::Space,
                    measurer,
                );
                tokens.push(Token {
                    kind: PieceKind::Space,
                    width: piece.width,
                    from: piece.from,
                    to: piece.to,
                    pieces: vec![piece],
                    break_after: true,
                });
                index = end;
                continue;
            }
            let mut end = index;
            while end < text.len() && text[end] != b'\n' as u16 && !is_break_space(text[end]) {
                end += 1;
                if is_break_after(text[end - 1]) && end - index > 1 {
                    break;
                }
            }
            let piece = piece_of(
                fragment,
                fragment.from + index,
                fragment.from + end,
                PieceKind::Word,
                measurer,
            );
            let current = word.get_or_insert_with(|| Token {
                kind: PieceKind::Word,
                pieces: Vec::new(),
                width: 0.0,
                from: piece.from,
                to: piece.to,
                break_after: false,
            });
            current.width += piece.width;
            current.to = piece.to;
            current.pieces.push(piece);
            if is_break_after(text[end - 1]) && end < text.len() && !is_space(text[end]) {
                current.break_after = true;
                if let Some(done) = word.take() {
                    tokens.push(done);
                }
            }
            index = end;
        }
    }
    if let Some(done) = word.take() {
        tokens.push(done);
    }
    tokens
}

fn sum_widths(pieces: &[Piece]) -> f64 {
    pieces.iter().fold(0.0, |total, piece| total + piece.width)
}

/// `splitToken`: splits a word token at a text offset (re-measured).
fn split_token(
    token: &Token,
    at: usize,
    fragments: &[Fragment],
    measurer: &dyn Measurer,
) -> (Token, Token) {
    let mut left = Vec::new();
    let mut right = Vec::new();
    for piece in &token.pieces {
        if piece.to <= at {
            left.push(piece.clone());
        } else if piece.from >= at {
            right.push(piece.clone());
        } else {
            let fragment = fragments
                .iter()
                .find(|candidate| candidate.from <= piece.from && candidate.to >= piece.to)
                .expect("fragment of a piece");
            left.push(piece_of(
                fragment,
                piece.from,
                at,
                PieceKind::Word,
                measurer,
            ));
            right.push(piece_of(fragment, at, piece.to, PieceKind::Word, measurer));
        }
    }
    let head = Token {
        kind: PieceKind::Word,
        width: sum_widths(&left),
        pieces: left,
        from: token.from,
        to: at,
        break_after: true,
    };
    let tail = Token {
        kind: PieceKind::Word,
        width: sum_widths(&right),
        pieces: right,
        from: at,
        to: token.to,
        break_after: token.break_after,
    };
    (head, tail)
}

fn word_text(token: &Token) -> String {
    token
        .pieces
        .iter()
        .map(|piece| piece.text.as_str())
        .collect()
}

struct Patterns {
    not_letter: regex::Regex,
    hyphenable: regex::Regex,
    trailing: regex::Regex,
    drop_cap: regex::Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        not_letter: regex::Regex::new(r"[^\p{L}]").expect("pattern"),
        hyphenable: regex::Regex::new(r#"^[\p{L}\-’']+[.,;:!?»«“”„"’)]*$"#).expect("pattern"),
        trailing: regex::Regex::new(r#"[.,;:!?»«“”„"’)]+$"#).expect("pattern"),
        drop_cap: regex::Regex::new(r#"^[„“"«‹‚'(]*[\p{L}\p{N}]"#).expect("pattern"),
    })
}

struct Breaker<'a> {
    style: &'a ResolvedStyle,
    measurer: &'a dyn Measurer,
    width: f64,
    drop_cap: Option<(f64, f64)>,
    base_font: FontSpec,
    base_metrics: FontMetrics,
    hyphen_width: f64,
    lines: Vec<LineBox>,
    footnotes: Vec<FootnoteRef>,
    cursor: usize,
}

impl Breaker<'_> {
    /// `lineStart(index)`: a list's first-line indent is the hanging space for its marker.
    fn line_start(&self, index: usize) -> f64 {
        let style = self.style;
        let mut x = style.indent_left
            + if index == 0 && style.list_marker.is_none() {
                style.indent_first
            } else {
                0.0
            };
        if let Some((width, lines)) = self.drop_cap {
            if (index as f64) < lines {
                x = style.indent_left + width;
            }
        }
        js::max(0.0, x)
    }

    fn available(&self, index: usize) -> f64 {
        js::max(
            20.0,
            self.width - self.style.indent_right - self.line_start(index),
        )
    }

    fn finish(
        &mut self,
        mut line_tokens: Vec<Token>,
        forced: bool,
        ends_paragraph: bool,
        hyphen: bool,
    ) {
        // A forced break stays the last piece of its line; the spaces before it hang like any trailing spaces.
        let break_token = if line_tokens
            .last()
            .is_some_and(|token| token.kind == PieceKind::Newline)
        {
            line_tokens.pop()
        } else {
            None
        };
        // Trailing spaces hang outside the line (see `Piece::hang`).
        let mut hanging: Vec<Token> = Vec::new();
        while line_tokens
            .last()
            .is_some_and(|token| token.kind == PieceKind::Space)
        {
            hanging.insert(0, line_tokens.pop().expect("a trailing space"));
        }
        let index = self.lines.len();
        let width = self.available(index);
        // The hyphen is drawn in the font of the piece it ends, so it is measured in that font.
        let last_font = line_tokens
            .iter()
            .rev()
            .find_map(|token| token.pieces.last())
            .map(|piece| piece.font);
        let hyphen_width = match (hyphen, last_font) {
            (true, Some(font)) => self.measurer.width(HYPHEN, &font),
            _ => 0.0,
        };
        let natural = line_tokens.iter().fold(0.0, |sum, token| sum + token.width) + hyphen_width;
        let last = forced || ends_paragraph;
        let spaces = line_tokens
            .iter()
            .filter(|token| token.kind == PieceKind::Space)
            .count();
        let style = self.style;
        let mut extra = 0.0;
        let mut offset_x = 0.0;
        if style.align == Align::Justify && !last && spaces > 0 {
            extra = js::max(0.0, width - natural) / spaces as f64;
        } else if style.align == Align::Center {
            offset_x = js::max(0.0, (width - natural) / 2.0);
        } else if style.align == Align::Right {
            offset_x = js::max(0.0, width - natural);
        }
        // An empty line (an empty paragraph, the line after a trailing break) starts and ends at the cursor.
        let from = line_tokens
            .first()
            .or(hanging.first())
            .or(break_token.as_ref())
            .map(|token| token.from)
            .unwrap_or(self.cursor);
        let to = break_token
            .as_ref()
            .or(hanging.last())
            .or(line_tokens.last())
            .map(|token| token.to)
            .unwrap_or(self.cursor);
        let mut x = offset_x;
        let mut pieces: Vec<Piece> = Vec::new();
        for token in line_tokens {
            let is_space = token.kind == PieceKind::Space;
            let count = token.pieces.len();
            for (position, mut piece) in token.pieces.into_iter().enumerate() {
                piece.x = x;
                x += piece.width;
                if is_space && extra != 0.0 && position == count - 1 {
                    piece.width += extra;
                    x += extra;
                }
                pieces.push(piece);
            }
        }
        if hyphen {
            if let Some(piece) = pieces.last_mut() {
                piece.hyphen = true;
            }
        }
        let mut hang_x = x;
        for token in hanging {
            for mut piece in token.pieces {
                piece.x = hang_x;
                piece.hang = true;
                hang_x += piece.width;
                pieces.push(piece);
            }
        }
        if let Some(token) = break_token {
            // A caret before the break sits after the hanging spaces.
            if let Some(mut piece) = token.pieces.into_iter().next() {
                piece.x = hang_x;
                pieces.push(piece);
            }
        }
        let largest = pieces.iter().fold(style.size, |max, piece| {
            let size = match piece.marks.as_ref().and_then(|marks| marks.size) {
                Some(size) if size != 0.0 && !size.is_nan() => pt_to_px(size),
                _ => 0.0,
            };
            js::max(max, size)
        });
        let height = largest * style.line_height;
        let metrics = if largest == style.size {
            self.base_metrics
        } else {
            self.measurer.metrics(&FontSpec {
                size: largest,
                ..self.base_font
            })
        };
        let baseline = (height - (metrics.ascent + metrics.descent)) / 2.0 + metrics.ascent;
        for piece in &pieces {
            if piece.kind == PieceKind::Anchor {
                if let Some(id) = piece
                    .marks
                    .as_ref()
                    .and_then(|marks| marks.fn_.as_ref())
                    .filter(|id| !id.is_empty())
                {
                    self.footnotes.push(FootnoteRef {
                        id: id.clone(),
                        line: index,
                    });
                }
            }
        }
        let start = self.line_start(index);
        self.lines.push(LineBox {
            from: if index == 0 { 0 } else { from },
            to,
            pieces,
            x: start,
            available: width,
            width: x + hyphen_width,
            height,
            baseline,
            last,
        });
    }
}

/// `layoutParagraph`.
pub fn layout_paragraph(input: &LayoutInput) -> ParagraphLayout {
    let style = input.style;
    let measurer = input.measurer;
    let fragments = fragments_of(input);
    let text_length: usize = input.runs.iter().map(|run| len16(&run.text)).sum();
    let base_font = FontSpec {
        family: style.font,
        bold: style.bold,
        italic: style.italic,
        size: style.size,
    };
    let base_metrics = measurer.metrics(&base_font);
    let line_advance = style.size * style.line_height;

    // Drop cap: the first letter (with an opening quote) spans `dropCap` lines.
    let mut drop_cap: Option<DropCap> = None;
    let mut start_offset = 0usize;
    if style.drop_cap > 1.0 {
        let plain: String = input.runs.iter().map(|run| run.text.as_str()).collect();
        if let Some(found) = patterns().drop_cap.find(&plain) {
            let cap_text = found.as_str();
            let cap_size =
                (line_advance * (style.drop_cap - 1.0) + base_metrics.ascent * 0.72) / 0.72;
            let cap_font = FontSpec {
                size: cap_size,
                bold: false,
                ..base_font
            };
            let _ = measurer.metrics(&cap_font);
            let baseline = (line_advance - (base_metrics.ascent + base_metrics.descent)) / 2.0
                + base_metrics.ascent
                + line_advance * (style.drop_cap - 1.0);
            drop_cap = Some(DropCap {
                text: if style.uppercase {
                    upper(cap_text)
                } else {
                    cap_text.to_string()
                },
                font: cap_font,
                width: measurer.width(cap_text, &cap_font) + style.size * 0.15,
                lines: style.drop_cap,
                x: 0.0,
                baseline,
            });
            start_offset = len16(cap_text);
        }
    }
    let trimmed: Vec<Fragment> = fragments
        .iter()
        .filter_map(|fragment| {
            if fragment.to <= start_offset && !fragment.anchor {
                return None;
            }
            if fragment.from < start_offset {
                let cut = start_offset - fragment.from;
                let mut copy = fragment.clone();
                copy.from = start_offset;
                copy.text = slice_units(&fragment.text, cut, usize::MAX).to_vec();
                copy.display = slice_units(&fragment.display, cut, usize::MAX).to_vec();
                return Some(copy);
            }
            Some(fragment.clone())
        })
        .collect();
    let mut tokens = tokenize(&trimmed, measurer);

    let mut breaker = Breaker {
        style,
        measurer,
        width: input.width,
        drop_cap: drop_cap.as_ref().map(|cap| (cap.width, cap.lines)),
        base_font,
        base_metrics,
        hyphen_width: measurer.width(HYPHEN, &base_font),
        lines: Vec::new(),
        footnotes: Vec::new(),
        cursor: 0,
    };

    let mut line_tokens: Vec<Token> = Vec::new();
    let mut line_width = 0.0;
    let mut pending_space = 0.0;
    let mut pending: Vec<Token> = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let limit = breaker.available(breaker.lines.len());
        let kind = tokens[index].kind;
        if kind == PieceKind::Newline {
            line_tokens.append(&mut pending);
            let token = std::mem::replace(&mut tokens[index], placeholder());
            breaker.cursor = token.to;
            line_tokens.push(token);
            breaker.finish(std::mem::take(&mut line_tokens), true, false, false);
            line_width = 0.0;
            pending_space = 0.0;
            index += 1;
            continue;
        }
        if kind == PieceKind::Space {
            // Spaces wait for the next word. If it fits they sit before it; if the line wraps they hang at the
            // end of this line (a wrapped line never starts with a space). After a forced break and at the start
            // of the paragraph they are typed text (verse, an address block) and stay.
            let token = std::mem::replace(&mut tokens[index], placeholder());
            pending_space += token.width;
            pending.push(token);
            index += 1;
            continue;
        }
        let token_width = tokens[index].width;
        if line_width + pending_space + token_width <= limit + 0.01 {
            line_tokens.append(&mut pending);
            line_tokens.push(std::mem::replace(&mut tokens[index], placeholder()));
            line_width += pending_space + token_width;
            pending_space = 0.0;
            index += 1;
            continue;
        }
        // The word does not fit. Try a hyphenation point, then break before it.
        let space = limit - line_width - pending_space;
        let mut split = false;
        if let (true, Some(hyphenator)) = (input.hyphenate, input.hyphenator) {
            if space - breaker.hyphen_width > style.size {
                let token = &tokens[index];
                let text = word_text(token);
                let letters = patterns().not_letter.replace_all(&text, "");
                if len16(&letters) >= 5 && patterns().hyphenable.is_match(&text) {
                    let core = patterns().trailing.replace(&text, "").into_owned();
                    let core_length = len16(&core);
                    let points: Vec<usize> = hyphenator
                        .points(&core)
                        .into_iter()
                        .filter(|&point| point >= 2 && core_length as i64 - point as i64 >= 2)
                        .collect();
                    for &point in points.iter().rev() {
                        let at = token.from + point;
                        let (head, tail) = split_token(token, at, &fragments, measurer);
                        // The hyphen is drawn in the font of the piece before it.
                        let hyphen_width =
                            head.pieces.last().map_or(breaker.hyphen_width, |piece| {
                                measurer.width(HYPHEN, &piece.font)
                            });
                        if head.width + hyphen_width <= space {
                            line_tokens.append(&mut pending);
                            line_tokens.push(head);
                            pending_space = 0.0;
                            breaker.finish(std::mem::take(&mut line_tokens), false, false, true);
                            breaker.cursor = at;
                            tokens[index] = tail;
                            line_width = 0.0;
                            split = true;
                            break;
                        }
                    }
                    if line_tokens.is_empty() && split {
                        continue;
                    }
                }
            }
        }
        if line_tokens.is_empty() && !pending.is_empty() {
            // Typed spaces at the start of a line and a word that does not fit after them: the spaces hang on a
            // line of their own and the word starts the next one (it may still fit there, or be broken).
            line_tokens.append(&mut pending);
            pending_space = 0.0;
            breaker.finish(std::mem::take(&mut line_tokens), false, false, false);
            breaker.cursor = tokens[index].from;
            line_width = 0.0;
            continue;
        }
        if line_tokens.is_empty() {
            // A single word wider than the line: break it by characters.
            let token = &tokens[index];
            let text = word_text(token);
            let mut cut = len16(&text) as i64 - 1;
            while cut > 1 {
                let (head, _) = split_token(token, token.from + cut as usize, &fragments, measurer);
                if head.width <= limit {
                    break;
                }
                cut -= 1;
            }
            let (head, tail) = split_token(
                token,
                token.from + cut.max(1) as usize,
                &fragments,
                measurer,
            );
            breaker.cursor = head.to;
            breaker.finish(vec![head], false, false, false);
            tokens[index] = tail;
            continue;
        }
        // The line wraps before this word. The spaces between the lines hang at the end of this one, so the
        // caret can sit after its last word and the next line starts with its word.
        line_tokens.append(&mut pending);
        pending_space = 0.0;
        breaker.finish(std::mem::take(&mut line_tokens), false, false, false);
        breaker.cursor = tokens[index].from;
        line_width = 0.0;
    }
    line_tokens.append(&mut pending);
    breaker.finish(line_tokens, false, true, false);
    let mut lines = breaker.lines;
    let footnotes = breaker.footnotes;
    // Lines cover the whole text: each starts where the previous ended.
    for line in 1..lines.len() {
        lines[line].from = lines[line - 1].to;
    }
    if let Some(last) = lines.last_mut() {
        last.to = text_length;
    }
    if let Some(marker) = &style.list_marker {
        // The marker hangs in the first-line indent, left of where the text starts.
        let width = measurer.width(marker, &base_font);
        let gap = style.size * 0.4;
        lines[0].pieces.insert(
            0,
            Piece {
                kind: PieceKind::Marker,
                from: 0,
                to: 0,
                text: String::new(),
                display: marker.clone(),
                font: base_font,
                marks: None,
                shift: 0.0,
                width,
                x: js::min(-gap - width, style.indent_first),
                hyphen: false,
                hang: false,
            },
        );
    }
    if let Some(cap) = drop_cap.as_mut() {
        lines[0].from = 0;
        cap.x = style.indent_left;
    }
    let height = lines.iter().fold(0.0, |sum, line| sum + line.height);
    ParagraphLayout {
        lines,
        style: style.clone(),
        drop_cap,
        height,
        footnotes,
        text_length,
    }
}

fn placeholder() -> Token {
    Token {
        kind: PieceKind::Space,
        pieces: Vec::new(),
        width: 0.0,
        from: 0,
        to: 0,
        break_after: false,
    }
}

// ── Caret geometry ─────────────────────────────────────────────────────────

/// `lineAt`: the line holding an offset (a caret at a line end belongs to that line unless `forward`).
pub fn line_at(layout: &ParagraphLayout, offset: usize, forward: bool) -> usize {
    let count = layout.lines.len();
    for (index, line) in layout.lines.iter().enumerate() {
        if offset < line.to || (offset == line.to && (!forward || index == count - 1)) {
            return index;
        }
    }
    count - 1
}

fn display_prefix(piece: &Piece, units: usize) -> String {
    let display: Vec<u16> = piece.display.encode_utf16().collect();
    String::from_utf16_lossy(slice_units(&display, 0, units))
}

/// `lineEnd`: where the caret goes at the end of a line (End key, a click right
/// of the text). Spaces that hang at a soft wrap are left out so the caret stays
/// on the line; spaces typed at the end of the paragraph or before a forced break
/// are text and come first. `upstream` is set when the offset also starts the
/// next line (a break after a hyphen or inside a word): the caret is then drawn
/// at the end of this line, not at the start of the next one.
pub fn line_end(layout: &ParagraphLayout, line_index: usize) -> (usize, bool) {
    let line = &layout.lines[line_index];
    if let Some(last) = line.pieces.last() {
        if last.kind == PieceKind::Newline {
            return (last.from, false);
        }
    }
    if line_index == layout.lines.len() - 1 {
        return (line.to, false);
    }
    match line.pieces.iter().find(|piece| piece.hang) {
        Some(hanging) => (hanging.from, false),
        None => (line.to, true),
    }
}

/// `capX`: x of a caret between the letters of the drop cap, left of the line start.
fn cap_x(cap: &DropCap, offset: usize, measurer: &dyn Measurer) -> f64 {
    let text: Vec<u16> = cap.text.encode_utf16().collect();
    -cap.width
        + measurer.width(
            &String::from_utf16_lossy(slice_units(&text, 0, offset)),
            &cap.font,
        )
}

/// `pieceX`: x of a caret at `offset` inside a piece, relative to the line start.
fn piece_x(piece: &Piece, offset: usize, measurer: &dyn Measurer) -> f64 {
    let inside = if piece.kind == PieceKind::Space {
        piece.width
            * ((offset as f64 - piece.from as f64) / (piece.to as f64 - piece.from as f64).max(1.0))
    } else {
        measurer.width(&display_prefix(piece, offset - piece.from), &piece.font)
    };
    // At the end of a line that breaks inside a word the caret sits after the hyphen.
    let hyphen = if piece.hyphen && offset == piece.to {
        measurer.width(HYPHEN, &piece.font)
    } else {
        0.0
    };
    piece.x + inside + hyphen
}

/// `caretX`: x of a caret within its line, relative to the line start. It never
/// leaves the line's box: spaces hanging past the margin do not push it out.
pub fn caret_x(
    layout: &ParagraphLayout,
    line_index: usize,
    offset: usize,
    measurer: &dyn Measurer,
) -> f64 {
    let line = &layout.lines[line_index];
    if let Some(cap) = &layout.drop_cap {
        if line_index == 0 && offset < len16(&cap.text) {
            return cap_x(cap, offset, measurer);
        }
    }
    if !line
        .pieces
        .iter()
        .any(|piece| piece.kind != PieceKind::Marker)
    {
        return match layout.style.align {
            Align::Center => line.available / 2.0,
            Align::Right => line.available,
            _ => 0.0,
        };
    }
    let count = line.pieces.len();
    for (position, piece) in line.pieces.iter().enumerate() {
        if piece.kind == PieceKind::Marker {
            continue;
        }
        if offset <= piece.from {
            return js::min(piece.x, line.available);
        }
        if offset < piece.to || (offset == piece.to && position == count - 1) {
            return js::min(piece_x(piece, offset, measurer), line.available);
        }
    }
    let last = &line.pieces[count - 1];
    js::min(last.x + last.width, line.available)
}

/// `caretAtX`: the caret nearest to x (relative to the line start): its offset,
/// and whether it belongs at the end of the line rather than at the start of the
/// next one. It never lies beyond `lineEnd`, so a click right of a wrapped line
/// ends that line.
pub fn caret_at_x(
    layout: &ParagraphLayout,
    line_index: usize,
    x: f64,
    measurer: &dyn Measurer,
) -> (usize, bool) {
    let line = &layout.lines[line_index];
    let (end_offset, end_upstream) = line_end(layout, line_index);
    let mut best = line.from;
    let mut best_distance = f64::INFINITY;
    // On a tie the later offset wins: spaces hanging past the margin share one x, and a click there ends the line.
    let mut consider = |offset: usize, position: f64| {
        let distance = (position - x).abs();
        if distance <= best_distance {
            best_distance = distance;
            best = offset;
        }
    };
    if let Some(cap) = &layout.drop_cap {
        if line_index == 0 {
            for offset in 0..len16(&cap.text) {
                consider(offset, cap_x(cap, offset, measurer));
            }
        }
    }
    let mut visited = false;
    for piece in &line.pieces {
        if matches!(
            piece.kind,
            PieceKind::Newline | PieceKind::Anchor | PieceKind::Marker
        ) {
            continue;
        }
        if visited && x < piece.x - 1.0 {
            break;
        }
        let mut offset = piece.from;
        while offset <= piece.to && offset <= end_offset {
            consider(
                offset,
                js::min(piece_x(piece, offset, measurer), line.available),
            );
            offset += 1;
        }
        visited = true;
    }
    // The end of the line is a stop of its own: an empty line, or one that only a break follows, has no piece to stop at.
    consider(
        end_offset,
        caret_x(layout, line_index, end_offset, measurer),
    );
    (best, end_upstream && best == end_offset)
}

/// `offsetAtX`: the offset nearest to x (relative to the line start).
pub fn offset_at_x(
    layout: &ParagraphLayout,
    line_index: usize,
    x: f64,
    measurer: &dyn Measurer,
) -> usize {
    caret_at_x(layout, line_index, x, measurer).0
}
