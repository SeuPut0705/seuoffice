//! The tables of math.ts, entries in its order. Its inverse lookups are maps
//! built from these where the first entry of a value wins, so a lookup here
//! is the first entry that matches.

pub const LATEX_SYMBOLS: &[(&str, &str)] = &[
    ("alpha", "α"),
    ("beta", "β"),
    ("gamma", "γ"),
    ("delta", "δ"),
    ("epsilon", "ε"),
    ("varepsilon", "ε"),
    ("zeta", "ζ"),
    ("eta", "η"),
    ("theta", "θ"),
    ("vartheta", "ϑ"),
    ("iota", "ι"),
    ("kappa", "κ"),
    ("lambda", "λ"),
    ("mu", "μ"),
    ("nu", "ν"),
    ("xi", "ξ"),
    ("pi", "π"),
    ("rho", "ρ"),
    ("sigma", "σ"),
    ("tau", "τ"),
    ("upsilon", "υ"),
    ("phi", "φ"),
    ("varphi", "ϕ"),
    ("chi", "χ"),
    ("psi", "ψ"),
    ("omega", "ω"),
    ("Gamma", "Γ"),
    ("Delta", "Δ"),
    ("Theta", "Θ"),
    ("Lambda", "Λ"),
    ("Xi", "Ξ"),
    ("Pi", "Π"),
    ("Sigma", "Σ"),
    ("Upsilon", "Υ"),
    ("Phi", "Φ"),
    ("Psi", "Ψ"),
    ("Omega", "Ω"),
    ("infty", "∞"),
    ("pm", "±"),
    ("mp", "∓"),
    ("times", "×"),
    ("div", "÷"),
    ("cdot", "⋅"),
    ("ast", "*"),
    ("le", "≤"),
    ("leq", "≤"),
    ("ge", "≥"),
    ("geq", "≥"),
    ("ne", "≠"),
    ("neq", "≠"),
    ("approx", "≈"),
    ("equiv", "≡"),
    ("sim", "∼"),
    ("propto", "∝"),
    ("to", "→"),
    ("rightarrow", "→"),
    ("leftarrow", "←"),
    ("leftrightarrow", "↔"),
    ("Rightarrow", "⇒"),
    ("Leftarrow", "⇐"),
    ("Leftrightarrow", "⇔"),
    ("partial", "∂"),
    ("nabla", "∇"),
    ("in", "∈"),
    ("notin", "∉"),
    ("subset", "⊂"),
    ("supset", "⊃"),
    ("subseteq", "⊆"),
    ("supseteq", "⊇"),
    ("cup", "∪"),
    ("cap", "∩"),
    ("forall", "∀"),
    ("exists", "∃"),
    ("wedge", "∧"),
    ("vee", "∨"),
    ("neg", "¬"),
    ("angle", "∠"),
    ("perp", "⊥"),
    ("parallel", "∥"),
    ("ldots", "…"),
    ("cdots", "⋯"),
    ("vdots", "⋮"),
    ("ddots", "⋱"),
    ("prime", "′"),
    ("circ", "∘"),
    ("degree", "°"),
    ("bullet", "∙"),
    ("star", "⋆"),
    ("emptyset", "∅"),
    ("hbar", "ℏ"),
    ("ell", "ℓ"),
    ("Re", "ℜ"),
    ("Im", "ℑ"),
    ("aleph", "ℵ"),
    ("therefore", "∴"),
    ("because", "∵"),
];

pub const LATEX_FUNCTIONS: &[&str] = &[
    "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "coth", "arcsin", "arccos",
    "arctan", "ln", "log", "exp", "max", "min", "sup", "inf", "arg", "det", "gcd", "deg", "dim",
    "ker", "mod",
];

/// Name, then the operator character and its `m:limLoc`.
pub const NARY_OPS: &[(&str, (&str, &str))] = &[
    ("sum", ("∑", "undOvr")),
    ("prod", ("∏", "undOvr")),
    ("coprod", ("∐", "undOvr")),
    ("bigcup", ("⋃", "undOvr")),
    ("bigcap", ("⋂", "undOvr")),
    ("int", ("∫", "subSup")),
    ("iint", ("∬", "subSup")),
    ("iiint", ("∭", "subSup")),
    ("oint", ("∮", "subSup")),
];

pub const ACCENT_CHARS: &[(&str, &str)] = &[
    ("hat", "\u{0302}"),
    ("bar", "\u{0304}"),
    ("vec", "\u{20D7}"),
    ("dot", "\u{0307}"),
    ("ddot", "\u{0308}"),
    ("tilde", "\u{0303}"),
    ("check", "\u{030C}"),
    ("breve", "\u{0306}"),
];

/// Environment, then its `m:begChr` and `m:endChr`; `None` is no `m:d`.
pub const MATRIX_DELIMS: &[(&str, Option<(&str, &str)>)] = &[
    ("matrix", None),
    ("pmatrix", Some(("(", ")"))),
    ("bmatrix", Some(("[", "]"))),
    ("Bmatrix", Some(("{", "}"))),
    ("vmatrix", Some(("|", "|"))),
    ("Vmatrix", Some(("‖", "‖"))),
    ("cases", Some(("{", ""))),
];

/// The tokens after `\left` and `\right`; `""` is no delimiter.
pub const LEFT_RIGHT_CHARS: &[(&str, &str)] = &[
    ("(", "("),
    (")", ")"),
    ("[", "["),
    ("]", "]"),
    ("|", "|"),
    (".", ""),
    ("\\{", "{"),
    ("\\}", "}"),
    ("\\|", "‖"),
    ("\\langle", "⟨"),
    ("\\rangle", "⟩"),
    ("\\lfloor", "⌊"),
    ("\\rfloor", "⌋"),
    ("\\lceil", "⌈"),
    ("\\rceil", "⌉"),
];

/// Characters of ordinary math text the LaTeX parser would read as syntax.
pub const CHAR_ESCAPES: &[(char, &str)] = &[
    ('{', "\\{ "),
    ('}', "\\} "),
    ('_', "\\_ "),
    ('^', "\\^ "),
    ('&', "\\& "),
    ('%', "\\% "),
    ('$', "\\$ "),
    ('#', "\\# "),
];

pub const OPERATOR_CHARS: &str = "+-−=<>±∓×÷·⋅∙*/!%&|,;:()[]{}′″∞→←↔⇒⇐⇔∈∉⊂⊃∪∩∀∃∧∨¬≤≥≠≈≡∼∝⊥∥°∂∇";

/// `table[key]` for a key the table owns.
pub fn value_of<V: Copy>(table: &[(&'static str, V)], key: &str) -> Option<V> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|&(_, value)| value)
}

/// The first key whose value is `value`: the inverse maps of math.ts.
pub fn first_key_of(table: &[(&'static str, &'static str)], value: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(_, candidate)| *candidate == value)
        .map(|&(name, _)| name)
}
