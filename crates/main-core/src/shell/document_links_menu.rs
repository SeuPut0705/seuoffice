//! `apps/shell/src/main/document-links-menu.ts`.
//!
//! A `MenuItemConstructorOptions` is a [`MenuItem`]; its `click` closure is a
//! [`MenuClick`], which [`MenuClick::run`] performs through the input's
//! `onMake` and `onOpen`. `click` is not part of the item's JSON (as
//! `JSON.stringify` drops a function).

use serde::Serialize;

use crate::shell::document_links::{DocumentLinkMenuModel, LinkMenuEntry};

/// `DocumentLinkMenuLabels`
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentLinkMenuLabels {
    pub make: String,
    pub sources: String,
    pub derived: String,
}

/// `onMake` and `onOpen` of `DocumentLinkMenuInput`
pub trait DocumentLinkMenuHandlers {
    fn on_make(&mut self);
    fn on_open(&mut self, path: &str);
}

/// what an item's `click` does
#[derive(Debug, Clone, PartialEq)]
pub enum MenuClick {
    Make,
    Open(String),
}

impl MenuClick {
    pub fn run(&self, handlers: &mut dyn DocumentLinkMenuHandlers) {
        match self {
            MenuClick::Make => handlers.on_make(),
            MenuClick::Open(path) => handlers.on_open(path),
        }
    }
}

/// `MenuItemConstructorOptions`, the keys these entries use, in the order any
/// of the entries writes them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MenuItem {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub item_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sublabel: Option<String>,
    #[serde(rename = "toolTip", skip_serializing_if = "Option::is_none")]
    pub tool_tip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submenu: Option<Vec<MenuItem>>,
    #[serde(skip)]
    pub click: Option<MenuClick>,
}

impl MenuItem {
    /// every `click` of the items, the item before its submenu
    pub fn run_clicks(items: &[MenuItem], handlers: &mut dyn DocumentLinkMenuHandlers) {
        for item in items {
            if let Some(click) = &item.click {
                click.run(handlers);
            }
            if let Some(submenu) = &item.submenu {
                MenuItem::run_clicks(submenu, handlers);
            }
        }
    }
}

fn file_items(entries: &[LinkMenuEntry], is_mac: bool) -> Vec<MenuItem> {
    entries
        .iter()
        .map(|entry| MenuItem {
            item_type: None,
            id: None,
            label: Some(entry.name.clone()),
            sublabel: if is_mac {
                None
            } else {
                Some(entry.path.clone())
            },
            tool_tip: Some(entry.path.clone()),
            enabled: Some(!entry.missing),
            submenu: None,
            click: Some(MenuClick::Open(entry.path.clone())),
        })
        .collect()
}

/// `documentLinkMenuItems(input)`: the entries, led by their own separator.
/// `is_mac`: macOS shows no sublabel; elsewhere the full path sits under the name.
pub fn document_link_menu_items(
    model: &DocumentLinkMenuModel,
    labels: &DocumentLinkMenuLabels,
    is_mac: bool,
) -> Vec<MenuItem> {
    let mut items = vec![
        MenuItem {
            item_type: Some("separator"),
            id: None,
            label: None,
            sublabel: None,
            tool_tip: None,
            enabled: None,
            submenu: None,
            click: None,
        },
        MenuItem {
            item_type: None,
            id: Some("document-links-make"),
            label: Some(labels.make.clone()),
            sublabel: None,
            tool_tip: None,
            enabled: None,
            submenu: None,
            click: Some(MenuClick::Make),
        },
    ];
    if !model.sources.is_empty() {
        items.push(MenuItem {
            item_type: None,
            id: Some("document-links-sources"),
            label: Some(labels.sources.clone()),
            sublabel: None,
            tool_tip: None,
            enabled: None,
            submenu: Some(file_items(&model.sources, is_mac)),
            click: None,
        });
    }
    if !model.derived.is_empty() {
        items.push(MenuItem {
            item_type: None,
            id: Some("document-links-derived"),
            label: Some(labels.derived.clone()),
            sublabel: None,
            tool_tip: None,
            enabled: None,
            submenu: Some(file_items(&model.derived, is_mac)),
            click: None,
        });
    }
    items
}
