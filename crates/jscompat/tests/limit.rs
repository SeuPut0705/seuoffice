//! A search whose backtrack stack would pass `BACKTRACK_LIMIT` stops with
//! `RegexLimit`, and the memory it takes stays near the bound however long
//! the text is. One test in this binary: the allocator counts for all of it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

use jscompat::{BACKTRACK_LIMIT, RegexLimit, TryJsRegex};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
        PEAK.fetch_max(live, Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Relaxed);
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        // the old and the new block live together while the bytes are copied
        let live = LIVE.fetch_add(size, Relaxed) + size;
        PEAK.fetch_max(live, Relaxed);
        LIVE.fetch_sub(layout.size(), Relaxed);
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The answer of one search, and the most bytes it held at once.
fn peak_of(regex: &TryJsRegex, text: &str) -> (Result<bool, RegexLimit>, usize) {
    let before = LIVE.load(Relaxed);
    PEAK.store(before, Relaxed);
    let answer = regex.try_test(text);
    (answer, PEAK.load(Relaxed) - before)
}

#[test]
fn a_search_that_passes_the_bound_refuses_within_it() {
    // a tag whose attributes run on: each character keeps entries on the stack
    let tag = TryJsRegex::new(r#"<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>"#, "").unwrap();
    // an entry is 40 bytes on a 64-bit target; growing the stack to the bound
    // copies it once, and a search without `u` may read the text as UTF-16 units
    let room = |text: &str| BACKTRACK_LIMIT * 40 * 5 / 4 + 2 * text.len();
    let mut answers = Vec::new();
    for length in [1_000_000, 2_000_000, 20_000_000] {
        let text = format!("<{}", "a".repeat(length));
        let (answer, peak) = peak_of(&tag, &text);
        println!(
            "{length} characters: {answer:?}, {} MB at most",
            peak / 1_000_000
        );
        assert!(peak <= room(&text), "{peak} bytes for {length} characters");
        answers.push(answer);
    }
    assert_eq!(answers, [Ok(false), Err(RegexLimit), Err(RegexLimit)]);
    // a refusal leaves the regex as it was
    let (answer, _) = peak_of(&tag, "<a b=\"c\">");
    assert_eq!(answer, Ok(true));

    // a lookahead that grows its own stack after the stack it sets aside has
    // grown and given its entries back: the two together stay near the bound
    let looked = TryJsRegex::new("^(?:(?:a|b)*x|a)(?=(?:a|b)*y)", "").unwrap();
    let text = "a".repeat(1_000_000);
    let (answer, peak) = peak_of(&looked, &text);
    println!(
        "lookahead over 1M characters: {answer:?}, {} MB at most",
        peak / 1_000_000
    );
    assert_eq!(answer, Ok(false));
    assert!(peak <= room(&text), "{peak} bytes in the lookahead");

    // a lookahead entered with a large stack set aside: that one keeps room
    // to double (at most 4,096 entries and twice what it holds), the
    // lookahead's own grows to what is left of the bound, so together they
    // hold twice the bound at most
    let twice = |text: &str| BACKTRACK_LIMIT * 40 * 2 + 4096 * 40 + 2 * text.len();
    for (pattern, text) in [
        (
            "^(?:(?:a|b)*x|(?:a|b){600000})(?=((?:a|b)*)c)",
            format!("{}c", "a".repeat(1_000_000)),
        ),
        (
            "^(?:(?:a|b)*x|(?:a|b){1050000})(?=(?:a|b)*y)",
            "a".repeat(1_700_000),
        ),
        ("^(?:(?!x)[\\s\\S])*y", "a".repeat(2_000_000)),
    ] {
        let regex = TryJsRegex::new(pattern, "").unwrap();
        let (answer, peak) = peak_of(&regex, &text);
        println!(
            "/{pattern}/ over {} characters: {answer:?}, {} MB at most",
            text.len(),
            peak / 1_000_000
        );
        assert!(peak <= twice(&text), "/{pattern}/: {peak} bytes");
    }
}
