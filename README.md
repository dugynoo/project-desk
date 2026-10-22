# Project Desk

A desktop app for running Claude Code, Codex and plain shell sessions across many projects from one window. Each project lists its sessions with a live status, so you can see at a glance which agent is working, which one is done and which one is waiting for you.

It replaces the earlier Cursor extension. Your editor opens only when you ask for it.

The UI is available in English, Slovak and Czech (⚙ Settings → Language). English is the default.

## Features

### Projects and sessions
- Projects live in the sidebar. Each project row has buttons for a new **✳ Claude**, **‹› Codex** or **▣ Shell** session, **↗** open in editor, **☆** pin and **✕** remove.
- Drag projects to reorder them. Pinned projects always stay on top.
- Drag the sidebar edge to resize it.
- Rename a session inline (double-click or ✎). Closing a terminal (✕ or `exit`) removes it from the list.

### Agent status
- **Claude Code:** status comes from Claude Code hooks: *Working*, *Needs you*, *Done*, *Ready*, *Agent exited*. The app starts Claude with `--settings` pointing at HTTP hooks on a local endpoint. Your `~/.claude` settings are never modified.
- **Codex:** status comes from the Codex session file in `~/.codex/sessions`: *Working*, *Done*. The app reads only the event type (`task_started`, `task_complete`, `turn_aborted`). Codex hooks would require changing its configuration, so they are not used.
- **Notifications:** a system notification and an unread dot appear when an agent finishes or needs you while you are looking elsewhere.

### Session info
Click **ⓘ** or right-click a session to see the model, context size, tokens (new, from cache, output) and, for Codex, the used rate limit. The conversation ID can be copied. The numbers apply to the current conversation and restart after `/clear`.

### Resume after restart
On start, sessions resume where they left off: Claude with `--resume <id>`, Codex with `codex resume <id>`. You can turn this off in Settings.

### Prompt templates
Press **✦** or **Ctrl+Shift+T**. Templates can be shared by all projects or belong to one project. A template is pasted into the active session as a single bracketed paste and can optionally be sent right away.

### Terminal
- **Search:** Ctrl+Shift+F, then Enter for next and Shift+Enter for previous.
- **Ctrl+click** a URL to open it in your browser. Ctrl+click a file path such as `src/main.ts:120` to open it in your editor at that line.
- **2×2 grid:** Ctrl+G shows up to four running sessions at once.
- **Find a session:** Ctrl+K.
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

## Security

- **No user text in shell commands.** The command line only contains the command from Settings, a validated UUID and a reference to an environment variable. Project and session names never get there. The working directory is passed as a process option.
- **Hook endpoint:** listens on `127.0.0.1` only, on a random port, and requires a random token in a header. A hook request is reduced to the event type and session ID.
- **Session files:** only numbers and event types are read from agent session files. Conversation text is never stored or sent to the UI.
- **Templates** are pasted as a bracketed paste. Any end-of-paste sequence inside the text is removed, so a template cannot run as a shell command.
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
cd src-tauri; cargo test
npm run tauri build   # release: src-tauri\target\release\project-desk.exe and an NSIS installer
```

The app state is stored in `%APPDATA%\eu.effistream.projectdesk\state.json`. The dev build uses `eu.effistream.projectdesk.dev`.

### Translations
UI strings live in `src/i18n.ts`. English defines the set of keys, and TypeScript fails the build if Slovak or Czech is missing one. Rust returns error codes such as `editor.missing` or `pty.openFailed: <detail>`, and the UI translates them. A test checks that every error code in `src-tauri/src` has a translation.

## Ideas

- Auto-update and macOS/Linux builds through GitHub Actions
- Ctrl+1–9 shortcuts
