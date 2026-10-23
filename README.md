# Project Desk

A desktop app for running Claude Code, Codex, Antigravity CLI and plain shell sessions across many projects from one window. Each project lists its sessions with a live status, so you can see at a glance which agent is working, which one is done and which one is waiting for you.

It replaces the earlier Cursor extension. Your editor opens only when you ask for it.

The UI is available in English, Slovak and Czech (⚙ Settings → Language). English is the default.

## Features

### Projects and sessions
- Projects live in the sidebar. Each project row has **+** to start your default session and **▾** to choose another provider, plus **↗** open in editor, **☆** pin and **✕** remove. Set the default in Settings: Claude (initial default), Codex, Antigravity or Shell. The dropdown shows the other providers and supports arrow keys and Escape.
- Drag projects to reorder them. Pinned projects always stay on top.
- Drag the sidebar edge to resize it.
- Rename a session inline (double-click or ✎). Closing a terminal with ✕ moves it to **Recently closed** (up to 20 sessions), where it can be resumed with its conversation ID.
- When a process exits, its terminal output stays visible with the exit code and a **Start again** button. Stopped sessions stay stopped after an app restart; terminal output itself is not saved to disk.

### Agent status
Green **Done** means the agent is ready for another prompt (including initial readiness or an interrupted turn); yellow **Working** means a turn is in progress; red **Waiting for input** means a reported approval request or question. Shells retain their neutral **Running** status.
- **Claude Code:** status comes from Claude Code hooks: *Working*, *Waiting for input*, *Done*, *Agent exited*. The app starts Claude with `--settings` pointing at HTTP hooks on a local endpoint. Your `~/.claude` settings are never modified.
- **Codex:** status comes from the Codex session file in `~/.codex/sessions`: *Working*, *Done*. The app reads only the event type (`task_started`, `task_complete`, `turn_aborted`). The last known state is restored without replaying old notifications. Approval requests are not persisted in this file, so Codex approval waiting cannot currently be detected.
- **Antigravity CLI:** project-local hooks report activity, completion and explicit `ask_question` / `ask_permission` tools. Automatic permission dialogs are not exposed by these hooks; token usage is not tracked. See setup below.
- **Notifications:** a system notification and an unread dot appear when an agent finishes or needs you while you are looking elsewhere.
- **Attention overview:** the sidebar counts waiting, completed and working sessions. Click the counts to filter to waiting/completed sessions; **Ctrl+Shift+A** jumps to the next one.

### Session info
Click **ⓘ** or right-click a session to see the model, context size, tokens (new, from cache, output) and, for Codex, the used rate limit. The conversation ID can be copied. The numbers apply to the current conversation and restart after `/clear`.

### Resume after restart
On start, sessions resume where they left off: Claude with `--resume <id>`, Codex with `codex resume <id>`, Antigravity with `agy --conversation <id>` once a hook has reported the conversation ID. You can turn this off in Settings.

### Antigravity setup
Install and sign in to [Antigravity CLI](https://www.antigravity.google/docs/cli/reference/) (`agy`), and make Node.js 22+ available on `PATH` for the hook relay. The Antigravity IDE launcher alone is not sufficient. Choose **Antigravity** in the project's **▾** menu, or set it as the default and use **+**. The launch command is configurable in Settings; the default `agy` preserves the CLI's permission policy.

On first launch in a project, Desk adds a **project-desk** entry to `.agents/hooks.json`, preserving other entries. Invalid JSON or a conflicting/disabled entry stops launch with an error instead of replacing your configuration. This file is a visible workspace change; keep it local or review it before committing. It contains a constant Node relay command, no credentials or machine paths. The entry remains after closing Desk; remove just that entry to uninstall it. Global Antigravity configuration is never changed.

The relay reads hooks from stdin, forwards only event/conversation/tool-name/idle metadata to Desk's authenticated loopback endpoint, and leaves tool approvals to the CLI. Outside a Desk-launched session it does nothing. Conversation IDs enable exact resume; before the first hook arrives, a restart opens a fresh session rather than selecting an unrelated recent conversation. Grid, pinning, history, search and prompt templates work as for other agents.

Status support follows the [documented hooks](https://www.antigravity.google/docs/hooks). A Stop event with background work still active does not mark the session done. Token counts and automatic permission prompts are currently unavailable. Real CLI compatibility still needs an authenticated end-to-end check; automated tests cover the documented payloads and local relay.

### Prompt templates
Press **✦** or **Ctrl+Shift+T**. Templates can be shared by all projects or belong to one project. A template is pasted into the active session as a single bracketed paste and can optionally be sent right away.

### Terminal
- **Search:** Ctrl+Shift+F, then Enter for next and Shift+Enter for previous.
- **Ctrl+click** a URL to open it in your browser. Ctrl+click a file path such as `src/main.ts:120` to open it in your editor at that line. File types listed in ⚙ Settings (by default HTML, PDF and images) open in the default app instead, so an HTML file opens in the browser.
- **Right-click** a file path for more: open in the editor, open with the default app, show in Explorer / Finder / the file manager, copy the full or relative path. Right-click a URL to open or copy it.
- **2×2 grid:** Ctrl+G shows up to four sessions at once. Use ☆ / ★ in a terminal header to pin a pane; pins retain their order and survive restarts. Unpinned slots follow recent activity. Selecting a different session when all four panes are pinned switches to single-session view without changing the pins.
- **Find a session:** Ctrl+K. **Ctrl+1–8** jumps to a session by its position in the sidebar, **Ctrl+9** to the last one.
- **Clipboard:** Ctrl+C copies the selection (with nothing selected it interrupts the process), Ctrl+V pastes, and Shift+Enter inserts a new line in Claude.

### Editor
Choose your editor in ⚙ Settings. The list shows editors that are actually installed:

| Platform | How editors are found |
|---|---|
| Windows | Uninstall entries in the registry, checked by display name **and publisher** |
| macOS | App bundle ID, via Spotlight |
| Linux | Commands on `PATH` |

Detection does not rely on `PATH` on Windows and macOS. Cursor, for example, puts its own `code` command on `PATH`, which would otherwise look like VS Code.

Supported editors: Cursor, VS Code, VS Code Insiders, Windsurf, VSCodium, Trae, Zed, Sublime Text, IntelliJ IDEA, WebStorm, PhpStorm, PyCharm, Rider, GoLand, RustRover, CLion and Notepad++. All of them open a file at the clicked line.

**Other program…** is for anything else. Pick the program and set its arguments. `%TARGET_PATH%` is replaced with the file or folder path and `%LINE%` with the line number. The default `%TARGET_PATH%` is enough for most programs.

### Updates
The app checks [GitHub Releases](https://github.com/dugynoo/project-desk/releases) shortly after start and then every 6 hours. When a new version is out, an **⬆ Update** button appears in the sidebar. To check right away, use **Check for updates** in ⚙ Settings. Updates are signed, and the app installs only an update signed with the project's key.

## Security

- **No user text in shell commands.** The command line only contains the command from Settings, a validated UUID and a reference to an environment variable. Project and session names never get there. The working directory is passed as a process option.
- **Hook endpoint:** listens on `127.0.0.1` only, on a random port, and requires a random token in a header. A hook request is reduced to the event type and session ID.
- **Session files:** only numbers and event types are read from agent session files. Conversation text is never stored or sent to the UI.
- **Templates** are pasted as a bracketed paste. Any end-of-paste sequence inside the text is removed, so a template cannot run as a shell command.
- **Default app:** only an existing file that the terminal link resolved can be opened. Programs, scripts, installers and shortcuts (`.exe`, `.bat`, `.ps1`, `.sh`, `.app`, `.lnk`, files without an extension…) never open with the default app, because that would run them. The check is in Rust and Settings cannot turn it off.
- **Editors** start directly as a program with an argument list, without `cmd` or a shell. The path is always a separate argument. On Windows a custom program must be an `.exe` or `.com`.
- **No orphan processes:** on Windows the app runs inside a Job Object with `KILL_ON_JOB_CLOSE`, so all terminals and agents end with the app, even after a crash. Editors start outside the Job Object and stay open when the app closes. On macOS and Linux, closing a terminal sends SIGHUP to its whole process group.
- **Permissions are bypassed by default.** The default commands are `claude --dangerously-skip-permissions` and `codex --dangerously-bypass-approvals-and-sandbox`, so agents run commands without asking. Change them in ⚙ Settings.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| App shell | **Tauri 2** (Rust) | Uses the system WebView (WebView2, WKWebView, WebKitGTK) instead of a bundled Chromium. The installer is a few MB and memory use is lower than Electron. Runs on Windows, macOS and Linux. |
| Terminal | **xterm.js 6** with the WebGL renderer and the search and web-links addons | The same emulator as VS Code and Cursor. WebGL is attached only to visible terminals. |
| PTY | **portable-pty** (from WezTerm) | ConPTY on Windows and openpty on Unix behind one API. |
| Agent status | Claude Code **HTTP hooks** served by `tiny_http`; Codex session files | Reliable events instead of parsing terminal output. Only event types are sent, never prompt text. |
| UI | Vanilla TypeScript and Vite | No framework, small bundle. |

## Development

You need Node 22+, Rust (via rustup) and, on Windows, the MSVC Build Tools.

```powershell
npm install
npm run app:dev       # dev build with separate state ("Project Desk (dev)")
npm test              # unit tests for the domain logic and translations
cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings   # CI runs both
npm run tauri build   # local release: src-tauri\target\release\project-desk.exe and an NSIS installer
```

The app state is stored in `%APPDATA%\eu.effistream.projectdesk\state.json`. The dev build uses `eu.effistream.projectdesk.dev`.

State writes are serialized and flushed before closing the window or installing an update. `state.json.bak` keeps the previous valid state. If the main file is damaged or missing, the app recovers from that backup and reports it. A damaged main file is preserved as `state.json.corrupt-<id>` on the next save. If neither file can be loaded, startup reports the error instead of silently replacing the data with an empty workspace.

Frontend orchestration lives in `src/main.ts`; settings, dialogs, updates, and the save queue have separate modules. Pure session lifecycle and grid rules live in `src/model.ts`; native state recovery lives in `src-tauri/src/persistence.rs`.

### Linux packages

Download the package from [GitHub Releases](https://github.com/dugynoo/project-desk/releases):

- **Debian / Ubuntu:** install the `.deb` with `sudo apt install ./Project.Desk_<version>_amd64.deb`.
- **Arch Linux (x86_64):** install the `.pkg.tar.zst` with `sudo pacman -U ./project-desk-bin-<version>-1-x86_64.pkg.tar.zst`. Pacman installs the required dependencies, desktop entry and icons. Upgrade by downloading the next package and running the same command.
- **Other distributions:** the AppImage remains available with the built-in updater.

The Arch package is a native pacman package containing the same executable as the Debian build, following [Tauri's Debian repackaging approach](https://v2.tauri.app/distribute/aur/). It is not an AppImage wrapper. It is attached to each new release; it is not currently published to AUR or a pacman repository, so `yay -S` and `pacman -Syu` do not fetch Project Desk updates.

The release pipeline runs `scripts/build-arch.sh` after the Linux build. It generates a checksummed PKGBUILD from `packaging/arch/PKGBUILD.in`, builds it as an unprivileged user in an Arch container, installs it, checks shared libraries and validates its desktop entry before uploading. For a local packaging check, run the script on Linux with Node and Docker after building exactly one amd64 Debian package in `src-tauri/target/release/bundle/deb/`.

### Releases
```powershell
npm version 0.2.0        # bumps the version, commits and tags v0.2.0
git push --follow-tags
```
`npm version` also writes the version to `src-tauri/Cargo.toml` and `Cargo.lock` (`scripts/sync-version.mjs`).

The tag starts the Release workflow. It builds Windows (NSIS), macOS (Apple Silicon and Intel) and Linux (AppImage, deb, Arch Linux x86_64 .pkg.tar.zst) and creates a draft release. The release notes list the commit subjects since the previous tag, and the app shows them when it offers the update. Windows, macOS and Linux AppImage installations see the update once you publish the draft. Debian and Arch packages are upgraded through the package manager.

The workflow signs updates with the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. The public key is in `tauri.conf.json`. If the private key is lost, installed apps cannot be updated anymore and have to be reinstalled by hand. Local builds do not create update files; `--config src-tauri/tauri.release.json` turns them on.

Keep `createUpdaterArtifacts: true` (Tauri v2 format). The updater's legacy v1 ZIP feature is disabled to avoid the vulnerable `zip` 4.x dependency. Windows uses the signed installer directly, Linux uses the AppImage, and macOS retains its required tar.gz support. TLS, system proxy support, and signature verification remain enabled.

The installers are not code-signed, so Windows SmartScreen and macOS Gatekeeper warn on first install.

- **Windows:** click *More info → Run anyway*.
- **macOS:** if macOS says the app "is damaged and can't be opened", move it to Applications and run `xattr -cr "/Applications/Project Desk.app"` in Terminal once.

### Translations
UI strings live in `src/i18n.ts`. English defines the set of keys, and TypeScript fails the build if Slovak or Czech is missing one. Rust returns error codes such as `editor.missing` or `pty.openFailed: <detail>`, and the UI translates them. A test checks that every error code in `src-tauri/src` has a translation.

## License

[MIT](LICENSE)
