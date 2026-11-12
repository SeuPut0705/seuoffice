//! `Array.prototype.sort` with a comparator.
//!
//! Not `slice::sort_by`: that may panic on a comparator that is not a total
//! order (`(a, b) => a.x - b.x` over a NaN), and a panic aborts the wasm
//! instance. V8 sorts with TimSort and reads a NaN from the comparator as 0.
//!
//! Below 64 elements TimSort is one run and a binary insertion sort, ported
//! here step by step from V8's `array-sort.tq`, so the result is V8's for any
//! comparator. From 64 elements on this is a plain stable merge sort: V8's
//! result for a consistent comparator, possibly another order for one that
//! is not.

/// `items.sort((a, b) => compare(a, b))`.
pub fn sort_by_number<T>(items: &mut [T], mut compare: impl FnMut(&T, &T) -> f64) {
    let length = items.len();
    if length < 2 {
        return;
    }
    let mut order: Vec<usize> = (0..length).collect();
    {
        // `SortCompareUserFn`: a NaN is 0
        let mut call = |a: usize, b: usize| {
            let v = compare(&items[a], &items[b]);
            if v.is_nan() { 0.0 } else { v }
        };
        if length < 64 {
            let run = count_and_make_run(&mut order, &mut call);
            binary_insertion_sort(&mut order, run, &mut call);
        } else {
            merge_sort(&mut order, &mut call);
        }
    }
    apply(items, order);
}

/// `CountAndMakeRun` over the whole array: the length of the run at the
/// start, reversed in place where it descends strictly.
fn count_and_make_run(order: &mut [usize], call: &mut impl FnMut(usize, usize) -> f64) -> usize {
    let high = order.len();
    let mut run_length = 2;
    let is_descending = call(order[1], order[0]) < 0.0;
    let mut previous = order[1];
    for &current in &order[2..high] {
        let v = call(current, previous);
        if is_descending {
            if v >= 0.0 {
                break;
            }
        } else if v < 0.0 {
            break;
        }
        previous = current;
        run_length += 1;
    }
    if is_descending {
        order[..run_length].reverse();
    }
    run_length
}

/// `BinaryInsertionSort(0, start, length)`: `[0, start)` is sorted already.
fn binary_insertion_sort(
    order: &mut [usize],
    start: usize,
    call: &mut impl FnMut(usize, usize) -> f64,
) {
    for start in start.max(1)..order.len() {
        let pivot = order[start];
        let (mut left, mut right) = (0, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if call(pivot, order[mid]) < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        order.copy_within(left..start, left + 1);
        order[left] = pivot;
    }
}

fn merge_sort(order: &mut [usize], call: &mut impl FnMut(usize, usize) -> f64) {
    let length = order.len();
    let mut from = order.to_vec();
    let mut into = vec![0; length];
    let mut width = 1;
    while width < length {
        for low in (0..length).step_by(2 * width) {
            let mid = (low + width).min(length);
            let high = (low + 2 * width).min(length);
            let (mut left, mut right) = (low, mid);
            for slot in &mut into[low..high] {
                // the right one goes first only where it is strictly below
                let take_right =
                    left == mid || (right < high && call(from[right], from[left]) < 0.0);
                if take_right {
                    *slot = from[right];
                    right += 1;
                } else {
                    *slot = from[left];
                    left += 1;
                }
            }
        }
        std::mem::swap(&mut from, &mut into);
        width *= 2;
    }
    order.copy_from_slice(&from);
}

/// Moves `items[order[i]]` to place `i`, by cycles.
fn apply<T>(items: &mut [T], mut order: Vec<usize>) {
    for start in 0..order.len() {
        let mut at = start;
        while order[at] != start {
            let next = order[at];
            items.swap(at, next);
            order[at] = at;
            at = next;
        }
        order[at] = at;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut items: Vec<(f64, char)>) -> String {
        sort_by_number(&mut items, |a, b| a.0 - b.0);
        items.iter().map(|(_, c)| *c).collect()
    }

    // the answers are Node 22's for the same arrays and `(a, b) => a[0] - b[0]`
    #[test]
    fn it_is_stable() {
        assert_eq!(
            sorted(vec![(2.0, 'a'), (1.0, 'b'), (2.0, 'c'), (1.0, 'd')]),
            "bdac"
        );
        assert_eq!(sorted(vec![(3.0, 'a'), (2.0, 'b'), (1.0, 'c')]), "cba");
    }

    #[test]
    fn a_nan_from_the_comparator_is_equal() {
        let mut same = [3, 1, 2];
        sort_by_number(&mut same, |_, _| f64::NAN);
        assert_eq!(same, [3, 1, 2]);
        assert_eq!(sorted(vec![(1.0, 'a'), (f64::NAN, 'b'), (0.0, 'c')]), "abc");
        assert_eq!(
            sorted(vec![
                (2.0, 'a'),
                (f64::NAN, 'b'),
                (1.0, 'c'),
                (0.0, 'd'),
                (f64::NAN, 'e'),
                (-1.0, 'f')
            ]),
            "abfdce"
        );
    }

    #[test]
    fn a_descending_run_ends_at_an_equal_pair() {
        assert_eq!(
            sorted(vec![
                (5.0, 'a'),
                (4.0, 'b'),
                (4.0, 'c'),
                (3.0, 'd'),
                (9.0, 'e'),
                (1.0, 'f')
            ]),
            "fdbcae"
        );
    }

    #[test]
    fn long_arrays_sort_stably_too() {
        let mut items: Vec<(f64, usize)> = (0..200)
            .map(|index| (((index * 37) % 11) as f64, index))
            .collect();
        sort_by_number(&mut items, |a, b| a.0 - b.0);
        assert!(
            items
                .windows(2)
                .all(|pair| pair[0].0 < pair[1].0
                    || (pair[0].0 == pair[1].0 && pair[0].1 < pair[1].1))
        );
    }
}
