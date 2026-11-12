//! `apps/sheets/src/main/pdf-page-variants.ts`.

use jscompat::number_to_string;

/// `PageVariant`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageVariant {
    Odd,
    Even,
    First,
}

impl PageVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            PageVariant::Odd => "odd",
            PageVariant::Even => "even",
            PageVariant::First => "first",
        }
    }
}

/// `VariantFlags`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VariantFlags {
    pub has_first: bool,
    pub has_even: bool,
}

/// Which pass prints the given 1-based page.
pub fn variant_for_page(page_number: f64, flags: VariantFlags) -> PageVariant {
    if page_number == 1.0 && flags.has_first {
        return PageVariant::First;
    }
    // `%` is the remainder of the division, as in Rust
    if page_number % 2.0 == 0.0 && flags.has_even {
        return PageVariant::Even;
    }
    PageVariant::Odd
}

/// `pageRanges` for the even pass of a `total`-page document ('' when none).
pub fn even_page_ranges(total: f64) -> String {
    let mut pages: Vec<String> = Vec::new();
    let mut page = 2.0;
    while page <= total {
        pages.push(number_to_string(page));
        page += 2.0;
    }
    pages.join(",")
}

/// `StitchStep`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StitchStep {
    /// 1-based document page.
    pub page: f64,
    pub source: PageVariant,
    /// Page index within the source pass's PDF.
    pub index: f64,
}

/// Page-by-page assembly plan.
pub fn stitch_plan(total: f64, flags: VariantFlags) -> Vec<StitchStep> {
    let mut steps = Vec::new();
    let mut page = 1.0;
    while page <= total {
        let source = variant_for_page(page, flags);
        steps.push(StitchStep {
            page,
            source,
            index: match source {
                PageVariant::First => 0.0,
                PageVariant::Even => page / 2.0 - 1.0,
                PageVariant::Odd => page - 1.0,
            },
        });
        page += 1.0;
    }
    steps
}
