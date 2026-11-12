//! The routes of the pptx table that are no export of the package: the
//! methods of `PackageArchive`, a JavaScript class that stays one. Each
//! answers `{ "$result": value }` like the generated rows. An archive argument
//! holds the parts the method reads (see `zip.ts`'s `parts`), not the whole
//! deck: the media never cross for a question about relationships.

use std::cell::RefCell;

use jscompat::JsNum;
use pptx_engine::embedded_fonts::{GlyphDemand, GlyphSet};
use pptx_engine::model3d::Model3dXmlOptions;
use pptx_engine::parse::ParseContextData;
use pptx_engine::zip::PackageArchive;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{InvokeEnv, pptx};

/// What a route answers: `None` is `undefined`.
pub type Out = Result<Option<Value>, String>;

fn reply(value: impl Serialize) -> Out {
    let value = jscompat::writing_for_host(|| serde_json::to_value(value))
        .map_err(|error| error.to_string())?;
    Ok(Some(pptx::answer(Some(value), Vec::new())))
}

fn archive_of(env: &InvokeEnv<'_>, args: &[Value]) -> Result<PackageArchive, String> {
    Ok(pptx::read_archive(env, args.first().unwrap_or(&Value::Null))?.archive)
}

fn text(args: &[Value], index: usize) -> Result<&str, String> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("TypeError: argument {index} is not a string"))
}

/// `PackageArchive.open(bytes)`: the archive in full.
pub fn package_archive_open(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let bytes = env.blob(args.first().unwrap_or(&Value::Null))?;
    let archive = PackageArchive::open(bytes)?;
    let answer = pptx::answer_archive_whole(env, &archive);
    Ok(Some(pptx::answer(Some(answer), Vec::new())))
}

/// `archive.readRels(partPath)`: the entries of the map, in order.
pub fn package_archive_read_rels(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let archive = archive_of(env, args)?;
    reply(archive.read_rels(text(args, 1)?)?)
}

/// `archive.readPresentation()`
pub fn package_archive_read_presentation(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let archive = archive_of(env, args)?;
    reply(archive.read_presentation()?)
}

/// `archive.resolveSlideChain(slidePath)`
pub fn package_archive_resolve_slide_chain(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {
    let archive = archive_of(env, args)?;
    reply(archive.resolve_slide_chain(text(args, 1)?)?)
}

// ---------------------------------------------------------------- helpers of the generated rows

/// The callbacks of the host as Rust closures, for the length of one call: an
/// error of the host is kept (the first one), the call goes on with `null`,
/// and `finish` throws it once the call returns.
pub struct Ask<'e, 'a> {
    env: &'e InvokeEnv<'a>,
    failed: RefCell<Option<String>>,
}

impl<'e, 'a> Ask<'e, 'a> {
    pub fn new(env: &'e InvokeEnv<'a>) -> Self {
        Self {
            env,
            failed: RefCell::new(None),
        }
    }

    /// The host function registered under `name`, called with the JSON list `arguments`.
    pub fn ask(&self, name: &str, arguments: Value) -> Value {
        self.env.callback(name, &arguments).unwrap_or_else(|error| {
            self.failed.borrow_mut().get_or_insert(error);
            Value::Null
        })
    }

    pub fn finish(self) -> Result<(), String> {
        match self.failed.into_inner() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

/// The placeholder maps and master text styles of a call, read the way a `ParseContext` reads them.
pub fn tables(
    layout: &Value,
    master: &Value,
    styles: Option<&Value>,
) -> Result<ParseContextData, String> {
    let mut object = Map::new();
    for (key, value) in [
        ("layoutPlaceholders", Some(layout)),
        ("masterPlaceholders", Some(master)),
        ("masterTextStyles", styles),
    ] {
        if let Some(value) = value.filter(|value| !value.is_null()) {
            object.insert(key.to_owned(), value.clone());
        }
    }
    serde_json::from_value(Value::Object(object)).map_err(|error| format!("TypeError: {error}"))
}

/// `Map<string, Set<number>>` as `GlyphDemand`: its entries, each a list of code points.
pub fn glyph_demand(value: &Value) -> Result<GlyphDemand, String> {
    let pairs: Vec<(String, Vec<u32>)> = serde_json::from_value(value.clone())
        .map_err(|error| format!("TypeError: demand: {error}"))?;
    let mut demand = GlyphDemand::new();
    for (key, code_points) in pairs {
        let mut set = GlyphSet::default();
        for code_point in code_points {
            set.add(code_point);
        }
        demand.set(key, set);
    }
    Ok(demand)
}

/// `[{ name, usize }]`: the declared parts of a loaded zip.
pub fn declared_parts(value: &Value) -> Result<Vec<(String, f64)>, String> {
    #[derive(Deserialize)]
    struct Declared {
        name: String,
        #[serde(rename = "usize")]
        size: JsNum,
    }
    let parts: Vec<Declared> =
        serde_json::from_value(value.clone()).map_err(|error| format!("TypeError: {error}"))?;
    Ok(parts
        .into_iter()
        .map(|part| (part.name, part.size.0))
        .collect())
}

/// `Model3dXmlOptions` as the binding sends it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model3dArg {
    id: JsNum,
    name: String,
    offset: pptx_engine::model3d::EmuRect,
    model_r_id: String,
    poster_r_id: String,
    #[serde(default)]
    bounds: Option<pptx_engine::model3d::GlbBounds>,
    #[serde(default)]
    rot: Option<pptx_engine::model3d::Model3dRotation>,
}

impl Model3dArg {
    pub fn options(&self) -> Model3dXmlOptions<'_> {
        Model3dXmlOptions {
            id: self.id,
            name: &self.name,
            offset: self.offset,
            model_r_id: &self.model_r_id,
            poster_r_id: &self.poster_r_id,
            bounds: self.bounds,
            rot: self.rot,
        }
    }
}
