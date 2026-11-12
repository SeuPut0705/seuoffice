//! Every case of `node-answers.json` was run through the real saxes 6.0.0 on
//! Node 22 (`tools/epub-diff/saxes-fixture.ts` writes it); the port must
//! answer the same list of events, key for key and in the same order.
#![cfg(feature = "record")]

use serde_json::Value;

#[test]
fn replays_the_answers_of_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("node-answers.json")).unwrap();
    assert!(cases.len() > 1000);
    let mut failures = Vec::new();
    for case in &cases {
        let label = case["label"].as_str().unwrap();
        let actual = saxes::record::run(&case["args"], case["text"].as_str().unwrap()).unwrap();
        let (actual, expected) = (
            serde_json::to_string(&actual).unwrap(),
            serde_json::to_string(&case["expected"]).unwrap(),
        );
        if actual != expected {
            failures.push(format!(
                "{label}\n  rust: {actual:.600}\n  node: {expected:.600}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
