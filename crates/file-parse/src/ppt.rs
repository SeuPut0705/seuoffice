//! `pptToText` of `packages/file-parse/src/ppt.ts` over `ppt-to-text` 1.0.1
//! (`ppt.js`, SheetJS), as far as `readBuffer` and `utils.to_text` reach.
//!
//! The blob is a `Buffer` with a position `l` that the record readers move by
//! whatever the file says, so `l` is a JavaScript number (`f64`): NaN after a
//! missing byte, negative or past the stream after a bad length, and every
//! read past the stream gives `undefined` for a byte, NaN for a 16 bit value
//! and, for a 32 bit one, NaN only when its low byte is missing.
//!
//! The codepage rule of ppt.ts (only 1200 decodes) never fires: `parse_CString`
//! asks for 1200 alone.
//!
//! Where the JavaScript never returns (a record chain that loops, a byte atom
//! of a negative length) or overflows the stack, this refuses with a message
//! that starts `ppt:` or is `Maximum call stack size exceeded`.

use crate::compound::{self, IndexEntry};
use crate::compound_gate::{JsError, Thrown, assert_sound_compound_file, normalize_text};

/// V8 overflows between about 3,000 and 4,000 levels of these readers,
/// depending on how warm the code is.
const MAX_DEPTH: u32 = 3000;
/// Record headers read in one call.
const MAX_RECORDS: u64 = 1 << 25;
/// Characters of one byte atom.
/// Units of text a stream may give beyond eight for each of its bytes.
const TEXT_BUDGET_BASE: u64 = 1 << 22;
/// Characters of one byte atom
const MAX_BYTES_ATOM: f64 = (1u64 << 26) as f64;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Handler {
    Noop,
    CString,
    CurrentUser,
    DocInfoList,
    Document,
    Environment,
    Drawing,
    EndDocument,
    MainMaster,
    Notes,
    ClientTextbox,
    Dg,
    Dgg,
    Fdg,
    Sp,
    Spgr,
    PersistDirectory,
    SlideAtom,
    Slide,
    SlideList,
    SlidePersist,
    TextBytes,
    TextHeader,
    UserEdit,
}

/// `RecordEnum`, by record type.
static RECORDS: &[(u16, &str, Handler)] = &[
    (0x03E8, "RT_Document", Handler::Document),
    (0x03E9, "RT_DocumentAtom", Handler::Noop),
    (0x03EA, "RT_EndDocumentAtom", Handler::EndDocument),
    (0x03EE, "RT_Slide", Handler::Slide),
    (0x03EF, "RT_SlideAtom", Handler::SlideAtom),
    (0x03F0, "RT_Notes", Handler::Notes),
    (0x03F1, "RT_NotesAtom", Handler::Noop),
    (0x03F2, "RT_Environment", Handler::Environment),
    (0x03F3, "RT_SlidePersistAtom", Handler::SlidePersist),
    (0x03F8, "RT_MainMaster", Handler::MainMaster),
    (0x03F9, "RT_SlideShowSlideInfoAtom", Handler::Noop),
    (0x03FA, "RT_SlideViewInfo", Handler::Noop),
    (0x03FB, "RT_GuideAtom", Handler::Noop),
    (0x03FD, "RT_ViewInfoAtom", Handler::Noop),
    (0x03FE, "RT_SlideViewInfoAtom", Handler::Noop),
    (0x03FF, "RT_VbaInfo", Handler::Noop),
    (0x0400, "RT_VbaInfoAtom", Handler::Noop),
    (0x0401, "RT_SlideShowDocInfoAtom", Handler::Noop),
    (0x0402, "RT_Summary", Handler::Noop),
    (0x0406, "RT_DocRoutingSlipAtom", Handler::Noop),
    (0x0407, "RT_OutlineViewInfo", Handler::Noop),
    (0x0408, "RT_SorterViewInfo", Handler::Noop),
    (0x0409, "RT_ExternalObjectList", Handler::Noop),
    (0x040A, "RT_ExternalObjectListAtom", Handler::Noop),
    (0x040B, "RT_DrawingGroup", Handler::Noop),
    (0x040C, "RT_Drawing", Handler::Drawing),
    (0x040D, "RT_GridSpacing10Atom", Handler::Noop),
    (0x040E, "RT_RoundTripTheme12Atom", Handler::Noop),
    (0x040F, "RT_RoundTripColorMapping12Atom", Handler::Noop),
    (0x0410, "RT_NamedShows", Handler::Noop),
    (0x0411, "RT_NamedShow", Handler::Noop),
    (0x0412, "RT_NamedShowSlidesAtom", Handler::Noop),
    (0x0413, "RT_NotesTextViewInfo9", Handler::Noop),
    (0x0414, "RT_NormalViewSetInfo9", Handler::Noop),
    (0x0415, "RT_NormalViewSetInfo9Atom", Handler::Noop),
    (
        0x041C,
        "RT_RoundTripOriginalMainMasterId12Atom",
        Handler::Noop,
    ),
    (0x041D, "RT_RoundTripCompositeMasterId12Atom", Handler::Noop),
    (0x041E, "RT_RoundTripContentMasterInfo12Atom", Handler::Noop),
    (0x041F, "RT_RoundTripShapeId12Atom", Handler::Noop),
    (0x0420, "RT_RoundTripHFPlaceholder12Atom", Handler::Noop),
    (0x0422, "RT_RoundTripContentMasterId12Atom", Handler::Noop),
    (0x0423, "RT_RoundTripOArtTextStyles12Atom", Handler::Noop),
    (
        0x0424,
        "RT_RoundTripHeaderFooterDefaults12Atom",
        Handler::Noop,
    ),
    (0x0425, "RT_RoundTripDocFlags12Atom", Handler::Noop),
    (
        0x0426,
        "RT_RoundTripShapeCheckSumForCL12Atom",
        Handler::Noop,
    ),
    (
        0x0427,
        "RT_RoundTripNotesMasterTextStyles12Atom",
        Handler::Noop,
    ),
    (0x0428, "RT_RoundTripCustomTableStyles12Atom", Handler::Noop),
    (0x07D0, "RT_List", Handler::DocInfoList),
    (0x07D5, "RT_FontCollection", Handler::Noop),
    (0x07D6, "RT_FontCollection10", Handler::Noop),
    (0x07E3, "RT_BookmarkCollection", Handler::Noop),
    (0x07E4, "RT_SoundCollection", Handler::Noop),
    (0x07E5, "RT_SoundCollectionAtom", Handler::Noop),
    (0x07E6, "RT_Sound", Handler::Noop),
    (0x07E7, "RT_SoundDataBlob", Handler::Noop),
    (0x07E9, "RT_BookmarkSeedAtom", Handler::Noop),
    (0x07F0, "RT_ColorSchemeAtom", Handler::Noop),
    (0x07F8, "RT_BlipCollection9", Handler::Noop),
    (0x07F9, "RT_BlipEntity9Atom", Handler::Noop),
    (0x0BC1, "RT_ExternalObjectRefAtom", Handler::Noop),
    (0x0BC3, "RT_PlaceholderAtom", Handler::Noop),
    (0x0BDB, "RT_ShapeAtom", Handler::Noop),
    (0x0BDC, "RT_ShapeFlags10Atom", Handler::Noop),
    (0x0BDD, "RT_RoundTripNewPlaceholderId12Atom", Handler::Noop),
    (0x0F9E, "RT_OutlineTextRefAtom", Handler::Noop),
    (0x0F9F, "RT_TextHeaderAtom", Handler::TextHeader),
    (0x0FA0, "RT_TextCharsAtom", Handler::CString),
    (0x0FA1, "RT_StyleTextPropAtom", Handler::Noop),
    (0x0FA2, "RT_MasterTextPropAtom", Handler::Noop),
    (0x0FA3, "RT_TextMasterStyleAtom", Handler::Noop),
    (0x0FA4, "RT_TextCharFormatExceptionAtom", Handler::Noop),
    (0x0FA5, "RT_TextParagraphFormatExceptionAtom", Handler::Noop),
    (0x0FA6, "RT_TextRulerAtom", Handler::Noop),
    (0x0FA7, "RT_TextBookmarkAtom", Handler::Noop),
    (0x0FA8, "RT_TextBytesAtom", Handler::TextBytes),
    (0x0FA9, "RT_TextSpecialInfoDefaultAtom", Handler::Noop),
    (0x0FAA, "RT_TextSpecialInfoAtom", Handler::Noop),
    (0x0FAB, "RT_DefaultRulerAtom", Handler::Noop),
    (0x0FAC, "RT_StyleTextProp9Atom", Handler::Noop),
    (0x0FAD, "RT_TextMasterStyle9Atom", Handler::Noop),
    (0x0FAE, "RT_OutlineTextProps9", Handler::Noop),
    (0x0FAF, "RT_OutlineTextPropsHeader9Atom", Handler::Noop),
    (0x0FB0, "RT_TextDefaults9Atom", Handler::Noop),
    (0x0FB1, "RT_StyleTextProp10Atom", Handler::Noop),
    (0x0FB2, "RT_TextMasterStyle10Atom", Handler::Noop),
    (0x0FB3, "RT_OutlineTextProps10", Handler::Noop),
    (0x0FB4, "RT_TextDefaults10Atom", Handler::Noop),
    (0x0FB5, "RT_OutlineTextProps11", Handler::Noop),
    (0x0FB6, "RT_StyleTextProp11Atom", Handler::Noop),
    (0x0FB7, "RT_FontEntityAtom", Handler::Noop),
    (0x0FB8, "RT_FontEmbedDataBlob", Handler::Noop),
    (0x0FBA, "RT_CString", Handler::CString),
    (0x0FC1, "RT_MetaFile", Handler::Noop),
    (0x0FC3, "RT_ExternalOleObjectAtom", Handler::Noop),
    (0x0FC8, "RT_Kinsoku", Handler::Noop),
    (0x0FC9, "RT_Handout", Handler::Noop),
    (0x0FCC, "RT_ExternalOleEmbed", Handler::Noop),
    (0x0FCD, "RT_ExternalOleEmbedAtom", Handler::Noop),
    (0x0FCE, "RT_ExternalOleLink", Handler::Noop),
    (0x0FD0, "RT_BookmarkEntityAtom", Handler::Noop),
    (0x0FD1, "RT_ExternalOleLinkAtom", Handler::Noop),
    (0x0FD2, "RT_KinsokuAtom", Handler::Noop),
    (0x0FD3, "RT_ExternalHyperlinkAtom", Handler::Noop),
    (0x0FD7, "RT_ExternalHyperlink", Handler::Noop),
    (0x0FD8, "RT_SlideNumberMetaCharAtom", Handler::Noop),
    (0x0FD9, "RT_HeadersFooters", Handler::Noop),
    (0x0FDA, "RT_HeadersFootersAtom", Handler::Noop),
    (0x0FDF, "RT_TextInteractiveInfoAtom", Handler::Noop),
    (0x0FE4, "RT_ExternalHyperlink9", Handler::Noop),
    (0x0FE7, "RT_RecolorInfoAtom", Handler::Noop),
    (0x0FEE, "RT_ExternalOleControl", Handler::Noop),
    (0x0FF0, "RT_SlideListWithText", Handler::SlideList),
    (0x0FF1, "RT_AnimationInfoAtom", Handler::Noop),
    (0x0FF2, "RT_InteractiveInfo", Handler::Noop),
    (0x0FF3, "RT_InteractiveInfoAtom", Handler::Noop),
    (0x0FF5, "RT_UserEditAtom", Handler::UserEdit),
    (0x0FF6, "RT_CurrentUserAtom", Handler::CurrentUser),
    (0x0FF7, "RT_DateTimeMetaCharAtom", Handler::Noop),
    (0x0FF8, "RT_GenericDateMetaCharAtom", Handler::Noop),
    (0x0FF9, "RT_HeaderMetaCharAtom", Handler::Noop),
    (0x0FFA, "RT_FooterMetaCharAtom", Handler::Noop),
    (0x0FFB, "RT_ExternalOleControlAtom", Handler::Noop),
    (0x1004, "RT_ExternalMediaAtom", Handler::Noop),
    (0x1005, "RT_ExternalVideo", Handler::Noop),
    (0x1006, "RT_ExternalAviMovie", Handler::Noop),
    (0x1007, "RT_ExternalMciMovie", Handler::Noop),
    (0x100D, "RT_ExternalMidiAudio", Handler::Noop),
    (0x100E, "RT_ExternalCdAudio", Handler::Noop),
    (0x100F, "RT_ExternalWavAudioEmbedded", Handler::Noop),
    (0x1010, "RT_ExternalWavAudioLink", Handler::Noop),
    (0x1011, "RT_ExternalOleObjectStg", Handler::Noop),
    (0x1012, "RT_ExternalCdAudioAtom", Handler::Noop),
    (0x1013, "RT_ExternalWavAudioEmbeddedAtom", Handler::Noop),
    (0x1014, "RT_AnimationInfo", Handler::Noop),
    (0x1015, "RT_RtfDateTimeMetaCharAtom", Handler::Noop),
    (0x1018, "RT_ExternalHyperlinkFlagsAtom", Handler::Noop),
    (0x1388, "RT_ProgTags", Handler::Noop),
    (0x1389, "RT_ProgStringTag", Handler::Noop),
    (0x138A, "RT_ProgBinaryTag", Handler::Noop),
    (0x138B, "RT_BinaryTagDataBlob", Handler::Noop),
    (0x1770, "RT_PrintOptionsAtom", Handler::Noop),
    (0x1772, "RT_PersistDirectoryAtom", Handler::PersistDirectory),
    (0x177A, "RT_PresentationAdvisorFlags9Atom", Handler::Noop),
    (0x177B, "RT_HtmlDocInfo9Atom", Handler::Noop),
    (0x177C, "RT_HtmlPublishInfoAtom", Handler::Noop),
    (0x177D, "RT_HtmlPublishInfo9", Handler::Noop),
    (0x177E, "RT_BroadcastDocInfo9", Handler::Noop),
    (0x177F, "RT_BroadcastDocInfo9Atom", Handler::Noop),
    (0x1784, "RT_EnvelopeFlags9Atom", Handler::Noop),
    (0x1785, "RT_EnvelopeData9Atom", Handler::Noop),
    (0x2AFB, "RT_VisualShapeAtom", Handler::Noop),
    (0x2B00, "RT_HashCodeAtom", Handler::Noop),
    (0x2B01, "RT_VisualPageAtom", Handler::Noop),
    (0x2B02, "RT_BuildList", Handler::Noop),
    (0x2B03, "RT_BuildAtom", Handler::Noop),
    (0x2B04, "RT_ChartBuild", Handler::Noop),
    (0x2B05, "RT_ChartBuildAtom", Handler::Noop),
    (0x2B06, "RT_DiagramBuild", Handler::Noop),
    (0x2B07, "RT_DiagramBuildAtom", Handler::Noop),
    (0x2B08, "RT_ParaBuild", Handler::Noop),
    (0x2B09, "RT_ParaBuildAtom", Handler::Noop),
    (0x2B0A, "RT_LevelInfoAtom", Handler::Noop),
    (0x2B0B, "RT_RoundTripAnimationAtom12Atom", Handler::Noop),
    (0x2B0D, "RT_RoundTripAnimationHashAtom12Atom", Handler::Noop),
    (0x2EE0, "RT_Comment10", Handler::Noop),
    (0x2EE1, "RT_Comment10Atom", Handler::Noop),
    (0x2EE4, "RT_CommentIndex10", Handler::Noop),
    (0x2EE5, "RT_CommentIndex10Atom", Handler::Noop),
    (0x2EE6, "RT_LinkedShape10Atom", Handler::Noop),
    (0x2EE7, "RT_LinkedSlide10Atom", Handler::Noop),
    (0x2EEA, "RT_SlideFlags10Atom", Handler::Noop),
    (0x2EEB, "RT_SlideTime10Atom", Handler::Noop),
    (0x2EEC, "RT_DiffTree10", Handler::Noop),
    (0x2EED, "RT_Diff10", Handler::Noop),
    (0x2EEE, "RT_Diff10Atom", Handler::Noop),
    (0x2EEF, "RT_SlideListTableSize10Atom", Handler::Noop),
    (0x2EF0, "RT_SlideListEntry10Atom", Handler::Noop),
    (0x2EF1, "RT_SlideListTable10", Handler::Noop),
    (0x2F14, "RT_CryptSession10Container", Handler::Noop),
    (0x32C8, "RT_FontEmbedFlags10Atom", Handler::Noop),
    (0x36B0, "RT_FilterPrivacyFlags10Atom", Handler::Noop),
    (0x36B1, "RT_DocToolbarStates10Atom", Handler::Noop),
    (0x36B2, "RT_PhotoAlbumInfo10Atom", Handler::Noop),
    (0x36B3, "RT_SmartTagStore11Container", Handler::Noop),
    (0x3714, "RT_RoundTripSlideSyncInfo12", Handler::Noop),
    (0x3715, "RT_RoundTripSlideSyncInfoAtom12", Handler::Noop),
    (0x6969, "RT_SheetJSAtom", Handler::Noop),
    (0xF000, "OfficeArtDggContainer", Handler::Dgg),
    (0xF001, "OfficeArtBStoreContainer", Handler::Noop),
    (0xF002, "OfficeArtDgContainer", Handler::Dg),
    (0xF003, "OfficeArtSpgrContainer", Handler::Spgr),
    (0xF004, "OfficeArtSpContainer", Handler::Sp),
    (0xF005, "OfficeArtSolverContainer", Handler::Noop),
    (0xF006, "OfficeArtFDGGBlock", Handler::Noop),
    (0xF007, "OfficeArtFBSE", Handler::Noop),
    (0xF008, "OfficeArtFDG", Handler::Fdg),
    (0xF009, "OfficeArtFSPGR", Handler::Noop),
    (0xF00A, "OfficeArtFSP", Handler::Noop),
    (0xF00B, "OfficeArtFOPT", Handler::Noop),
    (0xF00D, "OfficeArtClientTextbox", Handler::ClientTextbox),
    (0xF00F, "OfficeArtChildAnchor", Handler::Noop),
    (0xF010, "OfficeArtClientAnchor", Handler::Noop),
    (0xF011, "OfficeArtClientData", Handler::Noop),
    (0xF012, "OfficeArtFConnectorRule", Handler::Noop),
    (0xF014, "OfficeArtFArcRule", Handler::Noop),
    (0xF017, "OfficeArtFCalloutRule", Handler::Noop),
    (0xF01A, "OfficeArtBlipEMF", Handler::Noop),
    (0xF01B, "OfficeArtBlipWMF", Handler::Noop),
    (0xF01C, "OfficeArtBlipPICT", Handler::Noop),
    (0xF01D, "OfficeArtBlipJPEG", Handler::Noop),
    (0xF01E, "OfficeArtBlipPNG", Handler::Noop),
    (0xF01F, "OfficeArtBlipDIB", Handler::Noop),
    (0xF029, "OfficeArtBlipTIFF", Handler::Noop),
    (0xF118, "OfficeArtFRITContainer", Handler::Noop),
    (0xF119, "OfficeArtFDGSL", Handler::Noop),
    (0xF11A, "OfficeArtMRUContainer", Handler::Noop),
    (0xF11D, "OfficeArtFPSPL", Handler::Noop),
    (0xF11E, "OfficeArtSplitMenuColorContainer", Handler::Noop),
    (0xF121, "OfficeArtSecondaryFOPT", Handler::Noop),
    (0xF122, "OfficeArtTertiaryFOPT", Handler::Noop),
    (0xF125, "RT_TimeConditionContainer", Handler::Noop),
    (0xF127, "RT_TimeNode", Handler::Noop),
    (0xF128, "RT_TimeCondition", Handler::Noop),
    (0xF129, "RT_TimeModifier", Handler::Noop),
    (0xF12A, "RT_TimeBehaviorContainer", Handler::Noop),
    (0xF12B, "RT_TimeAnimateBehaviorContainer", Handler::Noop),
    (0xF12C, "RT_TimeColorBehaviorContainer", Handler::Noop),
    (0xF12D, "RT_TimeEffectBehaviorContainer", Handler::Noop),
    (0xF12E, "RT_TimeMotionBehaviorContainer", Handler::Noop),
    (0xF12F, "RT_TimeRotationBehaviorContainer", Handler::Noop),
    (0xF130, "RT_TimeScaleBehaviorContainer", Handler::Noop),
    (0xF131, "RT_TimeSetBehaviorContainer", Handler::Noop),
    (0xF132, "RT_TimeCommandBehaviorContainer", Handler::Noop),
    (0xF133, "RT_TimeBehavior", Handler::Noop),
    (0xF134, "RT_TimeAnimateBehavior", Handler::Noop),
    (0xF135, "RT_TimeColorBehavior", Handler::Noop),
    (0xF136, "RT_TimeEffectBehavior", Handler::Noop),
    (0xF137, "RT_TimeMotionBehavior", Handler::Noop),
    (0xF138, "RT_TimeRotationBehavior", Handler::Noop),
    (0xF139, "RT_TimeScaleBehavior", Handler::Noop),
    (0xF13A, "RT_TimeSetBehavior", Handler::Noop),
    (0xF13B, "RT_TimeCommandBehavior", Handler::Noop),
    (0xF13C, "RT_TimeClientVisualElement", Handler::Noop),
    (0xF13D, "RT_TimePropertyList", Handler::Noop),
    (0xF13E, "RT_TimeVariantList", Handler::Noop),
    (0xF13F, "RT_TimeAnimationValueList", Handler::Noop),
    (0xF140, "RT_TimeIterateData", Handler::Noop),
    (0xF141, "RT_TimeSequenceData", Handler::Noop),
    (0xF142, "RT_TimeVariant", Handler::Noop),
    (0xF143, "RT_TimeAnimationValue", Handler::Noop),
    (0xF144, "RT_TimeExtTimeNodeContainer", Handler::Noop),
    (0xF145, "RT_TimeSubEffectContainer", Handler::Noop),
    (0xFC1C, "RT_MagicAtom", Handler::Noop),
];

const SHEETJS: (u16, &str, Handler) = (0x6969, "RT_SheetJSAtom", Handler::Noop);

/// A record's name and reader.
#[derive(Clone, Copy)]
struct Rec {
    name: &'static str,
    handler: Handler,
}

/// `RecordEnum[type]`, or the SheetJS atom `recordhopper` falls back to.
fn lookup(record_type: f64) -> Rec {
    let found = if record_type.is_nan() {
        None
    } else {
        RECORDS
            .binary_search_by_key(&(record_type as u32), |entry| u32::from(entry.0))
            .ok()
            .map(|at| RECORDS[at])
    };
    let (_, name, handler) = found.unwrap_or(SHEETJS);
    Rec { name, handler }
}

/// A `Buffer` that `prep_blob` gave a position.
struct Blob<'a> {
    data: &'a [u8],
    l: f64,
}

impl<'a> Blob<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, l: 0.0 }
    }

    fn length(&self) -> f64 {
        self.data.len() as f64
    }

    /// `this[at]`: `None` is `undefined`.
    fn byte(&self, at: f64) -> Option<u8> {
        if at.fract() != 0.0 || at < 0.0 || at >= self.length() {
            return None;
        }
        self.data.get(at as usize).copied()
    }

    /// `read_shift(1)`: `None` is `undefined`.
    fn read1(&mut self) -> Option<u8> {
        let value = self.byte(self.l);
        self.l += 1.0;
        value
    }

    /// `read_shift(2)`: NaN unless both bytes are there.
    fn read2(&mut self) -> f64 {
        let value = match (self.byte(self.l), self.byte(self.l + 1.0)) {
            (Some(low), Some(high)) => f64::from(high) * 256.0 + f64::from(low),
            _ => f64::NAN,
        };
        self.l += 2.0;
        value
    }

    /// `read_shift(4)`: a signed 32 bit number, NaN when the low byte is
    /// missing, a missing higher byte is 0.
    fn read4(&mut self) -> f64 {
        let value = match self.byte(self.l) {
            None => f64::NAN,
            Some(low) => {
                let at = |k: f64| self.byte(self.l + k).unwrap_or(0);
                f64::from(i32::from_le_bytes([low, at(1.0), at(2.0), at(3.0)]))
            }
        };
        self.l += 4.0;
        value
    }

    /// `Buffer.prototype.slice(start, end)`.
    fn slice(&self, start: f64, end: f64) -> &'a [u8] {
        let len = self.length();
        let adjust = |offset: f64| {
            let offset = offset.trunc();
            if offset == 0.0 || offset.is_nan() {
                0.0
            } else if offset < 0.0 {
                (offset + len).max(0.0)
            } else if offset < len {
                offset
            } else {
                len
            }
        };
        let (start, end) = (adjust(start), adjust(end));
        if end > start {
            &self.data[start as usize..end as usize]
        } else {
            &[]
        }
    }
}

/// Counts what a reader can do before it is taken to be looping.
struct Guard {
    depth: u32,
    records: u64,
    /// Units of text collected so far, and what a stream of this size may hold.
    text: u64,
    text_budget: u64,
}

impl Guard {
    fn enter(&mut self) -> Result<(), Thrown> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(Thrown::Range("Maximum call stack size exceeded".into()));
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    /// A rewind can read one atom again and again; real text stays far
    /// below the budget.
    fn take_text(&mut self, units: f64) -> Result<(), Thrown> {
        self.text = self.text.saturating_add(units as u64);
        if self.text > self.text_budget {
            return Err(Thrown::Error("ppt: the text never ends".into()));
        }
        Ok(())
    }

    fn record(&mut self) -> Result<(), Thrown> {
        self.records += 1;
        if self.records > MAX_RECORDS {
            return Err(Thrown::Error("ppt: the records never end".into()));
        }
        Ok(())
    }
}

type Text = Vec<u16>;

/// One child of an `OfficeArtSpgrContainer`: a shape (an object with an
/// optional `clientTextbox`) or a nested group (an array).
enum Item {
    Shape(Option<Text>),
    Group,
}

/// What a reader returns, as far as a caller reads it.
enum Val {
    Undefined,
    Text(Text),
    TextList(Vec<Text>),
    CurrentUser {
        offset: f64,
    },
    UserEdit {
        last_edit: f64,
        persist_directory: f64,
    },
    Textbox(Text),
    Shape(Option<Text>),
    Group(Vec<Item>),
    Dg {
        group_shape: Option<Vec<Item>>,
    },
    Drawing(Option<Option<Vec<Item>>>),
    Slide {
        drawing: Option<Option<Vec<Item>>>,
    },
    Document {
        slide_list: Option<Vec<Text>>,
    },
}

type Reader<'c, 'b> = dyn FnMut(Rec, Val, f64, &mut Blob<'b>) -> Result<(), Thrown> + 'c;

/// `parse_CString`: `cptable.utils.decode(1200, blob.slice(blob.l, blob.l+length))`.
fn c_string(blob: &mut Blob<'_>, length: f64) -> Text {
    let bytes = blob.slice(blob.l, blob.l + length);
    blob.l += length;
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect()
}

fn replace_cr(text: &[u16]) -> Text {
    text.iter()
        .map(|&unit| if unit == 0x0d { 0x0a } else { unit })
        .collect()
}

/// A container being read: what its callback has collected so far.
enum Frame {
    Ignore,
    Document { slide_list: Option<Vec<Text>> },
    SlideList { texts: Vec<Text> },
    Slide { drawing: Option<Option<Vec<Item>>> },
    Drawing { found: Option<Option<Vec<Item>>> },
    Dg { group_shape: Option<Vec<Item>> },
    Sp { client_textbox: Option<Text> },
    Spgr { items: Vec<Item> },
    ClientTextbox { text: Text },
}

impl Frame {
    /// The frame of a container record; `None` for an atom.
    fn of(handler: Handler) -> Option<Frame> {
        Some(match handler {
            Handler::Document => Frame::Document { slide_list: None },
            Handler::SlideList => Frame::SlideList { texts: Vec::new() },
            Handler::Slide => Frame::Slide { drawing: None },
            Handler::MainMaster
            | Handler::Notes
            | Handler::DocInfoList
            | Handler::Environment
            | Handler::Dgg => Frame::Ignore,
            Handler::Drawing => Frame::Drawing { found: None },
            Handler::Dg => Frame::Dg { group_shape: None },
            Handler::Sp => Frame::Sp {
                client_textbox: None,
            },
            Handler::Spgr => Frame::Spgr { items: Vec::new() },
            Handler::ClientTextbox => Frame::ClientTextbox { text: Vec::new() },
            _ => return None,
        })
    }

    /// What the reader returns when its last child is read.
    fn into_val(self) -> Val {
        match self {
            Frame::Ignore => Val::Undefined,
            Frame::Document { slide_list } => Val::Document { slide_list },
            Frame::SlideList { texts } => Val::TextList(texts),
            Frame::Slide { drawing } => Val::Slide { drawing },
            Frame::Drawing { found } => Val::Drawing(found),
            Frame::Dg { group_shape } => Val::Dg { group_shape },
            Frame::Sp { client_textbox } => Val::Shape(client_textbox),
            Frame::Spgr { items } => Val::Group(items),
            Frame::ClientTextbox { text } => Val::Textbox(text),
        }
    }

    /// The callback of the container's `recordhopper`.
    fn child(&mut self, rec: Rec, val: Val, len: f64, blob: &mut Blob<'_>) {
        match (self, rec.name, val) {
            (Frame::Document { slide_list }, "RT_SlideListWithText", Val::TextList(list)) => {
                *slide_list = Some(list);
            }
            (Frame::Document { .. }, "RT_HeadersFooters", _) => blob.l -= len,
            (
                Frame::SlideList { texts },
                "RT_TextBytesAtom" | "RT_TextCharsAtom",
                Val::Text(text),
            ) => texts.push(text),
            (Frame::Slide { drawing }, "RT_Drawing", Val::Drawing(found)) => *drawing = found,
            (Frame::Drawing { found }, "OfficeArtDgContainer", Val::Dg { group_shape }) => {
                *found = Some(group_shape);
            }
            (Frame::Dg { group_shape }, "OfficeArtSpgrContainer", Val::Group(items)) => {
                *group_shape = Some(items);
            }
            (Frame::Sp { client_textbox }, "OfficeArtClientTextbox", Val::Textbox(text)) => {
                *client_textbox = Some(text);
            }
            (Frame::Spgr { items }, "OfficeArtSpContainer", Val::Shape(text)) => {
                items.push(Item::Shape(text));
            }
            (Frame::Spgr { items }, "OfficeArtSpgrContainer", _) => items.push(Item::Group),
            (
                Frame::ClientTextbox { text },
                "RT_TextBytesAtom" | "RT_TextCharsAtom",
                Val::Text(found),
            ) => *text = replace_cr(&found),
            _ => {}
        }
    }
}

/// A container whose `recordhopper` is running.
struct Open {
    frame: Frame,
    rec: Rec,
    length: f64,
    end: f64,
}

/// `recordhopper` over `blob` up to `end`, the containers it meets read with a
/// stack of their own instead of recursion; `records` filters the top level
/// only, and `callback` is what the top level does with each record.
fn recordhopper<'b>(
    guard: &mut Guard,
    blob: &mut Blob<'b>,
    end: f64,
    records: Option<&[&str]>,
    callback: &mut Reader<'_, 'b>,
) -> Result<(), Thrown> {
    let mut stack: Vec<Open> = Vec::new();
    loop {
        let top_end = stack.last().map_or(end, |open| open.end);
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(blob.l < top_end) {
            let Some(done) = stack.pop() else {
                return Ok(());
            };
            guard.leave();
            let (rec, length) = (done.rec, done.length);
            let val = done.frame.into_val();
            match stack.last_mut() {
                Some(parent) => parent.frame.child(rec, val, length, blob),
                None => callback(rec, val, length, blob)?,
            }
            continue;
        }
        guard.record()?;
        let record_type = {
            let _version = blob.read2();
            blob.read2()
        };
        let length = blob.read4();
        let rec = lookup(record_type);
        if stack.is_empty()
            && let Some(wanted) = records
            && !wanted.contains(&rec.name)
        {
            blob.l += length;
            continue;
        }
        if let Some(frame) = Frame::of(rec.handler) {
            guard.enter()?;
            stack.push(Open {
                frame,
                rec,
                length,
                end: blob.l + length,
            });
            continue;
        }
        let val = parse_atom(guard, rec, blob, length)?;
        match stack.last_mut() {
            Some(parent) => parent.frame.child(rec, val, length, blob),
            None => callback(rec, val, length, blob)?,
        }
    }
}

/// The readers of the records that hold no records.
fn parse_atom(
    guard: &mut Guard,
    rec: Rec,
    blob: &mut Blob<'_>,
    length: f64,
) -> Result<Val, Thrown> {
    match rec.handler {
        Handler::CString => {
            let text = c_string(blob, length);
            guard.take_text(text.len() as f64)?;
            Ok(Val::Text(text))
        }
        Handler::TextBytes => {
            if length.is_nan() || length < 0.0 || length > MAX_BYTES_ATOM {
                return Err(Thrown::Error("ppt: a byte atom that never ends".into()));
            }
            guard.take_text(length)?;
            let mut out = Vec::new();
            let mut i = 0.0;
            while i != length {
                out.push(u16::from(blob.read1().unwrap_or(0)));
                i += 1.0;
            }
            Ok(Val::Text(out))
        }
        Handler::TextHeader => {
            blob.read4();
            Ok(Val::Undefined)
        }
        Handler::CurrentUser => {
            blob.l += 8.0;
            let offset = blob.read4();
            blob.l += length - 12.0;
            Ok(Val::CurrentUser { offset })
        }
        Handler::UserEdit => {
            blob.l += 8.0;
            let last_edit = blob.read4();
            let persist_directory = blob.read4();
            blob.l += length - 16.0;
            Ok(Val::UserEdit {
                last_edit,
                persist_directory,
            })
        }
        Handler::PersistDirectory => {
            let end = blob.l + length;
            while blob.l < end {
                guard.record()?;
                let idcnt = blob.read4();
                let persist = to_uint32(idcnt) >> 20;
                for _ in 0..persist {
                    blob.read4();
                }
            }
            Ok(Val::Undefined)
        }
        Handler::SlidePersist => {
            blob.read4();
            blob.l += 4.0;
            blob.read4();
            blob.read4();
            blob.l += 4.0;
            Ok(Val::Undefined)
        }
        Handler::SlideAtom => {
            blob.read4();
            for _ in 0..8 {
                blob.read1();
            }
            blob.read4();
            blob.read4();
            blob.read2();
            blob.l += 2.0;
            Ok(Val::Undefined)
        }
        Handler::Fdg => {
            blob.read4();
            blob.read4();
            Ok(Val::Undefined)
        }
        Handler::EndDocument => {
            if length != 0.0 {
                return Err(Thrown::Text("EndDocumentAtom length != 0".into()));
            }
            Ok(Val::Undefined)
        }
        _ => {
            blob.l += length;
            Ok(Val::Undefined)
        }
    }
}

/// `x >>> 0` for a number read as int32 (NaN is 0).
fn to_uint32(value: f64) -> u32 {
    if value.is_nan() {
        0
    } else {
        value as i64 as u32
    }
}

/// `CFB.find`.
fn find<'a>(index: &'a [IndexEntry], path: &str) -> Option<&'a IndexEntry> {
    let uc_full: Vec<String> = index
        .iter()
        .map(|entry| entry.full_path.to_uppercase())
        .collect();
    let uc_paths: Vec<String> = uc_full
        .iter()
        .map(|full| {
            let parts: Vec<&str> = full.split('/').collect();
            let back = if full.ends_with('/') { 2 } else { 1 };
            parts[parts.len() - back].to_owned()
        })
        .collect();
    let (by_full, path) = if let Some(rest) = path.strip_prefix('/') {
        let root = uc_full
            .first()
            .map_or("", |root| root.strip_suffix('/').unwrap_or(root));
        (true, format!("{root}{rest}"))
    } else {
        (path.contains('/'), path.to_owned())
    };
    let wanted = path.to_uppercase();
    let list = if by_full { &uc_full } else { &uc_paths };
    if let Some(at) = list.iter().position(|candidate| *candidate == wanted) {
        return index.get(at);
    }
    let chr1 = |c: char| ('\u{1}'..='\u{6}').contains(&c);
    let m = !wanted.chars().any(chr1);
    let wanted: String = wanted.chars().filter(|&c| c != '\0').collect();
    let wanted: String = if m {
        wanted
            .chars()
            .map(|c| if chr1(c) { '!' } else { c })
            .collect()
    } else {
        wanted
    };
    let fixed = |text: &str| -> String {
        text.chars()
            .map(|c| if m && chr1(c) { '!' } else { c })
            .filter(|&c| c != '\0')
            .collect()
    };
    (0..uc_full.len())
        .find(|&at| fixed(&uc_full[at]) == wanted || fixed(&uc_paths[at]) == wanted)
        .and_then(|at| index.get(at))
}

fn type_error_reading(what: &str, property: &str) -> Thrown {
    Thrown::Type(format!(
        "Cannot read properties of {what} (reading '{property}')"
    ))
}

/// What `process_ppt` collects: the slides and the documents.
struct Presentation {
    slides: Vec<Option<Option<Vec<Item>>>>,
    docs: Vec<Option<Vec<Text>>>,
}

/// `process_ppt`.
fn process_ppt(index: &[IndexEntry]) -> Result<Presentation, Thrown> {
    let longest = ["Current User", "PowerPoint Document"]
        .iter()
        .filter_map(|name| find(index, name)?.content.as_deref())
        .map(<[u8]>::len)
        .max()
        .unwrap_or(0) as u64;
    let mut guard = Guard {
        depth: 0,
        records: 0,
        text: 0,
        text_budget: TEXT_BUDGET_BASE + 8 * longest,
    };
    let custream = find(index, "Current User");
    let cublob = custream
        .ok_or_else(|| type_error_reading("null", "content"))?
        .content
        .as_deref();
    let pptstream = find(index, "PowerPoint Document");
    let pptblob = pptstream
        .ok_or_else(|| type_error_reading("null", "content"))?
        .content
        .as_deref();

    let mut cu: Option<f64> = None;
    let cublob = cublob.ok_or_else(|| type_error_reading("undefined", "length"))?;
    let mut custream = Blob::new(cublob);
    let end = custream.length();
    recordhopper(
        &mut guard,
        &mut custream,
        end,
        Some(&["RT_CurrentUserAtom"]),
        &mut |_, val, _, _| {
            if cu.is_some() {
                return Err(Thrown::Text(
                    "unexpected second RT_CurrentUserAtom in Current User stream".into(),
                ));
            }
            if let Val::CurrentUser { offset } = val {
                cu = Some(offset);
            }
            Ok(())
        },
    )?;

    let offset = cu.ok_or_else(|| type_error_reading("undefined", "offset"))?;
    let pptdata = pptblob
        .ok_or_else(|| Thrown::Type("Cannot set properties of undefined (setting 'l')".into()))?;
    let mut ppt = Blob::new(pptdata);
    ppt.l = offset;

    let mut ueas: Vec<(f64, f64)> = Vec::new();
    let end = ppt.length();
    recordhopper(
        &mut guard,
        &mut ppt,
        end,
        Some(&["RT_PersistDirectoryAtom", "RT_UserEditAtom"]),
        &mut |rec, val, _, blob| {
            if rec.name == "RT_UserEditAtom" {
                if let Val::UserEdit {
                    last_edit,
                    persist_directory,
                } = val
                {
                    ueas.push((last_edit, persist_directory));
                    blob.l = persist_directory;
                }
            } else {
                let Some(&(last_edit, _)) = ueas.last() else {
                    return Err(type_error_reading("undefined", "offsetLastEdit"));
                };
                blob.l = last_edit;
                if blob.l == 0.0 {
                    blob.l = blob.length();
                }
            }
            Ok(())
        },
    )?;

    let mut out = Presentation {
        slides: Vec::new(),
        docs: Vec::new(),
    };
    ppt.l = 0.0;
    let end = ppt.length();
    recordhopper(&mut guard, &mut ppt, end, None, &mut |rec, val, _, _| {
        match (rec.name, val) {
            ("RT_Slide", Val::Slide { drawing }) => out.slides.push(drawing),
            ("RT_Document", Val::Document { slide_list }) => out.docs.push(slide_list),
            _ => {}
        }
        Ok(())
    })?;
    Ok(out)
}

/// `to_text`.
fn to_text(presentation: &Presentation) -> Result<Vec<Text>, Thrown> {
    if !presentation.slides.is_empty() {
        let mut out = Vec::new();
        for drawing in &presentation.slides {
            let Some(drawing) = drawing else {
                out.push(Vec::new());
                continue;
            };
            let Some(items) = drawing else {
                return Err(type_error_reading("undefined", "length"));
            };
            let mut texts: Vec<&Text> = Vec::new();
            for item in items {
                if let Item::Shape(Some(text)) = item {
                    texts.push(text);
                }
            }
            out.push(join_lines(&texts));
        }
        return Ok(out);
    }
    if presentation
        .docs
        .first()
        .is_some_and(|doc| doc.as_ref().is_some_and(|list| !list.is_empty()))
    {
        let mut out = Vec::new();
        for doc in &presentation.docs {
            let Some(list) = doc else {
                return Err(type_error_reading("undefined", "length"));
            };
            out.extend(list.iter().cloned());
        }
        return Ok(out);
    }
    Ok(Vec::new())
}

fn join_lines(texts: &[&Text]) -> Text {
    let mut out = Vec::new();
    for (at, text) in texts.iter().enumerate() {
        if at > 0 {
            out.push(0x0a);
        }
        out.extend_from_slice(text);
    }
    out
}

/// `pptToText`.
pub fn ppt_to_text(bytes: &[u8]) -> Result<String, JsError> {
    assert_sound_compound_file(bytes, "PowerPoint 97-2003")?;
    let index = compound::read_index(bytes).map_err(JsError::of_cfb)?;
    let presentation = process_ppt(&index)?;
    let slides = to_text(&presentation)?;
    let mut out: Text = Vec::new();
    for (at, text) in slides.iter().enumerate() {
        if at > 0 {
            out.extend("\n\n".encode_utf16());
        }
        let content = normalize_text(text);
        out.extend(format!("## Slide {}", at + 1).encode_utf16());
        if !content.is_empty() {
            out.push(0x0a);
            out.extend_from_slice(&content);
        }
    }
    Ok(String::from_utf16_lossy(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(kind: u16, length: i32) -> Vec<u8> {
        let mut out = vec![0, 0];
        out.extend(kind.to_le_bytes());
        out.extend(length.to_le_bytes());
        out
    }

    #[test]
    fn a_rewind_over_a_text_atom_is_refused() {
        // SlideListWithText { TextCharsAtom "ab"; DocumentAtom of length -22 }:
        // the noop atom walks back to the text atom, for ever.
        let mut body = header(0x0FA0, 4);
        body.extend([b'a', 0, b'b', 0]);
        body.extend(header(0x03E9, -(8 + 4 + 8)));
        let mut data = header(0x0FF0, body.len() as i32);
        data.extend(body);
        let mut guard = Guard {
            depth: 0,
            records: 0,
            text: 0,
            text_budget: TEXT_BUDGET_BASE + 8 * data.len() as u64,
        };
        let mut blob = Blob::new(&data);
        let end = blob.length();
        let got = recordhopper(&mut guard, &mut blob, end, None, &mut |_, _, _, _| Ok(()));
        assert!(matches!(got, Err(Thrown::Error(m)) if m == "ppt: the text never ends"));
    }
}
