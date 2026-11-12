//! The bound on the backtrack stack: a search that would need more stops, and
//! says so, instead of growing without end.

use regress::Regex;

/// `(?:a|b)*` keeps entries for each turn: one unclosed run of a few
/// thousand characters needs more than a few thousand entries.
#[test]
fn a_search_past_the_limit_stops_and_says_so() {
    let mut regex = Regex::new("<(?:a|b)*>").unwrap();
    regex.set_backtrack_limit(Some(1000));
    let text = format!("<{}", "a".repeat(10_000));
    let mut found = regex.find_iter(&text);
    assert!(found.next().is_none());
    assert!(found.limit_exceeded());
    // a short run stays under the limit and answers as before
    let mut short = regex.find_iter("x <ab> <a");
    assert_eq!(short.next().map(|m| m.range()), Some(2..6));
    assert!(short.next().is_none());
    assert!(!short.limit_exceeded());
}

#[test]
fn a_lookaround_counts_the_stack_it_sets_aside() {
    let mut regex = Regex::new("<(?:a|b)*(?=(?:a|b)*c)").unwrap();
    regex.set_backtrack_limit(Some(1000));
    let text = format!("<{}", "a".repeat(400));
    let mut found = regex.find_iter(&text);
    assert!(found.next().is_none());
    assert!(found.limit_exceeded());
}

#[test]
fn without_a_limit_nothing_changes() {
    let regex = Regex::new("<(?:a|b)*>").unwrap();
    let text = format!("<{}", "a".repeat(10_000));
    let mut found = regex.find_iter(&text);
    assert!(found.next().is_none());
    assert!(!found.limit_exceeded());
}

#[test]
fn a_single_character_loop_takes_one_entry() {
    let mut regex = Regex::new("<[^>]*>").unwrap();
    regex.set_backtrack_limit(Some(100));
    let text = format!("<{}", "a".repeat(100_000));
    let mut found = regex.find_iter(&text);
    assert!(found.next().is_none());
    assert!(!found.limit_exceeded());
}
