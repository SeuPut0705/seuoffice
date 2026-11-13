//! `packages/electron-utils/src/context-menu.ts`: the native right-click
//! menu for surfaces without a self-drawn one (AI panel, inputs, chrome).
//!
//! What the menu holds and what each entry does is decided here; the caller
//! listens for Electron's `context-menu` event, asks the window's interceptor
//! first ([`ContextMenuInterceptors`], [`after_interceptor`]), pops up
//! [`context_menu_template`] with Electron's `Menu`, and carries out the
//! [`MenuCommand`] of a clicked entry on the `webContents`.

use std::collections::HashMap;

use jscompat::{js_regex, trim};
use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};

/// Native "View Image" hands the src to the renderer, which owns the viewer overlay
pub const VIEW_IMAGE_CHANNEL: &str = "seuoffice:view-image";

/// `ContextMenuLabels`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuLabels {
    pub cut: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub select_all: &'static str,
    pub view_image: &'static str,
    pub copy_image: &'static str,
    pub save_image_as: &'static str,
}

const EN: ContextMenuLabels = ContextMenuLabels {
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    view_image: "View Image",
    copy_image: "Copy Image",
    save_image_as: "Save Image As\u{2026}",
};

const KO: ContextMenuLabels = ContextMenuLabels {
    cut: "\u{C798}\u{B77C}\u{B0B4}\u{AE30}",
    copy: "\u{BCF5}\u{C0AC}",
    paste: "\u{BD99}\u{C5EC}\u{B123}\u{AE30}",
    select_all: "\u{BAA8}\u{B450} \u{C120}\u{D0DD}",
    view_image: "\u{C774}\u{BBF8}\u{C9C0} \u{BCF4}\u{AE30}",
    copy_image: "\u{C774}\u{BBF8}\u{C9C0} \u{BCF5}\u{C0AC}",
    save_image_as: "\u{C774}\u{BBF8}\u{C9C0}\u{B97C} \u{B2E4}\u{B978} \u{C774}\u{B984}\u{C73C}\u{B85C} \u{C800}\u{C7A5}\u{2026}",
};

/// `LABELS[lang]`
fn labels_of(lang: &str) -> Option<ContextMenuLabels> {
    match lang {
        "en" => Some(EN),
        "ko" => Some(KO),
        _ => None,
    }
}

/// `baseLang(lang)`: the language before its first `-`
pub fn base_lang(lang: &str) -> &str {
    lang.split('-').next().unwrap_or(lang)
}

/// `contextMenuLabels(lang)`: the table of the language, of its base
/// language, or English.
pub fn context_menu_labels(lang: &str) -> ContextMenuLabels {
    labels_of(lang)
        .or_else(|| labels_of(base_lang(lang)))
        .unwrap_or(EN)
}

/// `editFlags` of Electron's `ContextMenuParams`, the four the menu reads
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EditFlags {
    pub can_cut: bool,
    pub can_copy: bool,
    pub can_paste: bool,
    pub can_select_all: bool,
}

/// The fields of Electron's `ContextMenuParams` the menu reads.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ContextMenuParams {
    pub is_editable: bool,
    pub selection_text: String,
    pub misspelled_word: String,
    pub dictionary_suggestions: Vec<String>,
    pub edit_flags: EditFlags,
    pub media_type: Option<String>,
    pub src_url: Option<String>,
    /// where the click was, for "Copy Image"
    pub x: f64,
    pub y: f64,
}

/// The four editing commands, by the name of the `webContents` method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditAction {
    Cut,
    Copy,
    Paste,
    SelectAll,
}

impl EditAction {
    /// the action's name, and the `webContents` method it calls
    pub fn name(self) -> &'static str {
        match self {
            EditAction::Cut => "cut",
            EditAction::Copy => "copy",
            EditAction::Paste => "paste",
            EditAction::SelectAll => "selectAll",
        }
    }
}

/// The three image entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageAction {
    ViewImage,
    CopyImage,
    SaveImageAs,
}

impl ImageAction {
    pub fn name(self) -> &'static str {
        match self {
            ImageAction::ViewImage => "viewImage",
            ImageAction::CopyImage => "copyImage",
            ImageAction::SaveImageAs => "saveImageAs",
        }
    }
}

/// `ContextMenuItem`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextMenuItem {
    Separator,
    ReplaceMisspelling {
        label: String,
    },
    Edit {
        action: EditAction,
        label: String,
        enabled: bool,
    },
    Image {
        action: ImageAction,
        label: String,
    },
}

impl Serialize for ContextMenuItem {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self {
            ContextMenuItem::Separator => map.serialize_entry("type", "separator")?,
            ContextMenuItem::ReplaceMisspelling { label } => {
                map.serialize_entry("action", "replaceMisspelling")?;
                map.serialize_entry("label", label)?;
            }
            ContextMenuItem::Edit {
                action,
                label,
                enabled,
            } => {
                map.serialize_entry("action", action.name())?;
                map.serialize_entry("label", label)?;
                map.serialize_entry("enabled", enabled)?;
            }
            ContextMenuItem::Image { action, label } => {
                map.serialize_entry("action", action.name())?;
                map.serialize_entry("label", label)?;
            }
        }
        map.end()
    }
}

/// `buildContextMenuItems(params, labels)`: empty means no menu.
pub fn build_context_menu_items(
    params: &ContextMenuParams,
    labels: &ContextMenuLabels,
) -> Vec<ContextMenuItem> {
    let rest = build_edit_items(params, labels);
    let has_image_src = params.src_url.as_deref().is_some_and(|src| !src.is_empty());
    if params.media_type.as_deref() != Some("image") || !has_image_src {
        return rest;
    }
    let mut image = vec![
        ContextMenuItem::Image {
            action: ImageAction::ViewImage,
            label: labels.view_image.to_owned(),
        },
        ContextMenuItem::Image {
            action: ImageAction::CopyImage,
            label: labels.copy_image.to_owned(),
        },
        ContextMenuItem::Image {
            action: ImageAction::SaveImageAs,
            label: labels.save_image_as.to_owned(),
        },
    ];
    if !rest.is_empty() {
        image.push(ContextMenuItem::Separator);
        image.extend(rest);
    }
    image
}

fn edit_item(action: EditAction, label: &str, enabled: bool) -> ContextMenuItem {
    ContextMenuItem::Edit {
        action,
        label: label.to_owned(),
        enabled,
    }
}

fn build_edit_items(
    params: &ContextMenuParams,
    labels: &ContextMenuLabels,
) -> Vec<ContextMenuItem> {
    let flags = params.edit_flags;
    if params.is_editable {
        let mut items = Vec::new();
        if !params.misspelled_word.is_empty() && !params.dictionary_suggestions.is_empty() {
            for word in &params.dictionary_suggestions {
                items.push(ContextMenuItem::ReplaceMisspelling {
                    label: word.clone(),
                });
            }
            items.push(ContextMenuItem::Separator);
        }
        items.extend([
            edit_item(EditAction::Cut, labels.cut, flags.can_cut),
            edit_item(EditAction::Copy, labels.copy, flags.can_copy),
            edit_item(EditAction::Paste, labels.paste, flags.can_paste),
            ContextMenuItem::Separator,
            edit_item(
                EditAction::SelectAll,
                labels.select_all,
                flags.can_select_all,
            ),
        ]);
        return items;
    }
    if !trim(&params.selection_text).is_empty() {
        return vec![
            edit_item(EditAction::Copy, labels.copy, flags.can_copy),
            edit_item(
                EditAction::SelectAll,
                labels.select_all,
                flags.can_select_all,
            ),
        ];
    }
    Vec::new()
}

/// What a clicked entry does to the `webContents` it was opened on.
#[derive(Debug, Clone, PartialEq)]
pub enum MenuCommand {
    /// `contents.replaceMisspelling(word)`
    ReplaceMisspelling(String),
    /// `contents.send(VIEW_IMAGE_CHANNEL, srcURL)`
    ViewImage(Option<String>),
    /// `contents.copyImageAt(x, y)`
    CopyImageAt { x: f64, y: f64 },
    /// `saveImageFromUrl(BrowserWindow.fromWebContents(contents), srcURL, { title })`
    SaveImageAs {
        src_url: Option<String>,
        title: String,
    },
    /// `contents[action]()`
    Edit(EditAction),
}

/// One entry of the template `Menu.buildFromTemplate` is given.
#[derive(Debug, Clone, PartialEq)]
pub enum MenuEntry {
    Separator,
    Item {
        label: String,
        /// left out for the entries that are always enabled
        enabled: Option<bool>,
        click: MenuCommand,
    },
}

/// The template `popupMenu` builds for these params; empty means no menu.
pub fn context_menu_template(
    params: &ContextMenuParams,
    labels: &ContextMenuLabels,
) -> Vec<MenuEntry> {
    build_context_menu_items(params, labels)
        .into_iter()
        .map(|item| match item {
            ContextMenuItem::Separator => MenuEntry::Separator,
            ContextMenuItem::ReplaceMisspelling { label } => MenuEntry::Item {
                click: MenuCommand::ReplaceMisspelling(label.clone()),
                label,
                enabled: None,
            },
            ContextMenuItem::Image { action, label } => {
                let click = match action {
                    ImageAction::ViewImage => MenuCommand::ViewImage(params.src_url.clone()),
                    ImageAction::CopyImage => MenuCommand::CopyImageAt {
                        x: params.x,
                        y: params.y,
                    },
                    ImageAction::SaveImageAs => MenuCommand::SaveImageAs {
                        src_url: params.src_url.clone(),
                        title: js_regex!(r"\u2026$").replace_all(&label, |_| String::new()),
                    },
                };
                MenuEntry::Item {
                    label,
                    enabled: None,
                    click,
                }
            }
            ContextMenuItem::Edit {
                action,
                label,
                enabled,
            } => MenuEntry::Item {
                label,
                enabled: Some(enabled),
                click: MenuCommand::Edit(action),
            },
        })
        .collect()
}

/// `setContextMenuInterceptor` and the lookup of `installContextMenu`: the
/// interceptor of each `webContents`, by its id. The TypeScript keeps the
/// table on the `app` object; the caller keeps this one.
pub struct ContextMenuInterceptors<I> {
    by_contents: HashMap<u64, I>,
}

impl<I> Default for ContextMenuInterceptors<I> {
    fn default() -> Self {
        ContextMenuInterceptors {
            by_contents: HashMap::new(),
        }
    }
}

impl<I> ContextMenuInterceptors<I> {
    /// `setContextMenuInterceptor(app, contents, interceptor)`; `None` removes it
    pub fn set(&mut self, contents_id: u64, interceptor: Option<I>) {
        match interceptor {
            Some(interceptor) => {
                self.by_contents.insert(contents_id, interceptor);
            }
            None => {
                self.by_contents.remove(&contents_id);
            }
        }
    }

    pub fn get(&self, contents_id: u64) -> Option<&I> {
        self.by_contents.get(&contents_id)
    }
}

/// Whether the native menu shows after the interceptor answered: `Ok(true)`
/// means the renderer showed its own menu; a thrown interceptor did not
/// handle it after all.
pub fn after_interceptor<E>(answer: Option<Result<bool, E>>) -> bool {
    !matches!(answer, Some(Ok(true)))
}
