//! The pieces of `packages/pdf-structure/src/tree/inline.ts` and
//! `tree/derive.ts` the result store reads: `runsText` over `InlineRun`
//! (`tree/types.ts`) and the `TextUnit` type.

/// `InlineRun`: a run of a block's text
#[derive(Debug, Clone, PartialEq)]
pub enum InlineRun {
    /// plain text with its marks (the marks are not read here)
    Text { text: String },
    /// a footnote marker (no text of its own)
    FootnoteRef,
    /// an inline formula
    Math { latex: String },
    /// an intentional line break inside one paragraph
    LineBreak,
}

/// `TextUnit` of `tree/derive.ts`: every translatable unit in reading order
#[derive(Debug, Clone, PartialEq)]
pub struct TextUnit {
    pub key: String,
    pub runs: Vec<InlineRun>,
    /// the block the unit belongs to (the table for cell units)
    pub block_id: String,
    pub page: f64,
    pub page_fingerprint: String,
}

/// `runsText(runs)`: plain text of runs (markers and math omitted, line
/// breaks as `\n`; the TypeScript concatenates `latex` of a math run)
pub fn runs_text(runs: &[InlineRun]) -> String {
    let mut text = String::new();
    for run in runs {
        match run {
            InlineRun::Text { text: run_text } => text.push_str(run_text),
            InlineRun::LineBreak => text.push('\n'),
            InlineRun::Math { latex } => text.push_str(latex),
            InlineRun::FootnoteRef => {}
        }
    }
    text
}
