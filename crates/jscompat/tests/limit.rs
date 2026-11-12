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
    // an entry is 48 bytes on a 64-bit target; growing the stack copies it
    // once, and a search without `u` reads the text as UTF-16 units
    let room = |text: &str| BACKTRACK_LIMIT * 48 * 5 / 4 + 2 * text.len();
    let mut answers = Vec::new();
    for length in [1_000_000, 2_000_000, 20_000_000] {
        let text = format!("<{}", "a".repeat(length));
        let (answer, peak) = peak_of(&tag, &text);
        println!("{length} characters: {answer:?}, {} MB at most", peak / 1_000_000);
        assert!(peak <= room(&text), "{peak} bytes for {length} characters");
        answers.push(answer);
    }
    assert_eq!(answers, [Ok(false), Err(RegexLimit), Err(RegexLimit)]);
    // a refusal leaves the regex as it was
    let (answer, _) = peak_of(&tag, "<a b=\"c\">");
    assert_eq!(answer, Ok(true));
}
