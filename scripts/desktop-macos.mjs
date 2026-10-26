// Real WKWebView + PTYs; the embedded driver exists only in this opt-in build.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { emptyState } from '../src/model.ts';
import { exerciseEditor } from './desktop/editor.mjs';

if (process.platform !== 'darwin') throw Error('This suite requires macOS and the Tauri build prerequisites.');
const root = fileURLToPath(new URL('../', import.meta.url));
const defaultDependencies = execFileSync('cargo', ['tree', '--manifest-path', 'src-tauri/Cargo.toml',
  '--locked', '-e', 'normal', '--prefix', 'none'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
assert.ok(!defaultDependencies.includes('tauri-plugin-wdio-webdriver'), 'Default macOS build must exclude automation');
const fixture = await mkdtemp(join(tmpdir(), 'project-desk-macos-'));
const identifier = `eu.effistream.projectdesk.smoke${randomUUID().replaceAll('-', '')}.dev`;
// macOS resolves app_config_dir under Application Support, not XDG_CONFIG_HOME.
// Keep the real HOME intact; only a fresh random app identifier is ever seeded.
const stateDir = join(homedir(), 'Library/Application Support', identifier);
await mkdir(stateDir);
const statePath = join(stateDir, 'state.json');
const artifacts = resolve(root, 'test-results/desktop-macos');
await mkdir(artifacts, { recursive: true });
await writeFile(join(artifacts, 'fixture.json'), JSON.stringify({ fixture, stateDir, identifier }, null, 2));
const config = join(fixture, 'tauri.json');
await writeFile(config, JSON.stringify({ identifier, productName: 'Project Desk macOS smoke',
  app: { windows: [{ title: identifier, width: 1200, height: 800 }], security: {
    capabilities: ['default', { identifier: 'macos-smoke', windows: ['main'], permissions: ['wdio-webdriver:default'] }],
  } } }));
console.log(`macOS fixture: ${fixture}`);
const build = spawn(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
  'build', '--debug', '--no-bundle', '--features', 'desktop-smoke', '--config', config,
  '--', '--locked', '--config', 'profile.dev.package.project-desk.debug=0'], { cwd: root, stdio: 'inherit' });
const [code] = await once(build, 'exit');
if (code !== 0) throw Error(`macOS smoke build failed: ${code}`);
const executable = join(fixture, 'project-desk');
await copyFile(join(process.env.CARGO_TARGET_DIR || join(root, 'src-tauri/target'), 'debug/project-desk'), executable);
await chmod(executable, 0o700);
const state = emptyState();
state.settings.language = 'en';
state.settings.shell = '/bin/bash';
state.projects = [{ id: 'p', name: 'macOS smoke project', path: fixture }];
state.sessions = ['s', 's2'].map((id, index) => ({ id, projectId: 'p', provider: 'shell',
  title: `macOS shell ${index + 1}`, started: true, stopped: false,
  createdAt: Date.now() + index, lastUsedAt: Date.now() }));
state.ui.activeSessionId = 's'; state.ui.grid = true; state.ui.paneSlots = ['s', 's2'];
await writeFile(statePath, JSON.stringify(state));

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function until(read, accepts, description) {
  const deadline = Date.now() + 30_000;
  while (true) {
    const value = await read();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
let app, sessionId, endpoint;
let appLog = '';
const alive = () => app && app.exitCode === null && app.signalCode === null;
async function request(method, path, data) {
  // The driver allows 30 seconds for script execution; let it return its own
  // diagnostic before the transport deadline, especially during cold WKWebView startup.
  const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(45_000),
    headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) })
    .catch(error => { throw Error(`${method} ${path}: ${error.message}`, { cause: error }); });
  const result = await response.json();
  if (!response.ok || result.error || result.value?.error) throw Error(`${method} ${path}: ${JSON.stringify(result)}`);
  return result.value;
}
const command = (method, path, data) => request(method, `/session/${sessionId}${path}`, data);
// Use the plugin's macOS-hardened evaluation channel for DOM reads/focus only.
// It handles WebKit reclaiming completion callbacks on cold CI webviews (#540).
// User actions still go through WebDriver; no application IPC is mocked/invoked.
const evaluate = (script, ...args) => request('POST', '/wdio/eval', {
  window_label: 'main', timeout_ms: 30_000,
  script: `const done = arguments[arguments.length - 1];
    try { const value = (function() { ${script}\n }).apply(null, ${JSON.stringify(args)});
      done({ ok: true, value: value === undefined ? null : value });
    } catch (error) { done({ ok: false, error: String(error) }); }`,
});
const wait = (script, message) => until(() => evaluate(script), Boolean, message);
const saved = async () => JSON.parse(await readFile(statePath, 'utf8'));
const optionalFile = name => readFile(join(fixture, name), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''; throw error;
});
async function element(selector) {
  return (await command('POST', '/element', { using: 'css selector', value: selector }))['element-6066-11e4-a52e-4f735466cecf'];
}
async function elementAction(selector, action, data = {}) {
  // Status/branch updates can rebuild sidebar inputs between lookup and action.
  // Retry only stale references, never assertions, timeouts or other driver errors.
  for (let attempt = 0; ; attempt++) {
    try { return await command('POST', `/element/${await element(selector)}/${action}`, data); }
    catch (error) {
      if (attempt >= 2 || !error.message.includes('"error":"stale element reference"')) throw error;
    }
  }
}
async function click(selector) { await elementAction(selector, 'click'); }
async function type(selector, text, replace = false) {
  // This embedded driver's clear keeps focus (unlike native WebKitWebDriver).
  // Re-resolve after clear in case a UI update replaced the input.
  if (replace) await elementAction(selector, 'clear');
  await elementAction(selector, 'value', { text });
}
async function shell(index, text) {
  // Mark the actual xterm textarea; avoid child indices of the stage (dividers).
  await evaluate('document.querySelectorAll("textarea[data-smoke-input]").forEach(el => el.removeAttribute("data-smoke-input")); const el = document.querySelectorAll(".pane.visible")[arguments[0]].querySelector("textarea.xterm-helper-textarea"); el.dataset.smokeInput = "true"; el.focus()', index);
  await type('textarea[data-smoke-input]', text + '\uE007');
}
async function launch() {
  const port = await freePort();
  endpoint = `http://127.0.0.1:${port}`;
  app = spawn(executable, [], { cwd: fixture, env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port), RUST_BACKTRACE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError;
  app.on('error', error => { spawnError = error; });
  app.on('exit', (code, signal) => { appLog += `\nApplication exit: code=${code}, signal=${signal}\n`; });
  app.stdout.on('data', data => { appLog += data; });
  app.stderr.on('data', data => { appLog += data; });
  await until(async () => {
    if (spawnError) throw spawnError;
    if (!alive()) throw Error(`App exited before driver was ready: ${appLog}`);
    return fetch(endpoint + '/status', { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
  }, Boolean, 'embedded macOS driver starts');
  sessionId = (await request('POST', '/session', { capabilities: { alwaysMatch: {} } })).sessionId;
  await wait('return document.querySelectorAll(".pane.visible").length === 2', 'two terminal panes');
  await wait('return document.querySelector(".pane.visible .pane-head").textContent.includes("Running")', 'first shell running');
}
async function close() {
  // The embedded driver's Close Window calls window.close(), not destroy().
  // It exercises our native CloseRequested/save handler. App exit may cut HTTP short.
  await command('DELETE', '/window').catch(error => { appLog += `\nClose response: ${error.message}\n`; });
  await until(() => alive(), running => !running, 'native window close exits application');
  assert.equal(app.exitCode, 0, `normal close exits cleanly (signal=${app.signalCode})`);
  sessionId = undefined;
}
function assertRecovered(actual, expected) {
  assert.deepEqual(actual.settings, expected.settings);
  assert.deepEqual(actual.ui.paneSlots, expected.ui.paneSlots);
  assert.equal(actual.ui.grid, expected.ui.grid);
  assert.deepEqual(actual.closedSessions, expected.closedSessions);
  assert.deepEqual(actual.sessions.map(s => [s.id, s.title, s.stopped]),
    expected.sessions.map(s => [s.id, s.title, s.stopped]));
}
async function checkRestored(marker) {
  await wait('return !!document.querySelectorAll(".pane.visible")[1].querySelector(".pane-head.stopped")', 'stopped shell stays stopped');
  // marker is a fixed test constant, never user input.
  await shell(0, `printf '${marker}' > ${marker}.txt`);
  await until(() => optionalFile(`${marker}.txt`), text => text === marker, 'restored PTY executes input');
}

try {
  await launch();
  console.log('macOS: real shell input, stop/restart, sidebar and settings');
  await shell(0, "printf 'MAC_READY' > mac-ready.txt");
  await until(() => optionalFile('mac-ready.txt'), text => text === 'MAC_READY', 'real PTY input');
  await shell(1, 'exit');
  await wait('return !!document.querySelectorAll(".pane.visible")[1].querySelector(".pane-head.stopped")', 'shell stopped');
  await click('[data-focus-id="restart-s2"]');
  await wait('return document.querySelectorAll(".pane.visible")[1].querySelector(".pane-head").textContent.includes("Running")', 'shell restarted');
  await exerciseEditor({ fixture, platform: 'macOS', command, evaluate, wait, until, shell, click, type });
  await click('[data-focus-id="session-menu-s"]');
  await click('[role="menuitem"]');
  await type('input.title-edit', 'macOS saved session\uE007', true);
  await wait('return document.querySelector("[data-focus-id=session-s]").textContent.includes("macOS saved session")', 'renamed session');
  await click('[data-focus-id="project-p"]');
  assert.equal(await evaluate('return document.querySelectorAll("#projects .session").length'), 0);
  await click('[data-focus-id="project-p"]');
  assert.equal(await evaluate('return document.querySelectorAll("#projects .session").length'), 2);
  await click('#btn-settings');
  await click('#settings-tab-editor');
  await type('#settings-panel-editor input[type=number]', '18', true);
  await click('#settings-panel-editor input[type=checkbox]');
  await click('#overlay button.primary');
  await wait('return !document.querySelector("#settings-tab-editor")', 'settings saved');
  await shell(1, 'exit');
  await wait('return !!document.querySelectorAll(".pane.visible")[1].querySelector(".pane-head.stopped")', 'second session intentionally stopped');
  await close();
  const checkpoint = await saved();
  assert.equal(checkpoint.sessions.find(s => s.id === 's').title, 'macOS saved session');
  assert.equal(checkpoint.sessions.find(s => s.id === 's2').stopped, true);
  assert.equal(checkpoint.settings.editorFontSize, 18);
  assert.equal(checkpoint.settings.editorWordWrap, true);
  console.log('macOS: normal relaunch, saved layout/settings and usable terminal');
  await launch();
  await checkRestored('MAC_RESTORED');
  await close();
  assertRecovered(await saved(), checkpoint);

  console.log('macOS: SIGKILL bypasses save handler; relaunch verifies lock and checkpoint');
  await launch();
  await checkRestored('MAC_BEFORE_CRASH');
  await click('[data-focus-id="session-menu-s"]');
  await click('[role="menuitem"]');
  await type('input.title-edit', 'macOS crash checkpoint\uE007', true);
  const crashCheckpoint = await until(saved, state => state.sessions.find(s => s.id === 's')?.title === 'macOS crash checkpoint', 'ordinary debounce reaches disk');
  assert.ok(app.kill('SIGKILL'), 'only our owned application is terminated');
  await until(() => alive(), running => !running, 'application terminated');
  assert.equal(app.signalCode, 'SIGKILL');
  sessionId = undefined;
  assertRecovered(await saved(), crashCheckpoint);
  await launch();
  await wait('return document.querySelector("[data-focus-id=session-s]").textContent.includes("macOS crash checkpoint")', 'crash checkpoint restored');
  await checkRestored('MAC_CRASH_RESTORED');
  await close();
  assertRecovered(await saved(), crashCheckpoint);
  await writeFile(join(artifacts, 'result.txt'), 'PASS: macOS real PTYs, editor save/dirty/conflict/grid, sidebar, settings, normal and crash recovery\n');
  console.log('PASS: macOS desktop smoke');
} catch (error) {
  if (sessionId && alive()) {
    await command('GET', '/screenshot').then(png => writeFile(join(artifacts, 'failure.png'), Buffer.from(png, 'base64'))).catch(() => {});
    await command('GET', '/source').then(html => writeFile(join(artifacts, 'failure.html'), html)).catch(() => {});
  }
  await writeFile(join(artifacts, 'failure.txt'), error.stack);
  await copyFile(statePath, join(artifacts, 'state.json')).catch(() => {});
  // Only reports naming this random fixture executable; never collect unrelated apps.
  const reports = join(homedir(), 'Library/Logs/DiagnosticReports');
  for (const name of await readdir(reports).catch(() => [])) {
    if (!name.startsWith('project-desk') || !/\.(ips|crash)$/.test(name)) continue;
    const report = await readFile(join(reports, name), 'utf8').catch(() => '');
    if (report.includes(identifier) || report.includes(fixture)) {
      await writeFile(join(artifacts, name), report);
    }
  }
  throw error;
} finally {
  if (sessionId && alive()) await close().catch(() => {});
  if (alive()) {
    app.kill('SIGKILL');
    await until(() => alive(), running => !running, 'owned application cleanup');
  }
  await writeFile(join(artifacts, 'app.log'), appLog);
}
