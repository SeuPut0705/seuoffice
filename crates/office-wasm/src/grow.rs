//! The allocator of the wasm build: the system one (wasi-libc's dlmalloc),
//! which grows the linear memory by doubling it instead of by what each
//! allocation lacks.
//!
//! Every `memory.grow` is external memory to V8, which answers a growth with
//! a full garbage collection of the JavaScript heap. Growing page run by page
//! run while a call builds a large model made that collection run hundreds of
//! times (178 full collections, 2 s of a 3.7 s call building a 130,000 row
//! table, with the rows in the JavaScript heap). Doubling makes the number of
//! growths logarithmic in the peak size. The linear memory never shrinks
//! either way, so reserving ahead costs at most the doubling's slack.
//!
//! The reservation is a block as large as the memory then is, allocated and
//! freed at once: dlmalloc merges it into its top chunk, which it never trims
//! back (wasi-libc builds it with `MORECORE_CANNOT_TRIM`), and serves later
//! allocations from it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::arch::wasm32::memory_size;
use std::cell::Cell;

pub struct Doubling;

thread_local! {
    /// Pages of linear memory after the last reservation.
    static RESERVED: Cell<usize> = const { Cell::new(0) };
    /// Set while a reservation runs: its own allocation must not reserve again.
    static RESERVING: Cell<bool> = const { Cell::new(false) };
}

const PAGE: usize = 65_536;
/// No reservation before the memory reaches this: small calls keep a small memory.
const FROM_PAGES: usize = 256;
/// One reservation at most this large: a 32-bit memory holds 4 GiB.
const MAX_RESERVE: usize = 512 << 20;

impl Doubling {
    fn reserve_ahead(&self) {
        let pages = memory_size(0);
        if pages < FROM_PAGES || pages <= RESERVED.with(Cell::get) || RESERVING.with(Cell::get) {
            return;
        }
        RESERVING.with(|reserving| reserving.set(true));
        let size = (pages * PAGE).min(MAX_RESERVE);
        if let Ok(layout) = Layout::from_size_align(size, 16) {
            // SAFETY: a fresh layout of nonzero size; the block is freed with it at once
            unsafe {
                let block = System.alloc(layout);
                if !block.is_null() {
                    System.dealloc(block, layout);
                }
            }
        }
        RESERVED.with(|reserved| reserved.set(memory_size(0)));
        RESERVING.with(|reserving| reserving.set(false));
    }
}

// SAFETY: every method hands the layout to the system allocator unchanged
unsafe impl GlobalAlloc for Doubling {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let block = unsafe { System.alloc(layout) };
        self.reserve_ahead();
        block
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let block = unsafe { System.alloc_zeroed(layout) };
        self.reserve_ahead();
        block
    }

    unsafe fn dealloc(&self, block: *mut u8, layout: Layout) {
        unsafe { System.dealloc(block, layout) }
    }

    unsafe fn realloc(&self, block: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(block, layout, size) };
        self.reserve_ahead();
        moved
    }
}
