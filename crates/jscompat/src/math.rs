//! `Math.max`, `Math.min`, `Math.sign` and the trigonometry of `Math`.
//!
//! `Math.max` and `Math.min` are not `f64::max` and `f64::min`: those return
//! the other operand when one is NaN, where JavaScript returns NaN, and they
//! may order -0 and +0 either way.
//!
//! The trigonometric functions call the platform's libm: on `wasm32-wasip1`
//! that is the `libm` of Rust's compiler builtins, a port of musl's, which
//! comes from fdlibm. V8 computes `Math.atan2` and `Math.tan` with fdlibm
//! too, but `Math.sin` and `Math.cos` with a port of glibc's where it is
//! built with `v8_use_libm_trig_functions`. The two can differ in the last
//! bit; these wrappers are the one place to change that.

/// `Math.max(a, b)`: NaN wins, and +0 is above -0. `Math.max(a, b, c)` is
/// `math_max(math_max(a, b), c)`.
pub fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN wins, and -0 is below +0. `Math.min(a, b, c)` is
/// `math_min(math_min(a, b), c)`.
pub fn math_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.sign(x)`: NaN for NaN, and a zero keeps its sign.
pub fn math_sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        x
    } else if x > 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// `Math.sin(x)`
pub fn math_sin(x: f64) -> f64 {
    x.sin()
}

/// `Math.cos(x)`
pub fn math_cos(x: f64) -> f64 {
    x.cos()
}

/// `Math.tan(x)`
pub fn math_tan(x: f64) -> f64 {
    x.tan()
}

/// `Math.atan2(y, x)`
pub fn math_atan2(y: f64, x: f64) -> f64 {
    y.atan2(x)
}

/// `Math.hypot(...values)` as V8 computes it (`MathHypot` of
/// src/builtins/math.tq): Infinity before NaN, 0 when every value is 0, else
/// each value divided by the largest one, squared and summed with Kahan
/// compensation, and the root scaled back. The standard library's two-argument
/// `hypot` rounds differently.
pub fn math_hypot(values: &[f64]) -> f64 {
    let mut one_is_nan = false;
    let mut max: f64 = 0.0;
    for &value in values {
        if value.is_nan() {
            one_is_nan = true;
        } else if value.abs() > max {
            max = value.abs();
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if one_is_nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum: f64 = 0.0;
    let mut compensation: f64 = 0.0;
    for &value in values {
        let n = value.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `if (x)`, and `x || y`, on a number: 0, -0 and NaN are false.
pub fn number_truthy(x: f64) -> bool {
    !(x == 0.0 || x.is_nan())
}

/// `Math.pow(x, y)` and `x ** y`. Not C's `pow` at two points: a NaN exponent
/// gives NaN even where the base is 1, and a base of +1 or -1 under an infinite
/// exponent gives NaN where C gives 1.
///
/// Every other case is `pow` of the `libm` crate, on every target. `f64::powf`
/// was not V8's answer in the last bit: two colors of the tracked decks came
/// back one step off after the gamma curve of a tint. With this one the 1,259
/// colors of the gate agree with Node 22; that is measured on those inputs,
/// not proven for every pair.
pub fn math_pow(x: f64, y: f64) -> f64 {
    if y.is_nan() || (y.is_infinite() && x.abs() == 1.0) {
        return f64::NAN;
    }
    libm::pow(x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_and_min_follow_javascript() {
        assert!(math_max(f64::NAN, 1.0).is_nan());
        assert!(math_min(1.0, f64::NAN).is_nan());
        assert!(math_max(-0.0, 0.0).is_sign_positive());
        assert!(math_max(0.0, -0.0).is_sign_positive());
        assert!(math_min(0.0, -0.0).is_sign_negative());
        assert!(math_min(-0.0, 0.0).is_sign_negative());
        assert_eq!(math_max(2.0, 3.0), 3.0);
        assert_eq!(math_min(f64::INFINITY, 3.0), 3.0);
    }

    #[test]
    fn sign_keeps_zeros_and_nan() {
        assert!(math_sign(f64::NAN).is_nan());
        assert!(math_sign(-0.0).is_sign_negative());
        assert_eq!(math_sign(-5.0), -1.0);
        assert_eq!(math_sign(f64::INFINITY), 1.0);
    }

    #[test]
    fn hypot_follows_v8() {
        assert_eq!(math_hypot(&[]), 0.0);
        assert_eq!(math_hypot(&[0.0, -0.0]), 0.0);
        assert_eq!(math_hypot(&[f64::NAN, f64::INFINITY]), f64::INFINITY);
        assert!(math_hypot(&[f64::NAN, 1.0]).is_nan());
        assert_eq!(math_hypot(&[3.0, 4.0]), 5.0);
        assert_eq!(math_hypot(&[1e308, 1e308]), 1e308 * 2f64.sqrt());
    }

    #[test]
    fn numbers_are_truthy_as_in_javascript() {
        assert!(!number_truthy(0.0));
        assert!(!number_truthy(-0.0));
        assert!(!number_truthy(f64::NAN));
        assert!(number_truthy(-1.0));
        assert!(number_truthy(f64::NEG_INFINITY));
    }

    // what Node 22 answers for the same input
    #[test]
    fn the_cases_where_javascript_is_not_c() {
        assert!(math_pow(1.0, f64::NAN).is_nan());
        assert!(math_pow(1.0, f64::INFINITY).is_nan());
        assert!(math_pow(-1.0, f64::NEG_INFINITY).is_nan());
        assert_eq!(math_pow(f64::NAN, 0.0), 1.0);
        assert_eq!(math_pow(0.0, 2.2), 0.0);
        assert_eq!(math_pow(2.0, 10.0), 1024.0);
        assert!(math_pow(f64::NAN, 2.2).is_nan());
    }
}
