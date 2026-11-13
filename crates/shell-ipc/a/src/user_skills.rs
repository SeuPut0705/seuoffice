//! `apps/shell/src/main/user-skills/*.ts` (work in progress)

#[cfg(test)]
mod scratch {
    use main_core::packages::ai_provider::user_skills_import::{
        ChangedCheck, GitHubSkillUpdateCheck, SkillImport, Thrown,
    };
    use main_core::packages::electron_utils::generate_handoff::HandoffStore;
    use main_core::shell::user_skills::template_tabs::TemplateTabs;
    use main_core::shell::user_skills::user_skills_ipc::{Run, UserSkillsIpc};
    use main_core::shell::user_skills::user_skills_service::{Failure, PrepareEnv};
    fn send<T: Send>() {}
    #[test]
    fn s() {
        send::<SkillImport>();
        send::<ChangedCheck>();
        send::<GitHubSkillUpdateCheck>();
        send::<Thrown>();
        send::<Failure>();
        send::<PrepareEnv>();
        send::<Run>();
        send::<TemplateTabs>();
        send::<HandoffStore>();
    }
    #[allow(dead_code)]
    fn t<H: main_core::shell::user_skills::user_skills_service::UserSkillsHost + Send, L: main_core::shell::user_skills::user_skills_service::SkillLibrary + Send>() {
        send::<UserSkillsIpc<H, L>>();
    }
}
