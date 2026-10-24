# Project Desk — agent instructions

This is the canonical project guidance shared with Codex through `AGENTS.md`.
Edit this file; keep project rules in one place.

## Project

Project Desk is a cross-platform desktop app for running Claude Code, Codex, Antigravity CLI,
and shell sessions across projects in one window. It provides live agent status,
notifications, session resume, prompt templates, terminal search, a four-pane
grid, and editor integration. It replaces an earlier Cursor extension.

The stack is Tauri 2 / Rust, vanilla TypeScript / Vite, xterm.js, and
portable-pty. Preserve the lightweight, framework-free architecture. Windows,
macOS, and Linux are supported; keep OS-specific behavior behind platform checks.
See `README.md` for product behavior, setup details, and release instructions.

## Where to work

- `src/main.ts`: UI, terminal lifecycle, Tauri calls/events and notifications.
- `src/settings.ts`, `dialogs.ts`, `updates.ts`: settings UI, modal dialogs and updates.
  `src/persistence.ts`: serialized, debounced saves with explicit close/update flush.
- `src/model.ts`: pure domain logic, state parsing/migrations, commands, statuses,
  and terminal paste/link helpers. Keep this module independent of DOM and Tauri.
- `src/i18n.ts`: English, Slovak, and Czech UI strings; `src/style.css` and
  `index.html`: styling and app markup.
- `src-tauri/src/lib.rs`: Tauri command registration, IPC and app lifecycle.
  `src-tauri/src/persistence.rs`: validated state writes, backup and recovery.
- `src-tauri/src/pty.rs` and `job.rs`: PTYs and child-process cleanup.
- `src-tauri/src/antigravity.rs` and `antigravity-relay.cjs`: user-scoped AGY plugin and metadata-only relay.
- `src-tauri/src/hooks.rs`: Claude/Antigravity HTTP hooks; `codex.rs`: conversation discovery;
  `usage.rs`: incremental session-file parsing for usage and Codex status.
- `src-tauri/src/editors.rs` and `files.rs`: editor detection/launch and file actions.
- `.github/workflows/ci.yml`: checks on all three platforms; `release.yml`: releases.

## Development and verification

Use npm and the committed lockfile. Prerequisites: Node 22+, stable Rust,
and platform-specific Tauri build dependencies (see README and CI).

Run from the repository root:

```sh
npm ci
npm run app:dev
```

Use `app:dev` for desktop testing: its separate app identifier keeps development
state apart from production state. `npm run dev` starts only Vite; it does not
provide the native Tauri backend. Do not use real user state as test fixtures.

The full CI check sequence, from the repository root, is:

```sh
npm test
npm run build
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Build the frontend before Rust checks: Tauri's generated context needs `dist/`.
`npm run lint` is TypeScript checking only, not ESLint. TypeScript tests use
Node's built-in test runner; Rust unit tests live beside the implementation.
Run checks relevant to the change; documentation-only changes need no app build.
For UI/terminal changes, also exercise the affected behavior in the desktop app
when available. Report checks run and any platform or manual checks not performed.

## Conventions and invariants

- Put testable domain behavior in `src/model.ts` and cover behavior changes in
  `src/model.test.ts`; keep native behavior tests next to the Rust implementation.
- Add UI strings in all three languages. English defines the translation keys.
  Rust errors use codes such as `editor.missing` or `pty.openFailed: <detail>`;
  add matching translations and keep `src/i18n.test.ts` passing.
- Keep explicit close/archive separate from unexpected process exit. Retain the
  stopped terminal for diagnosis; archive metadata only, never terminal output.
- Preserve compatibility with saved state through `parseState` and existing
  settings migrations. Default-setting migrations must preserve user overrides.
- Keep TypeScript IPC types and Rust serde payloads aligned (camelCase at the
  boundary). Register new commands in `lib.rs` and review Tauri capabilities
  when adding native functionality.
- Derive agent status from Claude hooks and Codex session events, not terminal
  text scraping. Keep integrations local; do not modify global agent settings except for the owned
  Project Desk AGY plugin in ~/.gemini/config/plugins/project-desk. Preserve other
  plugins/settings and only migrate exact copies of our legacy workspace hooks.
- Session-file watchers and hook payloads expose only required metadata, events,
  and usage statistics. Do not persist or forward conversation text through them.
- Never interpolate project/session names, paths, or pasted text into shell
  commands. Preserve UUID validation, environment-variable indirection, and
  bracketed-paste sanitization. Launch editors with separate argument arrays.
- Keep the hook server on loopback with its random token. Keep executable-file
  rejection in Rust for default-app opening; UI settings must not bypass it.
- Preserve process cleanup: Windows Job Objects and Unix process-group signals.
  Editors and update installers must retain their intended ability to outlive
  the app. Dispose terminal resources when sessions close.
- Edit source files, not generated `dist/`, `src-tauri/gen/`, or target output.
  Keep this guide focused on durable rules; update README for user-facing changes.

## Releases and shared instructions

`npm version` also updates Cargo versions via `scripts/sync-version.mjs` and
creates a commit/tag. A pushed `v*` tag triggers release builds and a draft release;
publishing that draft makes the update available. Treat these as release actions,
not routine validation. Preserve updater signing configuration.

Locally, `AGENTS.md` and `CLAUDE.md` are hard links to the same file, so writes
to either name update both. Edit `CLAUDE.md` in place; replacing a file through
rename/delete can break the link. Git stores them as two regular files and does
not preserve hard links across clones. After cloning or replacing either file,
restore the link from the canonical `CLAUDE.md` in PowerShell:

```powershell
Remove-Item -LiteralPath AGENTS.md
New-Item -ItemType HardLink -Path AGENTS.md -Target CLAUDE.md
```

Keep both paths in Git with identical content.
