//! `gateway/formula-reads.ts` of xlsx-gateway with `gateway/future-functions.ts`
//! (`XLFN_FUNCTIONS`, `XLWS_FUNCTIONS`) and the `RangeBounds` of
//! `domain/cell-address.ts`: which cells a formula reads, and which formula
//! cells therefore show a value derived from a cell withheld from a model.
//!
//! A JavaScript number is an `f64` here, as in the TypeScript: a mark may name
//! any non-negative integer a JSON number holds.
//!
//! A sticky (`y`) regular expression of the TypeScript is an `^` pattern run
//! over the text from the index on: the same match, found without a search
//! ahead of the index.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::LazyLock;

use jscompat::{JsMatch, RegexLimit, js_regex, to_number, trim, try_js_regex};

use crate::xlsx::letters_index;

/// Excel's grid limits: a whole-column or whole-row reference runs to them.
pub const MAX_ROW: f64 = 1_048_575.0;
pub const MAX_COLUMN: f64 = 16_383.0;

/// `RangeBounds` of cell-address.ts, zero-based and inclusive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RangeBounds {
    pub start_row: f64,
    pub start_column: f64,
    pub end_row: f64,
    pub end_column: f64,
}

/// One rectangle a formula reads; `sheet` is the qualifier as written, `None` for the formula's own sheet.
#[derive(Debug, Clone)]
pub struct FormulaRead {
    pub bounds: RangeBounds,
    pub sheet: Option<String>,
}

#[derive(Debug)]
pub struct FormulaReads {
    pub reads: Vec<FormulaRead>,
    /// identifiers that are neither functions nor references: defined names, lowercased
    pub names: Vec<String>,
    /// the cells read cannot be listed (the TypeScript says why; nothing here reads the reason)
    pub unknown: bool,
}

/// `CLASSIC_FUNCTIONS.split(' ')`
const CLASSIC_FUNCTIONS: &[&str] = &[
    "ABS",
    "ACOS",
    "ACOSH",
    "ASIN",
    "ASINH",
    "ATAN",
    "ATAN2",
    "ATANH",
    "CEILING",
    "COMBIN",
    "COS",
    "COSH",
    "DEGREES",
    "EVEN",
    "EXP",
    "FACT",
    "FACTDOUBLE",
    "FLOOR",
    "GCD",
    "INT",
    "ISO.CEILING",
    "LCM",
    "LN",
    "LOG",
    "LOG10",
    "MDETERM",
    "MINVERSE",
    "MMULT",
    "MOD",
    "MROUND",
    "MULTINOMIAL",
    "ODD",
    "PI",
    "POWER",
    "PRODUCT",
    "QUOTIENT",
    "RADIANS",
    "RAND",
    "RANDBETWEEN",
    "ROMAN",
    "ROUND",
    "ROUNDDOWN",
    "ROUNDUP",
    "SERIESSUM",
    "SIGN",
    "SIN",
    "SINH",
    "SQRT",
    "SQRTPI",
    "SUBTOTAL",
    "SUM",
    "SUMIF",
    "SUMIFS",
    "SUMPRODUCT",
    "SUMSQ",
    "SUMX2MY2",
    "SUMX2PY2",
    "SUMXMY2",
    "TAN",
    "TANH",
    "TRUNC",
    "AVEDEV",
    "AVERAGE",
    "AVERAGEA",
    "AVERAGEIF",
    "AVERAGEIFS",
    "BETADIST",
    "BETAINV",
    "BINOMDIST",
    "CHIDIST",
    "CHIINV",
    "CHITEST",
    "CONFIDENCE",
    "CORREL",
    "COUNT",
    "COUNTA",
    "COUNTBLANK",
    "COUNTIF",
    "COUNTIFS",
    "COVAR",
    "CRITBINOM",
    "DEVSQ",
    "EXPONDIST",
    "FDIST",
    "FINV",
    "FISHER",
    "FISHERINV",
    "FORECAST",
    "FREQUENCY",
    "FTEST",
    "GAMMADIST",
    "GAMMAINV",
    "GAMMALN",
    "GEOMEAN",
    "GROWTH",
    "HARMEAN",
    "HYPGEOMDIST",
    "INTERCEPT",
    "KURT",
    "LARGE",
    "LINEST",
    "LOGEST",
    "LOGINV",
    "LOGNORMDIST",
    "MAX",
    "MAXA",
    "MEDIAN",
    "MIN",
    "MINA",
    "MODE",
    "NEGBINOMDIST",
    "NORMDIST",
    "NORMINV",
    "NORMSDIST",
    "NORMSINV",
    "PEARSON",
    "PERCENTILE",
    "PERCENTRANK",
    "PERMUT",
    "POISSON",
    "PROB",
    "QUARTILE",
    "RANK",
    "RSQ",
    "SKEW",
    "SLOPE",
    "SMALL",
    "STANDARDIZE",
    "STDEV",
    "STDEVA",
    "STDEVP",
    "STDEVPA",
    "STEYX",
    "TDIST",
    "TINV",
    "TREND",
    "TRIMMEAN",
    "TTEST",
    "VAR",
    "VARA",
    "VARP",
    "VARPA",
    "WEIBULL",
    "ZTEST",
    "ASC",
    "BAHTTEXT",
    "CHAR",
    "CLEAN",
    "CODE",
    "CONCATENATE",
    "DBCS",
    "DOLLAR",
    "EXACT",
    "FIND",
    "FINDB",
    "FIXED",
    "JIS",
    "LEFT",
    "LEFTB",
    "LEN",
    "LENB",
    "LOWER",
    "MID",
    "MIDB",
    "PHONETIC",
    "PROPER",
    "REPLACE",
    "REPLACEB",
    "REPT",
    "RIGHT",
    "RIGHTB",
    "SEARCH",
    "SEARCHB",
    "SUBSTITUTE",
    "T",
    "TEXT",
    "TRIM",
    "UPPER",
    "USDOLLAR",
    "VALUE",
    "DATE",
    "DATEDIF",
    "DATEVALUE",
    "DAY",
    "DAYS360",
    "EDATE",
    "EOMONTH",
    "HOUR",
    "MINUTE",
    "MONTH",
    "NETWORKDAYS",
    "NOW",
    "SECOND",
    "TIME",
    "TIMEVALUE",
    "TODAY",
    "WEEKDAY",
    "WEEKNUM",
    "WORKDAY",
    "YEAR",
    "YEARFRAC",
    "AND",
    "FALSE",
    "IF",
    "IFERROR",
    "NOT",
    "OR",
    "TRUE",
    "ADDRESS",
    "AREAS",
    "CHOOSE",
    "COLUMN",
    "COLUMNS",
    "HLOOKUP",
    "HYPERLINK",
    "INDEX",
    "LOOKUP",
    "MATCH",
    "ROW",
    "ROWS",
    "RTD",
    "TRANSPOSE",
    "VLOOKUP",
    "ERROR.TYPE",
    "INFO",
    "ISBLANK",
    "ISERR",
    "ISERROR",
    "ISEVEN",
    "ISLOGICAL",
    "ISNA",
    "ISNONTEXT",
    "ISNUMBER",
    "ISODD",
    "ISREF",
    "ISTEXT",
    "N",
    "NA",
    "TYPE",
    "DAVERAGE",
    "DCOUNT",
    "DCOUNTA",
    "DGET",
    "DMAX",
    "DMIN",
    "DPRODUCT",
    "DSTDEV",
    "DSTDEVP",
    "DSUM",
    "DVAR",
    "DVARP",
    "ACCRINT",
    "ACCRINTM",
    "AMORDEGRC",
    "AMORLINC",
    "COUPDAYBS",
    "COUPDAYS",
    "COUPDAYSNC",
    "COUPNCD",
    "COUPNUM",
    "COUPPCD",
    "CUMIPMT",
    "CUMPRINC",
    "DB",
    "DDB",
    "DISC",
    "DOLLARDE",
    "DOLLARFR",
    "DURATION",
    "EFFECT",
    "FV",
    "FVSCHEDULE",
    "INTRATE",
    "IPMT",
    "IRR",
    "ISPMT",
    "MDURATION",
    "MIRR",
    "NOMINAL",
    "NPER",
    "NPV",
    "ODDFPRICE",
    "ODDFYIELD",
    "ODDLPRICE",
    "ODDLYIELD",
    "PMT",
    "PPMT",
    "PRICE",
    "PRICEDISC",
    "PRICEMAT",
    "PV",
    "RATE",
    "RECEIVED",
    "SLN",
    "SYD",
    "TBILLEQ",
    "TBILLPRICE",
    "TBILLYIELD",
    "VDB",
    "XIRR",
    "XNPV",
    "YIELD",
    "YIELDDISC",
    "YIELDMAT",
    "BESSELI",
    "BESSELJ",
    "BESSELK",
    "BESSELY",
    "BIN2DEC",
    "BIN2HEX",
    "BIN2OCT",
    "COMPLEX",
    "CONVERT",
    "DEC2BIN",
    "DEC2HEX",
    "DEC2OCT",
    "DELTA",
    "ERF",
    "ERFC",
    "GESTEP",
    "HEX2BIN",
    "HEX2DEC",
    "HEX2OCT",
    "IMABS",
    "IMAGINARY",
    "IMARGUMENT",
    "IMCONJUGATE",
    "IMCOS",
    "IMDIV",
    "IMEXP",
    "IMLN",
    "IMLOG10",
    "IMLOG2",
    "IMPOWER",
    "IMPRODUCT",
    "IMREAL",
    "IMSIN",
    "IMSQRT",
    "IMSUB",
    "IMSUM",
    "OCT2BIN",
    "OCT2DEC",
    "OCT2HEX",
    "CUBEKPIMEMBER",
    "CUBEMEMBER",
    "CUBEMEMBERPROPERTY",
    "CUBERANKEDMEMBER",
    "CUBESET",
    "CUBESETCOUNT",
    "CUBEVALUE",
    "ARRAYTOTEXT",
    "VALUETOTEXT",
    "FIELDVALUE",
    "GROUPBY",
    "PIVOTBY",
    "PERCENTOF",
    "TRIMRANGE",
    "REGEXTEST",
    "REGEXEXTRACT",
    "REGEXREPLACE",
    "TRANSLATE",
    "DETECTLANGUAGE",
];

/// `XLFN_FUNCTIONS` of future-functions.ts
const XLFN_FUNCTIONS: &[&str] = &[
    "AGGREGATE",
    "BETA.DIST",
    "BETA.INV",
    "BINOM.DIST",
    "BINOM.INV",
    "CEILING.PRECISE",
    "CHISQ.DIST",
    "CHISQ.DIST.RT",
    "CHISQ.INV",
    "CHISQ.INV.RT",
    "CHISQ.TEST",
    "CONFIDENCE.NORM",
    "CONFIDENCE.T",
    "COVARIANCE.P",
    "COVARIANCE.S",
    "ERF.PRECISE",
    "ERFC.PRECISE",
    "EXPON.DIST",
    "F.DIST",
    "F.DIST.RT",
    "F.INV",
    "F.INV.RT",
    "F.TEST",
    "FLOOR.PRECISE",
    "GAMMA.DIST",
    "GAMMA.INV",
    "GAMMALN.PRECISE",
    "HYPGEOM.DIST",
    "LOGNORM.DIST",
    "LOGNORM.INV",
    "MODE.MULT",
    "MODE.SNGL",
    "NEGBINOM.DIST",
    "NETWORKDAYS.INTL",
    "NORM.DIST",
    "NORM.INV",
    "NORM.S.DIST",
    "NORM.S.INV",
    "PERCENTILE.EXC",
    "PERCENTILE.INC",
    "PERCENTRANK.EXC",
    "PERCENTRANK.INC",
    "POISSON.DIST",
    "QUARTILE.EXC",
    "QUARTILE.INC",
    "RANK.AVG",
    "RANK.EQ",
    "STDEV.P",
    "STDEV.S",
    "T.DIST",
    "T.DIST.2T",
    "T.DIST.RT",
    "T.INV",
    "T.INV.2T",
    "T.TEST",
    "VAR.P",
    "VAR.S",
    "WEIBULL.DIST",
    "WORKDAY.INTL",
    "Z.TEST",
    "ACOT",
    "ACOTH",
    "ARABIC",
    "BASE",
    "BINOM.DIST.RANGE",
    "BITAND",
    "BITLSHIFT",
    "BITOR",
    "BITRSHIFT",
    "BITXOR",
    "CEILING.MATH",
    "COMBINA",
    "COT",
    "COTH",
    "CSC",
    "CSCH",
    "DAYS",
    "DECIMAL",
    "ENCODEURL",
    "FILTERXML",
    "FLOOR.MATH",
    "FORMULATEXT",
    "GAMMA",
    "GAUSS",
    "IFNA",
    "IMCOSH",
    "IMCOT",
    "IMCSC",
    "IMCSCH",
    "IMSEC",
    "IMSECH",
    "IMSINH",
    "IMTAN",
    "ISFORMULA",
    "ISOWEEKNUM",
    "MUNIT",
    "NUMBERVALUE",
    "PDURATION",
    "PERMUTATIONA",
    "PHI",
    "RRI",
    "SEC",
    "SECH",
    "SHEET",
    "SHEETS",
    "SKEW.P",
    "UNICHAR",
    "UNICODE",
    "WEBSERVICE",
    "XOR",
    "CONCAT",
    "FORECAST.ETS",
    "FORECAST.ETS.CONFINT",
    "FORECAST.ETS.SEASONALITY",
    "FORECAST.ETS.STAT",
    "FORECAST.LINEAR",
    "IFS",
    "MAXIFS",
    "MINIFS",
    "SWITCH",
    "TEXTJOIN",
    "BYCOL",
    "BYROW",
    "CHOOSECOLS",
    "CHOOSEROWS",
    "DROP",
    "EXPAND",
    "HSTACK",
    "IMAGE",
    "ISOMITTED",
    "LAMBDA",
    "LET",
    "MAKEARRAY",
    "MAP",
    "RANDARRAY",
    "REDUCE",
    "SCAN",
    "SEQUENCE",
    "SORTBY",
    "STOCKHISTORY",
    "TAKE",
    "TEXTAFTER",
    "TEXTBEFORE",
    "TEXTSPLIT",
    "TOCOL",
    "TOROW",
    "UNIQUE",
    "VSTACK",
    "WRAPCOLS",
    "WRAPROWS",
    "XLOOKUP",
    "XMATCH",
    "SINGLE",
    "ANCHORARRAY",
];

/// `XLWS_FUNCTIONS` of future-functions.ts
const XLWS_FUNCTIONS: &[&str] = &["FILTER", "SORT"];

const OPAQUE_FUNCTIONS: &[&str] = &["INDIRECT", "OFFSET", "GETPIVOTDATA", "CELL", "ANCHORARRAY"];

static KNOWN_FUNCTIONS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    CLASSIC_FUNCTIONS
        .iter()
        .chain(XLFN_FUNCTIONS)
        .chain(XLWS_FUNCTIONS)
        .copied()
        .filter(|name| !OPAQUE_FUNCTIONS.contains(name))
        .collect()
});

/// `/\s+/y` at the start of `rest`: the length of the match. A first byte that
/// is ASCII and no white space cannot begin one.
fn whitespace_length(rest: &str) -> Option<usize> {
    let first = *rest.as_bytes().first()?;
    if first < 0x80 && !matches!(first, b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ') {
        return None;
    }
    js_regex!(r"^\s+")
        .exec(rest)
        .map(|found| found.as_str().len())
}

/// `/"(?:[^"]|"")*"/y`
fn string_literal(rest: &str) -> Result<Option<JsMatch<'_>>, RegexLimit> {
    if !rest.starts_with('"') {
        return Ok(None);
    }
    try_js_regex!(r#"^"(?:[^"]|"")*""#).try_exec(rest)
}

/// `/'((?:[^']|'')*)'!/y`
fn quoted_qualifier(rest: &str) -> Result<Option<JsMatch<'_>>, RegexLimit> {
    if !rest.starts_with('\'') {
        return Ok(None);
    }
    try_js_regex!(r"^'((?:[^']|'')*)'!").try_exec(rest)
}

/// `ERROR_LITERAL` with `/y`: the length of the match.
fn error_literal(rest: &str) -> Option<usize> {
    if !rest.starts_with('#') {
        return None;
    }
    js_regex!(
        r"^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!|PYTHON!|EXTERNAL!)"
    )
    .exec(rest)
    .map(|found| found.as_str().len())
}

/// `REFERENCE` with `/uy`: `Sheet!` (optional), then a cell, a cell range,
/// whole columns or whole rows. The lookahead keeps a longer word (`LOG10(`,
/// `A1B`, `Rate2024.q`) or a spill `#` from being cut into a reference.
fn reference_at(rest: &str) -> Option<JsMatch<'_>> {
    js_regex!(
        r"^(?:([\p{L}_][\p{L}\p{N}_.]*)!)?(\$?[A-Za-z]{1,3}\$?[0-9]{1,7}(?::\$?[A-Za-z]{1,3}\$?[0-9]{1,7})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?[0-9]{1,7}:\$?[0-9]{1,7})(?![\p{L}\p{N}_.(\\?!$#])",
        "u"
    )
    .exec(rest)
}

/// `NUMBER` with `/y`: the length of the match.
fn number_length(rest: &str) -> Option<usize> {
    js_regex!(r"^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
        .exec(rest)
        .map(|found| found.as_str().len())
}

/// `IDENTIFIER` with `/uy`
fn identifier_at(rest: &str) -> Option<JsMatch<'_>> {
    js_regex!(r"^[\p{L}_\\][\p{L}\p{N}_.\\?]*", "u").exec(rest)
}

/// `CALL_OPEN` with `/y`
fn call_opens(rest: &str) -> bool {
    js_regex!(r"^\s*\(").test(rest)
}

/// `STORAGE_MARKER`: the length of the markers Excel puts before later
/// functions (`_xlfn.`, `_xlfn._xlws.`) at the start of a word.
fn storage_marker_length(word: &str) -> Result<Option<usize>, RegexLimit> {
    Ok(try_js_regex!(r"^(?:_xlfn\.|_xlws\.)+", "i")
        .try_exec(word)?
        .map(|found| found.as_str().len()))
}

/// The rectangle of a reference token (`$B$2`, `A1:C9`, `A:C`, `3:7`); `None` when it is off the grid.
fn bounds_of(token: &str) -> Option<RangeBounds> {
    let token = token.replace('$', "");
    let mut parts = token.split(':');
    let first = parts.next().unwrap_or_default();
    let second = parts.next().unwrap_or(first);
    let columns = js_regex!(r"^[A-Za-z]+$");
    let rows = js_regex!(r"^[0-9]+$");
    let bounds = if columns.test(first) && columns.test(second) {
        RangeBounds {
            start_row: 0.0,
            end_row: MAX_ROW,
            start_column: letters_index(first).min(letters_index(second)),
            end_column: letters_index(first).max(letters_index(second)),
        }
    } else if rows.test(first) && rows.test(second) {
        RangeBounds {
            start_row: to_number(first).min(to_number(second)) - 1.0,
            end_row: to_number(first).max(to_number(second)) - 1.0,
            start_column: 0.0,
            end_column: MAX_COLUMN,
        }
    } else {
        let cell = js_regex!(r"^([A-Za-z]+)([0-9]+)$");
        let (a, b) = (cell.exec(first)?, cell.exec(second)?);
        let letters = |found: &JsMatch<'_>| letters_index(found.get(1).unwrap_or_default());
        let digits = |found: &JsMatch<'_>| to_number(found.get(2).unwrap_or_default());
        RangeBounds {
            start_row: digits(&a).min(digits(&b)) - 1.0,
            end_row: digits(&a).max(digits(&b)) - 1.0,
            start_column: letters(&a).min(letters(&b)),
            end_column: letters(&a).max(letters(&b)),
        }
    };
    if bounds.start_row < 0.0 || bounds.end_row > MAX_ROW || bounds.end_column > MAX_COLUMN {
        return None;
    }
    Some(bounds)
}

/// List what a formula reads. `formula` is the text with or without its
/// leading `=`, as a file or the grid holds it (A1 notation, `,` separators).
///
/// The scan is total: every character belongs to a token it recognises, or the
/// result says `unknown`. It never guesses at a part it skipped. A search that
/// passes the bound of the regular expression engine is the error.
pub fn formula_reads(formula: &str) -> Result<FormulaReads, RegexLimit> {
    let text = formula.strip_prefix('=').unwrap_or(formula);
    let mut reads: Vec<FormulaRead> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    macro_rules! unknown {
        () => {
            return Ok(FormulaReads {
                reads,
                names,
                unknown: true,
            })
        };
    }
    if trim(text).is_empty() {
        unknown!();
    }

    let mut index = 0;
    // a quoted `'Sheet name'!` waiting for the reference it qualifies
    let mut qualifier: Option<String> = None;
    while index < text.len() {
        let rest = &text[index..];
        if qualifier.is_none()
            && let Some(length) = whitespace_length(rest)
        {
            index += length;
            continue;
        }
        if qualifier.is_none() {
            let literal = match string_literal(rest)? {
                Some(found) => Some(found.as_str().len()),
                None => error_literal(rest),
            };
            if let Some(length) = literal {
                index += length;
                continue;
            }
            if let Some(quoted) = quoted_qualifier(rest)? {
                let sheet = quoted.get(1).unwrap_or_default().replace("''", "'");
                if sheet.contains('[') {
                    unknown!();
                }
                if sheet.contains(':') {
                    unknown!();
                }
                qualifier = Some(sheet);
                index += quoted.as_str().len();
                continue;
            }
        }
        if let Some(reference) = reference_at(rest)
            && !(qualifier.is_some() && reference.get(1).is_some())
        {
            let Some(bounds) = bounds_of(reference.get(2).unwrap_or_default()) else {
                // A token off the grid (`ZZZ1`) is a name to Excel, and one nobody defined here.
                unknown!();
            };
            reads.push(FormulaRead {
                bounds,
                sheet: qualifier
                    .take()
                    .or_else(|| reference.get(1).map(str::to_owned)),
            });
            index += reference.as_str().len();
            continue;
        }
        if qualifier.is_some() {
            // `'Sheet'!#REF!` reads nothing; `'Sheet'!Name` is a sheet-scoped name.
            if let Some(length) = error_literal(rest) {
                qualifier = None;
                index += length;
                continue;
            }
            let Some(scoped) = identifier_at(rest) else {
                unknown!();
            };
            names.push(scoped.as_str().to_lowercase());
            qualifier = None;
            index += scoped.as_str().len();
            continue;
        }
        if let Some(length) = number_length(rest) {
            index += length;
            continue;
        }
        if let Some(found) = identifier_at(rest) {
            let word = found.as_str();
            index += word.len();
            if text.as_bytes().get(index) == Some(&b'!') {
                // `Sheet!Name`, or `Sheet!#REF!`: the reference form was tried above.
                let after = &text[index + 1..];
                let broken = error_literal(after);
                let scoped = if broken.is_some() {
                    None
                } else {
                    identifier_at(after)
                };
                if let Some(length) = broken {
                    index += 1 + length;
                } else if let Some(scoped) = scoped {
                    names.push(scoped.as_str().to_lowercase());
                    index += 1 + scoped.as_str().len();
                } else {
                    unknown!();
                }
                continue;
            }
            let call = call_opens(&text[index..]);
            let bare = match storage_marker_length(word)? {
                Some(length) => &word[length..],
                None => word,
            };
            let name = bare.to_uppercase();
            if call {
                if !KNOWN_FUNCTIONS.contains(name.as_str()) {
                    unknown!();
                }
                continue;
            }
            if name != "TRUE" && name != "FALSE" {
                names.push(word.to_lowercase());
            }
            continue;
        }
        let character = rest.chars().next().unwrap_or_default();
        if matches!(
            character,
            '+' | '-'
                | '*'
                | '/'
                | '^'
                | '&'
                | '='
                | '<'
                | '>'
                | '%'
                | ','
                | ';'
                | '('
                | ')'
                | '{'
                | '}'
                | '@'
        ) {
            index += character.len_utf8();
            continue;
        }
        // `:` (a range built from computed ends), `[` (a table or another
        // workbook), `#` (a spill range) and anything else
        unknown!();
    }
    if qualifier.is_some() {
        unknown!();
    }
    Ok(FormulaReads {
        reads,
        names,
        unknown: false,
    })
}

/// A defined name and the formula it stands for (its `refers to`, with or without `=`).
#[derive(Debug, Clone)]
pub struct NameDefinition {
    pub name: String,
    pub formula: String,
}

/// A formula and the cells it fills: its own cell, or the whole range an array formula fills.
#[derive(Debug, Clone)]
pub struct FormulaCell {
    pub area: RangeBounds,
    pub formula: String,
}

/// One sheet as a reader knows it, in the coordinates the reader asks about cells in.
#[derive(Debug)]
pub struct ReadsSheet {
    /// the name formulas qualify references with; compared without case, as Excel does
    pub name: String,
    /// the rectangles a mark withholds
    pub marks: Vec<RangeBounds>,
    /// Cells whose formulas the reader could not list. They are withheld, and
    /// so is everything that reads them.
    pub unknown: Vec<RangeBounds>,
    pub formulas: Vec<FormulaCell>,
}

#[derive(Debug)]
pub struct DerivedCells {
    /// per sheet, in the order given: the cells to withhold beyond the marks
    pub by_sheet: Vec<Vec<RangeBounds>>,
    /// the workbook was too entangled to trace within the budget: every formula is withheld
    pub over_budget: bool,
}

/// How many "does this reference cover that cell" checks one trace may make.
/// Past it every formula of the workbook is withheld.
pub const DERIVED_CHECK_BUDGET: f64 = 20_000_000.0;

const BUCKET_ROWS: f64 = 256.0;
/// A reference spanning more buckets than this is kept in one list per sheet
/// and compared against every traced cell (`A:A`, a running total's range).
const MAX_BUCKETS_PER_READ: f64 = 16.0;

fn intersects(a: &RangeBounds, b: &RangeBounds) -> bool {
    a.start_row <= b.end_row
        && a.end_row >= b.start_row
        && a.start_column <= b.end_column
        && a.end_column >= b.start_column
}

/// A rectangle read by the formula cell `owner`.
struct PlacedRead {
    bounds: RangeBounds,
    owner: usize,
}

/// A place a value comes from: a withheld area, or a formula cell found to depend on one.
#[derive(Clone, Copy)]
struct Source {
    sheet: usize,
    area: RangeBounds,
}

/// `Map<number, PlacedRead[]>`: the lists in the order their buckets were first used.
#[derive(Default)]
struct Buckets {
    at: HashMap<u64, usize>,
    lists: Vec<Vec<usize>>,
}

impl Buckets {
    fn list(&self, bucket: f64) -> Option<&Vec<usize>> {
        self.at.get(&bucket.to_bits()).map(|at| &self.lists[*at])
    }

    fn push(&mut self, bucket: f64, read: usize) {
        let next = self.lists.len();
        let at = *self.at.entry(bucket.to_bits()).or_insert(next);
        if at == next {
            self.lists.push(Vec::new());
        }
        self.lists[at].push(read);
    }
}

/// `readsOf` and `readsOfName` of `cellsDerivedFromWithheld`, with what they remember.
struct Reading {
    parsed: HashMap<String, Rc<FormulaReads>>,
    definitions: HashMap<String, Vec<String>>,
    /// what a name reads, every definition of it at any scope together; `None` when it cannot be listed
    name_reads: HashMap<String, Option<Rc<Vec<FormulaRead>>>>,
}

impl Reading {
    fn reads_of(&mut self, formula: &str) -> Result<Rc<FormulaReads>, RegexLimit> {
        if let Some(reads) = self.parsed.get(formula) {
            return Ok(Rc::clone(reads));
        }
        let reads = Rc::new(formula_reads(formula)?);
        self.parsed.insert(formula.to_owned(), Rc::clone(&reads));
        Ok(reads)
    }

    fn reads_of_name(
        &mut self,
        name: &str,
        open: &HashSet<String>,
    ) -> Result<Option<Rc<Vec<FormulaRead>>>, RegexLimit> {
        if let Some(known) = self.name_reads.get(name) {
            return Ok(known.clone());
        }
        // undefined here, or a name defined through itself
        let Some(bodies) = self.definitions.get(name).cloned() else {
            return Ok(None);
        };
        if open.contains(name) {
            return Ok(None);
        }
        let mut inside = open.clone();
        inside.insert(name.to_owned());
        let mut all: Vec<FormulaRead> = Vec::new();
        let mut listed = true;
        for body in &bodies {
            let reads = self.reads_of(body)?;
            // A name is used from any sheet, so a reference without one has no fixed place.
            if reads.unknown || reads.reads.iter().any(|read| read.sheet.is_none()) {
                listed = false;
                break;
            }
            all.extend(reads.reads.iter().cloned());
            for inner in &reads.names {
                match self.reads_of_name(inner, &inside)? {
                    None => listed = false,
                    Some(more) => all.extend(more.iter().cloned()),
                }
            }
            if !listed {
                break;
            }
        }
        let result = listed.then(|| Rc::new(all));
        self.name_reads.insert(name.to_owned(), result.clone());
        Ok(result)
    }
}

struct Trace {
    nodes: Vec<Source>,
    tainted: Vec<bool>,
    pending: Vec<Source>,
    placed: Vec<PlacedRead>,
    checks: f64,
}

impl Trace {
    fn taint(&mut self, node: usize) {
        if self.tainted[node] {
            return;
        }
        self.tainted[node] = true;
        self.pending.push(self.nodes[node]);
    }

    fn reach(&mut self, reads: &[usize], area: &RangeBounds) {
        self.checks += reads.len() as f64;
        for read in reads {
            let PlacedRead { bounds, owner } = &self.placed[*read];
            if !self.tainted[*owner] && intersects(bounds, area) {
                let owner = *owner;
                self.taint(owner);
            }
        }
    }
}

/// The cells to withhold because of what their formula reads.
///
/// Traced forwards from the withheld cells, not backwards from every formula:
/// a workbook where one hidden cell feeds three totals costs three steps
/// however many formulas it has.
pub fn cells_derived_from_withheld(
    sheets: &[ReadsSheet],
    names: &[NameDefinition],
    budget: f64,
) -> Result<DerivedCells, RegexLimit> {
    if sheets.iter().all(|sheet| sheet.marks.is_empty()) {
        return Ok(DerivedCells {
            by_sheet: sheets.iter().map(|_| Vec::new()).collect(),
            over_budget: false,
        });
    }

    let mut sheet_index: HashMap<String, usize> = HashMap::new();
    for (index, sheet) in sheets.iter().enumerate() {
        sheet_index.insert(sheet.name.to_lowercase(), index);
    }
    let mut definitions: HashMap<String, Vec<String>> = HashMap::new();
    for NameDefinition { name, formula } in names {
        definitions
            .entry(name.to_lowercase())
            .or_default()
            .push(formula.clone());
    }
    let mut reading = Reading {
        parsed: HashMap::new(),
        definitions,
        name_reads: HashMap::new(),
    };

    let mut trace = Trace {
        nodes: Vec::new(),
        tainted: Vec::new(),
        pending: Vec::new(),
        placed: Vec::new(),
        checks: 0.0,
    };
    // per sheet: the references into it, by the row buckets they cover
    let mut buckets: Vec<Buckets> = sheets.iter().map(|_| Buckets::default()).collect();
    let mut tall: Vec<Vec<usize>> = sheets.iter().map(|_| Vec::new()).collect();

    for (own, sheet) in sheets.iter().enumerate() {
        for FormulaCell { area, formula } in &sheet.formulas {
            let node = trace.nodes.len();
            trace.nodes.push(Source {
                sheet: own,
                area: *area,
            });
            trace.tainted.push(false);
            let reads = reading.reads_of(formula)?;
            let mut unlisted = reads.unknown;
            let mut all: Vec<FormulaRead> = reads.reads.clone();
            if !unlisted {
                for name in &reads.names {
                    match reading.reads_of_name(name, &HashSet::new())? {
                        None => {
                            unlisted = true;
                            break;
                        }
                        Some(more) => all.extend(more.iter().cloned()),
                    }
                }
            }
            let mut placed: Vec<(usize, RangeBounds)> = Vec::new();
            if !unlisted {
                for read in &all {
                    let target = match &read.sheet {
                        None => Some(own),
                        Some(sheet) => sheet_index.get(&sheet.to_lowercase()).copied(),
                    };
                    let Some(target) = target else {
                        unlisted = true;
                        break;
                    };
                    placed.push((target, read.bounds));
                }
            }
            if unlisted {
                trace.taint(node);
                continue;
            }
            // Its reads are kept even when one already lies on a mark: the trace
            // below finds that, in one pass over the marks instead of one per read.
            for (target, bounds) in placed {
                let entry = trace.placed.len();
                trace.placed.push(PlacedRead {
                    bounds,
                    owner: node,
                });
                let first = (bounds.start_row / BUCKET_ROWS).floor();
                let last = (bounds.end_row / BUCKET_ROWS).floor();
                if last - first >= MAX_BUCKETS_PER_READ {
                    tall[target].push(entry);
                    continue;
                }
                let mut bucket = first;
                while bucket <= last {
                    buckets[target].push(bucket, entry);
                    // a bucket number past 2^53 does not move: the TypeScript never leaves this loop there
                    if bucket + 1.0 == bucket {
                        break;
                    }
                    bucket += 1.0;
                }
            }
        }
    }

    // The marks and the unlisted areas are where the trace starts.
    for (index, sheet) in sheets.iter().enumerate() {
        for area in &sheet.marks {
            trace.pending.push(Source {
                sheet: index,
                area: *area,
            });
        }
        for area in &sheet.unknown {
            trace.pending.push(Source {
                sheet: index,
                area: *area,
            });
        }
    }
    while !trace.pending.is_empty() && trace.checks <= budget {
        let Some(Source { sheet, area }) = trace.pending.pop() else {
            break;
        };
        trace.reach(&tall[sheet], &area);
        let first = (area.start_row / BUCKET_ROWS).floor();
        let last = (area.end_row / BUCKET_ROWS).floor();
        if last - first >= MAX_BUCKETS_PER_READ {
            for list in &buckets[sheet].lists {
                trace.reach(list, &area);
            }
        } else {
            let mut bucket = first;
            while bucket <= last {
                if let Some(list) = buckets[sheet].list(bucket) {
                    trace.reach(list, &area);
                }
                if bucket + 1.0 == bucket {
                    break;
                }
                bucket += 1.0;
            }
        }
    }
    let over_budget = !trace.pending.is_empty();

    let mut by_sheet: Vec<Vec<RangeBounds>> =
        sheets.iter().map(|sheet| sheet.unknown.clone()).collect();
    for (index, node) in trace.nodes.iter().enumerate() {
        if over_budget || trace.tainted[index] {
            by_sheet[node.sheet].push(node.area);
        }
    }
    Ok(DerivedCells {
        by_sheet,
        over_budget,
    })
}

/// `(row, column) => is it in one of these areas`, for a reader that asks cell by cell.
#[derive(Debug)]
pub struct AreaLookup {
    cells: HashSet<u64>,
    ranges: Vec<RangeBounds>,
}

/// `row * (MAX_COLUMN + 1) + column`, the key of a cell in a set of numbers.
pub fn cell_key(row: f64, column: f64) -> u64 {
    (row * (MAX_COLUMN + 1.0) + column).to_bits()
}

impl AreaLookup {
    pub fn new(areas: &[RangeBounds]) -> Self {
        let mut cells = HashSet::new();
        let mut ranges = Vec::new();
        for area in areas {
            if area.start_row == area.end_row && area.start_column == area.end_column {
                cells.insert(cell_key(area.start_row, area.start_column));
            } else {
                ranges.push(*area);
            }
        }
        Self { cells, ranges }
    }

    pub fn contains(&self, row: f64, column: f64) -> bool {
        self.cells.contains(&cell_key(row, column))
            || self.ranges.iter().any(|area| {
                row >= area.start_row
                    && row <= area.end_row
                    && column >= area.start_column
                    && column <= area.end_column
            })
    }
}
