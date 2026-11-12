// WebView2 route of the print_pdf command: ICoreWebView2_7::PrintToPdf with print settings
// from ICoreWebView2Environment6::CreatePrintSettings.

use std::cell::Cell;
use std::rc::Rc;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Environment, ICoreWebView2Environment6, ICoreWebView2_7,
};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{Interface, HSTRING};

pub type Done = Box<dyn FnOnce(Result<(), String>)>;

/// Prints the page behind `controller` to the PDF file `out`, paper size in inches, margins 0,
/// backgrounds on. `done` runs exactly once: on the UI thread when WebView2 has finished, or at
/// once when the request could not be started. Must be called on the UI thread.
pub fn print_to_pdf(
    controller: &ICoreWebView2Controller,
    environment: &ICoreWebView2Environment,
    out: &str,
    width_in: f64,
    height_in: f64,
    done: Done,
) {
    let slot = Rc::new(Cell::new(Some(done)));
    let finish = {
        let slot = Rc::clone(&slot);
        move |result: Result<(), String>| {
            if let Some(done) = slot.take() {
                done(result);
            }
        }
    };
    let started = (|| -> Result<(), String> {
        let at = |what: &'static str| move |e: windows::core::Error| format!("{what}: {e}");
        unsafe {
            let core = controller.CoreWebView2().map_err(at("CoreWebView2"))?;
            let core7: ICoreWebView2_7 = core.cast().map_err(at("ICoreWebView2_7"))?;
            let env6: ICoreWebView2Environment6 =
                environment.cast().map_err(at("ICoreWebView2Environment6"))?;
            let settings = env6.CreatePrintSettings().map_err(at("CreatePrintSettings"))?;
            settings.SetPageWidth(width_in).map_err(at("SetPageWidth"))?;
            settings.SetPageHeight(height_in).map_err(at("SetPageHeight"))?;
            settings.SetMarginTop(0.0).map_err(at("SetMarginTop"))?;
            settings.SetMarginBottom(0.0).map_err(at("SetMarginBottom"))?;
            settings.SetMarginLeft(0.0).map_err(at("SetMarginLeft"))?;
            settings.SetMarginRight(0.0).map_err(at("SetMarginRight"))?;
            settings
                .SetShouldPrintBackgrounds(true)
                .map_err(at("SetShouldPrintBackgrounds"))?;
            let on_done = finish.clone();
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                on_done(match result {
                    Ok(()) if ok => Ok(()),
                    Ok(()) => Err("PrintToPdf reported failure".into()),
                    Err(e) => Err(format!("PrintToPdf: {e}")),
                });
                Ok(())
            }));
            core7
                .PrintToPdf(&HSTRING::from(out), &settings, &handler)
                .map_err(at("PrintToPdf"))
        }
    })();
    if let Err(error) = started {
        finish(Err(error));
    }
}
