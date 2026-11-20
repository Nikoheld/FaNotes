//! Guard that keeps tests away from the user's real profile, home and keyring.
//!
//! Production code that is about to read a real machine location calls
//! [`forbid_real`]. It panics while tests run, so a test that forgot to inject
//! a temp directory or the in-memory secret store fails loudly instead of
//! reading (or writing) the developer's data.

/// True in the host's own unit tests, in cargo integration tests (cargo sets
/// `CARGO_TARGET_TMPDIR` for them) and when `FANOTES_HERMETIC` is set.
pub fn under_test() -> bool {
    cfg!(test)
        || std::env::var_os("CARGO_TARGET_TMPDIR").is_some()
        || std::env::var_os("FANOTES_HERMETIC").is_some_and(|value| !value.is_empty())
}

/// Panics when a test is about to touch `what` on the real machine.
#[track_caller]
pub fn forbid_real(what: &str) {
    assert!(
        !under_test(),
        "hermetic test violation: this test would use {what}. Inject a temp directory or the in-memory store."
    );
}
