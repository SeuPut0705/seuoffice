//! Every channel of batch A, by the TypeScript main module that answers it.
//! Each trait is that module's port (see [`crate::port`]).

use crate::port::ports;

ports! {
    /// The agent window: its session, preferences, project skills and templates
    pub trait AgentWindow("apps/shell/src/main/agent/agent-window.ts") {
        invoke "agent-window:answer" => agent_window_answer;
        event "agent-window:event";
        invoke "agent-window:get-init" => agent_window_get_init;
        invoke "agent-window:get-project-prefs" => agent_window_get_project_prefs;
        invoke "agent-window:get-project-skills" => agent_window_get_project_skills;
        invoke "agent-window:get-theme" => agent_window_get_theme;
        event "agent-window:install-proposal";
        invoke "agent-window:open-file" => agent_window_open_file;
        invoke "agent-window:pick-folder" => agent_window_pick_folder;
        invoke "agent-window:send" => agent_window_send;
        invoke "agent-window:set-prefs" => agent_window_set_prefs;
        invoke "agent-window:set-project-prefs" => agent_window_set_project_prefs;
        invoke "agent-window:set-project-skills" => agent_window_set_project_skills;
        event "agent-window:skill-proposal";
        invoke "agent-window:start" => agent_window_start;
        invoke "agent-window:stop" => agent_window_stop;
        invoke "agent-window:template-as-is" => agent_window_template_as_is;
        invoke "agent-window:template-blank" => agent_window_template_blank;
        invoke "agent-window:template-check" => agent_window_template_check;
    }

    /// The shared AI channels every editor uses (`registerAiIpc` of docs-main, which answers them for every app in the shell): settings, streams, chat, model lists, search and reading the web
    pub trait AiCore("apps/docs/src/main/docs-main.ts") {
        invoke "ai:chat" => ai_chat;
        invoke "ai:codex-models" => ai_codex_models;
        invoke "ai:custom-models" => ai_custom_models;
        invoke "ai:fetch-image" => ai_fetch_image;
        invoke "ai:get-settings" => ai_get_settings;
        invoke "ai:image-search" => ai_image_search;
        invoke "ai:local-inspect" => ai_local_inspect;
        invoke "ai:local-models" => ai_local_models;
        invoke "ai:local-test" => ai_local_test;
        invoke "ai:local-test-cancel" => ai_local_test_cancel;
        invoke "ai:media-test" => ai_media_test;
        invoke "ai:read-url" => ai_read_url;
        invoke "ai:search-test" => ai_search_test;
        invoke "ai:set-settings" => ai_set_settings;
        event "ai:settings-changed";
        invoke "ai:stream" => ai_stream;
        invoke "ai:stream-cancel" => ai_stream_cancel;
        event "ai:stream-chunk";
        invoke "ai:tool-capabilities" => ai_tool_capabilities;
        invoke "ai:web-search" => ai_web_search;
    }

    /// A file name suggested by the AI
    pub trait AiNaming("apps/shell/src/main/ai-naming-service.ts") {
        invoke "ai:suggest-file-name" => ai_suggest_file_name;
    }

    /// Per-app AI channels answered in the entry modules (docs-main, sheets-main)
    pub trait AppAi("apps/docs/src/main/docs-main.ts") {
        invoke "docs:consume-ai-doc-content" => docs_consume_ai_doc_content;
        invoke "sheets:ai-tool-capabilities" => sheets_ai_tool_capabilities;
    }

    /// Each editor's image generation (docs-main, html-main, hwp and mindmap `ai-image`, markdown-main, sheets-main)
    pub trait AppAiImage("apps/docs/src/main/docs-main.ts") {
        invoke "docs:ai-generate-image" => docs_ai_generate_image;
        invoke "html:ai-generate-image" => html_ai_generate_image;
        invoke "hwp:ai-generate-image" => hwp_ai_generate_image;
        invoke "markdown:ai-generate-image" => markdown_ai_generate_image;
        invoke "mindmap:ai-generate-image" => mindmap_ai_generate_image;
        invoke "sheets:ai-generate-image" => sheets_ai_generate_image;
    }

    /// Google Drive: the connection, its token vault, listing and opening files, and Drive for the AI
    pub trait Drive("apps/shell/src/main/drive/drive-ipc.ts") {
        invoke "drive:ai-enabled" => drive_ai_enabled;
        invoke "drive:ai-read" => drive_ai_read;
        invoke "drive:ai-search" => drive_ai_search;
        invoke "drive:cancel-connect" => drive_cancel_connect;
        invoke "drive:connect" => drive_connect;
        invoke "drive:connected" => drive_connected;
        invoke "drive:disconnect" => drive_disconnect;
        invoke "drive:list" => drive_list;
        invoke "drive:open" => drive_open;
        invoke "drive:pick-attachments" => drive_pick_attachments;
        invoke "drive:pick-open" => drive_pick_open;
        invoke "drive:set-ai-access" => drive_set_ai_access;
        invoke "drive:set-training-ack" => drive_set_training_ack;
        invoke "drive:state" => drive_state;
        event "drive:state-changed";
    }

    /// The free AI key: connect, quota, disconnect
    pub trait FreeAi("apps/docs/src/main/free-ai-ipc.ts") {
        invoke "ai:free-connect" => ai_free_connect;
        invoke "ai:free-connect-cancel" => ai_free_connect_cancel;
        invoke "ai:free-disconnect" => ai_free_disconnect;
        invoke "ai:free-open-key-page" => ai_free_open_key_page;
        invoke "ai:free-quota" => ai_free_quota;
    }

    /// The generate window and the home screen's ways into it
    pub trait GenerateWindow("apps/shell/src/main/generate/generate-window.ts") {
        invoke "generate:add-materials" => generate_add_materials;
        invoke "generate:cancel" => generate_cancel;
        invoke "generate:get-state" => generate_get_state;
        invoke "generate:get-theme" => generate_get_theme;
        invoke "generate:make" => generate_make;
        invoke "generate:open-with-group" => generate_open_with_group;
        invoke "generate:open-with-paths" => generate_open_with_paths;
        invoke "generate:refresh" => generate_refresh;
        invoke "generate:remove-material" => generate_remove_material;
        invoke "generate:save-material" => generate_save_material;
        invoke "generate:set-convert" => generate_set_convert;
        invoke "generate:set-kind" => generate_set_kind;
        event "generate:state";
    }

    /// Settings > Integrations: the app's skill for outside AI tools
    pub trait Integrations("apps/shell/src/main/integrations-ipc.ts") {
        invoke "integrations:copy-text" => integrations_copy_text;
        invoke "integrations:install-skill" => integrations_install_skill;
        invoke "integrations:pick-skill-dir" => integrations_pick_skill_dir;
        invoke "integrations:save-skill-zip" => integrations_save_skill_zip;
        invoke "integrations:status" => integrations_status;
        invoke "integrations:uninstall-skill" => integrations_uninstall_skill;
    }

    /// The knowledge base scopes of the shell (`kb:*` in the shell entry)
    pub trait KnowledgeBase("apps/shell/src/main/index.ts") {
        invoke "kb:close-scope" => kb_close_scope;
        invoke "kb:create-document" => kb_create_document;
        invoke "kb:list" => kb_list;
        invoke "kb:open-scope" => kb_open_scope;
        invoke "kb:read" => kb_read;
        invoke "kb:search" => kb_search;
    }

    /// The MCP server's commands to open docs and sheets editors and their results (mcp docs-bridge, sheets-bridge)
    pub trait McpDocumentBridges("apps/shell/src/main/mcp/docs-bridge.ts") {
        event "docs:mcp-command";
        send "docs:mcp-ready" => docs_mcp_ready;
        send "docs:mcp-result" => docs_mcp_result;
        event "sheets:mcp-command";
        send "sheets:mcp-ready" => sheets_mcp_ready;
        send "sheets:mcp-result" => sheets_mcp_result;
    }

    /// User MCP servers: Settings > MCP servers and the tools the editors call
    pub trait McpHub("apps/shell/src/main/mcp-client/hub-ipc.ts") {
        invoke "mcp-servers:add" => mcp_servers_add;
        invoke "mcp-servers:answer-runtime-download" => mcp_servers_answer_runtime_download;
        invoke "mcp-servers:approve-instructions" => mcp_servers_approve_instructions;
        invoke "mcp-servers:approve-launch" => mcp_servers_approve_launch;
        invoke "mcp-servers:approve-tool" => mcp_servers_approve_tool;
        invoke "mcp-servers:cancel-sign-in" => mcp_servers_cancel_sign_in;
        event "mcp-servers:changed";
        invoke "mcp-servers:edit" => mcp_servers_edit;
        invoke "mcp-servers:list" => mcp_servers_list;
        invoke "mcp-servers:mark-tools-seen" => mcp_servers_mark_tools_seen;
        event "mcp-servers:open-server";
        invoke "mcp-servers:parse-paste" => mcp_servers_parse_paste;
        invoke "mcp-servers:planned-launch" => mcp_servers_planned_launch;
        invoke "mcp-servers:remove" => mcp_servers_remove;
        invoke "mcp-servers:retry" => mcp_servers_retry;
        invoke "mcp-servers:set-enabled" => mcp_servers_set_enabled;
        invoke "mcp-servers:set-keep-results-inside" => mcp_servers_set_keep_results_inside;
        invoke "mcp-servers:set-tool-permission" => mcp_servers_set_tool_permission;
        invoke "mcp-servers:sign-in" => mcp_servers_sign_in;
        invoke "mcp-servers:test" => mcp_servers_test;
        invoke "mcp-tools:call" => mcp_tools_call;
        invoke "mcp-tools:cancel" => mcp_tools_cancel;
        event "mcp-tools:changed";
        invoke "mcp-tools:list" => mcp_tools_list;
        invoke "mcp-tools:open-settings" => mcp_tools_open_settings;
        invoke "mcp-tools:retry" => mcp_tools_retry;
    }

    /// Asking before the AI reaches the internet
    pub trait Outbound("apps/shell/src/main/outbound-confirm.ts") {
        invoke "ai:confirm-addresses" => ai_confirm_addresses;
        invoke "ai:internet-tools" => ai_internet_tools;
    }

    /// App-wide AI panel preferences and slides AI fonts (shell entry)
    pub trait ShellAiPrefs("apps/shell/src/main/index.ts") {
        invoke "ai:open-model-settings" => ai_open_model_settings;
        event "app:ai-panel-prefs-changed";
        invoke "app:get-ai-panel-prefs" => app_get_ai_panel_prefs;
        invoke "app:set-ai-panel-prefs" => app_set_ai_panel_prefs;
        invoke "home:get-ai-panel-prefs" => home_get_ai_panel_prefs;
        invoke "home:get-slides-ai-fonts" => home_get_slides_ai_fonts;
        invoke "home:set-ai-panel-prefs" => home_set_ai_panel_prefs;
        invoke "home:set-slides-ai-fonts" => home_set_slides_ai_fonts;
    }

    /// The slides AI: images, media, style templates, sidecars, capabilities
    pub trait SlidesAi("apps/slides/src/main/ai-ipc.ts") {
        invoke "ai:analyze-media" => ai_analyze_media;
        invoke "ai:generate-image" => ai_generate_image;
        invoke "ai:insert-image-url" => ai_insert_image_url;
        invoke "ai:list-style-templates" => ai_list_style_templates;
        invoke "ai:load-style-template" => ai_load_style_template;
        invoke "ai:log-run-failure" => ai_log_run_failure;
        invoke "ai:replace-picture-url" => ai_replace_picture_url;
        invoke "ai:save-sidecar" => ai_save_sidecar;
        invoke "ai:save-style-template" => ai_save_style_template;
        invoke "slides:ai-default-fonts" => slides_ai_default_fonts;
        invoke "slides:ai-snapshot-restore" => slides_ai_snapshot_restore;
        invoke "slides:ai-tool-capabilities" => slides_ai_tool_capabilities;
    }

    /// A slides AI run held as a proposal until accepted
    pub trait SlidesAiProposal("apps/slides/src/main/ai-proposal.ts") {
        invoke "slides:ai-proposal-accept" => slides_ai_proposal_accept;
        invoke "slides:ai-proposal-reject" => slides_ai_proposal_reject;
        invoke "slides:ai-run-begin" => slides_ai_run_begin;
        invoke "slides:ai-run-hold" => slides_ai_run_hold;
    }

    /// The design templates the slides AI may use
    pub trait SlidesTemplateSelection("apps/slides/src/main/template-selection-ipc.ts") {
        invoke "slides:ai-template-selection-get" => slides_ai_template_selection_get;
        invoke "slides:ai-template-selection-set" => slides_ai_template_selection_set;
    }

    /// AI subscriptions (CLI sign-ins): status, sign-in, install, update
    pub trait Subscription("packages/ai-provider/src/subscription/contract.ts") {
        invoke "ai:subscription-cancel-login" => ai_subscription_cancel_login;
        event "ai:subscription-changed";
        invoke "ai:subscription-codex-image" => ai_subscription_codex_image;
        invoke "ai:subscription-install" => ai_subscription_install;
        invoke "ai:subscription-login" => ai_subscription_login;
        invoke "ai:subscription-logout" => ai_subscription_logout;
        invoke "ai:subscription-metered" => ai_subscription_metered;
        invoke "ai:subscription-off" => ai_subscription_off;
        invoke "ai:subscription-recheck" => ai_subscription_recheck;
        invoke "ai:subscription-statuses" => ai_subscription_statuses;
        invoke "ai:subscription-update" => ai_subscription_update;
        invoke "home:open-subscription-install-help" => home_open_subscription_install_help;
    }

    /// A skill's template opened in a tab for preview
    pub trait TemplateTabs("apps/shell/src/main/user-skills/template-tabs-ipc.ts") {
        invoke "skills:finish-preview" => skills_finish_preview;
        invoke "skills:focus-tab" => skills_focus_tab;
        invoke "skills:open-preview" => skills_open_preview;
        invoke "skills:open-template" => skills_open_template;
        invoke "skills:preview-original" => skills_preview_original;
        invoke "skills:take-handoff" => skills_take_handoff;
    }

    /// User skills: list, read, import, export, update, remove
    pub trait UserSkills("apps/shell/src/main/user-skills/user-skills-ipc.ts") {
        invoke "skills:agent-notice" => skills_agent_notice;
        invoke "skills:agent-notice-seen" => skills_agent_notice_seen;
        invoke "skills:ai-read" => skills_ai_read;
        invoke "skills:ai-read-file" => skills_ai_read_file;
        invoke "skills:apply-update" => skills_apply_update;
        invoke "skills:cancel-import" => skills_cancel_import;
        invoke "skills:cancel-update" => skills_cancel_update;
        event "skills:changed";
        invoke "skills:check-name" => skills_check_name;
        invoke "skills:check-update" => skills_check_update;
        invoke "skills:copy-to-mine" => skills_copy_to_mine;
        event "skills:dropped";
        invoke "skills:export-bundle" => skills_export_bundle;
        invoke "skills:export-info" => skills_export_info;
        invoke "skills:export-zip" => skills_export_zip;
        invoke "skills:hide-builtin" => skills_hide_builtin;
        invoke "skills:import-folder" => skills_import_folder;
        invoke "skills:import-github" => skills_import_github;
        invoke "skills:import-text" => skills_import_text;
        invoke "skills:import-zip" => skills_import_zip;
        invoke "skills:install" => skills_install;
        invoke "skills:list" => skills_list;
        invoke "skills:open-folder" => skills_open_folder;
        invoke "skills:open-settings" => skills_open_settings;
        event "skills:preview-ended";
        invoke "skills:read" => skills_read;
        invoke "skills:read-import" => skills_read_import;
        invoke "skills:read-import-file" => skills_read_import_file;
        invoke "skills:remove" => skills_remove;
        invoke "skills:save" => skills_save;
        invoke "skills:save-from-card" => skills_save_from_card;
        invoke "skills:set-state" => skills_set_state;
        invoke "skills:suggest-name" => skills_suggest_name;
        invoke "skills:take-dropped" => skills_take_dropped;
        invoke "skills:unhide-builtins" => skills_unhide_builtins;
    }

    /// The Zotero word-processor integration
    pub trait Zotero("apps/docs/src/main/zotero-ipc.ts") {
        invoke "zotero:command" => zotero_command;
        event "zotero:request";
        send "zotero:response" => zotero_response;
    }
}
