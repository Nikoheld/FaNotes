//! Runs (`model/runs.ts`): inline-formatted text pieces of a paragraph.
//! Offsets are UTF-16 offsets into the paragraph text, as in TypeScript.

use super::types::{FontFamily, Marks, Paragraph, Run, StoryLanguage};
use crate::js::{len16, slice16};

/// `marksEqual`: `undefined` and `{}` are equal.
pub fn marks_equal(left: Option<&Marks>, right: Option<&Marks>) -> bool {
    let empty = Marks::default();
    left.unwrap_or(&empty) == right.unwrap_or(&empty)
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value.as_ref().filter(|text| !text.is_empty()).cloned()
}

/// `cleanMarks`: drops empty values; `None` when nothing is left.
pub fn clean_marks(marks: Option<&Marks>) -> Option<Marks> {
    let marks = marks?;
    let out = Marks {
        color: non_empty(&marks.color),
        hl: non_empty(&marks.hl),
        link: non_empty(&marks.link),
        fn_: non_empty(&marks.fn_),
        cm: non_empty(&marks.cm),
        ..marks.clone()
    };
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn has_footnote(marks: Option<&Marks>) -> bool {
    marks.is_some_and(|marks| marks.fn_.is_some())
}

/// `normalizeRuns`: merges neighbours with equal marks and drops empty runs (footnote anchors are kept).
pub fn normalize_runs(runs: Vec<Run>) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::with_capacity(runs.len());
    for run in runs {
        let marks = clean_marks(run.m.as_ref());
        if run.text.is_empty() && !has_footnote(marks.as_ref()) {
            continue;
        }
        if let Some(last) = out.last_mut() {
            if !has_footnote(marks.as_ref())
                && !has_footnote(last.m.as_ref())
                && marks_equal(last.m.as_ref(), marks.as_ref())
            {
                last.text.push_str(&run.text);
                continue;
            }
        }
        out.push(Run {
            text: run.text,
            m: marks,
        });
    }
    out
}

pub fn runs_text(runs: &[Run]) -> String {
    runs.iter().map(|run| run.text.as_str()).collect()
}

pub fn paragraph_text(paragraph: &Paragraph) -> String {
    runs_text(&paragraph.runs)
}

/// `runsLength` (UTF-16).
pub fn runs_length(runs: &[Run]) -> usize {
    runs.iter().map(|run| len16(&run.text)).sum()
}

/// `sliceRuns(runs, from, to)`; `to = None` is the end.
pub fn slice_runs(runs: &[Run], from: usize, to: Option<usize>) -> Vec<Run> {
    let to = to.unwrap_or(usize::MAX);
    let mut out = Vec::new();
    let mut position = 0usize;
    for run in runs {
        let length = len16(&run.text);
        let start = position;
        let end = position + length;
        position = end;
        if end <= from || start >= to {
            if run.text.is_empty() && has_footnote(run.m.as_ref()) && start >= from && start < to {
                out.push(run.clone());
            }
            continue;
        }
        let text = slice16(
            &run.text,
            from.saturating_sub(start),
            length.min(to - start),
        );
        out.push(Run {
            text,
            m: run.m.clone(),
        });
    }
    normalize_runs(out)
}

/// `withoutAnchors`: typing next to a footnote marker or inside a link does not extend them.
pub fn without_anchors(marks: &Marks) -> Option<Marks> {
    let rest = Marks {
        fn_: None,
        cm: None,
        link: None,
        ..marks.clone()
    };
    clean_marks(Some(&rest))
}

/// `marksAt`: marks of the character before the offset.
pub fn marks_at(runs: &[Run], offset: usize) -> Option<Marks> {
    let mut position = 0usize;
    let mut previous: Option<&Marks> = None;
    let mut seen_previous = false;
    for run in runs {
        let end = position + len16(&run.text);
        if offset > position && offset <= end {
            return run.m.as_ref().and_then(without_anchors);
        }
        if offset == 0 && !run.text.is_empty() {
            return run.m.as_ref().and_then(without_anchors);
        }
        previous = run.m.as_ref();
        seen_previous = true;
        position = end;
    }
    let _ = seen_previous;
    previous.and_then(without_anchors)
}

pub fn insert_runs(runs: &[Run], offset: usize, inserted: &[Run]) -> Vec<Run> {
    let mut all = slice_runs(runs, 0, Some(offset));
    all.extend(inserted.iter().cloned());
    all.extend(slice_runs(runs, offset, None));
    normalize_runs(all)
}

pub fn insert_text(runs: &[Run], offset: usize, text: &str, marks: Option<Marks>) -> Vec<Run> {
    insert_runs(
        runs,
        offset,
        &[Run {
            text: text.to_string(),
            m: marks,
        }],
    )
}

pub fn delete_range(runs: &[Run], from: usize, to: usize) -> Vec<Run> {
    let mut all = slice_runs(runs, 0, Some(from));
    all.extend(slice_runs(runs, to, None));
    normalize_runs(all)
}

/// `MarkPatch`: `Some(Some(v))` sets, `Some(None)` clears, `None` leaves a mark as it is.
/// Flags: `Some(true)` sets, `Some(false)` clears.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MarkPatch {
    pub b: Option<bool>,
    pub i: Option<bool>,
    pub u: Option<bool>,
    pub s: Option<bool>,
    pub sc: Option<bool>,
    pub sup: Option<bool>,
    pub sub: Option<bool>,
    pub font: Option<Option<FontFamily>>,
    pub size: Option<Option<f64>>,
    pub color: Option<Option<String>>,
    pub hl: Option<Option<String>>,
    pub link: Option<Option<String>>,
    pub fn_: Option<Option<String>>,
    pub cm: Option<Option<String>>,
    pub lang: Option<Option<StoryLanguage>>,
}

fn patch_value<T: Clone>(target: &mut Option<T>, patch: &Option<Option<T>>) {
    if let Some(value) = patch {
        *target = value.clone();
    }
}

/// `applyMarks`: sets or clears marks on a range.
pub fn apply_marks(runs: &[Run], from: usize, to: usize, patch: &MarkPatch) -> Vec<Run> {
    if from >= to {
        return runs.to_vec();
    }
    let middle: Vec<Run> = slice_runs(runs, from, Some(to))
        .into_iter()
        .map(|run| {
            let mut next = run.m.clone().unwrap_or_default();
            for (flag, value) in [
                (&mut next.b, patch.b),
                (&mut next.i, patch.i),
                (&mut next.u, patch.u),
                (&mut next.s, patch.s),
                (&mut next.sc, patch.sc),
                (&mut next.sup, patch.sup),
                (&mut next.sub, patch.sub),
            ] {
                if let Some(value) = value {
                    *flag = value;
                }
            }
            patch_value(&mut next.font, &patch.font);
            patch_value(&mut next.size, &patch.size);
            patch_value(&mut next.color, &patch.color);
            patch_value(&mut next.hl, &patch.hl);
            patch_value(&mut next.link, &patch.link);
            patch_value(&mut next.fn_, &patch.fn_);
            patch_value(&mut next.cm, &patch.cm);
            patch_value(&mut next.lang, &patch.lang);
            if patch.sup == Some(true) {
                next.sub = false;
            }
            if patch.sub == Some(true) {
                next.sup = false;
            }
            Run {
                text: run.text,
                m: Some(next),
            }
        })
        .collect();
    let mut all = slice_runs(runs, 0, Some(from));
    all.extend(middle);
    all.extend(slice_runs(runs, to, None));
    normalize_runs(all)
}

/// `rangeHasMark`: every character in the range has the mark (`test` decides per run's marks).
pub fn range_has_mark(
    runs: &[Run],
    from: usize,
    to: usize,
    test: impl Fn(Option<&Marks>) -> bool,
) -> bool {
    let part: Vec<Run> = slice_runs(runs, from, Some(to))
        .into_iter()
        .filter(|run| !run.text.is_empty())
        .collect();
    if part.is_empty() {
        return test(marks_at(runs, from).as_ref());
    }
    part.iter().all(|run| test(run.m.as_ref()))
}

/// `replaceText`: replaces a range, keeping the marks of its first character.
pub fn replace_text(runs: &[Run], from: usize, to: usize, text: &str) -> Vec<Run> {
    let first = slice_runs(runs, from, Some((from + 1).max(to)))
        .into_iter()
        .next()
        .and_then(|run| run.m);
    let marks = first.or_else(|| marks_at(runs, from));
    insert_text(
        &delete_range(runs, from, to),
        from,
        text,
        marks.as_ref().and_then(without_anchors),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bold() -> Marks {
        Marks {
            b: true,
            ..Marks::default()
        }
    }

    #[test]
    fn insert_delete_marks() {
        let mut value = vec![Run::new("Hallo Welt")];
        value = apply_marks(
            &value,
            6,
            10,
            &MarkPatch {
                b: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(
            value,
            vec![Run::new("Hallo "), Run::with_marks("Welt", bold())]
        );
        value = insert_text(&value, 10, "!", marks_at(&value, 10));
        assert_eq!(
            value,
            vec![Run::new("Hallo "), Run::with_marks("Welt!", bold())]
        );
        value = delete_range(&value, 4, 8);
        assert_eq!(runs_text(&value), "Halllt!");
        value = apply_marks(
            &value,
            0,
            7,
            &MarkPatch {
                b: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(value, vec![Run::new("Halllt!")]);
        let anchor = Run::with_marks(
            "",
            Marks {
                fn_: Some("abcdef1".into()),
                ..Marks::default()
            },
        );
        let anchored = insert_runs(&[Run::new("Satz.")], 5, &[anchor]);
        assert_eq!(anchored.len(), 2);
        assert_eq!(marks_at(&anchored, 6), None);
    }
}
