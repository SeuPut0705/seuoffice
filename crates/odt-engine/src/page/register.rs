//! `page/register.ts`: what the page layer registers: a decorator of the text
//! layer's block converter (same id `text`) that points the first paragraph of
//! a page run at another master page on save, an inline converter for page
//! number / page count fields in headers and footers, and the run writer that
//! writes them back.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use docx_engine::parse::tables::hf_fields::{PAGE_MARK, TOTAL_PAGES_MARK};
use jscompat::{JsObject, TryJsRegex, js_regex};

use crate::core::body::OdtNode;
use crate::core::convert::{
    AlignedItem, BlockConverter, BlockEnv, BlockOoxml, BridgeBlock, BridgeElement,
    ConversionRegistry, EditedItem, FlowEnv, InlineConverter, InlineElement, InlineEnv,
    InlineOoxml, Neighbours, OdfToOoxmlContext, OoxmlToOdfContext,
};
use crate::core::errors::OdtError;
use crate::core::styles::{OdtStylePart, OdtStyleScope};
use crate::core::xml::decode_xml_entities;
use crate::text::props::AttrOverrides;
use crate::text::style_xml::{StyleXmlEdit, edit_style_xml, new_style_xml, patch_start_tag};

use super::hf::PageFieldRunWriter;
use super::model::PAGE_OWNER;

/// `StartChange`: a page-run start the decorator writes on save. A field is
/// `None` where the TypeScript leaves it `undefined` (keep), `Some(None)` for
/// `null` (remove).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StartChange {
    /// bridge paragraph record of the paragraph that starts the run
    pub paragraph: usize,
    /// new `style:master-page-name`
    pub master: Option<Option<String>>,
    /// new `style:page-number`
    pub page_number: Option<Option<String>>,
}

/// `PagePlan`
#[derive(Default)]
pub struct PagePlan {
    /// bridge block id -> start change
    pub starts: HashMap<usize, StartChange>,
    /// edited item index -> its XML before it was marked to reach the decorator
    pub forced: HashMap<i64, String>,
}

/// `planOf`: the plan of a context, created on first use.
pub fn plan_of(rctx: &OoxmlToOdfContext) -> std::cell::RefMut<'_, PagePlan> {
    rctx.state::<PagePlan>()
}

/// `FORCE_MARK`: appended to an unchanged item's XML so the flow hands its
/// block to the decorator.
pub const FORCE_MARK: &str = "<!--odt-page-->";

fn escape_reg_exp(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ".*+?^${}()|[]\\".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `startStyle`: the automatic style a page-run start paragraph gets: a copy
/// of `current` with the new master page and page number.
pub fn start_style(
    rctx: &mut OoxmlToOdfContext,
    current: Option<&str>,
    change: &StartChange,
) -> Result<String, OdtError> {
    let info = rctx.part(OdtStylePart::ContentXml);
    let mut attrs = AttrOverrides::new();
    attrs.set("style:display-name", None);
    if let Some(master) = &change.master {
        attrs.set("style:master-page-name", master.clone());
    }
    let props = change.page_number.as_ref().map(|page_number| {
        let mut inner = AttrOverrides::new();
        inner.set("style:page-number", page_number.clone());
        let mut props = JsObject::new();
        props.set("style:paragraph-properties", inner);
        props
    });
    // `JSON.stringify` writes `undefined` and `null` of an array alike
    let key = serde_json::to_string(&serde_json::json!([
        "page-start",
        current,
        change.master.clone().flatten(),
        change.page_number.clone().flatten()
    ]))
    .unwrap_or_default();

    // what the build step reads of the context, taken before `derived_style`
    let existing = current.and_then(|c| {
        rctx.doc
            .styles
            .find(c, "paragraph", OdtStyleScope::Content)
            .filter(|s| s.automatic && s.part == OdtStylePart::ContentXml)
            .map(|s| info.xml.text[s.start..s.end].to_owned())
    });
    let base_paragraph_style = rctx.map.styles.base_paragraph_style.clone();
    let queued = match (&existing, current) {
        (None, Some(current)) => {
            let pattern = TryJsRegex::new(
                &format!(
                    "^<[^>]*\\sstyle:name=\"{}\"",
                    escape_reg_exp(&escape_attr(current))
                ),
                "",
            )
            .map_err(|e| OdtError::thrown(e.to_string()))?;
            let mut found = None;
            for x in rctx.new_automatic_styles(OdtStylePart::ContentXml) {
                if pattern
                    .try_test(x)
                    .map_err(|e| OdtError::thrown(e.to_string()))?
                {
                    found = Some(x.clone());
                    break;
                }
            }
            found
        }
        _ => None,
    };
    let prefixes = info.prefixes.clone();
    let mut failure: Option<OdtError> = None;
    let name = rctx.derived_style(
        OdtStylePart::ContentXml,
        &key,
        current.unwrap_or("P"),
        |name| {
            let base = match existing.or(queued) {
                Some(base) => base,
                None => new_style_xml(
                    name,
                    "paragraph",
                    current.or(base_paragraph_style.as_deref()),
                ),
            };
            match edit_style_xml(
                &base,
                &prefixes,
                &StyleXmlEdit {
                    name: Some(name.to_owned()),
                    attrs: Some(attrs),
                    props,
                    ..Default::default()
                },
            ) {
                Ok(xml) => xml,
                Err(error) => {
                    failure = Some(error);
                    String::new()
                }
            }
        },
    );
    match failure {
        Some(error) => Err(error),
        None => Ok(name),
    }
}

/// `restyleFirstParagraph`: re-styles the first paragraph start tag of `odf`
/// with the run start change.
fn restyle_first_paragraph(
    rctx: &mut OoxmlToOdfContext,
    odf: &str,
    change: &StartChange,
) -> Result<String, OdtError> {
    let Some(m) = js_regex!(r"<(text:p|text:h)(?=[\s/>])[^>]*>").exec(odf) else {
        return Ok(odf.to_owned());
    };
    let prefixes = rctx.part(OdtStylePart::ContentXml).prefixes.clone();
    let raw = js_regex!(r#"\stext:style-name="([^"]*)""#)
        .exec(m.as_str())
        .and_then(|x| x.get(1));
    let current = raw.map(decode_xml_entities);
    let name = start_style(rctx, current.as_deref(), change)?;
    let mut overrides = AttrOverrides::new();
    overrides.set("text:style-name", Some(name));
    let tag = patch_start_tag(m.as_str(), &prefixes, &overrides)?;
    Ok(format!("{}{}{}", &odf[..m.start()], tag, &odf[m.end()..]))
}

thread_local! {
    /// `decorators`: the decorators this thread made (a `WeakSet` in the TypeScript).
    static DECORATORS: RefCell<Vec<Weak<PageBlockDecorator>>> = const { RefCell::new(Vec::new()) };
}

/// `hasPageDecorator`: the registry carries the page layer's decorator of the
/// text converter.
pub fn has_page_decorator(registry: &ConversionRegistry) -> bool {
    DECORATORS.with(|decorators| {
        let decorators = decorators.borrow();
        registry.blocks.iter().any(|b| {
            let at = Rc::as_ptr(b) as *const ();
            decorators
                .iter()
                .any(|d| d.upgrade().is_some() && Weak::as_ptr(d) as *const () == at)
        })
    })
}

/// `decorate`: the decorator of the text block converter. It converts exactly
/// what the text converter would, and on save points the first paragraph of a
/// page run at another master page.
pub struct PageBlockDecorator {
    inner: Rc<dyn BlockConverter>,
}

fn decorate(inner: Rc<dyn BlockConverter>) -> Rc<PageBlockDecorator> {
    let decorator = Rc::new(PageBlockDecorator { inner });
    DECORATORS.with(|d| d.borrow_mut().push(Rc::downgrade(&decorator)));
    decorator
}

impl BlockConverter for PageBlockDecorator {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn matches(&self, node: &OdtNode, ctx: &OdfToOoxmlContext) -> bool {
        let blocks = &ctx.registry.blocks;
        let me = self as *const Self as *const ();
        let Some(own) = blocks
            .iter()
            .position(|b| std::ptr::addr_eq(Rc::as_ptr(b), me))
        else {
            return false;
        };
        for i in (0..own).rev() {
            if blocks[i].matches(node, ctx) {
                return std::ptr::addr_eq(Rc::as_ptr(&blocks[i]), Rc::as_ptr(&self.inner));
            }
        }
        false
    }

    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        node: &Rc<OdtNode>,
        env: &BlockEnv,
    ) -> Result<BlockOoxml, OdtError> {
        self.inner.to_ooxml(ctx, node, env)
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        block: &BridgeBlock,
        items: &[AlignedItem],
        env: &FlowEnv,
    ) -> Result<String, OdtError> {
        let (restored, change): (Vec<AlignedItem>, Option<StartChange>) = {
            let plan = rctx.state::<PagePlan>();
            let restored = items.iter().map(|a| restore(rctx, &plan, a)).collect();
            (restored, plan.starts.get(&block.id).cloned())
        };
        match change {
            None => self.inner.to_odf(rctx, block, &restored, env),
            Some(change) => write_start(rctx, &*self.inner, block, &restored, env, &change),
        }
    }

    fn absorbs(
        &self,
        rctx: &mut OoxmlToOdfContext,
        block: &BridgeBlock,
        item: &EditedItem,
    ) -> Result<bool, OdtError> {
        self.inner.absorbs(rctx, block, item)
    }

    fn identify(
        &self,
        rctx: &mut OoxmlToOdfContext,
        item: &EditedItem,
        candidates: &[BridgeElement],
    ) -> Result<Option<usize>, OdtError> {
        self.inner.identify(rctx, item, candidates)
    }

    fn has_identify(&self) -> bool {
        self.inner.has_identify()
    }
}

/// `restore`: an item marked only to reach the decorator, back to what it
/// really is.
fn restore(rctx: &OoxmlToOdfContext, plan: &PagePlan, a: &AlignedItem) -> AlignedItem {
    let index = a.item.borrow().index;
    let Some(xml) = plan.forced.get(&index) else {
        return a.clone();
    };
    let mut item = a.item.borrow().clone();
    item.xml = xml.clone();
    AlignedItem {
        item: Rc::new(RefCell::new(item)),
        element: a.element,
        unchanged: a.element.is_some_and(|e| rctx.map.elements[e].xml == *xml),
    }
}

/// `writeStart`
fn write_start(
    rctx: &mut OoxmlToOdfContext,
    inner: &dyn BlockConverter,
    block: &BridgeBlock,
    items: &[AlignedItem],
    env: &FlowEnv,
    change: &StartChange,
) -> Result<String, OdtError> {
    let k = items.iter().position(|a| {
        a.element
            .is_some_and(|e| rctx.map.elements[e].paragraph == Some(change.paragraph))
    });
    let Some(k) = k else {
        rctx.warn("a page start paragraph was not found; its page style was kept");
        return inner.to_odf(rctx, block, items, env);
    };
    let before = &items[..k];
    let out = if before.is_empty() {
        String::new()
    } else {
        inner.to_odf(rctx, block, before, env)?
    };
    let start = &items[k];
    if start.unchanged {
        let (rec_start, rec_end) = {
            let record = &rctx.map.paragraphs[change.paragraph];
            (record.start, record.end)
        };
        let source = {
            let info = rctx.part(OdtStylePart::ContentXml);
            info.xml.text[info.xml.to_byte(rec_start)..info.xml.to_byte(rec_end)].to_owned()
        };
        let rest = &items[k + 1..];
        let after = if rest.is_empty() {
            String::new()
        } else {
            let mut next = *env;
            next.neighbours = Some(Neighbours {
                before: start.element,
                after: env.neighbours.as_ref().and_then(|n| n.after),
            });
            inner.to_odf(rctx, block, rest, &next)?
        };
        return Ok(format!(
            "{out}{}{after}",
            restyle_first_paragraph(rctx, &source, change)?
        ));
    }
    let written = inner.to_odf(rctx, block, &items[k..], env)?;
    Ok(format!(
        "{out}{}",
        restyle_first_paragraph(rctx, &written, change)?
    ))
}

/// `pageFieldConverter`: header/footer page fields shown as Word fields.
pub struct PageFieldConverter;

impl InlineConverter for PageFieldConverter {
    fn id(&self) -> &str {
        PAGE_OWNER
    }

    fn names(&self) -> &[&'static str] {
        &["text:page-number", "text:page-count"]
    }

    fn to_ooxml(
        &self,
        _ctx: &mut OdfToOoxmlContext,
        el: &InlineElement,
        _env: &InlineEnv,
    ) -> Result<Option<InlineOoxml>, OdtError> {
        if el.part != OdtStylePart::StylesXml {
            return Ok(None);
        }
        let page = el.name == "text:page-number";
        Ok(Some(InlineOoxml::Xml {
            xml: format!(
                "<w:fldSimple w:instr=\" {} \"><w:r><w:t>1</w:t></w:r></w:fldSimple>",
                if page { "PAGE" } else { "NUMPAGES" }
            ),
            text: (if page { PAGE_MARK } else { TOTAL_PAGES_MARK }).to_string(),
        }))
    }
}

/// `registerPageConverters`: registers the page layer. Call after
/// `registerTextConverters` (it decorates the text converter registered at
/// that time); converters registered later are unaffected.
pub fn register_page_converters(registry: &mut ConversionRegistry) {
    if let Some(text) = registry.block_by_id("text") {
        registry.add_block(decorate(text));
    }
    registry.add_inline(Rc::new(PageFieldConverter));
    registry.add_run_writer(Rc::new(PageFieldRunWriter));
}
