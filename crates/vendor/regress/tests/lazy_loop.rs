//! A lazy loop over one character matcher takes one character per backtrack:
//! it never first walks to the farthest place it could reach.

use regress::Regex;
use std::time::Instant;

/// The time of one pass over `copies` copies of a run, the best of three.
fn pass(regex: &Regex, run: &str, copies: usize) -> f64 {
    let text = run.repeat(copies);
    (0..3)
        .map(|_| {
            let began = Instant::now();
            assert_eq!(regex.find_iter(&text).count(), copies);
            began.elapsed().as_secs_f64()
        })
        .fold(f64::INFINITY, f64::min)
}

/// Twice the text with twice the matches costs about twice, not four times.
/// A walk to the end of the text before each match makes the cost grow with
/// the square of the size: 4x here, against 2x without it. The factor 3 is
/// far from both, so a slow or busy machine does not change the verdict.
#[test]
fn a_pass_grows_with_the_text_not_its_square() {
    for pattern in [r"<t>([\s\S]*?)</t>", r"<t>(.*?)</t>", r"<t>[^#]*?</t>", r"<t>(?:[\s\S]{2})*?</t>"] {
        let regex = Regex::new(pattern).unwrap();
        // an even number of characters between the tags, for the pattern that takes two at a time
        let run = "<p><t>some words her</t></p>";
        let small = pass(&regex, run, 20_000);
        let large = pass(&regex, run, 40_000);
        assert!(large < small * 3.0, "/{pattern}/: {small:.4}s for 20,000 runs, {large:.4}s for 40,000");
    }
}

#[test]
fn a_lazy_loop_answers_as_before() {
    // as Node 22.23.5 answered `new RegExp(pattern).exec(text)`
    let cases: &[(&str, &str, Option<(usize, usize)>)] = &[
        (r"a.*?b", "a1b2b", Some((0, 3))),
        (r"a.*?b", "a12", None),
        (r"a.{2,3}?b", "a1b2bb", Some((0, 5))),
        (r"a.{2,3}?b", "a12345b", None),
        (r"a[^x]*?b", "axb a1b", Some((4, 7))),
        (r"a.*?$", "a\nb", None),
        (r"(?<=a.*?)b", "xab", Some((2, 3))),
        (r"a(?:.*?)c", "abbbc", Some((0, 5))),
        (r"x*?", "xxx", Some((0, 0))),
        (r"x+?", "xxx", Some((0, 1))),
        (r"x{2}?y", "xxy", Some((0, 3))),
    ];
    for (pattern, text, expected) in cases {
        let found = Regex::new(pattern).unwrap().find(text).map(|m| (m.range().start, m.range().end));
        assert_eq!(found, *expected, "/{pattern}/ on {text:?}");
    }
}
