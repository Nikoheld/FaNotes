//! Keeps the Rust button tables equal to `fanotes/src/lib/tabletButtons.ts`, and ports
//! the vectors of `fanotes/scripts/check-wacom-buttons.mjs`.

use fanotes_input::{
    tablet_button_identity, TabletButtonAction, TabletButtonId, TabletButtonMap,
    DEFAULT_TABLET_BUTTON_ACTIONS,
};

fn ts() -> String {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fanotes/src/lib/tabletButtons.ts"
    );
    std::fs::read_to_string(p).expect("tabletButtons.ts")
}

fn quoted_pairs(block: &str) -> Vec<(String, String)> {
    block
        .lines()
        .filter_map(|l| {
            let l = l.trim().trim_end_matches(',');
            let (k, v) = l.split_once(':')?;
            let k = k.trim().trim_matches('\'');
            let v = v.trim().trim_matches('\'');
            (!k.contains(' ') && !v.contains(' ')).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

#[test]
fn defaults_match_typescript() {
    let src = ts();
    let start = src
        .find("DEFAULT_TABLET_BUTTON_ACTIONS: TabletButtonMap = {")
        .unwrap();
    let block = &src[start..];
    let block = &block[block.find('{').unwrap() + 1..block.find('}').unwrap()];
    let ts_pairs = quoted_pairs(block);
    assert_eq!(ts_pairs.len(), DEFAULT_TABLET_BUTTON_ACTIONS.len());
    for (id, action) in DEFAULT_TABLET_BUTTON_ACTIONS {
        assert!(
            ts_pairs.contains(&(id.as_str().to_string(), action.as_str().to_string())),
            "{id:?}"
        );
    }
}

#[test]
fn ids_and_actions_match_typescript() {
    let src = ts();
    let actions = &src[src.find("TABLET_BUTTON_ACTIONS = [").unwrap()..];
    let actions = &actions[actions.find('[').unwrap() + 1..actions.find(']').unwrap()];
    let ts_actions: Vec<&str> = actions
        .split(',')
        .map(|s| s.trim().trim_matches('\''))
        .collect();
    let rust: Vec<&str> = TabletButtonAction::ALL.iter().map(|a| a.as_str()).collect();
    assert_eq!(ts_actions, rust);
    for id in TabletButtonId::ALL {
        assert!(src.contains(&format!("id: '{}'", id.as_str())), "{id:?}");
    }
    assert_eq!(src.matches("{ id: '").count(), TabletButtonId::ALL.len());
}

#[test]
fn check_wacom_buttons_vectors() {
    let id = |t, b, m, st| tablet_button_identity(t, b, m, st);
    assert_eq!(id("pen", 2, 2, false), Some(TabletButtonId::PenBarrel));
    assert_eq!(id("pen", 5, 32, false), Some(TabletButtonId::PenEraser));
    assert_eq!(id("mouse", 3, 8, false), Some(TabletButtonId::Tablet1));
    assert_eq!(id("pen", 0, 1, false), Some(TabletButtonId::PenTip));
    assert_eq!(id("mouse", 2, 2, false), None);
    assert_eq!(id("mouse", 2, 2, true), Some(TabletButtonId::PenBarrel));

    let factory = TabletButtonMap::default();
    assert_eq!(
        factory.action(id("pen", 2, 2, false)),
        TabletButtonAction::Eraser
    );
    assert_eq!(
        factory.action(id("mouse", 3, 8, false)),
        TabletButtonAction::Undo
    );
    assert_eq!(factory.action(None), TabletButtonAction::Os);
    let changed = TabletButtonMap::from_pairs([
        ("pen-barrel", "undo"),
        ("pen-eraser", "none"),
        ("tablet-1", "redo"),
        ("junk", "pan"),
    ]);
    assert_eq!(
        changed.action(id("pen", 2, 2, false)),
        TabletButtonAction::Undo
    );
    assert_eq!(
        changed.action(id("pen", 5, 32, false)),
        TabletButtonAction::None
    );
    assert_eq!(
        changed.action(id("mouse", 3, 8, false)),
        TabletButtonAction::Redo
    );
    assert_eq!(
        changed.action(Some(TabletButtonId::PenTip)),
        TabletButtonAction::Ink
    );
}
