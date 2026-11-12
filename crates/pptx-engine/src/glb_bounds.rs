//! The bounding box of a glTF binary (.glb) scene, from its JSON chunk alone
//! (packages/pptx-engine/src/glb-bounds.ts): each mesh's POSITION accessor
//! min/max, carried through the node hierarchy of the default scene.
//! PowerPoint frames a 3D model from this box (am3d:meterPerModelUnit,
//! preTrans, camera).
//!
//! The chunk is whatever `JSON.parse` gives, and the TypeScript reads it
//! through property reads, `?.`, `??`, `for...of`, destructuring and
//! arithmetic without checking a type. The port reads a [`JsonValue`] through
//! the same operations of `jscompat`, so a string where a list belongs, an
//! object where a number belongs or an own `toString` key answers as there.

use std::borrow::Cow;
use std::collections::HashSet;

use jscompat::{
    JsNum, JsTypeError, JsonValue, Primitive, json_parse, math_max, math_min, text_decoder_decode,
    to_primitive, to_property_key,
};
use serde::Serialize;

type Vec3 = [f64; 3];
type Mat4 = [f64; 16];

/// NaN and the infinities print as `null`, as `JSON.stringify` writes them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct GlbBounds {
    pub center: [JsNum; 3],
    pub size: [JsNum; 3],
}

const GLB_MAGIC: u32 = 0x4654_6c67;
const JSON_CHUNK: u32 = 0x4e4f_534a;
const IDENTITY: Mat4 = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

/// `view.getUint32(offset, true)`: a read past the end is a RangeError.
fn get_uint32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    bytes
        .get(offset..offset + 4)
        .and_then(|word| <[u8; 4]>::try_from(word).ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| "RangeError: Offset is outside the bounds of the DataView".to_owned())
}

/// The JSON chunk of a .glb, or `None` (`null`) when the bytes are not glTF
/// binary.
pub fn glb_json(bytes: &[u8]) -> Result<Option<JsonValue>, String> {
    if bytes.len() < 20 {
        return Ok(None);
    }
    if get_uint32(bytes, 0)? != GLB_MAGIC || get_uint32(bytes, 16)? != JSON_CHUNK {
        return Ok(None);
    }
    let length = u64::from(get_uint32(bytes, 12)?);
    if 20 + length > bytes.len() as u64 {
        return Ok(None);
    }
    let Some(chunk) = usize::try_from(length)
        .ok()
        .and_then(|length| bytes.get(20..20 + length))
    else {
        return Ok(None);
    };
    Ok(json_parse(&text_decoder_decode(chunk)).ok())
}

/// `value[key]` (or `value?.[key]`) on a value read before, keeping the
/// lifetime of the chunk where the value is part of it: that is why this and
/// its callers take the `Cow` and not the value it holds.
#[allow(clippy::ptr_arg)]
fn read<'a>(value: &Cow<'a, JsonValue>, key: &str) -> Option<Cow<'a, JsonValue>> {
    match value {
        Cow::Borrowed(value) => (*value).get(key),
        Cow::Owned(value) => value.get(key).map(|got| Cow::Owned(got.into_owned())),
    }
}

/// `value ?? fallback` leaves `None` for both `undefined` and `null`.
fn not_nullish(value: Option<Cow<'_, JsonValue>>) -> Option<Cow<'_, JsonValue>> {
    value.filter(|value| !matches!(**value, JsonValue::Null))
}

/// `table?.[key]`: the key is converted only where the table is there.
fn lookup<'a>(
    table: Option<&Cow<'a, JsonValue>>,
    key: &JsonValue,
) -> Result<Option<Cow<'a, JsonValue>>, JsTypeError> {
    match table {
        None => Ok(None),
        Some(table) => Ok(read(table, &to_property_key(key)?)),
    }
}

/// `for (const item of value ?? [])`
fn items_or_none(
    value: Option<Cow<'_, JsonValue>>,
) -> Result<Vec<Cow<'_, JsonValue>>, JsTypeError> {
    match not_nullish(value) {
        None => Ok(Vec::new()),
        Some(Cow::Borrowed(value)) => value.iterate(),
        Some(Cow::Owned(value)) => Ok(value
            .iterate()?
            .into_iter()
            .map(|item| Cow::Owned(item.into_owned()))
            .collect()),
    }
}

/// What a `for...of` walks, without a copy of an array that is part of the
/// chunk: a node may list ten thousand children and be visited as often.
enum Items<'a> {
    Slice(&'a [JsonValue]),
    Listed(Vec<Cow<'a, JsonValue>>),
}

impl<'a> Items<'a> {
    /// `for (const item of value ?? [])`
    fn of(value: Option<Cow<'a, JsonValue>>) -> Result<Self, JsTypeError> {
        match not_nullish(value) {
            Some(Cow::Borrowed(JsonValue::Array(items))) => Ok(Items::Slice(items)),
            other => items_or_none(other).map(Items::Listed),
        }
    }

    fn get(&self, index: usize) -> Option<Cow<'a, JsonValue>> {
        match self {
            Items::Slice(items) => items.get(index).map(Cow::Borrowed),
            Items::Listed(items) => items.get(index).cloned(),
        }
    }
}

/// One call of `visit` that is walking its children.
struct Frame<'a> {
    children: Items<'a>,
    next: usize,
    world: Mat4,
}

/// How deep `visit` may nest. The TypeScript recurses and throws a
/// RangeError where the host's stack ends, some thousands of calls deep;
/// this is an error too, at a depth no model has.
const MAX_DEPTH: usize = 4096;

/// Why there are no bounds: what the TypeScript throws.
enum Refusal {
    Type(JsTypeError),
    TooDeep,
}

impl From<JsTypeError> for Refusal {
    fn from(error: JsTypeError) -> Self {
        Refusal::Type(error)
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Refusal::Type(error) => error.fmt(formatter),
            Refusal::TooDeep => formatter.write_str("RangeError: Maximum call stack size exceeded"),
        }
    }
}

/// `value?.length === n`
#[allow(clippy::ptr_arg)]
fn length_is(value: &Cow<'_, JsonValue>, n: f64) -> bool {
    matches!(read(value, "length").as_deref(), Some(JsonValue::Number(length)) if *length == n)
}

/// `ToNumber(value[index])`, what `*` and `Math.min` apply to an item.
#[allow(clippy::ptr_arg)]
fn number_at(value: &Cow<'_, JsonValue>, index: usize) -> Result<f64, JsTypeError> {
    Ok(to_primitive(read(value, &index.to_string()).as_deref())?.to_number())
}

/// `const [a, b, ...] = value ?? fallback`, each item as the primitive the
/// arithmetic below converts it to.
fn destructure<const N: usize>(
    value: Option<Cow<'_, JsonValue>>,
    fallback: [f64; N],
) -> Result<[Primitive; N], JsTypeError> {
    let Some(value) = not_nullish(value) else {
        return Ok(fallback.map(Primitive::Number));
    };
    let items = value.iterate()?;
    let mut out = [const { Primitive::Undefined }; N];
    for (slot, item) in out.iter_mut().zip(&items) {
        *slot = to_primitive(Some(&**item))?;
    }
    Ok(out)
}

#[allow(clippy::ptr_arg)]
fn local_matrix(node: &Cow<'_, JsonValue>) -> Result<Mat4, JsTypeError> {
    if let Some(matrix) = read(node, "matrix").filter(|matrix| length_is(matrix, 16.0)) {
        // multiply converts each item with `*`
        let mut out = [0.0; 16];
        for (index, slot) in out.iter_mut().enumerate() {
            *slot = number_at(&matrix, index)?;
        }
        return Ok(out);
    }
    let [tx, ty, tz] = destructure(read(node, "translation"), [0.0, 0.0, 0.0])?;
    let [qx, qy, qz, qw] = destructure(read(node, "rotation"), [0.0, 0.0, 0.0, 1.0])?;
    let [sx, sy, sz] = destructure(read(node, "scale"), [1.0, 1.0, 1.0])?;
    // `qx + qx` joins strings where qx is one
    let x2 = qx.add(&qx).to_number();
    let y2 = qy.add(&qy).to_number();
    let z2 = qz.add(&qz).to_number();
    let (qx, qy, qz, qw) = (
        qx.to_number(),
        qy.to_number(),
        qz.to_number(),
        qw.to_number(),
    );
    let (sx, sy, sz) = (sx.to_number(), sy.to_number(), sz.to_number());
    let xx = qx * x2;
    let xy = qx * y2;
    let xz = qx * z2;
    let yy = qy * y2;
    let yz = qy * z2;
    let zz = qz * z2;
    let wx = qw * x2;
    let wy = qw * y2;
    let wz = qw * z2;
    Ok([
        (1.0 - yy - zz) * sx,
        (xy + wz) * sx,
        (xz - wy) * sx,
        0.0,
        (xy - wz) * sy,
        (1.0 - xx - zz) * sy,
        (yz + wx) * sy,
        0.0,
        (xz + wy) * sz,
        (yz - wx) * sz,
        (1.0 - xx - yy) * sz,
        0.0,
        tx.to_number(),
        ty.to_number(),
        tz.to_number(),
        1.0,
    ])
}

/// a × b, both column-major.
fn multiply(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [0.0; 16];
    for col in 0..4 {
        for row in 0..4 {
            out[col * 4 + row] = a[row] * b[col * 4]
                + a[4 + row] * b[col * 4 + 1]
                + a[8 + row] * b[col * 4 + 2]
                + a[12 + row] * b[col * 4 + 3];
        }
    }
    out
}

/// A member of `visited`, a `Set`: a primitive by its value (SameValueZero:
/// -0 is 0), an array or object by which one it is.
#[derive(PartialEq, Eq, Hash)]
enum Visited {
    Null,
    Bool(bool),
    Number(u64),
    String(String),
    Object(usize),
}

impl Visited {
    fn of(index: &JsonValue) -> Self {
        match index {
            JsonValue::Null => Visited::Null,
            JsonValue::Bool(flag) => Visited::Bool(*flag),
            // JSON gives no NaN
            JsonValue::Number(x) => Visited::Number(if *x == 0.0 { 0 } else { x.to_bits() }),
            JsonValue::String(text) => Visited::String(text.clone()),
            JsonValue::Array(_) | JsonValue::Object(_) => {
                Visited::Object(std::ptr::from_ref(index) as usize)
            }
        }
    }
}

#[allow(clippy::ptr_arg)]
fn mesh_box(
    gltf: &Cow<'_, JsonValue>,
    index: &JsonValue,
) -> Result<Option<(Vec3, Vec3)>, JsTypeError> {
    let mut found: Option<(Vec3, Vec3)> = None;
    let mesh = lookup(not_nullish(read(gltf, "meshes")).as_ref(), index)?;
    let primitives = items_or_none(mesh.as_ref().and_then(|mesh| read(mesh, "primitives")))?;
    for primitive in primitives {
        // gltf.accessors?.[primitive.attributes?.POSITION ?? -1]: the key is
        // read only where there are accessors
        let accessor = match not_nullish(read(gltf, "accessors")) {
            None => None,
            Some(accessors) => {
                if matches!(*primitive, JsonValue::Null) {
                    return Err(JsTypeError(
                        "Cannot read properties of null (reading 'attributes')".to_owned(),
                    ));
                }
                let position = read(&primitive, "attributes")
                    .and_then(|attributes| read(&attributes, "POSITION"));
                let key = match not_nullish(position) {
                    Some(position) => to_property_key(&position)?,
                    None => "-1".to_owned(),
                };
                read(&accessors, &key)
            }
        };
        let Some(accessor) = accessor else { continue };
        let (Some(low), Some(high)) = (read(&accessor, "min"), read(&accessor, "max")) else {
            continue;
        };
        if !length_is(&low, 3.0) || !length_is(&high, 3.0) {
            continue;
        }
        let (mut lo, mut hi) = found.unwrap_or(([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]));
        for i in 0..3 {
            lo[i] = math_min(lo[i], number_at(&low, i)?);
            hi[i] = math_max(hi[i], number_at(&high, i)?);
        }
        found = Some((lo, hi));
    }
    Ok(found)
}

pub fn glb_bounds(bytes: &[u8]) -> Result<Option<GlbBounds>, String> {
    let Some(gltf) = glb_json(bytes)? else {
        return Ok(None);
    };
    if !gltf.truthy() {
        return Ok(None);
    }
    bounds_of(&Cow::Borrowed(&gltf)).map_err(|error| error.to_string())
}

#[allow(clippy::ptr_arg)]
fn bounds_of(gltf: &Cow<'_, JsonValue>) -> Result<Option<GlbBounds>, Refusal> {
    let mut min: Vec3 = [f64::INFINITY; 3];
    let mut max: Vec3 = [f64::NEG_INFINITY; 3];
    let mut visited = HashSet::new();
    // gltf.scenes?.[gltf.scene ?? 0]
    let scene = match not_nullish(read(gltf, "scenes")) {
        None => None,
        Some(scenes) => {
            let index =
                not_nullish(read(gltf, "scene")).unwrap_or(Cow::Owned(JsonValue::Number(0.0)));
            read(&scenes, &to_property_key(&index)?)
        }
    };
    let roots = Items::of(scene.as_ref().and_then(|scene| read(scene, "nodes")))?;
    let nodes = not_nullish(read(gltf, "nodes"));
    // `visit` recurses depth first: a frame is one call walking its children
    let mut stack = vec![Frame {
        children: roots,
        next: 0,
        world: IDENTITY,
    }];
    while let Some(frame) = stack.last_mut() {
        let Some(index) = frame.children.get(frame.next) else {
            stack.pop();
            continue;
        };
        frame.next += 1;
        let parent = frame.world;
        let node = lookup(nodes.as_ref(), &index)?;
        let Some(node) = node.filter(|node| node.truthy()) else {
            continue;
        };
        if !visited.insert(Visited::of(&index)) {
            continue;
        }
        let world = multiply(&parent, &local_matrix(&node)?);
        let found = match read(&node, "mesh") {
            Some(mesh) => mesh_box(gltf, &mesh)?,
            None => None,
        };
        if let Some((lo, hi)) = found {
            for x in [lo[0], hi[0]] {
                for y in [lo[1], hi[1]] {
                    for z in [lo[2], hi[2]] {
                        let p: Vec3 = [
                            world[0] * x + world[4] * y + world[8] * z + world[12],
                            world[1] * x + world[5] * y + world[9] * z + world[13],
                            world[2] * x + world[6] * y + world[10] * z + world[14],
                        ];
                        for i in 0..3 {
                            min[i] = math_min(min[i], p[i]);
                            max[i] = math_max(max[i], p[i]);
                        }
                    }
                }
            }
        }
        let children = Items::of(read(&node, "children"))?;
        if stack.len() >= MAX_DEPTH {
            return Err(Refusal::TooDeep);
        }
        stack.push(Frame {
            children,
            next: 0,
            world,
        });
    }
    if !min[0].is_finite() {
        return Ok(None);
    }
    Ok(Some(GlbBounds {
        center: [0, 1, 2].map(|i| JsNum((min[i] + max[i]) / 2.0)),
        size: [0, 1, 2].map(|i| JsNum(max[i] - min[i])),
    }))
}
