//! `apps/shell/src/main/dropped-files.ts`: payload handling for OS file drops
//! (`installDropOpenBridge` in the preloads). `DroppedFilesDeps` is a trait
//! the shell implements; what a skill file holds (`DroppedSkillSource`) is
//! the implementor's own type.

use serde_json::Value;

use crate::packages::electron_utils::drop_open::partition_drop_payload;

/// `DroppedFilesDeps`
pub trait DroppedFilesDeps {
    /// `DroppedSkillSource`: what a `SKILL.md` or zip file holds as skills
    type SkillSource;

    /// the normal File > Open pipeline; false = the path didn't open
    fn open_document_path(&mut self, path: &str) -> bool;
    /// bring the shell window forward (the drop may land in a detached editor)
    fn reveal_shell_window(&mut self);
    /// the shared warning box; receives a localized message
    fn show_warning(&mut self, message: &str);
    /// localized template for one-or-more unsupported extensions
    fn unsupported_message(&mut self, exts: &[String]) -> String;
    /// what a `SKILL.md` or zip file holds as skills; `Ok(None)` = not a skill
    /// file, `Err` is a rejected promise (the caller reads it as `None`)
    fn skill_source_of(&mut self, path: &str) -> Result<Option<Self::SkillSource>, String>;
    /// hand a skill file to the settings' import preview (opens the settings on Skills)
    fn import_skills(&mut self, source: Self::SkillSource);
    /// say that the dropped zip or `SKILL.md` held no skill
    fn no_skills_found(&mut self);
}

/// `handleDroppedFiles(raw, deps)`: open each openable path (last drop wins
/// activation), reveal the shell if anything opened, and surface one combined
/// warning for known-but-unsupported formats. A skill file goes to the skills
/// import preview. A zip or `SKILL.md` that holds no skill gets one notice for
/// the whole drop, and only when the drop gave the app nothing else to do.
pub fn handle_dropped_files<D: DroppedFilesDeps>(raw: &Value, deps: &mut D) {
    let drop = partition_drop_payload(raw);
    let mut opened = false;
    for path in &drop.supported {
        opened = deps.open_document_path(path) || opened;
    }
    if opened {
        deps.reveal_shell_window();
    }
    if !drop.unsupported_exts.is_empty() {
        let message = deps.unsupported_message(&drop.unsupported_exts);
        deps.show_warning(&message);
    }
    let mut acted = opened || !drop.unsupported_exts.is_empty();
    let mut missed = false;
    for path in &drop.skill_files {
        // `.catch(() => undefined)`
        let source = deps.skill_source_of(path).unwrap_or(None);
        match source {
            Some(source) => {
                deps.import_skills(source);
                acted = true;
            }
            None => missed = true,
        }
    }
    if missed && !acted {
        deps.no_skills_found();
    }
}
