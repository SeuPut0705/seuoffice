//! [`FontQueries`]: main-core's port of packages/font-metrics (`familyInfoFor`,
//! `familyVerticalMetrics`, `familyAliases`) and the PDF editor's
//! `listEditFonts`. Those modules keep module state (the font scan, the
//! caches); here it is one value behind a lock, because the handlers run the
//! queries on worker threads.

use std::sync::{Mutex, MutexGuard};

use jscompat::json_value_from_serde;
use main_core::packages::font_metrics::family_info::{FamilyInfoScan, family_info_for};
use main_core::packages::font_metrics::metrics::MetricsCache;
use main_core::packages::font_metrics::sfnt::FontScan;
use main_core::pdf::edit_fonts::{EditFontCache, list_edit_fonts};
use main_core::pdf::font_locate::{FontEnv, Platform};
use serde_json::Value;
use shell_ipc_m::hosts::FontQueries;

pub(super) struct Fonts(Mutex<State>);

struct State {
    scan: FontScan,
    info: FamilyInfoScan,
    metrics: MetricsCache,
    edit: EditFontCache,
}

impl Fonts {
    /// The docs module's start: the design templates' fonts are indexed with
    /// the system's (`configureExtraFontDirs([templateFontsDir])`), and the
    /// metrics persist in `userData/font-metrics` (`configureMetricsCache`)
    pub(super) fn new(home: String, template_fonts: String, metrics_dir: &str) -> Fonts {
        let platform = if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(windows) {
            Platform::Win32
        } else {
            Platform::Other
        };
        let mut scan = FontScan::new(FontEnv { platform, home });
        scan.configure_extra_font_dirs(&[template_fonts]);
        let mut metrics = MetricsCache::new(&scan);
        metrics.configure_metrics_cache(metrics_dir);
        Fonts(Mutex::new(State {
            scan,
            info: FamilyInfoScan::new(),
            metrics,
            edit: EditFontCache::new(),
        }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl FontQueries for Fonts {
    fn family_info_for(&self, families: &Value) -> Value {
        let state = &mut *self.state();
        let families = json_value_from_serde(families);
        match family_info_for(&state.scan, &mut state.info, &families) {
            Ok(infos) => Value::Array(
                infos
                    .into_iter()
                    .map(|(name, info)| {
                        let info = serde_json::to_value(&info).unwrap_or(Value::Null);
                        Value::Array(vec![Value::String(name), info])
                    })
                    .collect(),
            ),
            // a family name too long for the style-suffix pattern's step limit:
            // answered as a machine without that family
            Err(_) => {
                eprintln!("shell: familyInfoFor: a family name hit the regex step limit");
                Value::Array(Vec::new())
            }
        }
    }

    fn family_vertical_metrics(&self, family: &str) -> Option<Value> {
        let state = &mut *self.state();
        let metrics = state
            .metrics
            .family_vertical_metrics(&mut state.scan, family)?;
        serde_json::to_value(&metrics).ok()
    }

    fn family_aliases(&self, name: &str) -> Vec<String> {
        self.state().scan.family_aliases(name)
    }

    fn list_edit_fonts(&self) -> Vec<String> {
        list_edit_fonts(&mut self.state().edit, &|path| path.to_owned())
    }
}
