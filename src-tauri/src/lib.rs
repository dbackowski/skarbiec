use std::{fs, io::ErrorKind, path::PathBuf};
use tauri::{AppHandle, Manager};

fn data_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("skarbiec.json"))
}

#[tauri::command]
fn load_data(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(data_file(&app)?) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(r#"{"transactions":[]}"#.into()),
        Err(e) => Err(e.to_string()),
    }
}

// Write to a temp file and rename, so a crash mid-write never truncates the data.
#[tauri::command]
fn save_data(app: AppHandle, data: String) -> Result<(), String> {
    let path = data_file(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![load_data, save_data])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
