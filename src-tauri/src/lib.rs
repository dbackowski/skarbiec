use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

fn data_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("skarbiec.json"))
}

// A missing file is an empty portfolio; any other read error is reported, never replaced by
// empty data (the next save would then overwrite the real file).
fn read_data(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(r#"{"transactions":[]}"#.into()),
        Err(e) => Err(e.to_string()),
    }
}

// Rejects anything that is not JSON, then writes to a temp file and renames it, so neither a UI
// bug nor a crash mid-write can leave a truncated or unreadable data file.
fn write_data(path: &Path, data: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(data)
        .map_err(|e| format!("Niepoprawne dane: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_data(app: AppHandle) -> Result<String, String> {
    read_data(&data_file(&app)?)
}

#[tauri::command]
fn save_data(app: AppHandle, data: String) -> Result<(), String> {
    write_data(&data_file(&app)?, &data)
}

const KEEP_BACKUPS: usize = 20;

// `stamp` comes from the UI ("2026-11-15_12-47-03"); only digits, '-' and '_' are accepted,
// so it cannot change the target directory.
fn checked_stamp(stamp: &str) -> Result<&str, String> {
    let ok = stamp.len() == 19
        && stamp
            .chars()
            .all(|c| c.is_ascii_digit() || c == '-' || c == '_');
    if ok {
        Ok(stamp)
    } else {
        Err(format!("Niepoprawny znacznik czasu: {stamp}"))
    }
}

fn copy_data(app: &AppHandle, dst: &Path) -> Result<String, String> {
    fs::copy(data_file(app)?, dst).map_err(|e| e.to_string())?;
    Ok(dst.display().to_string())
}

// Copy of the data file in <app data>/backups, keeping the newest KEEP_BACKUPS copies.
// Returns "" when there is nothing to back up yet.
#[tauri::command]
fn backup_data(app: AppHandle, stamp: String) -> Result<String, String> {
    let stamp = checked_stamp(&stamp)?;
    if !data_file(&app)?.exists() {
        return Ok(String::new());
    }
    let dir = data_file(&app)?.with_file_name("backups");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let saved = copy_data(&app, &dir.join(format!("skarbiec-{stamp}.json")))?;
    prune_backups(&dir, KEEP_BACKUPS)?;
    Ok(saved)
}

fn prune_backups(dir: &Path, keep: usize) -> Result<(), String> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("skarbiec-"))
        })
        .collect();
    files.sort(); // the stamp sorts chronologically
    for p in files.iter().rev().skip(keep) {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Copy of the data file in the user's Downloads folder.
#[tauri::command]
fn export_data(app: AppHandle, stamp: String) -> Result<String, String> {
    let stamp = checked_stamp(&stamp)?;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    copy_data(&app, &dir.join(format!("skarbiec-kopia-{stamp}.json")))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            backup_data,
            export_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("skarbiec-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_reads_as_empty_portfolio() {
        let dir = temp_dir("read");
        assert_eq!(
            read_data(&dir.join("skarbiec.json")).unwrap(),
            r#"{"transactions":[]}"#
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unreadable_file_is_an_error_not_empty_data() {
        let dir = temp_dir("unreadable");
        let path = dir.join("skarbiec.json");
        fs::create_dir(&path).unwrap(); // a directory where the file should be
        assert!(read_data(&path).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_replaces_atomically_and_round_trips() {
        let dir = temp_dir("write");
        let path = dir.join("skarbiec.json");
        write_data(&path, r#"{"transactions":[1]}"#).unwrap();
        write_data(&path, r#"{"transactions":[2]}"#).unwrap();
        assert_eq!(read_data(&path).unwrap(), r#"{"transactions":[2]}"#);
        assert!(!dir.join("skarbiec.json.tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_json_never_reaches_the_file() {
        let dir = temp_dir("invalid");
        let path = dir.join("skarbiec.json");
        write_data(&path, r#"{"transactions":[]}"#).unwrap();
        assert!(write_data(&path, "{\"transactions\": [").is_err());
        assert!(write_data(&path, "").is_err());
        assert_eq!(read_data(&path).unwrap(), r#"{"transactions":[]}"#);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stamp_must_not_change_the_path() {
        assert!(checked_stamp("2026-11-15_12-47-03").is_ok());
        assert!(checked_stamp("../../etc/passwd--").is_err());
        assert!(checked_stamp("2026-11-15_12-47-0/").is_err());
    }

    #[test]
    fn prune_keeps_newest_backups_only() {
        let dir = temp_dir("prune");
        for s in [
            "2026-01-01_00-00-00",
            "2026-03-01_00-00-00",
            "2026-02-01_00-00-00",
        ] {
            fs::write(dir.join(format!("skarbiec-{s}.json")), "{}").unwrap();
        }
        fs::write(dir.join("other.txt"), "").unwrap();
        prune_backups(&dir, 2).unwrap();
        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into())
            .collect();
        left.sort();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            left,
            [
                "other.txt",
                "skarbiec-2026-02-01_00-00-00.json",
                "skarbiec-2026-03-01_00-00-00.json"
            ]
        );
    }
}
