//! `apps/slides/src/main`: the modules that hold no Electron object (decision 0029),
//! one file per TypeScript file.

pub mod ai_default_fonts;
pub mod autofit_writeback;
pub mod cfb_sniff;
pub mod element_clipboard;
pub mod export_images;
pub mod font_scan;
pub mod font_store;
pub mod generated_page_temp;
pub mod jpeg_orientation;
pub mod media_mime;
pub mod metafile_fonts;
pub mod mp4_audio_sniff;
pub mod paste_cascade;
pub mod pdf_export;
pub mod picture_frame;
pub mod print_window;
pub mod save_as_formats;
pub mod seed_deck;
pub mod seed_queue;
pub mod session_state;
pub mod session_txn;
pub mod shaped_metrics;
pub mod template_selection;
pub mod template_selection_store;
pub mod video_size;
