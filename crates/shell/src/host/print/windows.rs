//! Silent printing on Windows: the PDF the page was rendered to (CDP
//! `Page.printToPDF`, host/contents.rs) is drawn page by page into a GDI printer DC.
//!
//! CEF has no silent print, and the repo's pdfium is an Emscripten wasm module, so
//! there is no native PDF renderer to link. `Windows.Data.Pdf` (WinRT, Windows 10+)
//! renders a page to a bitmap without shipping a binary; `StretchDIBits` puts the
//! bitmap on the printer's page. Settings that Electron's `webContents.print` took
//! (copies, collate, duplex, orientation, colour) go in the DEVMODE the driver
//! validates in `DocumentPropertiesW`.
//!
//! The top half is pure (no Win32): it compiles and is unit-tested on every host.
//! The `native` half is `cfg(windows)`. The module is declared with
//! `#[cfg(any(windows, test))] mod windows;` in host/print.rs.
//!
//! `::windows` is spelled with the leading `::` because this module is itself
//! called `windows` and must not shadow the crate.

// Off Windows only the tests use the pure half.
#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
pub(crate) use native::{print_pdf, printers};

/// Both-sides printing, as Electron's `duplexMode`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Duplex {
    Simplex,
    LongEdge,
    ShortEdge,
}

/// What `webContents.print({ silent: true, ... })` took that a PDF spool can honour.
/// The paper size is not here: the page is fitted to the printer's printable area, and
/// the PDF already carries the size the page was laid out for.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SilentJob {
    /// `None` or `""`: the default printer
    pub device_name: Option<String>,
    pub copies: u32,
    pub collate: bool,
    pub duplex: Option<Duplex>,
    pub landscape: bool,
    /// `Some(false)` prints in greyscale; `None` leaves the driver's default
    pub color: Option<bool>,
    /// 1-based, inclusive; empty = every page
    pub page_ranges: Vec<(u32, u32)>,
    /// Resolution pages are rendered at (never above the printer's own)
    pub dpi: u32,
}

impl Default for SilentJob {
    fn default() -> Self {
        Self {
            device_name: None,
            copies: 1,
            collate: false,
            duplex: None,
            landscape: false,
            color: None,
            page_ranges: Vec::new(),
            dpi: DEFAULT_DPI,
        }
    }
}

pub(crate) const DEFAULT_DPI: u32 = 300;
const MIN_DPI: u32 = 72;
const MAX_DPI: u32 = 1200;
/// A rendered bitmap side above this is scaled down: 16384 x 16384 x 4 bytes is already
/// a gigabyte, and WinRT's renderer fails somewhere above it anyway.
const MAX_RENDER_SIDE: u32 = 16_384;

// DEVMODE values (wingdi.h). Declared here so the mapping below is testable off Windows;
// the `native` half asserts at compile time that they equal the `windows` crate's.
const DM_ORIENTATION: u32 = 0x0000_0001;
const DM_COPIES: u32 = 0x0000_0100;
const DM_COLOR: u32 = 0x0000_0800;
const DM_DUPLEX: u32 = 0x0000_1000;
const DM_COLLATE: u32 = 0x0000_8000;
const DMORIENT_PORTRAIT: i16 = 1;
const DMORIENT_LANDSCAPE: i16 = 2;
const DMCOLOR_MONOCHROME: i16 = 1;
const DMCOLOR_COLOR: i16 = 2;
const DMDUP_SIMPLEX: i16 = 1;
const DMDUP_VERTICAL: i16 = 2;
const DMDUP_HORIZONTAL: i16 = 3;

/// How many copies the driver makes and how many the loop makes
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CopyPlan {
    /// `dmCopies` handed to the driver
    pub driver_copies: u32,
    pub driver_collate: bool,
    /// Whole-document repeats inside one StartDoc/EndDoc (collated copies by hand)
    pub document_passes: u32,
    /// Times one page is emitted in a row (uncollated copies by hand)
    pub page_repeats: u32,
}

/// The driver's own copies are preferred (it spools once and the printer makes the
/// copies). Many drivers ignore `dmCopies` or cannot collate; `DC_COPIES` and
/// `DC_COLLATE` say so, and then the loop makes the copies.
pub(crate) fn plan_copies(
    copies: u32,
    collate: bool,
    driver_max_copies: i32,
    driver_can_collate: bool,
) -> CopyPlan {
    let copies = copies.max(1);
    let by_driver = copies == 1
        || (i64::from(driver_max_copies) >= i64::from(copies) && (!collate || driver_can_collate));
    if by_driver {
        // `dmCopies` is an `i16`
        let driver_copies = copies.min(i16::MAX as u32);
        return CopyPlan {
            driver_copies,
            driver_collate: collate && copies > 1,
            document_passes: 1,
            page_repeats: 1,
        };
    }
    CopyPlan {
        driver_copies: 1,
        driver_collate: false,
        document_passes: if collate { copies } else { 1 },
        page_repeats: if collate { 1 } else { copies },
    }
}

/// The DEVMODE members this job sets, before the driver merges them
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DevmodeRequest {
    /// `dmFields`: which of the members below are valid
    pub fields: u32,
    pub orientation: i16,
    pub copies: i16,
    pub collate: bool,
    pub color: Option<i16>,
    pub duplex: Option<i16>,
}

pub(crate) fn devmode_request(job: &SilentJob, plan: &CopyPlan) -> DevmodeRequest {
    let mut fields = DM_ORIENTATION | DM_COPIES;
    if plan.driver_copies > 1 {
        fields |= DM_COLLATE;
    }
    let color = job.color.map(|color| {
        fields |= DM_COLOR;
        if color { DMCOLOR_COLOR } else { DMCOLOR_MONOCHROME }
    });
    let duplex = job.duplex.map(|duplex| {
        fields |= DM_DUPLEX;
        match duplex {
            Duplex::Simplex => DMDUP_SIMPLEX,
            // the same mapping as Chromium's and the CUPS path's
            Duplex::LongEdge => DMDUP_VERTICAL,
            Duplex::ShortEdge => DMDUP_HORIZONTAL,
        }
    });
    DevmodeRequest {
        fields,
        orientation: if job.landscape { DMORIENT_LANDSCAPE } else { DMORIENT_PORTRAIT },
        copies: plan.driver_copies as i16,
        collate: plan.driver_collate,
        color,
        duplex,
    }
}

/// The 1-based pages to print, ascending and without repeats. A range written backwards
/// is read forwards, `0` counts as 1, and a range past the end is cut at the last page.
/// An empty list is every page; a list that selects none is an error rather than an
/// empty job.
pub(crate) fn expand_page_ranges(ranges: &[(u32, u32)], page_count: u32) -> Result<Vec<u32>, String> {
    if page_count == 0 {
        return Err("the PDF has no pages".into());
    }
    if ranges.is_empty() {
        return Ok((1..=page_count).collect());
    }
    let mut selected = vec![false; page_count as usize];
    for &(a, b) in ranges {
        let (from, to) = if a <= b { (a, b) } else { (b, a) };
        let from = from.max(1);
        let to = to.min(page_count);
        for page in from..=to {
            selected[page as usize - 1] = true;
        }
    }
    let pages: Vec<u32> = (1..=page_count).filter(|page| selected[*page as usize - 1]).collect();
    if pages.is_empty() {
        return Err(format!("the page ranges select no page of the {page_count} in the document"));
    }
    Ok(pages)
}

/// A rectangle in device pixels
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// A WinRT page size is in DIPs (1/96 inch); the printer's pixels need not be square.
pub(crate) fn natural_size_px(page_dip: (f32, f32), dpi_x: i32, dpi_y: i32) -> (f64, f64) {
    (
        f64::from(page_dip.0) / 96.0 * f64::from(dpi_x),
        f64::from(page_dip.1) / 96.0 * f64::from(dpi_y),
    )
}

/// The page scaled to fit the printable area, centred, aspect ratio kept (a bigger
/// page shrinks, a smaller one grows: "fit to page"). The device origin of a printer DC
/// is the corner of the printable area, so the rectangle needs no physical offset.
pub(crate) fn fit_in_area(natural: (f64, f64), area: (i32, i32)) -> Option<Rect> {
    let (natural_w, natural_h) = natural;
    let (area_w, area_h) = area;
    if !(natural_w > 0.0 && natural_h > 0.0) || area_w <= 0 || area_h <= 0 {
        return None;
    }
    let scale = (f64::from(area_w) / natural_w).min(f64::from(area_h) / natural_h);
    let width = ((natural_w * scale).round() as i32).clamp(1, area_w);
    let height = ((natural_h * scale).round() as i32).clamp(1, area_h);
    Some(Rect { x: (area_w - width) / 2, y: (area_h - height) / 2, width, height })
}

/// The bitmap WinRT renders for a page that lands in `dest`: capped at `render_dpi`
/// (more pixels than the printer has are wasted) and at `MAX_RENDER_SIDE`.
pub(crate) fn render_size(dest: Rect, dpi_x: i32, dpi_y: i32, render_dpi: u32) -> (u32, u32) {
    let render_dpi = f64::from(render_dpi.clamp(MIN_DPI, MAX_DPI));
    let scale_x = (render_dpi / f64::from(dpi_x.max(1))).min(1.0);
    let scale_y = (render_dpi / f64::from(dpi_y.max(1))).min(1.0);
    let mut width = (f64::from(dest.width) * scale_x).round().max(1.0);
    let mut height = (f64::from(dest.height) * scale_y).round().max(1.0);
    let longest = width.max(height);
    if longest > f64::from(MAX_RENDER_SIDE) {
        let shrink = f64::from(MAX_RENDER_SIDE) / longest;
        width = (width * shrink).round().max(1.0);
        height = (height * shrink).round().max(1.0);
    }
    (width as u32, height as u32)
}

/// Greyscale in place for a BGRA bitmap, for a driver that ignores `dmColor`
/// (BT.601 luma, integer).
pub(crate) fn to_grayscale_bgra(pixels: &mut [u8]) {
    let (pixels, _) = pixels.as_chunks_mut::<4>();
    for pixel in pixels {
        let (b, g, r) = (u32::from(pixel[0]), u32::from(pixel[1]), u32::from(pixel[2]));
        let luma = ((r * 299 + g * 587 + b * 114) / 1000) as u8;
        pixel[0] = luma;
        pixel[1] = luma;
        pixel[2] = luma;
    }
}

/// `None` and `""` name the default printer
pub(crate) fn requested_printer(name: &Option<String>) -> Option<&str> {
    name.as_deref().map(str::trim).filter(|name| !name.is_empty())
}

#[cfg(windows)]
mod native {
    use std::mem::size_of;

    use ::windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
    use ::windows::Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
        ExifOrientationMode,
    };
    use ::windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use ::windows::UI::Color;
    use ::windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use ::windows::Win32::Graphics::Gdi::{
        self, BITMAPINFO, BI_RGB, CreateDCW, DEVMODEW, DeleteDC,
        DIB_RGB_COLORS, GetDeviceCaps, HALFTONE, HDC, HORZRES, LOGPIXELSX, LOGPIXELSY, SRCCOPY,
        SetStretchBltMode, StretchDIBits, VERTRES,
    };
    use ::windows::Win32::Graphics::Printing::{
        ClosePrinter, DocumentPropertiesW, EnumPrintersW, GetDefaultPrinterW, OpenPrinterW,
        PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_4W,
    };
    use ::windows::Win32::Storage::Xps::{
        AbortDoc, DC_COLLATE, DC_COPIES, DOCINFOW, DeviceCapabilitiesW, EndDoc, EndPage,
        PRINTER_DEVICE_CAPABILITIES, StartDocW, StartPage,
    };
    use ::windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
    use ::windows::core::{PCWSTR, PWSTR};

    use super::*;

    // The pure half's DEVMODE values are the platform's.
    const _: () = {
        assert!(DM_ORIENTATION == Gdi::DM_ORIENTATION.0);
        assert!(DM_COPIES == Gdi::DM_COPIES.0);
        assert!(DM_COLOR == Gdi::DM_COLOR.0);
        assert!(DM_DUPLEX == Gdi::DM_DUPLEX.0);
        assert!(DM_COLLATE == Gdi::DM_COLLATE.0);
        assert!(DMORIENT_PORTRAIT == Gdi::DMORIENT_PORTRAIT as i16);
        assert!(DMORIENT_LANDSCAPE == Gdi::DMORIENT_LANDSCAPE as i16);
        assert!(DMCOLOR_MONOCHROME == Gdi::DMCOLOR_MONOCHROME.0);
        assert!(DMCOLOR_COLOR == Gdi::DMCOLOR_COLOR.0);
        assert!(DMDUP_SIMPLEX == Gdi::DMDUP_SIMPLEX.0);
        assert!(DMDUP_VERTICAL == Gdi::DMDUP_VERTICAL.0);
        assert!(DMDUP_HORIZONTAL == Gdi::DMDUP_HORIZONTAL.0);
    };

    /// `DocumentPropertiesW` returns `IDOK` (1) on success
    const IDOK: i32 = 1;

    fn os_err(context: &str, error: ::windows::core::Error) -> String {
        format!("{context}: {error}")
    }

    /// The GDI calls report failure by a return value and put the reason in the thread's
    /// last error.
    fn last_error(context: &str, returned: i32) -> String {
        let error = ::windows::core::Error::from_thread();
        if error.code().is_ok() {
            format!("{context}: failed (code {returned})")
        } else {
            os_err(context, error)
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A struct the driver fills, 8-byte aligned (a `Vec<u8>` is not)
    struct AlignedBuf {
        words: Vec<u64>,
        len: usize,
    }

    impl AlignedBuf {
        fn zeroed(len: usize) -> Self {
            Self { words: vec![0; len.div_ceil(8).max(1)], len }
        }

        fn bytes_mut(&mut self) -> &mut [u8] {
            // SAFETY: `words` owns at least `len` initialised bytes
            unsafe { std::slice::from_raw_parts_mut(self.words.as_mut_ptr().cast(), self.len) }
        }

        fn as_devmode(&mut self) -> *mut DEVMODEW {
            self.words.as_mut_ptr().cast()
        }
    }

    /// WinRT is initialised once per worker thread and released when the job ends.
    struct WinRt(bool);

    impl WinRt {
        fn init() -> Result<Self, String> {
            // SAFETY: balanced by `RoUninitialize` in `Drop` whenever it succeeded
            match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
                Ok(()) => Ok(Self(true)),
                // the thread already runs in a single-threaded apartment: WinRT works
                // there, and it is not ours to tear down
                Err(error) if error.code() == RPC_E_CHANGED_MODE => Ok(Self(false)),
                Err(error) => Err(os_err("WinRT initialisation", error)),
            }
        }
    }

    impl Drop for WinRt {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: pairs the successful `RoInitialize`
                unsafe { RoUninitialize() };
            }
        }
    }

    struct Printer(PRINTER_HANDLE);

    impl Printer {
        fn open(name: &[u16]) -> Result<Self, String> {
            let mut handle = PRINTER_HANDLE::default();
            // SAFETY: `name` is NUL-terminated and outlives the call
            unsafe { OpenPrinterW(PCWSTR(name.as_ptr()), &mut handle, None) }
                .map_err(|error| os_err("OpenPrinter", error))?;
            Ok(Self(handle))
        }
    }

    impl Drop for Printer {
        fn drop(&mut self) {
            // SAFETY: the handle came from `OpenPrinterW`
            let _ = unsafe { ClosePrinter(self.0) };
        }
    }

    struct PrinterDc(HDC);

    impl Drop for PrinterDc {
        fn drop(&mut self) {
            // SAFETY: the DC came from `CreateDCW` and is deleted once
            let _ = unsafe { DeleteDC(self.0) };
        }
    }

    /// A started document that is aborted unless `EndDoc` finished it, so a failed page
    /// does not leave a half job in the queue.
    struct Document<'a> {
        dc: &'a PrinterDc,
        finished: bool,
    }

    impl Drop for Document<'_> {
        fn drop(&mut self) {
            if !self.finished {
                // SAFETY: the DC is alive and has a started document
                unsafe { AbortDoc(self.dc.0) };
            }
        }
    }

    pub(crate) fn printers() -> Result<Vec<(String, String, bool)>, String> {
        let default = default_printer();
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        // The list can change between the sizing call and the filling one.
        for _ in 0..3 {
            let (mut needed, mut returned) = (0u32, 0u32);
            // SAFETY: with no buffer the call only reports the size
            let sizing = unsafe {
                EnumPrintersW(flags, PCWSTR::null(), 4, None, &mut needed, &mut returned)
            };
            if needed == 0 {
                // no printer, or a failure that is not "buffer too small"
                return match sizing {
                    Ok(()) => Ok(Vec::new()),
                    Err(error) => Err(os_err("EnumPrinters", error)),
                };
            }
            let mut buffer = AlignedBuf::zeroed(needed as usize);
            // SAFETY: `buffer` is `needed` bytes
            let filled = unsafe {
                EnumPrintersW(
                    flags,
                    PCWSTR::null(),
                    4,
                    Some(buffer.bytes_mut()),
                    &mut needed,
                    &mut returned,
                )
            };
            match filled {
                Ok(()) => {
                    let infos = buffer.words.as_ptr().cast::<PRINTER_INFO_4W>();
                    let mut printers = Vec::with_capacity(returned as usize);
                    for index in 0..returned as usize {
                        // SAFETY: the call filled `returned` consecutive PRINTER_INFO_4W,
                        // whose name pointers point into the same buffer
                        let name = unsafe { (*infos.add(index)).pPrinterName.to_string() }
                            .map_err(|error| format!("EnumPrinters: a printer name is not UTF-16: {error}"))?;
                        let is_default =
                            default.as_ref().is_some_and(|default| default.to_lowercase() == name.to_lowercase());
                        // Windows has one name per queue; a description would need the
                        // slower level 2
                        printers.push((name.clone(), name, is_default));
                    }
                    return Ok(printers);
                }
                // the list grew: size it again
                Err(error) if error.code() == ::windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER.to_hresult() => {}
                Err(error) => return Err(os_err("EnumPrinters", error)),
            }
        }
        Err("EnumPrinters: the printer list kept changing".into())
    }

    fn default_printer() -> Option<String> {
        let mut len = 0u32;
        // SAFETY: with no buffer the call only reports the length (in UTF-16 units, NUL included)
        let _ = unsafe { GetDefaultPrinterW(None, &mut len) };
        if len == 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize];
        // SAFETY: `buffer` holds `len` UTF-16 units
        let ok = unsafe { GetDefaultPrinterW(Some(PWSTR(buffer.as_mut_ptr())), &mut len) };
        if !ok.as_bool() {
            return None;
        }
        let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]))
    }

    pub(crate) fn print_pdf(pdf: &[u8], job: &SilentJob, doc_name: &str) -> Result<(), String> {
        if pdf.is_empty() {
            return Err("the PDF is empty".into());
        }
        let _winrt = WinRt::init()?;

        // Open the document first: a PDF Windows cannot read fails before the printer
        // is touched.
        let document = load_pdf(pdf)?;
        let page_count = document.PageCount().map_err(|error| os_err("PDF page count", error))?;
        let pages = expand_page_ranges(&job.page_ranges, page_count)?;

        let name = match requested_printer(&job.device_name) {
            Some(name) => name.to_owned(),
            None => default_printer().ok_or("there is no default printer")?,
        };
        let name_w = wide(&name);

        let driver_max_copies = device_capability(&name_w, DC_COPIES);
        let driver_can_collate = device_capability(&name_w, DC_COLLATE) == 1;
        let plan = plan_copies(job.copies, job.collate, driver_max_copies, driver_can_collate);
        let request = devmode_request(job, &plan);

        let mut devmode = {
            let printer = Printer::open(&name_w)?;
            merged_devmode(&printer, &name_w, &request)?
        };
        // SAFETY: `devmode` is the validated DEVMODE the driver returned
        let dc = unsafe {
            CreateDCW(
                ::windows::core::w!("WINSPOOL"),
                PCWSTR(name_w.as_ptr()),
                PCWSTR::null(),
                Some(devmode.as_devmode().cast_const()),
            )
        };
        if dc.is_invalid() {
            return Err(last_error(&format!("CreateDC for \"{name}\""), 0));
        }
        let dc = PrinterDc(dc);

        // SAFETY: the DC is alive
        let (dpi_x, dpi_y, area_w, area_h) = unsafe {
            (
                GetDeviceCaps(Some(dc.0), LOGPIXELSX),
                GetDeviceCaps(Some(dc.0), LOGPIXELSY),
                GetDeviceCaps(Some(dc.0), HORZRES),
                GetDeviceCaps(Some(dc.0), VERTRES),
            )
        };
        if dpi_x <= 0 || dpi_y <= 0 || area_w <= 0 || area_h <= 0 {
            return Err(format!("\"{name}\" reports no printable area ({area_w} x {area_h} at {dpi_x} x {dpi_y} dpi)"));
        }

        let doc_name_w = wide(doc_name);
        let info = DOCINFOW {
            cbSize: size_of::<DOCINFOW>() as i32,
            lpszDocName: PCWSTR(doc_name_w.as_ptr()),
            lpszOutput: PCWSTR::null(),
            lpszDatatype: PCWSTR::null(),
            fwType: 0,
        };
        // SAFETY: `info` and the strings it points to outlive the call
        let started = unsafe { StartDocW(dc.0, &info) };
        if started <= 0 {
            return Err(last_error("StartDoc", started));
        }
        let mut job_doc = Document { dc: &dc, finished: false };

        let grayscale = job.color == Some(false);
        for _ in 0..plan.document_passes {
            for &page_number in &pages {
                let page = document
                    .GetPage(page_number - 1)
                    .map_err(|error| os_err(&format!("PDF page {page_number}"), error))?;
                let size = page.Size().map_err(|error| os_err("PDF page size", error))?;
                let natural = natural_size_px((size.Width, size.Height), dpi_x, dpi_y);
                let target = fit_in_area(natural, (area_w, area_h))
                    .ok_or_else(|| format!("PDF page {page_number} has no size"))?;
                let (render_w, render_h) = render_size(target, dpi_x, dpi_y, job.dpi.max(1));

                let options = PdfPageRenderOptions::new().map_err(|error| os_err("PDF render options", error))?;
                options.SetDestinationWidth(render_w).map_err(|error| os_err("PDF render options", error))?;
                options.SetDestinationHeight(render_h).map_err(|error| os_err("PDF render options", error))?;
                // paper is white, and a high-contrast theme must not recolour a print
                options
                    .SetBackgroundColor(Color { A: 255, R: 255, G: 255, B: 255 })
                    .map_err(|error| os_err("PDF render options", error))?;
                options.SetIsIgnoringHighContrast(true).map_err(|error| os_err("PDF render options", error))?;

                let (mut pixels, width, height) = render_page(&page, &options, page_number)?;
                if grayscale {
                    to_grayscale_bgra(&mut pixels);
                }
                for _ in 0..plan.page_repeats {
                    // SAFETY: the DC has a started document
                    let started = unsafe { StartPage(dc.0) };
                    if started <= 0 {
                        return Err(last_error("StartPage", started));
                    }
                    draw_bitmap(&dc, target, &pixels, width, height)?;
                    // SAFETY: the page was started
                    let ended = unsafe { EndPage(dc.0) };
                    if ended <= 0 {
                        return Err(last_error("EndPage", ended));
                    }
                }
            }
        }

        // SAFETY: the document was started
        let ended = unsafe { EndDoc(dc.0) };
        if ended <= 0 {
            return Err(last_error("EndDoc", ended));
        }
        job_doc.finished = true;
        Ok(())
    }

    fn load_pdf(pdf: &[u8]) -> Result<PdfDocument, String> {
        let stream = InMemoryRandomAccessStream::new().map_err(|error| os_err("PDF stream", error))?;
        let writer = DataWriter::CreateDataWriter(&stream).map_err(|error| os_err("PDF stream", error))?;
        writer.WriteBytes(pdf).map_err(|error| os_err("PDF stream", error))?;
        writer
            .StoreAsync()
            .and_then(|operation| operation.join())
            .map_err(|error| os_err("PDF stream", error))?;
        // the stream is the writer's until it is detached
        writer.DetachStream().map_err(|error| os_err("PDF stream", error))?;
        stream.Seek(0).map_err(|error| os_err("PDF stream", error))?;
        PdfDocument::LoadFromStreamAsync(&stream)
            .and_then(|operation| operation.join())
            .map_err(|error| os_err("Windows could not open the PDF", error))
    }

    /// One page as top-down BGRA, and its size in pixels
    fn render_page(
        page: &::windows::Data::Pdf::PdfPage,
        options: &PdfPageRenderOptions,
        page_number: u32,
    ) -> Result<(Vec<u8>, i32, i32), String> {
        let context = format!("rendering PDF page {page_number}");
        let encoded = InMemoryRandomAccessStream::new().map_err(|error| os_err(&context, error))?;
        page.RenderWithOptionsToStreamAsync(&encoded, options)
            .and_then(|action| action.join())
            .map_err(|error| os_err(&context, error))?;
        encoded.Seek(0).map_err(|error| os_err(&context, error))?;
        let decoder = BitmapDecoder::CreateAsync(&encoded)
            .and_then(|operation| operation.join())
            .map_err(|error| os_err(&context, error))?;
        let width = decoder.PixelWidth().map_err(|error| os_err(&context, error))?;
        let height = decoder.PixelHeight().map_err(|error| os_err(&context, error))?;
        let transform = BitmapTransform::new().map_err(|error| os_err(&context, error))?;
        let provider = decoder
            .GetPixelDataTransformedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Straight,
                &transform,
                ExifOrientationMode::IgnoreExifOrientation,
                ColorManagementMode::DoNotColorManage,
            )
            .and_then(|operation| operation.join())
            .map_err(|error| os_err(&context, error))?;
        let pixels = provider.DetachPixelData().map_err(|error| os_err(&context, error))?.to_vec();
        if width == 0 || height == 0 || pixels.len() < width as usize * height as usize * 4 {
            return Err(format!("{context}: the bitmap is {width} x {height} with {} bytes", pixels.len()));
        }
        Ok((pixels, width as i32, height as i32))
    }

    fn draw_bitmap(dc: &PrinterDc, target: Rect, bgra: &[u8], width: i32, height: i32) -> Result<(), String> {
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<::windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        // a negative height is a top-down DIB, which is how the decoder lays rows out
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;
        // SAFETY: `bgra` holds `width * height` 32-bit pixels (checked in `render_page`);
        // the DC has a started page
        let scanlines = unsafe {
            // averaging, not dropping, pixels when a printer has fewer than the bitmap
            SetStretchBltMode(dc.0, HALFTONE);
            StretchDIBits(
                dc.0,
                target.x,
                target.y,
                target.width,
                target.height,
                0,
                0,
                width,
                height,
                Some(bgra.as_ptr().cast()),
                &info,
                DIB_RGB_COLORS,
                SRCCOPY,
            )
        };
        if scanlines <= 0 {
            return Err(last_error("StretchDIBits", scanlines));
        }
        Ok(())
    }

    fn device_capability(name: &[u16], capability: PRINTER_DEVICE_CAPABILITIES) -> i32 {
        // SAFETY: `name` is NUL-terminated; with no output buffer the call returns the
        // capability's count or flag (-1 when the driver does not know it)
        unsafe {
            DeviceCapabilitiesW(PCWSTR(name.as_ptr()), PCWSTR::null(), capability, None, None)
        }
    }

    /// The driver's DEVMODE for the printer with this job's members merged in. The driver
    /// is the one that knows which values it supports, so it validates the merge.
    fn merged_devmode(printer: &Printer, name: &[u16], request: &DevmodeRequest) -> Result<AlignedBuf, String> {
        let name = PCWSTR(name.as_ptr());
        // SAFETY: with no output the call returns the size of the driver's DEVMODE
        let size = unsafe { DocumentPropertiesW(None, printer.0, name, None, None, 0) };
        if size <= 0 {
            return Err(last_error("DocumentProperties (size)", size));
        }
        let mut buffer = AlignedBuf::zeroed(size as usize);
        let devmode = buffer.as_devmode();
        let out = Gdi::DM_OUT_BUFFER.0;
        // SAFETY: `buffer` is the `size` bytes the driver asked for
        let got = unsafe { DocumentPropertiesW(None, printer.0, name, Some(devmode), None, out) };
        if got != IDOK {
            return Err(last_error("DocumentProperties (defaults)", got));
        }
        // SAFETY: the driver wrote a DEVMODEW at the start of `buffer`
        unsafe {
            let dm = &mut *devmode;
            dm.dmFields = Gdi::DEVMODE_FIELD_FLAGS(dm.dmFields.0 | request.fields);
            dm.Anonymous1.Anonymous1.dmOrientation = request.orientation;
            dm.Anonymous1.Anonymous1.dmCopies = request.copies;
            dm.dmCollate = Gdi::DEVMODE_COLLATE(i16::from(request.collate));
            if let Some(color) = request.color {
                dm.dmColor = Gdi::DEVMODE_COLOR(color);
            }
            if let Some(duplex) = request.duplex {
                dm.dmDuplex = Gdi::DEVMODE_DUPLEX(duplex);
            }
        }
        let merge = Gdi::DM_IN_BUFFER.0 | Gdi::DM_OUT_BUFFER.0;
        // SAFETY: the same buffer is the input and the output, which the API allows
        let merged = unsafe {
            DocumentPropertiesW(None, printer.0, name, Some(devmode), Some(devmode.cast_const()), merge)
        };
        if merged != IDOK {
            return Err(last_error("DocumentProperties (merge)", merged));
        }
        Ok(buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_copy_is_the_drivers_whatever_it_supports() {
        let plan = plan_copies(1, true, -1, false);
        assert_eq!(
            plan,
            CopyPlan { driver_copies: 1, driver_collate: false, document_passes: 1, page_repeats: 1 }
        );
        assert_eq!(plan_copies(0, false, 0, false), plan_copies(1, false, 0, false));
    }

    #[test]
    fn copies_go_to_the_driver_when_it_makes_them() {
        let plan = plan_copies(3, true, 99, true);
        assert_eq!(
            plan,
            CopyPlan { driver_copies: 3, driver_collate: true, document_passes: 1, page_repeats: 1 }
        );
        // uncollated copies need no collate support
        let plan = plan_copies(3, false, 99, false);
        assert_eq!(
            plan,
            CopyPlan { driver_copies: 3, driver_collate: false, document_passes: 1, page_repeats: 1 }
        );
    }

    #[test]
    fn a_driver_that_ignores_copies_leaves_them_to_the_loop() {
        // DC_COPIES of 1 (or -1, unknown): collated copies repeat the document,
        // uncollated copies repeat each page
        for max in [1, -1, 0] {
            assert_eq!(
                plan_copies(3, true, max, true),
                CopyPlan { driver_copies: 1, driver_collate: false, document_passes: 3, page_repeats: 1 }
            );
            assert_eq!(
                plan_copies(3, false, max, false),
                CopyPlan { driver_copies: 1, driver_collate: false, document_passes: 1, page_repeats: 3 }
            );
        }
        // copies beyond the driver's maximum, or collating without driver support
        assert_eq!(plan_copies(5, false, 4, true).page_repeats, 5);
        assert_eq!(plan_copies(2, true, 99, false).document_passes, 2);
    }

    #[test]
    fn copies_past_the_devmode_range_are_clamped() {
        assert_eq!(plan_copies(100_000, false, i32::MAX, false).driver_copies, i16::MAX as u32);
    }

    #[test]
    fn the_devmode_carries_each_setting_and_only_those_asked_for() {
        let job = SilentJob { landscape: true, ..SilentJob::default() };
        let plan = plan_copies(1, false, 1, false);
        let request = devmode_request(&job, &plan);
        assert_eq!(request.fields, DM_ORIENTATION | DM_COPIES);
        assert_eq!(request.orientation, 2);
        assert_eq!(request.copies, 1);
        assert_eq!(request.color, None);
        assert_eq!(request.duplex, None);

        let job = SilentJob {
            copies: 2,
            collate: true,
            duplex: Some(Duplex::LongEdge),
            color: Some(false),
            ..SilentJob::default()
        };
        let plan = plan_copies(job.copies, job.collate, 99, true);
        let request = devmode_request(&job, &plan);
        assert_eq!(
            request.fields,
            DM_ORIENTATION | DM_COPIES | DM_COLLATE | DM_COLOR | DM_DUPLEX
        );
        assert_eq!(request.orientation, 1);
        assert_eq!(request.copies, 2);
        assert!(request.collate);
        assert_eq!(request.color, Some(1));
        assert_eq!(request.duplex, Some(2));
    }

    #[test]
    fn duplex_and_colour_map_to_the_wingdi_values() {
        let plan = plan_copies(1, false, 1, false);
        let duplex = |duplex| {
            devmode_request(&SilentJob { duplex: Some(duplex), ..SilentJob::default() }, &plan).duplex
        };
        assert_eq!(duplex(Duplex::Simplex), Some(1));
        assert_eq!(duplex(Duplex::LongEdge), Some(2));
        assert_eq!(duplex(Duplex::ShortEdge), Some(3));
        let colour = |color| {
            devmode_request(&SilentJob { color: Some(color), ..SilentJob::default() }, &plan).color
        };
        assert_eq!(colour(true), Some(2));
        assert_eq!(colour(false), Some(1));
    }

    #[test]
    fn no_ranges_is_every_page() {
        assert_eq!(expand_page_ranges(&[], 3), Ok(vec![1, 2, 3]));
    }

    #[test]
    fn ranges_are_ascending_distinct_and_cut_to_the_document() {
        assert_eq!(expand_page_ranges(&[(5, 6), (1, 2), (2, 3)], 10), Ok(vec![1, 2, 3, 5, 6]));
        assert_eq!(expand_page_ranges(&[(3, 99)], 5), Ok(vec![3, 4, 5]));
        // written backwards, and from page 0
        assert_eq!(expand_page_ranges(&[(4, 2)], 5), Ok(vec![2, 3, 4]));
        assert_eq!(expand_page_ranges(&[(0, 2)], 5), Ok(vec![1, 2]));
    }

    #[test]
    fn ranges_that_select_nothing_are_an_error() {
        assert!(expand_page_ranges(&[(7, 9)], 5).is_err());
        assert!(expand_page_ranges(&[], 0).is_err());
    }

    #[test]
    fn a_page_a_little_larger_than_the_area_shrinks_to_it() {
        // A4 at 600 dpi is 4960.6 x 7015.6 px; the printable area is a little smaller
        let natural = natural_size_px((793.7, 1122.5), 600, 600);
        assert!((natural.0 - 4960.6).abs() < 1.0 && (natural.1 - 7015.6).abs() < 1.0);
        // the width limits, so the height shrinks by the same factor and is centred
        let rect = fit_in_area(natural, (4800, 6800)).unwrap();
        assert_eq!(rect, Rect { x: 0, y: 6, width: 4800, height: 6788 });
    }

    #[test]
    fn fitting_keeps_the_aspect_ratio_and_centres() {
        // a wide page into a tall area: width limits
        assert_eq!(
            fit_in_area((200.0, 100.0), (100, 400)),
            Some(Rect { x: 0, y: 175, width: 100, height: 50 })
        );
        // a tall page into a wide area: height limits
        assert_eq!(
            fit_in_area((100.0, 200.0), (400, 100)),
            Some(Rect { x: 175, y: 0, width: 50, height: 100 })
        );
        // a small page grows to the area
        assert_eq!(
            fit_in_area((10.0, 10.0), (100, 100)),
            Some(Rect { x: 0, y: 0, width: 100, height: 100 })
        );
    }

    #[test]
    fn a_non_square_printer_pixel_is_part_of_the_natural_size() {
        // 96 x 96 DIPs is one inch each way: 600 x 300 px on a 600 x 300 dpi device
        let natural = natural_size_px((96.0, 96.0), 600, 300);
        assert_eq!(natural, (600.0, 300.0));
        assert_eq!(
            fit_in_area(natural, (1200, 1200)),
            Some(Rect { x: 0, y: 300, width: 1200, height: 600 })
        );
    }

    #[test]
    fn no_rectangle_without_a_page_or_an_area() {
        assert_eq!(fit_in_area((0.0, 10.0), (100, 100)), None);
        assert_eq!(fit_in_area((10.0, 10.0), (0, 100)), None);
        assert_eq!(fit_in_area((f64::NAN, 10.0), (100, 100)), None);
    }

    #[test]
    fn rendering_never_exceeds_the_printers_resolution_or_the_cap() {
        let dest = Rect { x: 0, y: 0, width: 4800, height: 6800 };
        // 600 dpi device rendered at 300: half the pixels each way
        assert_eq!(render_size(dest, 600, 600, 300), (2400, 3400));
        // a 300 dpi device asked for 600: its own resolution
        let dest = Rect { x: 0, y: 0, width: 2480, height: 3508 };
        assert_eq!(render_size(dest, 300, 300, 600), (2480, 3508));
        // an absurd request is clamped to MAX_DPI, then to the side cap
        let dest = Rect { x: 0, y: 0, width: 40_000, height: 20_000 };
        let (w, h) = render_size(dest, 1200, 1200, 99_999);
        assert_eq!((w, h), (16_384, 8_192));
    }

    #[test]
    fn grayscale_uses_luma_and_leaves_alpha() {
        // BGRA: pure red, pure green, white
        let mut pixels = [0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 7];
        to_grayscale_bgra(&mut pixels);
        assert_eq!(pixels, [76, 76, 76, 255, 149, 149, 149, 255, 255, 255, 255, 7]);
    }

    #[test]
    fn an_empty_or_blank_name_is_the_default_printer() {
        assert_eq!(requested_printer(&None), None);
        assert_eq!(requested_printer(&Some(String::new())), None);
        assert_eq!(requested_printer(&Some("  ".into())), None);
        assert_eq!(requested_printer(&Some("Office".into())), Some("Office"));
    }
}
