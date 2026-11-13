//! Counts lines of code of the experiment: non-blank lines whose trimmed text
//! does not start with `//`. A `// == name` line opens a section; lines
//! between `// step NAME` and `// end step NAME` count for that step of way A
//! and not for their section.

use std::collections::BTreeMap;

fn count(path: &str) -> (Vec<(String, usize)>, BTreeMap<String, usize>) {
    let source = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut sections: Vec<(String, usize)> = vec![("preamble".into(), 0)];
    let mut steps: BTreeMap<String, usize> = BTreeMap::new();
    let mut step: Option<String> = None;
    for line in source.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("// == ") {
            sections.push((name.to_owned(), 0));
        } else if let Some(name) = line.strip_prefix("// end step ") {
            assert_eq!(step.as_deref(), Some(name), "{path}: unbalanced step");
            step = None;
        } else if let Some(name) = line.strip_prefix("// step ") {
            step = Some(name.to_owned());
        } else if !line.is_empty() && !line.starts_with("//") {
            match &step {
                Some(name) => *steps.entry(name.clone()).or_default() += 1,
                None => sections.last_mut().expect("preamble").1 += 1,
            }
        }
    }
    (sections, steps)
}

fn main() {
    let root = env!("CARGO_MANIFEST_DIR");
    for file in ["container.rs", "way_a.rs", "way_b.rs"] {
        let (sections, steps) = count(&format!("{root}/src/{file}"));
        let total: usize = sections.iter().map(|s| s.1).sum();
        let detail: Vec<String> = sections.iter().map(|(n, c)| format!("{n} {c}")).collect();
        println!("{file}: {total} ({})", detail.join(", "));
        for (name, lines) in steps {
            println!("  step {name}: {lines}");
        }
    }
}
