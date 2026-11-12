//! Slide ids of a presentation part (packages/pptx-engine/src/slide-ids.ts).

use std::collections::HashSet;
use std::fmt;

use jscompat::{js_regex, to_number};

/// ST_SlideId is 256..2147483647.
const SLIDE_ID_MIN: u32 = 256;
const SLIDE_ID_MAX: u32 = 2_147_483_647;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlideIdSpaceExhausted;

impl fmt::Display for SlideIdSpaceExhausted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("pptx: slide id space exhausted")
    }
}

impl std::error::Error for SlideIdSpaceExhausted {}

/// The next p:sldId/@id: the highest used plus one, or the lowest free id
/// once the deck sits at the ceiling.
pub fn next_slide_id(pres_xml: &str) -> Result<u32, SlideIdSpaceExhausted> {
    let mut used = HashSet::new();
    for found in js_regex!(r#"<p:sldId\s[^>]*\bid[\t\n\r ]*=[\t\n\r ]*(?:"(\d+)"|'(\d+)')"#)
        .find_iter(pres_xml)
    {
        // Out-of-range values are invalid per ST_SlideId; ignoring them keeps
        // a single hostile attribute from forcing the ceiling scan below.
        let n = to_number(found.get(1).or(found.get(2)).unwrap_or_default());
        if n >= f64::from(SLIDE_ID_MIN) && n <= f64::from(SLIDE_ID_MAX) {
            used.insert(n as u32);
        }
    }
    let max = used.iter().copied().max().unwrap_or(SLIDE_ID_MIN - 1);
    let mut id = max + 1;
    if id > SLIDE_ID_MAX {
        id = SLIDE_ID_MIN;
        while used.contains(&id) {
            id += 1;
            if id > SLIDE_ID_MAX {
                return Err(SlideIdSpaceExhausted);
            }
        }
    }
    Ok(id)
}
