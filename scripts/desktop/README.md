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
Windows, Linux and macOS desktop suites are configured in CI; domain/Rust checks run on all
three systems. These tests do not yet verify agent-provider behavior, background
Claude workers or native file pickers. Forced termination
tests the last completed save, not power loss, a crash during atomic replacement,
or preservation of unsaved editor text/debounced state changes.

## Why this approach

[Tauri's testing guide](https://v2.tauri.app/develop/tests/webdriver/)
describes WebDriver/WDIO for broader platform coverage. For this first Windows suite,
the existing local smoke scripts already exercised real WebView2, so we use
[Playwright's documented WebView2 connection](https://playwright.dev/docs/webview2)
with its standard locators, input, timeouts and screenshots. Only `playwright-core`
is a development dependency. On Windows/Linux no test plugin, application test IPC, background process
or polling is added to the shipped application. The debug port is set only in the generated temporary Tauri test configuration.
[Elevated hosts ignore environment-provided browser flags](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags),
so configuring the test build directly also supports Windows CI. Production
configuration never enables this port. Each fixture uses its own WebView profile.

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

## Linux native desktop suite

The Linux suite uses the real Tauri application through `tauri-driver` 2.1.0 and
system `WebKitWebDriver`, following [Tauri's WebDriver CI guidance](https://v2.tauri.app/develop/tests/webdriver/ci/).
It uses the standard WebDriver HTTP protocol from Node, without another npm test
framework or production automation plugin. Install `webkit2gtk-driver`, `xvfb`,
`dbus-x11`, `openbox` and `wmctrl` alongside the normal Linux build dependencies,
then `cargo install tauri-driver --version 2.1.0 --locked`. Run:

```sh
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x900x24' sh -eu -c '
  openbox >/tmp/project-desk-openbox.log 2>&1 &
  manager=$!
  trap "kill $manager 2>/dev/null || true" EXIT
  npm run test:desktop:linux
'
```

A unique app identifier and temporary XDG config/data/cache roots isolate all
state. The suite builds and copies its own executable. Two Bash PTYs exercise
actual shell input, exit/restart, sidebar rename/collapse/filter, editor settings,
native window close with save, and relaunch with a working restored shell and an
intentionally stopped session. Openbox plus `wmctrl` sends a native close request;
the test does not invoke private application IPC or replace persisted state to
simulate a successful save. Failures retain screenshot, DOM, state and driver log
under `test-results/desktop-linux` for CI artifacts.

The Linux crash scenario saves a rename through the normal debounce, starts a
finite foreground child in the real Bash PTY, and sends `SIGKILL` only to the
application. It obtains the app PID from the shell's parent and verifies that
`/proc/PID/exe` is the unique fixture executable before signalling it. Both shell
and child must be alive beforehand and exit before WebDriver cleanup is allowed.
Identity checks use PID plus [start time from `/proc/PID/stat`](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html),
so PID reuse does not count as a surviving process. Zombies count as exited, not
running orphans; this does not assert immediate reaping by the OS. Relaunch verifies
lock release, saved grid/settings/title, no unexpected archiving, an executable
restored shell and preservation of the deliberately stopped session.
`crash-processes.json` records synthetic process identities for failure diagnosis.

Both Linux and macOS also run `editor.mjs`: a modifier-click on an actual terminal
file link opens CodeMirror and temporarily focuses one pane. Keyboard input and
the platform save shortcut write a real fixture file. Cancel retains dirty edits;
an external file write makes Save report a conflict without overwriting either
version. Reload asks before discarding edits and reads the external version;
closing with Discard restores the original two pane headers/order. All actions
use WebDriver, not application IPC or direct changes to CodeMirror's state.

This Linux suite does not cover real agents, detached
or SIGHUP-ignoring descendants, Wayland, or all Linux distributions. A foreground
sleep process does not prove that every agent's background workers terminate.
Windows additionally covers live editor appearance changes. Docker is not required. No Linux build or virtual disk
needs to be installed on a Windows developer's machine to run the CI job.

## macOS desktop suite

On macOS with Node 22+, Xcode command-line tools and the normal Tauri prerequisites,
run `npm run test:desktop:macos`. The macOS CI job runs the same command. It builds
a debug binary with the explicit `desktop-smoke` Cargo feature and communicates
with the embedded `tauri-plugin-wdio-webdriver` 1.5.1 over standard WebDriver HTTP.
This is the macOS route described in [Tauri's testing guide](https://v2.tauri.app/develop/tests/webdriver/)
and [the plugin setup documentation](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup).
User actions use WebDriver; DOM reads/focus use the plugin's `/wdio/eval` channel,
which includes the macOS cold-WebView handling described in [upstream issue #540](https://github.com/webdriverio/desktop-mobile/issues/540).
The HTTP deadline exceeds the driver's script timeout so its diagnostics can arrive.
There is no WDIO JavaScript service,
mocking plugin, fake backend, paid driver or browser download.

The plugin is an optional macOS dependency, registered only with the feature AND
debug assertions. Building the application in release mode with this feature is
rejected. Normal dev/release builds have no automation server or its runtime cost.
Only the temporary smoke config adds its capability. The plugin listens on loopback
at a temporary port while the test app runs; it allows automation of that synthetic
app and must not be used as an everyday build. The runner always builds and copies
its own executable, and kills only the process it spawned if graceful cleanup fails.

Each run uses a random app identifier and seeds only its own directory under
`~/Library/Application Support/`. HOME, user settings and production state are left
intact. Synthetic fixtures are retained and listed in
`test-results/desktop-macos/fixture.json`; failures retain DOM, screenshot when
available, state, error and app log. The CI job uploads those diagnostics.

Coverage: two real Bash PTYs, actual command execution, stop/restart, sidebar rename
and collapse/expand, editor settings, a native close/save request, and relaunch with
saved layout/settings and a usable shell while intentionally stopped sessions stay
stopped. A second scenario saves through the ordinary debounce, kills only the owned
app with SIGKILL, then relaunches the same fixture to check lock release and recovery.
Input comes through the embedded driver's DOM event implementation; this is not a
test of macOS physical keyboard delivery, accessibility permissions, or IME handling.
The suite does not yet assert descendant-process cleanup on macOS, native Quit/logout,
or authenticated agent/subagent recovery. New editor scenarios require a
successful macOS CI run before these scenarios can be called platform-validated.
