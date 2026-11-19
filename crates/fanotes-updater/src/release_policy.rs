//! Port of `scripts/check-release-policy.mjs` (via `release-policy-core.mjs`):
//! the calendar-version rules a new release must satisfy.
//!
//! `YYYY.M.N` is stable number N of the month; `YYYY.M.N-beta.B` is beta B
//! for the stable that will be number N. A beta must target the next stable of
//! the month and be the next beta for it. The network part (fetching GitHub
//! release tags) stays with the caller: pass the tags in.

use std::sync::LazyLock;

use regex::Regex;

use crate::error::{err, ErrorKind, Result};

static VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4})\.([0-9]{1,2})\.([1-9][0-9]*)(?:-beta\.([1-9][0-9]*))?$").unwrap()
});
static STABLE_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^v[0-9]{4}\.[0-9]{1,2}\.[1-9][0-9]*$").unwrap());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CalendarVersion {
    pub year: u32,
    pub month: u32,
    pub stable_number: u32,
    pub beta_number: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseKind {
    Stable,
    Beta,
}

fn policy_error<T>(message: impl Into<String>) -> Result<T> {
    err(ErrorKind::Policy, message)
}

/// Syntax and month range (`1..=12`).
pub fn parse_calendar_version(version: &str) -> Result<CalendarVersion> {
    let Some(caps) = VERSION.captures(version) else {
        return policy_error("Calendar versions must use YYYY.M.N or YYYY.M.N-beta.B.");
    };
    // Components can exceed u32 in principle; JS would carry doubles. Reject what we cannot hold.
    let number = |index: usize| caps[index].parse::<u32>().ok();
    let (Some(year), Some(month), Some(stable_number)) = (number(1), number(2), number(3)) else {
        return policy_error("Calendar versions must use YYYY.M.N or YYYY.M.N-beta.B.");
    };
    if !(1..=12).contains(&month) {
        return policy_error("The release month must be between 1 and 12.");
    }
    let beta_number = match caps.get(4) {
        Some(m) => match m.as_str().parse::<u32>() {
            Ok(n) => Some(n),
            Err(_) => {
                return policy_error("Calendar versions must use YYYY.M.N or YYYY.M.N-beta.B.")
            }
        },
        None => None,
    };
    Ok(CalendarVersion {
        year,
        month,
        stable_number,
        beta_number,
    })
}

/// The release must be made in the current Europe/Zurich month (the caller supplies it).
pub fn assert_current_month(
    version: &str,
    parsed: &CalendarVersion,
    zurich_year: u32,
    zurich_month: u32,
) -> Result<()> {
    if parsed.year != zurich_year || parsed.month != zurich_month {
        return policy_error(format!(
            "Release {version} is not in the current Europe/Zurich month {zurich_year}.{zurich_month}."
        ));
    }
    Ok(())
}

/// Check the version against the existing release tags (`v2026.11.2`, ...).
pub fn check_against_tags<S: AsRef<str>>(
    version: &str,
    parsed: &CalendarVersion,
    tags: &[S],
) -> Result<ReleaseKind> {
    let CalendarVersion {
        year,
        month,
        stable_number,
        beta_number,
    } = *parsed;
    let prefix = format!("v{year}.{month}.");
    let monthly: Vec<&str> = tags
        .iter()
        .map(AsRef::as_ref)
        .filter(|tag| tag.starts_with(&prefix))
        .collect();
    let exact = format!("v{version}");
    if monthly.iter().any(|tag| *tag == exact) {
        return policy_error(format!("Release v{version} already exists."));
    }
    let stable_count = monthly
        .iter()
        .filter(|tag| STABLE_TAG.is_match(tag))
        .count() as u32;
    let Some(beta_number) = beta_number else {
        let expected = stable_count + 1;
        if stable_number != expected {
            return policy_error(format!(
                "The next stable release this month must be number {expected}."
            ));
        }
        return Ok(ReleaseKind::Stable);
    };
    let targeted = stable_count + 1;
    if stable_number != targeted {
        return policy_error(format!(
            "The next beta must target Stable {year}.{month}.{targeted}; a prerelease for {year}.{month}.{stable_number} would not be newer than the installed Stable channel."
        ));
    }
    let beta_prefix = format!("v{year}.{month}.{stable_number}-beta.");
    let highest = monthly
        .iter()
        .filter_map(|tag| tag.strip_prefix(beta_prefix.as_str()))
        .filter(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|rest| rest.parse::<u64>().ok())
        .max();
    let expected = highest.map_or(1, |max| max + 1);
    if u64::from(beta_number) != expected {
        return policy_error(format!(
            "The next beta for {year}.{month}.{stable_number} must be beta.{expected}."
        ));
    }
    Ok(ReleaseKind::Beta)
}

/// All three steps in the script's order.
pub fn check_release_policy<S: AsRef<str>>(
    version: &str,
    zurich_year: u32,
    zurich_month: u32,
    tags: &[S],
) -> Result<ReleaseKind> {
    let parsed = parse_calendar_version(version)?;
    assert_current_month(version, &parsed, zurich_year, zurich_month)?;
    check_against_tags(version, &parsed, tags)
}
