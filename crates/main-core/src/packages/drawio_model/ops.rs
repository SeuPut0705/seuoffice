//! `packages/drawio-model/src/ops.ts`: the diagram ops as data. The MCP
//! diagram tools are built from these definitions and the planner checks
//! input against the same schema. Only the table and its types are here
//! (`diagramOpDefinition`, `opsNeedApp`, `checkOpInput` are not on the MCP
//! modules' path).
//!
//! The types serialize (`serde`) with their keys in the order of the
//! TypeScript literals: `type`, `enum`, `items`, `exclusiveMinimum`,
//! `minLength`, `minItems`, `default`, `description` for a property; a key the
//! property does not have is left out.

use std::sync::LazyLock;

use serde::Serialize;

/// `SHAPE_NAMES` of `packages/drawio-model/src/style.ts`, which the `shape`
/// property of `add_shape` lists.
pub const SHAPE_NAMES: [&str; 12] = [
    "rectangle",
    "rounded",
    "ellipse",
    "rhombus",
    "parallelogram",
    "hexagon",
    "cylinder",
    "document",
    "cloud",
    "actor",
    "text",
    "note",
];

/// `ARROWS` of `style.ts`, which the `arrow` property of `add_edge` lists.
pub const ARROWS: [&str; 3] = ["end", "none", "both"];

/// `DIAGRAM_OP_NAMES`
pub const DIAGRAM_OP_NAMES: [&str; 9] = [
    "read",
    "add_shape",
    "add_edge",
    "update",
    "delete",
    "add_page",
    "rename_page",
    "delete_page",
    "insert_mermaid",
];

/// `OpPropertySchema['type']`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OpPropertyType {
    String,
    Number,
    Array,
}

/// `OpPropertySchema['default']`: `number | string`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OpDefault {
    Number(f64),
    Text(String),
}

/// `OpPropertySchema['items']`: `{ type: 'string' }`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpItems {
    #[serde(rename = "type")]
    pub kind: &'static str,
}

/// `OpPropertySchema`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpPropertySchema {
    #[serde(rename = "type")]
    pub kind: OpPropertyType,
    /// `enum`
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<&'static str>>,
    /// for arrays: the item type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<OpItems>,
    /// for numbers: values must be greater than this
    #[serde(rename = "exclusiveMinimum", skip_serializing_if = "Option::is_none")]
    pub exclusive_minimum: Option<f64>,
    #[serde(rename = "minLength", skip_serializing_if = "Option::is_none")]
    pub min_length: Option<f64>,
    #[serde(rename = "minItems", skip_serializing_if = "Option::is_none")]
    pub min_items: Option<f64>,
    #[serde(rename = "default", skip_serializing_if = "Option::is_none")]
    pub default: Option<OpDefault>,
    pub description: String,
}

impl OpPropertySchema {
    fn of(kind: OpPropertyType, description: impl Into<String>) -> OpPropertySchema {
        OpPropertySchema {
            kind,
            enum_values: None,
            items: None,
            exclusive_minimum: None,
            min_length: None,
            min_items: None,
            default: None,
            description: description.into(),
        }
    }
}

/// `OpInputSchema`: `properties` is a record whose keys keep the order the
/// literal gives them.
#[derive(Debug, Clone, PartialEq)]
pub struct OpInputSchema {
    pub properties: Vec<(&'static str, OpPropertySchema)>,
    pub required: Vec<&'static str>,
}

impl OpInputSchema {
    /// `properties[key]`
    pub fn property(&self, key: &str) -> Option<&OpPropertySchema> {
        self.properties
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, prop)| prop)
    }
}

impl Serialize for OpInputSchema {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        struct Properties<'a>(&'a [(&'static str, OpPropertySchema)]);
        impl Serialize for Properties<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(self.0.len()))?;
                for (key, prop) in self.0 {
                    map.serialize_entry(key, prop)?;
                }
                map.end()
            }
        }
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("type", "object")?;
        map.serialize_entry("properties", &Properties(&self.properties))?;
        map.serialize_entry("required", &self.required)?;
        map.serialize_entry("additionalProperties", &false)?;
        map.end()
    }
}

/// `DiagramOpDefinition`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiagramOpDefinition {
    pub name: &'static str,
    pub description: String,
    /// false for `read`, which never changes the diagram
    pub changes: bool,
    /// only the app can carry the op out (the Mermaid converter runs in
    /// draw.io): `needsApp?: true`
    #[serde(rename = "needsApp", skip_serializing_if = "Option::is_none")]
    pub needs_app: Option<bool>,
    pub input: OpInputSchema,
}

/// `DiagramPageListItem` of `table.ts`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiagramPageListItem {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<bool>,
}

/// `DiagramShapeRow` of `table.ts`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiagramShapeRow {
    pub id: String,
    pub label: String,
    pub shape: String,
    /// as stored: relative to `parent` when there is one
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<String>,
}

/// `DiagramEdgeRow` of `table.ts`; `source` and `target` are `null` for a
/// loose end
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiagramEdgeRow {
    pub id: String,
    pub label: String,
    pub source: Option<String>,
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// `DiagramPageTable` of `table.ts`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiagramPageTable {
    pub id: String,
    pub name: String,
    pub shapes: Vec<DiagramShapeRow>,
    pub edges: Vec<DiagramEdgeRow>,
    /// in the app only: the ids the person has selected on this page
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<Vec<String>>,
}

/// `DiagramReadResult` of `table.ts`: one page read, with the page list.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiagramReadResult {
    pub pages: Vec<DiagramPageListItem>,
    pub page: DiagramPageTable,
}

// ---- the property builders of the file ----

fn text(description: &str) -> OpPropertySchema {
    OpPropertySchema::of(OpPropertyType::String, description)
}

fn number(description: &str) -> OpPropertySchema {
    OpPropertySchema::of(OpPropertyType::Number, description)
}

/// `PAGE`
fn page() -> OpPropertySchema {
    text("Page id or name. Default: the current page in the app, the first page elsewhere.")
}

/// `NEW_ID`
fn new_id() -> OpPropertySchema {
    OpPropertySchema {
        min_length: Some(1.0),
        ..text("Id for the new element. Must not exist in the file. Default: a new unique id.")
    }
}

/// `STYLE_FULL(what)`
fn style_full(what: &str) -> OpPropertySchema {
    text(&format!(
        "draw.io style string (key=value; pairs) for the {what}."
    ))
}

/// `schema(properties, required)`
fn schema(
    properties: Vec<(&'static str, OpPropertySchema)>,
    required: Vec<&'static str>,
) -> OpInputSchema {
    OpInputSchema {
        properties,
        required,
    }
}

/// `DIAGRAM_OPS`: every op, in order.
pub static DIAGRAM_OPS: LazyLock<Vec<DiagramOpDefinition>> = LazyLock::new(|| {
    vec![
        DiagramOpDefinition {
            name: "read",
            description: "Read one page as a table of shapes (id, label, shape, x, y, width, height, parent, fill, stroke) and edges (id, label, source, target, parent), with the page list. Changes nothing.".to_owned(),
            changes: false,
            needs_app: None,
            input: schema(vec![("page", page())], vec![]),
        },
        DiagramOpDefinition {
            name: "add_shape",
            description: "Add a shape. `style` replaces the style of `shape` when both are given. x and y are relative to `parent` when it is set.".to_owned(),
            changes: true,
            needs_app: None,
            input: schema(
                vec![
                    ("page", page()),
                    ("id", new_id()),
                    ("label", text("Plain text; line breaks stay line breaks.")),
                    (
                        "shape",
                        OpPropertySchema {
                            enum_values: Some(SHAPE_NAMES.to_vec()),
                            default: Some(OpDefault::Text("rectangle".to_owned())),
                            ..text("Shape kind.")
                        },
                    ),
                    ("style", style_full("shape")),
                    ("x", number("Left edge.")),
                    ("y", number("Top edge.")),
                    (
                        "width",
                        OpPropertySchema {
                            exclusive_minimum: Some(0.0),
                            default: Some(OpDefault::Number(120.0)),
                            ..number("Width.")
                        },
                    ),
                    (
                        "height",
                        OpPropertySchema {
                            exclusive_minimum: Some(0.0),
                            default: Some(OpDefault::Number(60.0)),
                            ..number("Height.")
                        },
                    ),
                    (
                        "parent",
                        text("Id of a group or container shape on the same page to put the shape in."),
                    ),
                ],
                vec!["label", "x", "y"],
            ),
        },
        DiagramOpDefinition {
            name: "add_edge",
            description: "Connect two shapes of the same page with an edge.".to_owned(),
            changes: true,
            needs_app: None,
            input: schema(
                vec![
                    ("page", page()),
                    ("id", new_id()),
                    ("source", text("Id of the shape the edge starts at.")),
                    ("target", text("Id of the shape the edge ends at.")),
                    ("label", text("Plain text.")),
                    (
                        "arrow",
                        OpPropertySchema {
                            enum_values: Some(ARROWS.to_vec()),
                            default: Some(OpDefault::Text("end".to_owned())),
                            ..text("Arrowheads: at the end, none, or both ends.")
                        },
                    ),
                    ("style", style_full("edge")),
                ],
                vec!["source", "target"],
            ),
        },
        DiagramOpDefinition {
            name: "update",
            description: "Change a shape or an edge. `style` is merged over the existing style: each key=value; pair replaces that key, an empty value (key=;) removes it. Edges take only label and style.".to_owned(),
            changes: true,
            needs_app: None,
            input: schema(
                vec![
                    ("id", text("Id of the shape or edge.")),
                    ("page", page()),
                    ("label", text("Plain text; line breaks stay line breaks.")),
                    ("style", text("key=value; pairs to merge into the style.")),
                    ("x", number("Left edge.")),
                    ("y", number("Top edge.")),
                    (
                        "width",
                        OpPropertySchema {
                            exclusive_minimum: Some(0.0),
                            ..number("Width.")
                        },
                    ),
                    (
                        "height",
                        OpPropertySchema {
                            exclusive_minimum: Some(0.0),
                            ..number("Height.")
                        },
                    ),
                ],
                vec!["id"],
            ),
        },
        DiagramOpDefinition {
            name: "delete",
            description: "Delete shapes and edges. Deleting a shape also deletes the shapes inside it and every edge connected to them.".to_owned(),
            changes: true,
            needs_app: None,
            input: schema(
                vec![
                    (
                        "ids",
                        OpPropertySchema {
                            items: Some(OpItems { kind: "string" }),
                            min_items: Some(1.0),
                            ..OpPropertySchema::of(OpPropertyType::Array, "Ids to delete.")
                        },
                    ),
                    ("page", page()),
                ],
                vec!["ids"],
            ),
        },
        DiagramOpDefinition {
            name: "add_page",
            description: "Add an empty page after the last page.".to_owned(),
            changes: true,
            needs_app: None,
            input: schema(
                vec![
                    (
                        "name",
                        OpPropertySchema {
                            min_length: Some(1.0),
                            ..text("Page name.")
                        },
                    ),
                    ("id", new_id()),
                ],
                vec!["name"],
            ),
        },
        DiagramOpDefinition {
            name: "rename_page",
            description: "Rename a page.".to_owned(),
            changes: true,
            needs_app: None,
            input: schema(
                vec![
                    ("page", text("Page id or name.")),
                    (
                        "name",
                        OpPropertySchema {
                            min_length: Some(1.0),
                            ..text("New name.")
                        },
                    ),
                ],
                vec!["page", "name"],
            ),
        },
        DiagramOpDefinition {
            name: "delete_page",
            description: "Delete a page. The last remaining page cannot be deleted.".to_owned(),
            changes: true,
            needs_app: None,
            input: schema(vec![("page", text("Page id or name."))], vec!["page"]),
        },
        DiagramOpDefinition {
            name: "insert_mermaid",
            description: "Draw a Mermaid diagram as shapes on the page. Without x and y it goes to the free space right of the existing drawing (the origin on an empty page). Needs the app.".to_owned(),
            changes: true,
            needs_app: Some(true),
            input: schema(
                vec![
                    ("page", page()),
                    (
                        "text",
                        OpPropertySchema {
                            min_length: Some(1.0),
                            ..text("Mermaid source.")
                        },
                    ),
                    ("x", number("Left edge of the inserted drawing.")),
                    ("y", number("Top edge of the inserted drawing.")),
                ],
                vec!["text"],
            ),
        },
    ]
});
