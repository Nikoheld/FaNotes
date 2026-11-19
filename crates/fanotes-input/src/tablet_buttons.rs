//! Port of `fanotes/src/lib/tabletButtons.ts` as data. A test parses the TypeScript
//! file and fails if the tables below drift.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TabletButtonId {
    PenTip,
    PenBarrel,
    PenUpper,
    PenEraser,
    Tablet1,
    Tablet2,
}

impl TabletButtonId {
    pub const ALL: [TabletButtonId; 6] = [
        TabletButtonId::PenTip,
        TabletButtonId::PenBarrel,
        TabletButtonId::PenUpper,
        TabletButtonId::PenEraser,
        TabletButtonId::Tablet1,
        TabletButtonId::Tablet2,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PenTip => "pen-tip",
            Self::PenBarrel => "pen-barrel",
            Self::PenUpper => "pen-upper",
            Self::PenEraser => "pen-eraser",
            Self::Tablet1 => "tablet-1",
            Self::Tablet2 => "tablet-2",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|id| id.as_str() == s)
    }
    fn index(self) -> usize {
        Self::ALL.iter().position(|i| *i == self).unwrap()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TabletButtonAction {
    Ink,
    Eraser,
    Undo,
    Redo,
    Pan,
    None,
    Os,
}

impl TabletButtonAction {
    pub const ALL: [TabletButtonAction; 7] = [
        Self::Ink,
        Self::Eraser,
        Self::Undo,
        Self::Redo,
        Self::Pan,
        Self::None,
        Self::Os,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ink => "ink",
            Self::Eraser => "eraser",
            Self::Undo => "undo",
            Self::Redo => "redo",
            Self::Pan => "pan",
            Self::None => "none",
            Self::Os => "os",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|a| a.as_str() == s)
    }
}

/// `DEFAULT_TABLET_BUTTON_ACTIONS`.
pub const DEFAULT_TABLET_BUTTON_ACTIONS: [(TabletButtonId, TabletButtonAction); 6] = [
    (TabletButtonId::PenTip, TabletButtonAction::Ink),
    (TabletButtonId::PenBarrel, TabletButtonAction::Eraser),
    (TabletButtonId::PenUpper, TabletButtonAction::Pan),
    (TabletButtonId::PenEraser, TabletButtonAction::Eraser),
    (TabletButtonId::Tablet1, TabletButtonAction::Undo),
    (TabletButtonId::Tablet2, TabletButtonAction::Redo),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabletButtonMap([TabletButtonAction; 6]);

impl Default for TabletButtonMap {
    fn default() -> Self {
        let mut a = [TabletButtonAction::Os; 6];
        for (id, action) in DEFAULT_TABLET_BUTTON_ACTIONS {
            a[id.index()] = action;
        }
        Self(a)
    }
}

impl TabletButtonMap {
    /// `sanitizeTabletButtonMap`: unknown ids and actions are ignored.
    pub fn from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut map = Self::default();
        for (id, action) in pairs {
            if let (Some(id), Some(action)) =
                (TabletButtonId::parse(id), TabletButtonAction::parse(action))
            {
                map.0[id.index()] = action;
            }
        }
        map
    }
    pub fn action(&self, identity: Option<TabletButtonId>) -> TabletButtonAction {
        match identity {
            None => TabletButtonAction::Os,
            Some(id) => self.0[id.index()],
        }
    }
}

/// `tabletButtonIdentityFromPointer`. `button` is the changed button or -1.
pub fn tablet_button_identity(
    pointer_type: &str,
    button: i32,
    buttons: u32,
    as_stylus: bool,
) -> Option<TabletButtonId> {
    let pen = pointer_type == "pen";
    let stylus = pen || as_stylus;
    if button == 5 || buttons & 32 != 0 {
        return Some(TabletButtonId::PenEraser);
    }
    if button == 3 || buttons & 8 != 0 {
        return Some(TabletButtonId::Tablet1);
    }
    if button == 4 || buttons & 16 != 0 {
        return Some(TabletButtonId::Tablet2);
    }
    if button == 2 || (stylus && buttons & 2 != 0) {
        return stylus.then_some(TabletButtonId::PenBarrel);
    }
    if button == 1 || (stylus && buttons & 4 != 0) {
        return stylus.then_some(TabletButtonId::PenUpper);
    }
    if pen && (button == 0 || button == -1 || buttons & 1 != 0) {
        return Some(TabletButtonId::PenTip);
    }
    None
}
