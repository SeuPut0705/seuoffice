//! Read queries of the open deck and the comment and link edits: notes,
//! comments, links, header and footer, transition, show timing, animations,
//! morph keys.

use main_core::packages::electron_utils::author_name::configured_author_name;
use main_core::packages::electron_utils::safe_external_url::{
    SafeExternalUrlOptions, safe_external_url,
};
use main_core::slides::session_state::OpSource;
use shell_contract::ipc::CallContext;
use shell_contract::runtime::PathName;
use shell_contract::{IpcError, IpcValue};

use super::engine::TxnRequest;
use super::session::{null, op, prop, slide_index, target};
use super::state::App;
use super::{Route, now};
use crate::host::path_string;
use crate::value::{Args, as_str, field, obj, or_null, string};

type Reply = Result<IpcValue, IpcError>;

pub fn routes(app: &App) -> Vec<Route> {
    vec![
        now(app, "slides:get-notes", get_notes),
        now(app, "slides:get-comments", get_comments),
        now(app, "slides:get-all-comments", get_all_comments),
        now(app, "slides:add-comment", add_comment),
        now(app, "slides:delete-comment", delete_comment),
        now(app, "slides:get-link", get_link),
        now(app, "slides:set-link", set_link),
        now(app, "slides:get-slide-links", get_slide_links),
        now(app, "slides:get-run-links", get_run_links),
        now(app, "slides:get-header-footer", get_header_footer),
        now(app, "slides:get-transition", get_transition),
        now(app, "slides:get-show-timing", get_show_timing),
        now(app, "slides:get-animations", get_animations),
        now(app, "slides:get-shape-keys", get_shape_keys),
    ]
}

impl App {
    /// `commentAuthorName()`: Settings > General author name, else the OS account
    fn comment_author_name(&self) -> String {
        let user_data = path_string(self.services.paths.path(PathName::UserData));
        let username = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .ok();
        configured_author_name(&user_data, username.as_deref())
    }
}

/// `session?.opened.deck.slides[slideIndex]`: the session's deck and the slide
fn with_slide<R>(
    app: &App,
    cx: &CallContext,
    slide: &IpcValue,
    f: impl FnOnce(&super::state::SlideSession, usize) -> R,
) -> Option<R> {
    let state = app.state.borrow();
    let s = state.session(cx.sender.view)?;
    let index = slide_index(slide, app.engine.slide_paths(s.deck()).len())?;
    Some(f(s, index))
}

pub fn get_notes(app: &App, cx: &CallContext, args: Args) -> Reply {
    Ok(string(
        with_slide(app, cx, args.get(0), |s, i| {
            app.engine.slide_notes(s.deck(), i)
        })
        .unwrap_or_default(),
    ))
}

pub fn get_comments(app: &App, cx: &CallContext, args: Args) -> Reply {
    Ok(with_slide(app, cx, args.get(0), |s, i| {
        app.engine.slide_comments(s.deck(), i)
    })
    .unwrap_or(IpcValue::Array(Vec::new())))
}

pub fn get_all_comments(app: &App, cx: &CallContext, _args: Args) -> Reply {
    let state = app.state.borrow();
    let Some(s) = state.session(cx.sender.view) else {
        return Ok(IpcValue::Array(Vec::new()));
    };
    let count = app.engine.slide_paths(s.deck()).len();
    Ok(IpcValue::Array(
        (0..count)
            .map(|i| app.engine.slide_comments(s.deck(), i))
            .collect(),
    ))
}

/// A comment op, answering the slide's comments
fn comment_edit(
    app: &App,
    cx: &CallContext,
    args: &Args,
    build: impl FnOnce(&App, &IpcValue) -> IpcValue,
) -> Reply {
    let op_value = args.get(0);
    let mut state = app.state.borrow_mut();
    let Some(s) = state.session_mut(cx.sender.view) else {
        return null();
    };
    let slide = prop(op_value, "slideIndex")?;
    let Some(index) = slide_index(slide, app.engine.slide_paths(s.deck()).len()) else {
        return null();
    };
    let o = build(app, slide);
    if app
        .session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
        .is_none()
    {
        return null();
    }
    s.core.mark_meta_dirty();
    Ok(app.engine.slide_comments(s.deck(), index))
}

pub fn add_comment(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0).clone();
    comment_edit(app, cx, &args, |app, slide| {
        op("addComment")
            .set("target", target(slide, None))
            .set("author", string(app.comment_author_name()))
            .set("text", field(&op_value, "text").clone())
            .build()
    })
}

pub fn delete_comment(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0).clone();
    comment_edit(app, cx, &args, |_, slide| {
        op("deleteComment")
            .set("target", target(slide, None))
            .set("authorId", field(&op_value, "authorId").clone())
            .set("idx", field(&op_value, "idx").clone())
            .build()
    })
}

pub fn get_link(app: &App, cx: &CallContext, args: Args) -> Reply {
    let state = app.state.borrow();
    let Some(s) = state.session(cx.sender.view) else {
        return null();
    };
    Ok(app.engine.element_link(s.deck(), args.get(0), args.get(1)))
}

/// the schemes a deck link may carry into the package (`DECK_LINK_PROTOCOLS`)
fn deck_link_protocols() -> SafeExternalUrlOptions {
    SafeExternalUrlOptions {
        allowed_protocols: Some(vec!["http:".into(), "https:".into(), "mailto:".into()]),
    }
}

pub fn set_link(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let link = prop(op_value, "target");
        // a javascript: or file: target must never be saved into the package
        if let Ok(link) = link
            && as_str(field(link, "kind")) == Some("url")
            && safe_external_url(as_str(field(link, "url")), Some(&deck_link_protocols())).is_none()
        {
            return null();
        }
        let slide = prop(op_value, "slideIndex")?;
        let o = op("setLink")
            .set("target", target(slide, Some(field(op_value, "sourceId"))))
            .set("link", field(op_value, "target").clone())
            .build();
        Ok(
            match app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) {
                Some(_) => or_null(app.rebuild_slide(s, slide)),
                None => IpcValue::Null,
            },
        )
    })
}

pub fn get_slide_links(app: &App, cx: &CallContext, args: Args) -> Reply {
    let state = app.state.borrow();
    let Some(s) = state.session(cx.sender.view) else {
        return Ok(IpcValue::Array(Vec::new()));
    };
    let IpcValue::Array(items) = app.engine.slide_links(s.deck(), args.get(0)) else {
        return Ok(IpcValue::Array(Vec::new()));
    };
    Ok(IpcValue::Array(
        items
            .iter()
            .map(|item| {
                obj([
                    ("sourceId", field(item, "elementId").clone()),
                    ("target", field(item, "target").clone()),
                ])
            })
            .collect(),
    ))
}

pub fn get_run_links(app: &App, cx: &CallContext, args: Args) -> Reply {
    let state = app.state.borrow();
    let Some(s) = state.session(cx.sender.view) else {
        return Ok(IpcValue::Array(Vec::new()));
    };
    let IpcValue::Array(items) = app.engine.run_links(s.deck(), args.get(0)) else {
        return Ok(IpcValue::Array(Vec::new()));
    };
    Ok(IpcValue::Array(
        items
            .into_iter()
            .map(|item| match item {
                // `{ elementId, ...rest }` -> `{ sourceId: elementId, ...rest }`
                IpcValue::Object(entries) => {
                    let element_id = entries
                        .iter()
                        .find(|(k, _)| k == "elementId")
                        .map_or(IpcValue::Undefined, |(_, v)| v.clone());
                    let mut out = vec![("sourceId".to_owned(), element_id)];
                    out.extend(entries.into_iter().filter(|(k, _)| k != "elementId"));
                    IpcValue::Object(out)
                }
                other => other,
            })
            .collect(),
    ))
}

pub fn get_header_footer(app: &App, cx: &CallContext, args: Args) -> Reply {
    Ok(with_slide(app, cx, args.get(0), |s, i| {
        app.engine.header_footer(s.deck(), i)
    })
    .unwrap_or_else(|| {
        obj([
            ("footer", IpcValue::Null),
            ("slideNum", IpcValue::Bool(false)),
            ("date", IpcValue::Null),
        ])
    }))
}

pub fn get_transition(app: &App, cx: &CallContext, args: Args) -> Reply {
    Ok(with_slide(app, cx, args.get(0), |s, i| {
        app.engine.slide_transition(s.deck(), i)
    })
    .unwrap_or_else(|| string("none")))
}

pub fn get_show_timing(app: &App, cx: &CallContext, args: Args) -> Reply {
    Ok(with_slide(app, cx, args.get(0), |s, i| {
        app.engine.show_timing(s.deck(), i)
    })
    .unwrap_or_else(|| {
        obj([
            ("advanceMs", IpcValue::Null),
            ("narrationIds", IpcValue::Array(Vec::new())),
        ])
    }))
}

pub fn get_animations(app: &App, cx: &CallContext, args: Args) -> Reply {
    let labels: Vec<(String, String)> = [
        ("text", "labelTextBox"),
        ("shape", "labelShape"),
        ("picture", "labelPicture"),
        ("group", "labelGroup"),
        ("table", "labelTable"),
        ("chart", "labelChart"),
        ("passthrough", "labelObject"),
        ("object", "labelObject"),
    ]
    .into_iter()
    .map(|(kind, key)| (kind.to_owned(), app.tm(key, &[])))
    .collect();
    Ok(with_slide(app, cx, args.get(0), |s, i| {
        app.engine.animations(s.deck(), i, &labels)
    })
    .unwrap_or(IpcValue::Array(Vec::new())))
}

pub fn get_shape_keys(app: &App, cx: &CallContext, args: Args) -> Reply {
    Ok(with_slide(app, cx, args.get(0), |s, i| {
        app.engine.shape_keys(s.deck(), i)
    })
    .unwrap_or(IpcValue::Array(Vec::new())))
}
