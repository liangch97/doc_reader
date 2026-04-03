mod commands;
mod config;
mod db;
mod doc_reader;
mod llm;
mod parser;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
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
            commands::notebook_get_entry,
            commands::notebook_import_ppt,
            commands::notebook_annotate_text,
            commands::notebook_generate_from_pages,
            commands::notebook_generate_from_text,
        ])
        .setup(|app| {
            db::init_db(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
