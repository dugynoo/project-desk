mod antigravity;
mod codex;
mod cli;
mod conversations;
mod editors;
mod files;
mod git;
mod hooks;
pub mod hook_relay;
mod job;
mod pty;
mod persistence;
mod usage;
mod shutdown;
mod updates;
mod instance;
mod file_drop;

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
    state_write: Mutex<()>,
    usage: Arc<usage::Watcher>,
    editors: Mutex<Option<Vec<editors::Found>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    platform: &'static str,
    hooks_enabled: bool,
    state_file: String,
    /// Aktualizácie hľadá len vydaná verzia, dev build (`tauri.dev.json`) nie.
    updates: bool,
    automatic_updates: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnArgs {
    output_id: String,
    provider: Option<String>,
    id: String,
    cwd: String,
    command: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        platform: std::env::consts::OS,
        hooks_enabled: state.hooks.is_some(),
        state_file: state.state_file.to_string_lossy().into_owned(),
        updates: !cfg!(debug_assertions)
            && !app.config().identifier.ends_with(".dev"),
        automatic_updates: updates::automatic_updates(),
    }
}

#[tauri::command]
fn load_state(state: State<'_, AppState>) -> Result<persistence::Loaded, String> {
    let _guard = state.state_write.lock().map_err(|e| e.to_string())?;
    persistence::load(&state.state_file)
}

#[tauri::command]
fn save_state(state: State<'_, AppState>, json: String) -> Result<(), String> {
    let _guard = state.state_write.lock().map_err(|e| e.to_string())?;
    persistence::save(&state.state_file, &json)
}

#[tauri::command]
fn shutdown_pending(app: tauri::AppHandle) -> Vec<String> {
    shutdown::pending(&app)
}

#[tauri::command]
fn shutdown_ready(app: tauri::AppHandle, id: String, saved: bool) {
    shutdown::complete(&app, &id, saved);
}

#[tauri::command]
fn pty_spawn(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    args: SpawnArgs,
    on_output: Channel<pty::OutputChunk>,
) -> Result<(), String> {
    if !std::path::Path::new(&args.cwd).is_dir() {
        return Err(format!("project.missingFolder: {}", args.cwd));
    }
    let mut env = vec![(hooks::SESSION_ENV.to_owned(), args.id.clone())];
    if let Some(h) = &state.hooks {
        if args.provider.as_deref() == Some("antigravity") {
            let home = app.path().home_dir().map_err(|e| e.to_string())?;
            antigravity::install(Path::new(&args.cwd), &home)
                .map_err(|e| format!("antigravity.setupFailed: {e}"))?;
        }
        env.push((hooks::TOKEN_ENV.to_owned(), h.token.clone()));
        env.push((hooks::PORT_ENV.to_owned(), h.port.to_string()));
        env.push((hooks::SETTINGS_ENV.to_owned(), h.settings_path.to_string_lossy().into_owned()));
    }
    let req = SpawnRequest {
        id: args.id,
        output_id: args.output_id,
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
fn pty_output_ack(state: State<'_, AppState>, output_id: String, through: u64) {
    state.pty.acknowledge_output(&output_id, through);
}

#[tauri::command]
fn pty_output_cancel(state: State<'_, AppState>, output_id: String) {
    state.pty.cancel_output(&output_id);
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

/// Pred aktualizáciou (`true`) pustí nové procesy z Job Objectu, aby inštalátor prežil
/// ukončenie aplikácie. Ak aktualizácia zlyhá, frontend to vráti (`false`).
#[tauri::command]
fn prepare_update(on: bool) -> Result<(), String> {
    job::let_new_processes_out(on)
}

/// Súbor v predvolenej aplikácii systému (HTML v prehliadači…). Spustiteľné súbory odmietne.
#[tauri::command]
async fn open_file_default(path: String) -> Result<(), String> {
    files::open_default(&path)
}

/// Ukáže súbor v Prieskumníkovi, Finderi alebo správcovi súborov.
#[tauri::command]
async fn reveal_file(path: String) -> Result<(), String> {
    files::reveal(&path)
}

#[tauri::command]
async fn project_exists(path: String, existing: Vec<String>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || files::project_exists(&path, &existing))
        .await.map_err(|e| e.to_string())?
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

#[tauri::command]
async fn agent_retain(state: State<'_, AppState>, active_ids: Vec<String>) -> Result<(), String> {
    let watcher = state.usage.clone();
    tauri::async_runtime::spawn_blocking(move || watcher.retain(&active_ids)).await.map_err(|e| e.to_string())
}

/// Tokeny a stav agenta z jeho session súboru.
#[tauri::command]
async fn agent_poll(state: State<'_, AppState>, provider: String, agent_id: String, generation: u64) -> Result<Option<usage::Poll>, String> {
    let provider = match provider.as_str() {
        "claude" => usage::Provider::Claude,
        "codex" => usage::Provider::Codex,
        _ => return Ok(None),
    };
    let watcher = state.usage.clone();
    tauri::async_runtime::spawn_blocking(move || watcher.poll(provider, &agent_id, generation)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_conversations(provider: String, cwd: String) -> Vec<conversations::Conversation> {
    tauri::async_runtime::spawn_blocking(move || conversations::list(&provider, &cwd)).await.unwrap_or_default()
}

/// Recover a missing original ID before resume; ambiguous matches remain unlinked.
#[tauri::command]
async fn recover_codex_session(cwd: String, created_ms: u64, exclude: Vec<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        codex::recover_session(&codex::sessions_root()?, &cwd, created_ms, &exclude)
    }).await.ok().flatten()
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
        eprintln!("Orphan guard is off, terminals may outlive a crash: {e}");
    }
    let app = tauri::Builder::default()
        // Must run before other plugins and before hooks or state are opened.
        // The bundle identifier keeps development and production independent.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(file_drop::on_event)
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            // The plugin can fail open without D-Bus on Linux. The file lock
            // also protects the same directory across separate login sessions.
            let lock = instance::DataLock::acquire(&config_dir)?;
            app.resources_table().add(lock);
            let hooks = match hooks::start(app.handle().clone(), &config_dir) {
                Ok(h) => Some(h),
                Err(e) => {
                    eprintln!("Hook server did not start, agent status is unavailable: {e}");
                    None
                }
            };
            app.manage(AppState {
                pty: PtyManager::default(),
                hooks,
                state_file: config_dir.join("state.json"),
                usage: Arc::default(),
                state_write: Mutex::default(),
                editors: Mutex::default(),
            });
            shutdown::install(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            git::project_branch,
            app_info,
            updates::check_release,
            load_state,
            save_state,
            shutdown_pending,
            shutdown_ready,
            pty_spawn,
            pty_output_ack,
            pty_output_cancel,
            pty_write,
            pty_resize,
            pty_kill,
            open_in_editor,
            open_file_default,
            prepare_update,
            reveal_file,
            project_exists,
            list_editors,
            cli::check_cli,
            resolve_file,
            find_codex_session,
            recover_codex_session,
            list_conversations,
            agent_poll,
            agent_retain
        ])
        .build(tauri::generate_context!())
        .expect("Project Desk failed to start");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { code: None, api, .. } = &event {
            if handle.get_webview_window("main").is_some() {
                api.prevent_exit();
                shutdown::request(handle, shutdown::Reason::Quit);
            }
        }
        // Pri zatvorení okna ukončíme všetky shelly, nech po nás neostanú siroty.
        if let RunEvent::Exit = event {
            handle.state::<AppState>().pty.kill_all();
        }
    });
}

