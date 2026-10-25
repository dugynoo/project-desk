// Windows native smoke suite. No automation code is shipped in the application.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { emptyState } from '../src/model.ts';
import { exerciseDesktop } from './desktop/smoke.mjs';
import { exerciseCrashRecovery } from './desktop/crash.mjs';

if (process.platform !== 'win32') throw Error('Desktop smoke currently requires Windows and WebView2.');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = resolve(root, 'test-results/desktop');
await mkdir(artifacts, { recursive: true });
for (const name of ['failure.png', 'failure.txt', 'state.json', 'result.txt']) {
  await unlink(join(artifacts, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
const fixture = await mkdtemp(join(tmpdir(), 'project-desk-smoke-'));
const identifier = `eu.effistream.projectdesk.smoke${Date.now()}.dev`;
const stateDir = join(process.env.APPDATA, identifier);
const config = join(fixture, 'tauri.json');
await writeFile(config, JSON.stringify({ identifier, productName: 'Project Desk smoke', app: {
  windows: [{ title: identifier, width: 1200, height: 800 }],
} }));
await writeFile(join(artifacts, 'fixture.json'), JSON.stringify({ fixture, stateDir, identifier }, null, 2));
console.log(`Isolated fixture: ${fixture}\nIsolated state: ${stateDir}`);
// Always build: a stale production/dev binary must never be used against a fixture.
const build = spawn(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
  'build', '--debug', '--no-bundle', '--config', config,
  '--', '--config', 'profile.dev.package.project-desk.debug=0'], { cwd: root, stdio: 'inherit', windowsHide: true });
const [code] = await once(build, 'exit');
if (code !== 0) throw Error(`Smoke build failed: ${code}`);
const executable = join(fixture, 'project-desk.exe');
await copyFile(join(process.env.CARGO_TARGET_DIR || join(root, 'src-tauri/target'), 'debug/project-desk.exe'), executable);
await mkdir(stateDir);
const state = emptyState();
state.settings.language = 'en';
state.settings.shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
state.projects = [{ id: 'p', name: 'Smoke project', path: fixture, collapsed: false, pinned: false }];
state.sessions = ['s', 's2'].map((id, index) => ({ id, projectId: 'p', provider: 'shell',
  title: `Smoke shell ${index + 1}`, started: true, stopped: false, createdAt: Date.now() + index, lastUsedAt: Date.now() }));
state.ui.activeSessionId = 's'; state.ui.grid = true; state.ui.paneSlots = ['s', 's2'];
const statePath = join(stateDir, 'state.json');
await writeFile(statePath, JSON.stringify(state));
await writeFile(join(fixture, 'editor-smoke.md'), '# Smoke editor\n');

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}
let app, browser, page, exit;
const errors = [];
async function launch() {
  const port = await freePort();
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: join(fixture, 'webview-profile') };
  delete env.NO_COLOR;
  app = spawn(executable, [], { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  exit = once(app, 'exit');
  app.stdout.on('data', data => process.stdout.write(data));
  app.stderr.on('data', data => process.stderr.write(data));
  const deadline = Date.now() + 60_000;
  let endpoint, connectionError;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw Error(`App exited at startup: ${app.exitCode}`);
    try { endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); break; } catch (error) { connectionError = String(error); }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!endpoint) {
    const diagnostics = await promisify(execFile)(state.settings.shell, ['-NoProfile', '-NonInteractive', '-Command', `
      Get-Process -Id $env:PROJECT_DESK_SMOKE_PID | Select-Object Id, Responding, MainWindowTitle, SessionId | Format-List
      Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedgewebview2.exe' -or $_.ProcessId -eq $env:PROJECT_DESK_SMOKE_PID } | Select-Object Name, ProcessId, ParentProcessId, CommandLine | Format-List
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bitmap = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
      $bitmap.Save($env:PROJECT_DESK_SMOKE_SCREENSHOT)
      $graphics.Dispose(); $bitmap.Dispose()
    `], { windowsHide: true, timeout: 15_000, env: { ...process.env,
      PROJECT_DESK_SMOKE_PID: String(app.pid), PROJECT_DESK_SMOKE_SCREENSHOT: join(artifacts, 'startup.png') } }).catch(error => ({ stdout: String(error) }));
    await writeFile(join(artifacts, 'startup.txt'), diagnostics.stdout);
    throw Error(`WebView2 debugging endpoint did not start: ${connectionError}`);
  }
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl, { timeout: 15_000 });
  browser.contexts()[0].setDefaultTimeout(15_000);
  page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].waitForEvent('page');
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.locator('.pane.visible').first().waitFor();
  return page;
}
async function close() {
  // Send the real native close request; do not grant test-only Tauri permissions.
  await promisify(execFile)(state.settings.shell, ['-NoProfile', '-NonInteractive', '-Command',
    'if (-not ([Diagnostics.Process]::GetProcessById([int]$env:PROJECT_DESK_SMOKE_PID)).CloseMainWindow()) { exit 1 }'],
  { windowsHide: true, timeout: 5000, env: { ...process.env, PROJECT_DESK_SMOKE_PID: String(app.pid) } });
  await Promise.race([exit, new Promise((_, reject) => { const t = setTimeout(() => reject(Error('App did not close')), 15_000); t.unref(); })]);
  await browser.close(); browser = undefined;
}
async function crash() {
  // Kill only the owned application, not its process tree: the OS job must
  // clean up descendants without the graceful close/save path helping it.
  if (!app || app.exitCode !== null || app.signalCode !== null) throw Error('No live test app to crash');
  if (!app.kill('SIGKILL')) throw Error('Could not terminate test app');
  await Promise.race([exit, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('Crashed app did not exit')), 15_000); timer.unref();
  })]);
  await browser.close(); browser = undefined;
}
async function checkProcesses(records, exited) {
  // PID plus creation time prevents a reused PID from passing as our fixture.
  await promisify(execFile)(state.settings.shell, ['-NoProfile', '-NonInteractive', '-Command', `
    $records = ConvertFrom-Json $env:PROJECT_DESK_SMOKE_PROCESSES
    foreach ($record in $records) {
      $process = $null
      try { $process = [Diagnostics.Process]::GetProcessById([int]$record.id) } catch [ArgumentException] {}
      $same = $process -and ($process.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.started)
      if ($env:PROJECT_DESK_SMOKE_EXITED -eq 'true') {
        if ($same -and -not $process.WaitForExit(10000)) { throw "Fixture process still alive: $($record.id)" }
      } elseif (-not $same -or $process.HasExited) { throw "Fixture process not alive: $($record.id)" }
    }
  `], { windowsHide: true, timeout: 25_000, env: { ...process.env,
    PROJECT_DESK_SMOKE_PROCESSES: JSON.stringify(records), PROJECT_DESK_SMOKE_EXITED: String(exited) } });
}
try {
  await exerciseDesktop({ launch, close, fixture, statePath });
  await exerciseCrashRecovery({ launch, close, crash, checkProcesses, fixture, statePath });
  if (errors.length) throw Error(`Frontend exceptions:\n${errors.join('\n')}`);
  console.log('PASS: desktop lifecycle, restart, grid, editor, settings and forced crash recovery.');
  await writeFile(join(artifacts, 'result.txt'), 'PASS\n');
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  await writeFile(join(artifacts, 'failure.txt'), `${error.stack}\n${errors.join('\n')}`);
  await readFile(statePath).then(data => writeFile(join(artifacts, 'state.json'), data)).catch(() => {});
  throw error;
} finally {
  // Only this runner's process; never search for or terminate other Project Desk instances.
  if (app && app.exitCode === null && app.signalCode === null) { app.kill(); await exit; }
  await browser?.close().catch(() => {});
}
