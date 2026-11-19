//! Built-in page sizes, page setup, paragraph styles and new projects (`model/defaults.ts`).

use super::ids::{new_id, IdSource};
use super::keys::key_between;
use super::types::*;
use crate::json::JsMap;

pub struct PageSizeInfo {
    pub width: f64,
    pub height: f64,
    pub margins: Margins,
    pub name_de: &'static str,
    pub name_en: &'static str,
}

/// `PAGE_SIZES` (every size but `custom`).
pub fn page_size_info(size: PageSize) -> Option<PageSizeInfo> {
    let m = |top, bottom, inner, outer| Margins {
        top,
        bottom,
        inner,
        outer,
    };
    Some(match size {
        PageSize::A4 => PageSizeInfo {
            width: 210.0,
            height: 297.0,
            margins: m(25.0, 25.0, 25.0, 25.0),
            name_de: "A4",
            name_en: "A4",
        },
        PageSize::A5 => PageSizeInfo {
            width: 148.0,
            height: 210.0,
            margins: m(18.0, 20.0, 20.0, 15.0),
            name_de: "A5 (Buch)",
            name_en: "A5 (book)",
        },
        PageSize::Letter => PageSizeInfo {
            width: 215.9,
            height: 279.4,
            margins: m(25.4, 25.4, 25.4, 25.4),
            name_de: "US Letter",
            name_en: "US Letter",
        },
        PageSize::Pocket => PageSizeInfo {
            width: 115.0,
            height: 185.0,
            margins: m(15.0, 17.0, 17.0, 12.0),
            name_de: "Taschenbuch (11,5 × 18,5 cm)",
            name_en: "Pocket book (4.5 × 7.3 in)",
        },
        PageSize::Trade => PageSizeInfo {
            width: 152.4,
            height: 228.6,
            margins: m(19.0, 21.0, 22.0, 16.0),
            name_de: "Trade Paperback (6 × 9 in)",
            name_en: "Trade paperback (6 × 9 in)",
        },
        PageSize::Manuscript => PageSizeInfo {
            width: 210.0,
            height: 297.0,
            margins: m(25.4, 25.4, 25.4, 25.4),
            name_de: "Normseite / Manuskript",
            name_en: "Standard manuscript",
        },
        PageSize::Custom => return None,
    })
}

/// `defaultPageSetup(size, language)`; `custom` is treated as A5.
pub fn default_page_setup(size: PageSize, language: StoryLanguage) -> PageSetup {
    let size = if size == PageSize::Custom {
        PageSize::A5
    } else {
        size
    };
    let format = page_size_info(size).expect("built-in size");
    let book = matches!(size, PageSize::A5 | PageSize::Pocket | PageSize::Trade);
    let manuscript = size == PageSize::Manuscript;
    PageSetup {
        size,
        width: format.width,
        height: format.height,
        margins: format.margins,
        mirror: book,
        header: if book {
            HeaderFooter::new("{title}", "", "{chapter}")
        } else if manuscript {
            HeaderFooter::new("", "", "{author} / {title} / {page}")
        } else {
            HeaderFooter::new("", "", "")
        },
        footer: if book || manuscript {
            HeaderFooter::new("", if manuscript { "" } else { "{page}" }, "")
        } else {
            HeaderFooter::new("", "{page}", "")
        },
        hide_on_chapter_start: true,
        chapter_starts_right: false,
        page_number_start: 1.0,
        header_offset: if book { 10.0 } else { 12.7 },
        footer_offset: if book { 10.0 } else { 12.7 },
        widows_orphans: true,
        hyphenate: language.is_german(),
        scene_break: "* * *".into(),
    }
}

/// The optional parts of a built-in style (`rest` in defaults.ts).
#[derive(Default)]
struct Rest {
    font: Option<FontFamily>,
    size: Option<f64>,
    line_height: Option<f64>,
    space_before: Option<f64>,
    space_after: Option<f64>,
    indent_first: Option<f64>,
    indent_left: Option<f64>,
    indent_right: Option<f64>,
    align: Option<Align>,
    bold: bool,
    italic: bool,
    uppercase: bool,
    keep_with_next: bool,
    page_break_before: bool,
    next: Option<&'static str>,
    outline_level: f64,
    list_marker: Option<&'static str>,
}

fn style(id: &str, de: &str, en: &str, rest: Rest) -> ParagraphStyle {
    // Optional flags are stored only when set, exactly as a saved file reads back.
    let flag = |on: bool| on.then_some(true);
    ParagraphStyle {
        id: id.into(),
        name: LocalName {
            de: de.into(),
            en: en.into(),
        },
        font: rest.font.unwrap_or(FontFamily::Literata),
        size: rest.size.unwrap_or(11.0),
        line_height: rest.line_height.unwrap_or(1.45),
        space_before: rest.space_before.unwrap_or(0.0),
        space_after: rest.space_after.unwrap_or(0.0),
        indent_first: rest.indent_first.unwrap_or(0.0),
        indent_left: rest.indent_left.unwrap_or(0.0),
        indent_right: rest.indent_right.unwrap_or(0.0),
        align: rest.align.unwrap_or(Align::Justify),
        bold: flag(rest.bold),
        italic: flag(rest.italic),
        small_caps: None,
        uppercase: flag(rest.uppercase),
        keep_with_next: flag(rest.keep_with_next),
        page_break_before: flag(rest.page_break_before),
        no_indent_after_break: None,
        color: None,
        drop_cap: None,
        next: rest.next.map(str::to_string),
        list_marker: rest.list_marker.map(str::to_string),
        outline_level: (rest.outline_level != 0.0).then_some(rest.outline_level),
    }
}

/// `defaultStyles(manuscript)`: the built-in paragraph styles, in their stored order.
pub fn default_styles(manuscript: bool) -> JsMap<ParagraphStyle> {
    let font = Some(if manuscript {
        FontFamily::Courier
    } else {
        FontFamily::Literata
    });
    let size = Some(if manuscript { 12.0 } else { 11.0 });
    let line_height = Some(if manuscript { 2.0 } else { 1.45 });
    let ms = |a: f64, b: f64| Some(if manuscript { a } else { b });
    let prose_align = Some(if manuscript {
        Align::Left
    } else {
        Align::Justify
    });
    let list = vec![
        style(
            "body",
            "Fliesstext",
            "Body text",
            Rest {
                font,
                size,
                line_height,
                indent_first: ms(12.7, 5.0),
                align: prose_align,
                next: Some("body"),
                ..Rest::default()
            },
        ),
        style(
            "first",
            "Erster Absatz",
            "First paragraph",
            Rest {
                font,
                size,
                line_height,
                indent_first: Some(0.0),
                align: prose_align,
                next: Some("body"),
                ..Rest::default()
            },
        ),
        style(
            "chapter",
            "Kapitelüberschrift",
            "Chapter title",
            Rest {
                font,
                size: ms(12.0, 20.0),
                line_height: Some(1.2),
                space_before: ms(72.0, 60.0),
                space_after: ms(24.0, 30.0),
                align: Some(Align::Center),
                bold: !manuscript,
                uppercase: manuscript,
                keep_with_next: true,
                page_break_before: true,
                next: Some("first"),
                outline_level: 1.0,
                ..Rest::default()
            },
        ),
        style(
            "heading",
            "Überschrift",
            "Heading",
            Rest {
                font,
                size: ms(12.0, 14.0),
                line_height: Some(1.3),
                space_before: Some(18.0),
                space_after: Some(8.0),
                align: Some(Align::Left),
                bold: true,
                keep_with_next: true,
                next: Some("first"),
                outline_level: 2.0,
                ..Rest::default()
            },
        ),
        style(
            "subheading",
            "Zwischenüberschrift",
            "Subheading",
            Rest {
                font,
                size: Some(12.0),
                line_height: Some(1.3),
                space_before: Some(12.0),
                space_after: Some(6.0),
                align: Some(Align::Left),
                italic: true,
                keep_with_next: true,
                next: Some("first"),
                outline_level: 3.0,
                ..Rest::default()
            },
        ),
        style(
            "quote",
            "Zitat",
            "Quotation",
            Rest {
                font,
                size: ms(12.0, 10.5),
                line_height,
                space_before: Some(6.0),
                space_after: Some(6.0),
                indent_left: Some(10.0),
                indent_right: Some(10.0),
                align: prose_align,
                italic: !manuscript,
                next: Some("body"),
                ..Rest::default()
            },
        ),
        style(
            "dialogue",
            "Dialog",
            "Dialogue",
            Rest {
                font,
                size,
                line_height,
                indent_first: ms(12.7, 5.0),
                align: prose_align,
                next: Some("dialogue"),
                ..Rest::default()
            },
        ),
        style(
            "letter",
            "Brief / Einschub",
            "Letter / insert",
            Rest {
                font,
                size: ms(12.0, 10.5),
                line_height,
                space_before: Some(6.0),
                space_after: Some(6.0),
                indent_left: Some(8.0),
                indent_right: Some(8.0),
                align: Some(Align::Left),
                italic: !manuscript,
                next: Some("letter"),
                ..Rest::default()
            },
        ),
        style(
            "poem",
            "Gedicht / Lied",
            "Poem / song",
            Rest {
                font,
                size,
                line_height: ms(2.0, 1.35),
                indent_left: Some(15.0),
                align: Some(Align::Left),
                italic: !manuscript,
                next: Some("poem"),
                ..Rest::default()
            },
        ),
        style(
            "scenebreak",
            "Szenenwechsel",
            "Scene break",
            Rest {
                font,
                size,
                line_height,
                space_before: Some(8.0),
                space_after: Some(8.0),
                align: Some(Align::Center),
                keep_with_next: true,
                next: Some("first"),
                ..Rest::default()
            },
        ),
        style(
            "epigraph",
            "Motto",
            "Epigraph",
            Rest {
                font,
                size: ms(12.0, 10.0),
                line_height: Some(1.35),
                space_before: Some(24.0),
                space_after: Some(24.0),
                indent_left: Some(30.0),
                align: Some(Align::Right),
                italic: !manuscript,
                next: Some("first"),
                ..Rest::default()
            },
        ),
        style(
            "list",
            "Aufzählung",
            "List",
            Rest {
                font,
                size,
                line_height,
                indent_left: Some(6.0),
                indent_first: Some(-4.0),
                align: Some(Align::Left),
                next: Some("list"),
                list_marker: Some("•"),
                ..Rest::default()
            },
        ),
    ];
    list.into_iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect()
}

/// `emptyParagraph`.
pub fn empty_paragraph(
    ids: &mut dyn IdSource,
    style: &str,
    device_id: &str,
    key: &str,
    text: &str,
) -> Paragraph {
    let mut v = Vector::new();
    v.insert(device_id, 1.0);
    Paragraph {
        id: new_id(ids, 14),
        key: key.into(),
        v,
        style: style.into(),
        runs: if text.is_empty() {
            Vec::new()
        } else {
            vec![Run::new(text)]
        },
        ..Paragraph::default()
    }
}

/// `emptyScene` (the scene id is drawn before the paragraph id, as in TypeScript).
pub fn empty_scene(
    ids: &mut dyn IdSource,
    device_id: &str,
    first_style: &str,
    text: &str,
) -> Scene {
    let id = new_id(ids, 14);
    let key = key_between(None, None).expect("first key");
    let paragraph = empty_paragraph(ids, first_style, device_id, &key, text);
    Scene {
        id,
        paragraphs: vec![paragraph],
        footnotes: None,
        comments: None,
    }
}

pub struct NewStoryOptions<'a> {
    pub title: &'a str,
    pub author: Option<&'a str>,
    pub language: StoryLanguage,
    pub size: Option<PageSize>,
    pub device_id: &'a str,
    /// ISO timestamp (`new Date().toISOString()`).
    pub now: &'a str,
}

/// `newStory`: a project with one chapter holding one empty scene.
pub fn new_story(options: &NewStoryOptions, ids: &mut dyn IdSource) -> (StoryManifest, Vec<Scene>) {
    let scene = empty_scene(ids, options.device_id, "first", "");
    let english = options.language.is_english();
    let mut scene_node = BinderNode::new(
        scene.id.clone(),
        BinderKind::Scene,
        if english { "Scene 1" } else { "Szene 1" },
    );
    scene_node.status = Some(SceneStatus::Draft);
    let mut chapter = BinderNode::new(
        new_id(ids, 14),
        BinderKind::Chapter,
        if english { "Chapter 1" } else { "Kapitel 1" },
    );
    chapter.children = Some(vec![scene_node]);
    let size = options.size.unwrap_or(PageSize::A5);
    let trimmed = options.title.trim();
    let manifest = StoryManifest {
        id: new_id(ids, 14),
        title: if trimmed.is_empty() {
            (if english {
                "Untitled story"
            } else {
                "Unbenannte Geschichte"
            })
            .into()
        } else {
            trimmed.into()
        },
        subtitle: None,
        author: options
            .author
            .filter(|author| !author.is_empty())
            .map(str::to_string),
        language: options.language,
        page: default_page_setup(size, options.language),
        styles: default_styles(size == PageSize::Manuscript),
        binder: vec![chapter],
        goals: Some(StoryGoals::default()),
        dictionary: Some(Vec::new()),
        ignored: None,
        created_at: options.now.into(),
        updated_at: options.now.into(),
    };
    (manifest, vec![scene])
}

pub struct Typography {
    pub open: &'static str,
    pub close: &'static str,
    pub open_single: &'static str,
    pub close_single: &'static str,
    pub apostrophe: &'static str,
    pub dash: &'static str,
    pub wpm: u32,
}

/// `LANGUAGE_TYPOGRAPHY`.
pub fn language_typography(language: StoryLanguage) -> Typography {
    match language {
        StoryLanguage::De => Typography {
            open: "„",
            close: "“",
            open_single: "‚",
            close_single: "‘",
            apostrophe: "’",
            dash: " – ",
            wpm: 230,
        },
        StoryLanguage::DeCh => Typography {
            open: "«",
            close: "»",
            open_single: "‹",
            close_single: "›",
            apostrophe: "’",
            dash: " – ",
            wpm: 230,
        },
        StoryLanguage::EnUs => Typography {
            open: "“",
            close: "”",
            open_single: "‘",
            close_single: "’",
            apostrophe: "’",
            dash: "—",
            wpm: 250,
        },
        StoryLanguage::EnGb => Typography {
            open: "‘",
            close: "’",
            open_single: "“",
            close_single: "”",
            apostrophe: "’",
            dash: " – ",
            wpm: 250,
        },
    }
}
