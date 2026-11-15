//! `left.localeCompare(right, 'de')`, the title tie-break of the TS ranking.
//!
//! Same ICU collator and the same V8 quirk as `fanotes-host` (`dictionary_order`).

use std::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::{Collator, CollatorBorrowed};

fn collator() -> Option<&'static CollatorBorrowed<'static>> {
    static COLLATOR: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(icu_locale_core::locale!("de").into(), Default::default()).ok()
        })
        .as_ref()
}

/// Characters whose primary weights in V8's German sort differ from ICU4X.
fn sentinel_rank(character: char) -> Option<u32> {
    Some(match character {
        '\u{A7D3}' => 0,
        '\u{A7D5}' => 1,
        '\u{A7CE}' => 2,
        '\u{A7CF}' => 3,
        '\u{A7D2}' => 4,
        '\u{A7D4}' => 5,
        '\u{16EA0}'..='\u{16ED3}' => 6 + (u32::from(character) - 0x16EA0),
        _ => return None,
    })
}

fn collation_text(value: &str) -> std::borrow::Cow<'_, str> {
    if !value.chars().any(|c| sentinel_rank(c).is_some()) {
        return std::borrow::Cow::Borrowed(value);
    }
    value
        .chars()
        .map(|c| {
            sentinel_rank(c)
                .and_then(|rank| char::from_u32(0xF0000 + rank))
                .unwrap_or(c)
        })
        .collect::<String>()
        .into()
}

/// German dictionary order, as `String.prototype.localeCompare(other, 'de')`.
pub fn german_compare(left: &str, right: &str) -> Ordering {
    if left == right {
        return Ordering::Equal;
    }
    let left = collation_text(left);
    let right = collation_text(right);
    match collator() {
        Some(collator) => collator.compare(&left, &right),
        None => left.cmp(&right),
    }
}

#[cfg(test)]
mod tests {
    use super::german_compare;
    use std::cmp::Ordering::*;

    #[test]
    fn german_order() {
        assert_eq!(german_compare("a", "A"), Less);
        assert_eq!(german_compare("ä", "b"), Less);
        assert_eq!(german_compare("Straße", "Strasse"), Greater);
        assert_eq!(german_compare("a b", "ab"), Less);
        assert_eq!(german_compare("Zelle", "zelle"), Greater);
        assert_eq!(german_compare("Übung", "Uebung"), Less);
    }
}
