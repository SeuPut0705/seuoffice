//! `Math.max` and `Math.min` of two numbers.

/// `Math.max(a, b)`: NaN wins, and +0 is above -0.
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

/// `Math.min(a, b)`: NaN wins, and -0 is below +0.
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

#[cfg(test)]
mod tests {
    use super::*;

    // node 22: Math.max(-0, 0) is +0, Math.min(0, -0) is -0, NaN wins
    #[test]
    fn zero_and_nan() {
        assert!(math_max(-0.0, 0.0).is_sign_positive());
        assert!(math_max(0.0, -0.0).is_sign_positive());
        assert!(math_min(0.0, -0.0).is_sign_negative());
        assert!(math_min(-0.0, 0.0).is_sign_negative());
        assert!(math_max(f64::NAN, 1.0).is_nan());
        assert!(math_min(1.0, f64::NAN).is_nan());
        assert_eq!(math_max(2.0, 9.0), 9.0);
        assert_eq!(math_min(2.0, 9.0), 2.0);
    }
}
