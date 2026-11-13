//! `apps/shell/src/main/file-index/tokenize.ts`: the pre-tokenizer feeding
//! SQLite FTS5 (unicode61 has no CJK segmentation: a run of Han/kana/hangul is
//! one token, so a two-character word never matches inside a longer run).
//! CJK runs become character bigrams while Latin/digit runs stay whole words;
//! a parallel unigram stream serves one-character CJK queries.
//!
//! A character offset (`TokenExpr.at`, `termChars`) counts code points, as the
//! TypeScript's `for...of` does.

use jscompat::{JsMap, js_regex, trim};
use serde::Serialize;

pub use crate::shell::text_marks::fold_text;
use crate::shell::text_marks::is_word_char;

/// `Tokenized`
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Tokenized {
    /// bigram stream: CJK runs as overlapping pairs, other runs as whole words
    pub bi: Vec<String>,
    /// unigram stream: CJK runs as single characters, other runs as whole words
    pub uni: Vec<String>,
}

/// `CJK_RANGES`
const CJK_RANGES: [(u32, u32); 14] = [
    (0x2e80, 0x2fdf),   // CJK radicals
    (0x3005, 0x3007),   // iteration marks
    (0x3040, 0x30ff),   // hiragana, katakana
    (0x3100, 0x312f),   // bopomofo
    (0x3130, 0x318f),   // hangul compatibility jamo
    (0x31a0, 0x31ff),   // bopomofo ext, katakana ext
    (0x3400, 0x4dbf),   // CJK ext A
    (0x4e00, 0x9fff),   // CJK unified
    (0xa960, 0xa97f),   // hangul jamo ext A
    (0xac00, 0xd7ff),   // hangul syllables, jamo ext B
    (0xf900, 0xfaff),   // CJK compat ideographs
    (0xff66, 0xff9f),   // halfwidth katakana
    (0x1100, 0x11ff),   // hangul jamo
    (0x20000, 0x323af), // CJK ext B to H
];

pub fn is_cjk(cp: u32) -> bool {
    CJK_RANGES.iter().any(|&(lo, hi)| (lo..=hi).contains(&cp))
}

/// `RunKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunKind {
    Cjk,
    Word,
}

/// `Run`
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub kind: RunKind,
    /// code points as strings
    pub chars: Vec<String>,
}

pub(crate) fn split_runs(text: &str) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    // `current` is the last run of `runs` while it is set
    let mut current = false;
    for ch in fold_text(text).chars() {
        let kind = if is_cjk(u32::from(ch)) {
            Some(RunKind::Cjk)
        } else if is_word_char(ch) {
            Some(RunKind::Word)
        } else {
            None
        };
        let Some(kind) = kind else {
            current = false;
            continue;
        };
        match runs.last_mut() {
            Some(run) if current && run.kind == kind => run.chars.push(ch.to_string()),
            _ => {
                runs.push(Run {
                    kind,
                    chars: vec![ch.to_string()],
                });
                current = true;
            }
        }
    }
    runs
}

pub fn tokenize(text: &str) -> Tokenized {
    let mut bi: Vec<String> = Vec::new();
    let mut uni: Vec<String> = Vec::new();
    for run in split_runs(text) {
        if run.kind == RunKind::Word {
            let word = run.chars.concat();
            bi.push(word.clone());
            uni.push(word);
            continue;
        }
        uni.extend(run.chars.iter().cloned());
        if run.chars.len() == 1 {
            bi.push(run.chars[0].clone());
        } else {
            for i in 0..run.chars.len().saturating_sub(1) {
                bi.push(format!("{}{}", run.chars[i], run.chars[i + 1]));
            }
        }
    }
    Tokenized { bi, uni }
}

/// the space-joined form FTS5's unicode61 tokenizer re-splits one-to-one
pub fn to_index_text(tokens: &[String]) -> String {
    tokens.join(" ")
}

/// `QueryTerm`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueryTerm {
    /// the user's text for this term, folded, used for snippet matching
    pub text: String,
    /// true when every CJK run has two or more characters, so the bigram columns answer it
    #[serde(rename = "bigramSafe")]
    pub bigram_safe: bool,
    pub tokens: Tokenized,
    /// the term ends in a Latin/digit word the user may still be typing
    pub prefix: bool,
}

/// what `parseQuery` answers
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct ParsedQuery {
    pub include: Vec<QueryTerm>,
    pub exclude: Vec<QueryTerm>,
}

/// Whitespace splits terms (AND); "quoted text" keeps one phrase; a leading
/// `-` excludes the term. Column filters and other operators come later.
pub fn parse_query(input: &str) -> ParsedQuery {
    let mut include: Vec<QueryTerm> = Vec::new();
    let mut exclude: Vec<QueryTerm> = Vec::new();
    let re = js_regex!(r#"(-)?(?:"([^"]*)"|(\S+))"#, "g");
    for m in re.find_iter(input) {
        let raw = trim(m.get(2).or(m.get(3)).unwrap_or(""));
        if raw.is_empty() {
            continue;
        }
        let Some(term) = make_term(raw, m.get(2).is_none()) else {
            continue;
        };
        // `m[1]` is "-" or undefined
        if m.get(1).is_some() {
            exclude.push(term);
        } else {
            include.push(term);
        }
    }
    ParsedQuery { include, exclude }
}

fn make_term(raw: &str, allow_prefix: bool) -> Option<QueryTerm> {
    let runs = split_runs(raw);
    let last = runs.last()?;
    let tokens = tokenize(raw);
    let bigram_safe = runs
        .iter()
        .all(|r| r.kind == RunKind::Word || r.chars.len() >= 2);
    let prefix = allow_prefix && last.kind == RunKind::Word && last.chars.len() >= 2;
    Some(QueryTerm {
        text: fold_text(raw),
        bigram_safe,
        tokens,
        prefix,
    })
}

const BI_COLUMNS: &str = "{name path body}";
const UNI_COLUMNS: &str = "{name_u path_u body_u}";

fn phrase(tokens: &[String], prefix: bool) -> String {
    let quoted = format!(
        "\"{}\"",
        tokens
            .iter()
            .map(|t| t.replace('"', "\"\""))
            .collect::<Vec<_>>()
            .join(" ")
    );
    if prefix {
        format!("{quoted} *")
    } else {
        quoted
    }
}

pub fn term_expr(term: &QueryTerm) -> String {
    if term.bigram_safe {
        format!("{BI_COLUMNS}: {}", phrase(&term.tokens.bi, term.prefix))
    } else {
        format!("{UNI_COLUMNS}: {}", phrase(&term.tokens.uni, term.prefix))
    }
}

/// `join` of `toMatchExpression`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchJoin {
    And,
    Or,
}

impl MatchJoin {
    fn as_str(self) -> &'static str {
        match self {
            MatchJoin::And => "AND",
            MatchJoin::Or => "OR",
        }
    }
}

/// FTS5 MATCH expression for the parsed query, or `None` when nothing is searchable
pub fn to_match_expression(parsed: &ParsedQuery, join: MatchJoin) -> Option<String> {
    if parsed.include.is_empty() {
        return None;
    }
    let mut expr = parsed
        .include
        .iter()
        .map(|t| format!("({})", term_expr(t)))
        .collect::<Vec<_>>()
        .join(&format!(" {} ", join.as_str()));
    for t in &parsed.exclude {
        expr = format!("({expr}) NOT ({})", term_expr(t));
    }
    Some(expr)
}

/// `TokenExpr`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TokenExpr {
    /// folded token text, the needle the highlighter lights up
    pub text: String,
    /// FTS5 expression matching this token alone
    pub expr: String,
    /// character offsets of the term this token covers, across every place it occurs
    pub at: Vec<usize>,
}

/// One expression per distinct token of a term, with the characters each one
/// covers: coverage is measured in characters because a CJK phrase yields
/// bigrams straddling word boundaries that no file holds, and they must not
/// outvote the words that do match.
pub fn token_exprs(term: &QueryTerm) -> Vec<TokenExpr> {
    let cols = if term.bigram_safe {
        BI_COLUMNS
    } else {
        UNI_COLUMNS
    };
    let mut out: JsMap<TokenExpr> = JsMap::new();
    let mut add = |tok: String, at: Vec<usize>| match out.get_mut(&tok) {
        Some(cur) => cur.at.extend(at),
        None => {
            let text = tok.clone();
            out.set(
                tok,
                TokenExpr {
                    text,
                    expr: String::new(),
                    at,
                },
            );
        }
    };
    let mut pos = 0usize;
    let mut last = String::new();
    for run in split_runs(&term.text) {
        let n = run.chars.len();
        if run.kind == RunKind::Word {
            last = run.chars.concat();
            add(last.clone(), range(pos, n));
        } else if !term.bigram_safe || n == 1 {
            for (i, c) in run.chars.iter().enumerate() {
                add(c.clone(), vec![pos + i]);
            }
        } else {
            for i in 0..n - 1 {
                add(
                    format!("{}{}", run.chars[i], run.chars[i + 1]),
                    vec![pos + i, pos + i + 1],
                );
            }
        }
        pos += n;
    }
    let prefix = term.prefix;
    for t in out.values_mut() {
        t.expr = format!(
            "{cols}: {}",
            phrase(std::slice::from_ref(&t.text), prefix && t.text == last)
        );
    }
    out.values().cloned().collect()
}

fn range(start: usize, n: usize) -> Vec<usize> {
    (0..n).map(|i| start + i).collect()
}

/// code points of the term that tokens can cover, the unit `TokenExpr.at` indexes
pub fn term_chars(term: &QueryTerm) -> usize {
    split_runs(&term.text).iter().map(|r| r.chars.len()).sum()
}
