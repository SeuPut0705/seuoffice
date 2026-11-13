//! `apps/shell/src/main/user-skills/builtin-dir.ts`: the builtin skills
//! folder: next to the app's other resources once packaged
//! (`resources/builtin-skills`), the repository copy in a development run.

use jscompat::node_path::host::join;

/// the options of `builtinSkillsDirFor`
pub struct BuiltinSkillsDirOptions<'a> {
    pub is_packaged: bool,
    pub resources_path: &'a str,
    /// `app.getAppPath()`: the shell package folder in a development run
    pub app_path: &'a str,
}

/// `builtinSkillsDirFor(options)`
pub fn builtin_skills_dir_for(options: &BuiltinSkillsDirOptions<'_>) -> String {
    if options.is_packaged {
        join(&[options.resources_path, "builtin-skills"])
    } else {
        join(&[options.app_path, "resources", "builtin-skills"])
    }
}
