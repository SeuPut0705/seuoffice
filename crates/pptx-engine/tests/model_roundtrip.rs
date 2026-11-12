//! The model deserializes from what `JSON.stringify` writes for the
//! TypeScript model, and serializes back to the same text.

use pptx_engine::chart::ChartModel;
use pptx_engine::custgeom::CustomGeometry;
use pptx_engine::types::{Slide, SlideDeck, SlideElement};

const ANCHOR: &str = r#"{"spIndex":0,"originalXml":"<p:sp/>","range":[0,5]}"#;
const TRANSFORM: &str =
    r#"{"offset":{"x":0,"y":1,"cx":10,"cy":20},"rot":0,"flipH":false,"flipV":true}"#;

fn roundtrip<T: serde::de::DeserializeOwned + serde::Serialize>(json: &str) {
    let model: T = serde_json::from_str(json).unwrap_or_else(|e| panic!("{e}: {json}"));
    assert_eq!(serde_json::to_string(&model).unwrap(), json);
}

fn text_element(extra: &str) -> String {
    format!(
        r##"{{"id":"1","type":"shape","anchor":{ANCHOR},"transform":{TRANSFORM},"name":"A","fill":{{"type":"solid","color":"#FF0000"}},"stroke":{{"fill":{{"type":"none"}},"width":12700,"dash":"solid"}},"text":{{"paragraphs":[{{"runs":[{{"text":"hi","bold":true,"fontSize":null,"color":"#000000"}},{{"text":"yo"}}],"align":"left"}}],"insets":{{"l":1,"t":2,"r":3,"b":4}},"wrap":true}}{extra},"dirty":false}}"##
    )
}

#[test]
fn text_and_shape_elements_round_trip_with_null_and_absent_keys() {
    // `fontSize: null` is NaN written by JSON.stringify; the second run has no such key.
    let json = text_element(
        r#","customGeometry":{"path":"M 0 0 L 1 1","fillPath":"M 0 0"},"adjust":{"adj":50000}"#,
    );
    roundtrip::<SlideElement>(&json);
    let element: SlideElement = serde_json::from_str(&json).unwrap();
    let SlideElement::Text(text) = &element else {
        panic!("a shape is a TextElement")
    };
    let paragraph = &text.text.as_ref().unwrap().paragraphs.as_ref().unwrap()[0];
    let runs = paragraph.runs.as_ref().unwrap();
    assert!(runs[0].font_size.has_key());
    assert!(runs[0].font_size.unwrap().0.is_nan());
    assert!(!runs[1].font_size.has_key());
}

#[test]
fn custom_geometry_round_trips() {
    roundtrip::<CustomGeometry>(r#"{"path":"M 0 0","strokePath":"M 1 1"}"#);
    roundtrip::<CustomGeometry>(r#"{"fillPath":"M 0 0"}"#);
}

#[test]
fn the_other_elements_round_trip() {
    let picture = format!(
        r##"{{"id":"2","type":"picture","anchor":{ANCHOR},"transform":{TRANSFORM},"mediaRef":"rId2","srcRect":{{"l":0,"t":0,"r":0,"b":0}},"opacity":0.5,"duotone":["#000000","#FFFFFF"],"media":{{"kind":"video","external":false}},"dataUrl":"data:x"}}"##
    );
    roundtrip::<SlideElement>(&picture);

    let group = format!(
        r#"{{"id":"3","type":"group","anchor":{ANCHOR},"transform":{TRANSFORM},"children":[{}],"childOffset":{{"x":0,"y":0,"cx":5,"cy":6}}}}"#,
        text_element("")
    );
    roundtrip::<SlideElement>(&group);

    let table = format!(
        r#"{{"id":"4","type":"table","anchor":{ANCHOR},"transform":{TRANSFORM},"colWidths":[100,200],"rowHeights":[50],"rows":[[{{"text":{{"paragraphs":[]}},"borders":{{"t":{{"fill":{{"type":"none"}},"width":0}},"l":{{"fill":{{"type":"none"}},"width":1}}}},"gridSpan":2,"merged":false}}]],"styleFlags":{{"firstRow":true,"lastRow":false,"firstCol":false,"lastCol":false,"bandRow":true,"bandCol":false}}}}"#
    );
    roundtrip::<SlideElement>(&table);

    let passthrough = format!(
        r#"{{"id":"5","type":"passthrough","anchor":{ANCHOR},"transform":{TRANSFORM},"kind":"chart","noChip":true}}"#
    );
    roundtrip::<SlideElement>(&passthrough);
}

const CHART: &str = r#"{"kind":"bar","categories":["a","b"],"series":[{"name":"s","values":[1,null,3],"plotKind":"bar","dLblOverrides":[{"idx":0,"sizePt":null,"fill":null}],"pointColors":[null,"FF0000"]}],"legendLayout":{"x":0.5,"xMode":"edge"},"valAxis":{"min":0,"max":null,"isDate":true},"sunburst":{"levels":[["a"]],"sizes":[1,null],"pointColors":[null,"00FF00"]},"bar3D":{"rotX":15,"rotY":20,"depthPct":100,"rAngAx":true,"gapDepthPct":150,"serAxLabels":false}}"#;

#[test]
fn a_chart_round_trips() {
    roundtrip::<ChartModel>(CHART);
    let element = format!(
        r#"{{"id":"6","type":"chart","anchor":{ANCHOR},"transform":{TRANSFORM},"chart":{CHART},"userShapes":[{}]}}"#,
        text_element("")
    );
    roundtrip::<SlideElement>(&element);
}

#[test]
fn a_slide_and_a_deck_round_trip() {
    let slide = format!(
        r#"{{"path":"ppt/slides/slide1.xml","originalXml":"<x/>","bodyPrefix":"","bodySuffix":"","elements":[{}],"background":{{"type":"none"}},"structureDirty":true}}"#,
        text_element("")
    );
    roundtrip::<Slide>(&slide);
    let deck = format!(
        r#"{{"slides":[{slide}],"size":{{"cx":9144000,"cy":6858000}},"originalHash":"abc"}}"#
    );
    roundtrip::<SlideDeck>(&deck);
}

#[test]
fn an_unknown_key_or_type_is_refused() {
    // a js_object! struct
    let slide = r#"{"path":"p","bogus":1}"#;
    assert!(serde_json::from_str::<Slide>(slide).is_err());
    // a plain struct inside an element
    let element = text_element("").replace(r#""rot":0"#, r#""rot":0,"skew":1"#);
    assert!(serde_json::from_str::<SlideElement>(&element).is_err());
    // an unknown key of an element, and an element type that is not one
    assert!(serde_json::from_str::<SlideElement>(&text_element(r#","bogus":true"#)).is_err());
    let element = text_element("").replace(r#""type":"shape""#, r#""type":"smiley""#);
    assert!(serde_json::from_str::<SlideElement>(&element).is_err());
    // the type picks the variant: a picture's keys under `text` are not read as a picture
    let wrong = format!(
        r#"{{"id":"2","type":"text","anchor":{ANCHOR},"transform":{TRANSFORM},"mediaRef":"rId2"}}"#
    );
    assert!(serde_json::from_str::<SlideElement>(&wrong).is_err());
    assert!(serde_json::from_str::<CustomGeometry>(r#"{"path":"M","d":"x"}"#).is_err());
}
