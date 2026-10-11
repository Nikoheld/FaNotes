/// Pointer that produced a sample. Serialized as the strings `DrawingDocument` already stores.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PointerKind {
    Pen,
    Mouse,
    Touch,
    Section,
    Other(String),
}

impl PointerKind {
    pub fn parse(value: &str) -> Self {
        match value {
            "pen" => Self::Pen,
            "mouse" => Self::Mouse,
            "touch" => Self::Touch,
            "section" => Self::Section,
            other => Self::Other(other.to_string()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Pen => "pen",
            Self::Mouse => "mouse",
            Self::Touch => "touch",
            Self::Section => "section",
            Self::Other(value) => value.as_str(),
        }
    }
}
