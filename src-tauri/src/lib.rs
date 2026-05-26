mod agent;
mod commands;
mod config;
mod db;
mod doc_reader;
mod epub_cover;
mod knowledge_points;
mod library_cmd;
mod library_db;
mod llm;
mod parser;
mod rag;
mod runtime;
mod training;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            // release 时只写到文件 + WebView console;不写 stdout,避免 Windows 自动弹
            // 一个黑色 cmd 窗口(Tauri GUI 程序首次 print 到 stdout 时系统会附加 console)。
            // debug 时仍然让所有目标输出,方便开发调试。
            {
                let mut b = tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .clear_targets();
                #[cfg(debug_assertions)]
                {
                    b = b.targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                    ]);
                }
                #[cfg(not(debug_assertions))]
                {
                    b = b.targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                    ]);
                }
                b.build()
            },
        )
        .invoke_handler(tauri::generate_handler![
            // LLM 配置管理
            commands::get_llm_models,
            commands::save_llm_models,
            commands::test_llm_model,
            commands::delete_llm_model,
            commands::get_llm_models_raw,
            // Doc Reader
            commands::doc_reader_open,
            commands::doc_reader_get_session,
            commands::doc_reader_get_page,
            commands::doc_reader_generate_note,
            commands::doc_reader_generate_all,
            commands::doc_reader_chat,
            commands::doc_reader_save_note,
            commands::doc_reader_delete_note,
            commands::doc_reader_list_sessions,
            commands::doc_reader_delete_session,
            commands::doc_reader_export_ppt_slides,
            commands::doc_reader_get_file,
            // Notebook
            commands::notebook_create,
            commands::notebook_list,
            commands::notebook_get,
            commands::notebook_update,
            commands::notebook_delete,
            commands::notebook_add_entry,
            commands::notebook_update_entry,
            commands::notebook_delete_entry,
            commands::notebook_entry_auto_format,
            commands::notebook_get_entry,
            commands::notebook_import_ppt,
            commands::notebook_annotate_text,
            commands::notebook_generate_from_pages,
            commands::notebook_generate_from_text,
            commands::notebook_generate_auto_section,
            commands::notebook_generate_auto_sections_for_all,
            commands::notebook_generate_serial_next_pages,
            commands::notebook_append_explanation,
            commands::notebook_section_chat,
            commands::notebook_apply_chat_action,
            commands::notebook_get_entries_for_page,
            commands::notebook_get_outline,
            commands::notebook_relayout_knowledge_zones,
            commands::notebook_build_learning_outline,
            commands::notebook_get_learning_outline,
            commands::notebook_get_related_sections,
            // ════════ v2: courses / resources / progress / annotations / bookmarks ════════
            library_cmd::course_create,
            library_cmd::course_list,
            library_cmd::course_get,
            library_cmd::course_update,
            library_cmd::course_delete,
            library_cmd::course_attach_resource,
            library_cmd::course_detach_resource,
            library_cmd::course_list_resources,
            library_cmd::course_set_resource_category,
            library_cmd::resource_create,
            library_cmd::resource_list,
            library_cmd::resource_get,
            library_cmd::resource_update_meta,
            library_cmd::resource_save_cover,
            library_cmd::resource_delete,
            library_cmd::resource_guess_kind,
            library_cmd::resource_read_file,
            library_cmd::resource_import,
            library_cmd::progress_upsert,
            library_cmd::progress_get,
            library_cmd::annotation_create,
            library_cmd::annotation_update,
            library_cmd::annotation_delete,
            library_cmd::annotation_list,
            library_cmd::bookmark_create,
            library_cmd::bookmark_delete,
            library_cmd::bookmark_list,
            // 通用应用偏好 KV
            commands::app_prefs_get,
            commands::app_prefs_set,
            // RAG 知识库
            commands::rag_index_session,
            commands::rag_index_status,
            commands::rag_clear_session,
            commands::rag_chat,
            commands::rag_chat_stream,
            // Knowledge Points（语义边界 + TOC 切分 → 按知识点生成笔记）
            commands::kp_detect,
            commands::kp_refine_titles,
            commands::kp_list,
            commands::notebook_generate_from_kp,
            commands::notebook_generate_from_kps_all,
            commands::kp_generate_to_clipboard,
            // 学习 Agent（DESIGN.md §13 v2 Auto-Pilot）
            commands::agent_get_state,
            commands::agent_get_unit_entry_id,
            commands::agent_clarify_questions,
            commands::agent_plan_generate,
            commands::agent_teach_unit_stream,
            commands::agent_submit_answers,
            commands::agent_advance,
            commands::agent_prefetch_unit,
            commands::agent_followup_stream,
            commands::agent_generate_extra_quizzes_stream,
            commands::agent_reset,
            // 学习流档案
            commands::agent_archive_save,
            commands::agent_archive_list,
            commands::agent_archive_restore,
            commands::agent_archive_delete,
            commands::agent_archive_rename,
            // 训练模块（DESIGN.md §15）
            commands::training_get_skill_tree,
            commands::training_code_run,
            commands::training_translate_question,
            commands::code_runner_test,
            // v6 (2026-05) #3++ Docker / Piston 一键部署
            commands::docker_diagnose,
            commands::piston_container_start,
            commands::piston_container_stop,
            commands::piston_container_recreate,
            commands::piston_pull_image,
            commands::piston_container_logs,
            commands::piston_container_ports,
            commands::piston_install_runtime,
            commands::piston_list_runtimes,
            commands::training_generate_pack,
            commands::training_submit_attempt,
            commands::training_submit_batch,
            commands::training_get_history,
            commands::training_skill_overview,
            // v5 (2026-05) B2: 学习↔训练同步生成 pack
            commands::training_get_unit_pack,
            commands::training_list_unit_packs,
            // v4 (2026-05) user_skills 全局技能字典
            commands::skills_list,
            commands::skills_update,
            commands::skills_merge,
            commands::skills_delete,
            commands::skills_reorganize_tree,
            // v6 (2026-05) #3 vibelearning 统一 session 事件流
            commands::vibe_get_timeline,
            // v6 (2026-05) #3+ 学习流笔记（与课堂笔记隔离）
            commands::agent_stream_notes_list,
            // 用系统默认浏览器打开外部 URL（修 Tauri webview 拦截 target=_blank 的问题）
            commands::open_external_url,
        ])
        .setup(|app| {
            db::init_db(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
