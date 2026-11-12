//! The part of `apps/hwp/src/shared/ipc.ts` the modules of `src/main` use: the
//! two container formats, the limits of a print job and its page.

/// `HwpFormat`: the two container formats the editor writes. A document is
/// saved back in the format of its file name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwpFormat {
    Hwp,
    Hwpx,
}

impl HwpFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            HwpFormat::Hwp => "hwp",
            HwpFormat::Hwpx => "hwpx",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "hwp" => Some(HwpFormat::Hwp),
            "hwpx" => Some(HwpFormat::Hwpx),
            _ => None,
        }
    }
}

/// Most pages one job takes; past it the job is refused rather than run out of memory.
pub const MAX_PRINT_PAGES: usize = 5000;
/// Most characters of SVG and pictures one job takes.
pub const MAX_PRINT_CHARS: u64 = 600_000_000;

/// `PrintPage`: one page as the editor draws it for print.
#[derive(Debug, Clone, PartialEq)]
pub struct PrintPage {
    pub svg: String,
    pub width: f64,
    pub height: f64,
}
