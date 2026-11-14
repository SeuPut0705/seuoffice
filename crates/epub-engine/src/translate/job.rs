//! `translate/job.ts`: the book translation job on pdf-structure's job engine
//! (spec 8): the same store, resume, restart, stops and per-document lock as
//! the PDF translation, with the EPUB units, batching and model call.
//!
//! What this file holds is what is the book's: `epubTranslationJobParts` (the
//! blocks, the batcher, the model call and the mode the engine is given) and
//! the shape of what planning is given (`planInput`). `planEpubTranslationJob`,
//! `estimateEpubTranslationJob` and `startEpubTranslationJob` only hand those
//! to `planTranslationJob`, `estimateTranslationJob` and `startTranslationJob`
//! of `@seuoffice/pdf-structure`, the job engine with its store and its
//! document lock, which is not ported: a host that has the engine calls it
//! with `plan_input` and `epub_translation_job_parts`.

use crate::pdf_structure::TranslationMode;
use crate::translate::call::{
    EpubCallUnit, EpubTranslationModelCall, TranslationJobItem, batch_epub_translation_items,
    create_epub_translation_model_call,
};
use crate::translate::units::EpubTranslationUnit;
use crate::xml_positions_types::Thrown;

/// `epubBatcher`: the `batch` of the job: units cut into batches by a token
/// budget (`TRANSLATION_BATCH_TOKENS` when `None`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EpubBatcher {
    pub max_tokens: Option<f64>,
}

impl EpubBatcher {
    pub fn batch<'a, B: EpubCallUnit>(
        &self,
        items: &'a [TranslationJobItem<B>],
    ) -> Result<Vec<Vec<&'a TranslationJobItem<B>>>, Thrown> {
        batch_epub_translation_items(items, self.max_tokens)
    }
}

/// `EpubTranslationJobPartsOptions`
pub struct EpubTranslationJobPartsOptions<S> {
    /// target language code
    pub lang: String,
    pub send: S,
    /// token budget per batch; default `TRANSLATION_BATCH_TOKENS` (the PDF value)
    pub max_tokens: Option<f64>,
    /// resends of mismatched units; default `EPUB_TRANSLATION_MAX_RESENDS`
    pub max_resends: Option<f64>,
    /// 'easy': an easy explanation; default 'translate'
    pub mode: TranslationMode,
}

/// The book-specific options of pdf-structure's `startTranslationJob` and
/// `estimateTranslationJob`: `blocks`, `batch`, `callModel` and `mode`.
pub struct EpubTranslationJobParts<'a, S> {
    pub blocks: &'a [EpubTranslationUnit],
    pub batch: EpubBatcher,
    pub call_model: EpubTranslationModelCall<S>,
    /// `Some(Easy)` for an easy explanation; left out of a plain job
    pub mode: Option<TranslationMode>,
}

/// `epubTranslationJobParts`
pub fn epub_translation_job_parts<S>(
    units: &[EpubTranslationUnit],
    o: EpubTranslationJobPartsOptions<S>,
) -> Result<EpubTranslationJobParts<'_, S>, Thrown> {
    Ok(EpubTranslationJobParts {
        blocks: units,
        batch: EpubBatcher {
            max_tokens: o.max_tokens,
        },
        call_model: create_epub_translation_model_call(&o.lang, o.send, o.max_resends, o.mode)?,
        mode: (o.mode == TranslationMode::Easy).then_some(TranslationMode::Easy),
    })
}

/// `EpubTranslationPlanInput`: what planning and the pre-start estimate need.
/// `Model` is the engine's `JobModelChoice` and `Store` its
/// `Pick<DocumentJobStore, 'readTranslation'>`.
pub struct EpubTranslationPlanInput<'a, Model, Store> {
    /// `epubDocumentHash` of the stored book
    pub doc_hash: String,
    /// target language code
    pub lang: String,
    /// `epubTranslationUnits(book, ...).units`
    pub units: &'a [EpubTranslationUnit],
    pub model: Model,
    pub store: Store,
    /// plan as for a restart (the stored translation is ignored)
    pub restart: Option<bool>,
    /// with `restart`: blocks a person edited count as done
    pub keep_edited: Option<bool>,
    /// token budget per batch; default `TRANSLATION_BATCH_TOKENS`
    pub max_tokens: Option<f64>,
    /// 'easy': plan the easy explanation (its stored results); default 'translate'
    pub mode: Option<TranslationMode>,
}

/// `planInput`: what the engine's `planTranslationJob` and
/// `estimateTranslationJob` are given.
pub struct PlanInput<'a, Model, Store> {
    pub doc_hash: String,
    pub lang: String,
    pub blocks: &'a [EpubTranslationUnit],
    pub batch: EpubBatcher,
    pub model: Model,
    pub store: Store,
    pub restart: Option<bool>,
    pub keep_edited: Option<bool>,
    pub mode: Option<TranslationMode>,
}

/// `planInput`
pub fn plan_input<Model, Store>(
    o: EpubTranslationPlanInput<'_, Model, Store>,
) -> PlanInput<'_, Model, Store> {
    PlanInput {
        doc_hash: o.doc_hash,
        lang: o.lang,
        blocks: o.units,
        batch: EpubBatcher {
            max_tokens: o.max_tokens,
        },
        model: o.model,
        store: o.store,
        restart: o.restart,
        keep_edited: o.keep_edited,
        mode: o.mode,
    }
}
