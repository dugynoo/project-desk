# Native desktop smoke tests

Run `npm run test:desktop` from the repository root on Windows with Node 22+,
Rust, the normal Tauri build prerequisites and WebView2 installed. No browser
download, paid agent, CLI login or running Vite server is needed.

The runner always builds a debug application with a unique `.dev` identifier,
copies its executable to a temporary fixture, and seeds synthetic shell sessions.
Production and ordinary development state are never used. It starts only its own
process, connects Playwright to that process's WebView2, and terminates that process
in `finally` on failure. The copied executable is the only binary the runner launches.
As with any Tauri debug build, the shared `target/debug` output is overwritten;
use `npm run app:dev` to rebuild before subsequent interactive development.

Coverage:

- Two real shell PTYs start in grid mode; one exits and restarts through the UI.
- Ctrl-clicking a real terminal file link opens the lazy built-in editor.
- Save writes the expected file; cancel preserves dirty edits; discard restores grid.
- Editor settings apply live without losing edits and persist across application exit.
- A normal window close flushes state; relaunch restores the running shell and leaves
  the intentionally stopped shell stopped. The restored shell executes a command.
- Forced termination of the owned app (without a close/save handler) cleans up the
  real PTY shell and its test child. Checks use PID plus creation time, and first
  prove both are alive. Relaunching the same fixture verifies lock release,
  saved rename/settings/grid, no accidental archiving, a usable restored shell,
  and preservation of the intentionally stopped session and saved editor file.
- Frontend exceptions fail the suite. Readiness uses observable state and bounded waits.

Failures save a screenshot, error and synthetic state under `test-results/desktop`;
Windows CI uploads these artifacts. `fixture.json` identifies temporary files/state
retained for diagnosis (including on success). They contain no real conversations.
Tests currently run on Windows only; existing domain/Rust checks still run on all
three systems. These tests do not yet verify agent-provider behavior, background
Claude workers, native file pickers, or Linux/macOS desktop UI. Forced termination
tests the last completed save, not power loss, a crash during atomic replacement,
or preservation of unsaved editor text/debounced state changes.

## Why this approach

[Tauri's testing guide](https://v2.tauri.app/develop/tests/webdriver/)
describes WebDriver/WDIO for broader platform coverage. For this first Windows suite,
the existing local smoke scripts already exercised real WebView2, so we use
[Playwright's documented WebView2 connection](https://playwright.dev/docs/webview2)
with its standard locators, input, timeouts and screenshots. Only `playwright-core`
is a development dependency. No test plugin, application test IPC, background process
or polling is added to the shipped application. The debugging environment variable
is set only on the isolated child process, as documented by
[Microsoft](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code).

The crash scenario uses [Node's forceful Windows process termination](https://nodejs.org/api/child_process.html#subprocesskillsignal),
without recursively killing children in the runner. This lets the test observe
the app's [Windows Job Object cleanup](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
instead of masking failures with test cleanup. The synthetic child has a finite
lifetime as a fallback if cleanup regresses. No crash simulation or extra polling
is added to the application itself.

## Documentation screenshot

Set `PROJECT_DESK_SCREENSHOT` to an absolute PNG destination before running
`npm run test:desktop` to capture the real editor beside the synthetic shell.
The destination directory must exist. This is opt-in; normal CI does not update
tracked documentation images. The shell prompt is shortened for the screenshot.
The suite also covers sidebar rename persistence, keyboard menus, collapsing
projects and the attention filter.
