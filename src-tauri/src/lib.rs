mod codex;
mod editors;
mod hooks;
mod job;
mod pty;
mod usage;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{Manager, RunEvent, State};

use pty::{PtyManager, SpawnRequest};

struct AppState {
    pty: PtyManager,
    hooks: Option<hooks::HookServer>,
    state_file: PathBuf,
    usage: Arc<usage::Watcher>,
    editors: Mutex<Option<Vec<editors::Found>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    platform: &'static str,
    hooks_enabled: bool,
    state_file: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnArgs {
    id: String,
    cwd: String,
    command: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        platform: std::env::consts::OS,
        hooks_enabled: state.hooks.is_some(),
        state_file: state.state_file.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
fn load_state(state: State<'_, AppState>) -> Option<String> {
    std::fs::read_to_string(&state.state_file).ok()
}

/// Zápis cez dočasný súbor, aby pád uprostred nezničil uložený stav.
#[tauri::command]
fn save_state(state: State<'_, AppState>, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    if let Some(dir) = state.state_file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = state.state_file.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &state.state_file).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_spawn(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    args: SpawnArgs,
    on_output: Channel<String>,
) -> Result<(), String> {
    if !std::path::Path::new(&args.cwd).is_dir() {
        return Err(format!("Priečinok projektu neexistuje: {}", args.cwd));
    }
    let mut env = vec![(hooks::SESSION_ENV.to_owned(), args.id.clone())];
    if let Some(h) = &state.hooks {
        env.push((hooks::TOKEN_ENV.to_owned(), h.token.clone()));
        env.push((hooks::SETTINGS_ENV.to_owned(), h.settings_path.to_string_lossy().into_owned()));
    }
    let req = SpawnRequest {
        id: args.id,
        cwd: args.cwd,
        command: args.command,
        shell: args.shell.filter(|s| !s.trim().is_empty()),
        env,
        cols: args.cols,
        rows: args.rows,
    };
    state.pty.spawn(app, req, on_output)
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    state.pty.write(&id, &data)
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.pty.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.pty.kill(&id)
}

/// Nainštalované editory; výsledok sa zapamätá pre `open_in_editor`.
#[tauri::command]
async fn list_editors(state: State<'_, AppState>) -> Result<Vec<editors::Found>, String> {
    let found = tauri::async_runtime::spawn_blocking(editors::detect).await.map_err(|e| e.to_string())?;
    *state.editors.lock().unwrap() = Some(found.clone());
    Ok(found)
}

/// Otvorí priečinok alebo súbor v editore, voliteľne na konkrétnom riadku. Bez shellu.
#[tauri::command]
async fn open_in_editor(
    state: State<'_, AppState>,
    editor: editors::Choice,
    path: String,
    line: Option<u32>,
) -> Result<(), String> {
    let cached = state.editors.lock().unwrap().clone();
    let installed = match cached {
        Some(list) => list,
        None => {
            let list = tauri::async_runtime::spawn_blocking(editors::detect).await.map_err(|e| e.to_string())?;
            *state.editors.lock().unwrap() = Some(list.clone());
            list
        }
    };
    let (program, args) = editors::resolve(&editor, &installed, &path, line)?;
    editors::launch(&program, &args)
}

/// Cesta z výstupu terminálu → existujúci súbor (relatívne k projektu alebo absolútne).
#[tauri::command]
fn resolve_file(cwd: String, candidate: String) -> Option<String> {
    if candidate.len() > 1024 {
        return None;
    }
    let mut c = candidate.as_str();
    // Git diff píše `a/cesta` a `b/cesta`.
    for prefix in ["a/", "b/", "./"] {
        if let Some(rest) = c.strip_prefix(prefix) {
            if Path::new(&cwd).join(rest).is_file() {
                c = rest;
            }
        }
    }
    let p = Path::new(&cwd).join(c);
    p.is_file().then(|| p.to_string_lossy().into_owned())
}

/// Tokeny a stav agenta z jeho session súboru.
#[tauri::command]
async fn agent_poll(state: State<'_, AppState>, provider: String, agent_id: String) -> Result<Option<usage::Poll>, String> {
    let provider = match provider.as_str() {
        "claude" => usage::Provider::Claude,
        "codex" => usage::Provider::Codex,
        _ => return Ok(None),
    };
    let watcher = state.usage.clone();
    tauri::async_runtime::spawn_blocking(move || watcher.poll(provider, &agent_id)).await.map_err(|e| e.to_string())
}

/// ID Codex konverzácie, ktorá vznikla v `cwd` po `since_ms` a nepatrí inej relácii.
#[tauri::command]
async fn find_codex_session(cwd: String, since_ms: u64, exclude: Vec<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = codex::sessions_root()?;
        codex::find_session(&root, &cwd, since_ms, &exclude)
    })
    .await
    .ok()
    .flatten()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(e) = job::kill_children_on_exit() {
        eprintln!("Poistka proti sirotám sa nezapla, pri páde môžu ostať bežať terminály: {e}");
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let hooks = match hooks::start(app.handle().clone(), &config_dir) {
                Ok(h) => Some(h),
                Err(e) => {
                    eprintln!("Hook server sa nespustil, stav agentov nebude dostupný: {e}");
                    None
                }
            };
            app.manage(AppState {
                pty: PtyManager::default(),
                hooks,
                state_file: config_dir.join("state.json"),
                usage: Arc::default(),
                editors: Mutex::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            load_state,
            save_state,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            open_in_editor,
            list_editors,
            resolve_file,
            find_codex_session,
            agent_poll
        ])
        .build(tauri::generate_context!())
        .expect("Project Desk sa nepodarilo spustiť");

    app.run(|handle, event| {
        // Pri zatvorení okna ukončíme všetky shelly, nech po nás neostanú siroty.
        if let RunEvent::Exit = event {
            handle.state::<AppState>().pty.kill_all();
        }
    });
}

