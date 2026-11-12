//! A handler that calls `fail`, as word-extractor's reader does. The expected
//! lines are what saxes 6.0.0 printed on Node 22 for the same handlers.

use saxes::{Error, Handler, HandlerResult, Options, Parser, Tag, units};

#[derive(Default)]
struct Failing {
    log: Vec<String>,
    with_error_handler: bool,
    thrown: Option<Error>,
}

fn lossy(text: &[u16]) -> String {
    String::from_utf16_lossy(text)
}

impl Handler for Failing {
    fn wants_text(&self) -> bool {
        true
    }

    fn wants_error(&self) -> bool {
        self.with_error_handler
    }

    fn opentag(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        self.log
            .push(format!("open {} @{}", lossy(&tag.name), cx.position()));
        Ok(())
    }

    fn text(&mut self, cx: &mut Parser, text: &[u16]) -> HandlerResult {
        self.log.push(format!(
            "text {:?} @{} {}:{}",
            lossy(text),
            cx.position(),
            cx.line(),
            cx.column()
        ));
        let mut message = units("boom ");
        message.extend_from_slice(text);
        match cx.fail(&message) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.thrown = Some(error);
                Ok(())
            }
        }
    }

    fn closetag(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        self.log
            .push(format!("close {} @{}", lossy(&tag.name), cx.position()));
        Ok(())
    }

    fn error(&mut self, cx: &mut Parser, error: &Error) -> HandlerResult {
        self.log.push(format!(
            "error {} @{}",
            error.message_lossy(),
            cx.position()
        ));
        Ok(())
    }
}

#[test]
fn fail_inside_a_handler_reaches_the_error_handler() {
    let mut handler = Failing {
        with_error_handler: true,
        ..Failing::default()
    };
    let mut parser = Parser::new(Options::default()).unwrap();
    parser.write_str(&mut handler, "<a>x").unwrap();
    parser.write_str(&mut handler, "y</a>\n").unwrap();
    parser.close(&mut handler).unwrap();
    assert_eq!(
        handler.log,
        [
            "open a @3",
            "text \"xy\" @6 1:6",
            "error 1:6: boom xy @6",
            "close a @9",
            "text \"\\n\" @10 2:0",
            "error 2:0: boom \n @10",
        ]
    );
}

#[test]
fn fail_without_an_error_handler_is_an_error() {
    let mut handler = Failing::default();
    let mut parser = Parser::new(Options::default()).unwrap();
    parser.write_str(&mut handler, "<a>x</a>").unwrap();
    parser.close(&mut handler).unwrap();
    let error = handler.thrown.expect("fail returned its error");
    assert_eq!(error.message_lossy(), "1:5: boom x");
}

#[test]
fn constructor_errors_have_no_position() {
    let options = Options {
        xmlns: true,
        additional_namespaces: Some(vec![(units("xml"), units("urn:x"))]),
        ..Options::default()
    };
    let Err(error) = Parser::new(options) else {
        panic!("a bad xml binding is refused");
    };
    assert_eq!(
        error.message_lossy(),
        "undefined:undefined: xml prefix must be bound to http://www.w3.org/XML/1998/namespace."
    );
}
