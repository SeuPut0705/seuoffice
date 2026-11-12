//! `apps/shell/src/main/skill-target.ts`.

use jscompat::node_path::host::{is_absolute, resolve};

/// `isInstallableSkillDir(dir, vouched)`; `dir` is `None` where the
/// TypeScript's `typeof dir !== 'string'` holds.
pub fn is_installable_skill_dir(dir: Option<&str>, vouched: &[String]) -> bool {
    let Some(dir) = dir else {
        return false;
    };
    if dir.is_empty() || !is_absolute(dir) {
        return false;
    }
    let key = resolve(&[dir]);
    for allowed in vouched {
        if resolve(&[allowed.as_str()]) == key {
            return true;
        }
    }
    false
}
