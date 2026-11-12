use std::cell::Cell;
use std::ffi::c_void;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSWindow};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_web_kit::WKWebView;

pub type Done = Box<dyn FnOnce(Result<(), String>)>;

struct Ivars {
    done: Cell<Option<Done>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SeuPrintDelegate"]
    #[ivars = Ivars]
    struct PrintDelegate;

    unsafe impl NSObjectProtocol for PrintDelegate {}

    impl PrintDelegate {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(&self, _op: &NSPrintOperation, success: bool, _ctx: *mut c_void) {
            if let Some(done) = self.ivars().done.take() {
                done(if success { Ok(()) } else { Err("NSPrintOperation reported failure".into()) });
            }
        }
    }
);

impl PrintDelegate {
    fn new(mtm: MainThreadMarker, done: Done) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(Ivars { done: Cell::new(Some(done)) });
        unsafe { msg_send![super(this), init] }
    }
}

/// Starts printing the page of `wk` to the PDF file `out`; `done` runs on the main thread when the
/// operation has finished.
///
/// # Safety
/// `wk` and `ns_window` must be live WKWebView and NSWindow pointers, and this must run on the main thread.
pub unsafe fn print_to_pdf(wk: *mut c_void, ns_window: *mut c_void, out: &str, width_in: f64, height_in: f64, done: Done) {
    let Some(mtm) = MainThreadMarker::new() else {
        done(Err("not on the main thread".into()));
        return;
    };
    let webview: &WKWebView = unsafe { &*wk.cast::<WKWebView>() };
    let window: &NSWindow = unsafe { &*ns_window.cast::<NSWindow>() };

    let (w, h) = (width_in * 72.0, height_in * 72.0);
    let info = NSPrintInfo::new();
    info.setPaperSize(NSSize::new(w, h));
    info.setTopMargin(0.0);
    info.setBottomMargin(0.0);
    info.setLeftMargin(0.0);
    info.setRightMargin(0.0);
    info.setJobDisposition(unsafe { NSPrintSaveJob });
    let url = NSURL::fileURLWithPath(&NSString::from_str(out));
    let dict = info.dictionary();
    unsafe { dict.setObject_forKey(&*url, objc2::runtime::ProtocolObject::from_ref(NSPrintJobSavingURL)) };

    let op: Retained<NSPrintOperation> = unsafe { webview.printOperationWithPrintInfo(&info) };
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    if let Some(view) = op.view() {
        view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, h)));
    }
    let delegate = PrintDelegate::new(mtm, done);
    let target: &AnyObject = &delegate;
    unsafe {
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            window,
            Some(target),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            std::ptr::null_mut(),
        );
    }
    // the print system keeps no strong reference to its delegate
    std::mem::forget(delegate);
}
