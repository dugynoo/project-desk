// Real Tauri/WebKit smoke test. Run under dbus-run-session + Xvfb on Linux.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { emptyState } from '../src/model.ts';
import { exerciseLinuxCrash } from './desktop/linux-crash.mjs';

if (process.platform !== 'linux') throw Error('This suite requires Linux, WebKitWebDriver and tauri-driver.');
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'project-desk-linux-'));
const identifier = `eu.effistream.projectdesk.smoke${Date.now()}.dev`;
const artifacts = resolve(root, 'test-results/desktop-linux');
await mkdir(artifacts, { recursive: true });
const configRoot = join(fixture, 'config');
const stateDir = join(configRoot, identifier);
await mkdir(stateDir, { recursive: true });
const statePath = join(stateDir, 'state.json');
await writeFile(join(artifacts, 'fixture.json'), JSON.stringify({ fixture, stateDir, identifier }, null, 2));
const config = join(fixture, 'tauri.json');
await writeFile(config, JSON.stringify({ identifier, productName: 'Project Desk Linux smoke',
  app: { windows: [{ title: identifier, width: 1200, height: 800 }] } }));
console.log(`Linux fixture: ${fixture}`);
const build = spawn(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
  'build', '--debug', '--no-bundle', '--config', config,
  '--', '--config', 'profile.dev.package.project-desk.debug=0'], { cwd: root, stdio: 'inherit' });
const [code] = await once(build, 'exit');
if (code !== 0) throw Error(`Linux smoke build failed: ${code}`);
const executable = join(fixture, 'project-desk');
await copyFile(join(process.env.CARGO_TARGET_DIR || join(root, 'src-tauri/target'), 'debug/project-desk'), executable);
await chmod(executable, 0o700);
const state = emptyState();
state.settings.language = 'en';
state.settings.shell = '/bin/bash';
state.projects = [{ id: 'p', name: 'Linux smoke project', path: fixture }];
state.sessions = ['s', 's2'].map((id, index) => ({ id, projectId: 'p', provider: 'shell',
  title: `Linux shell ${index + 1}`, started: true, stopped: false,
  createdAt: Date.now() + index, lastUsedAt: Date.now() }));
state.ui.activeSessionId = 's'; state.ui.grid = true; state.ui.paneSlots = ['s', 's2'];
await writeFile(statePath, JSON.stringify(state));

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function until(read, accepts, message) {
  const deadline = Date.now() + 20_000;
  while (true) {
    const value = await read();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const port = await freePort();
let nativePort = await freePort();
while (nativePort === port) nativePort = await freePort();
const env = { ...process.env, XDG_CONFIG_HOME: configRoot,
  XDG_DATA_HOME: join(fixture, 'data'), XDG_CACHE_HOME: join(fixture, 'cache') };
delete env.NO_COLOR;
// Detached group contains only this driver's descendants. No process-name kills.
const driver = spawn('tauri-driver', ['--port', String(port), '--native-port', String(nativePort)],
  { cwd: fixture, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let driverLog = '';
driver.stdout.on('data', data => { driverLog += data; });
driver.stderr.on('data', data => { driverLog += data; });
driver.on('error', error => { driverLog += String(error); });
let sessionId;
const endpoint = `http://127.0.0.1:${port}`;
async function request(method, path, data) {
  const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
const command = (method, path, data) => request(method, `/session/${sessionId}${path}`, data);
const evaluate = (script, ...args) => command('POST', '/execute/sync', { script, args });
async function click(selector) {
  // Sidebar actions appear on hover; use native pointer actions rather than
  // WebKit's element-click algorithm on an initially transparent button.
  const point = await evaluate('const r = document.querySelector(arguments[0]).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }', selector);
  await command('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse',
    parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
      { type: 'pause', duration: 100 },
      { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
    ] }] });
}
async function type(selector, text, clear = false) {
  await evaluate('document.querySelector(arguments[0]).focus()', selector);
  const actions = [];
  const key = value => actions.push({ type: 'keyDown', value }, { type: 'keyUp', value });
  // WebKit element-clear blurs inline rename inputs, committing/removing them.
  // Real keyboard editing preserves focus even when sidebar status rerenders.
  if (clear) {
    actions.push({ type: 'keyDown', value: '\uE009' });
    key('a');
    actions.push({ type: 'keyUp', value: '\uE009' });
    key('\uE003');
  }
  for (const character of text) key(character);
  await command('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard', actions }] });
}
const wait = (script, message) => until(() => evaluate(script), Boolean, message);
const saved = async () => JSON.parse(await readFile(statePath, 'utf8'));
async function launch() {
  const session = await request('POST', '/session', { capabilities: { alwaysMatch: {
    'tauri:options': { application: executable } } } });
  sessionId = session.sessionId;
  await wait('return document.querySelectorAll(".pane.visible").length === 2', 'two terminal panes');
}
async function shell(index, text) {
  // Focus through DOM only; input itself goes through the native WebDriver keys.
  const input = await evaluate('const input = document.querySelectorAll(".pane.visible")[arguments[0]].querySelector("textarea.xterm-helper-textarea"); input.focus(); return input', index);
  await command('POST', `/element/${input['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: text + '\uE007' });
}
async function close() {
  // Native WM_DELETE_WINDOW via the window manager exercises Tauri's save handler.
  await run('wmctrl', ['-F', '-c', identifier], { timeout: 5000 });
  await until(async () => (await run('wmctrl', ['-l'], { timeout: 5000 })).stdout,
    windows => !windows.includes(identifier), 'native window closes');
  await releaseSession();
}
async function releaseSession() {
  await request('DELETE', `/session/${sessionId}`).catch(error => console.log(`Session already closed: ${error.message}`));
  sessionId = undefined;
}

try {
  await until(async () => {
    if (driver.exitCode !== null) throw Error(`Driver exited: ${driverLog}`);
    return fetch(endpoint + '/status', { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
  }, Boolean, 'WebDriver starts');
  await launch();
  console.log('Linux: real PTY input, exit and restart');
  await wait('return [...document.querySelectorAll(".pane.visible .pane-head")].every(h => h.textContent.includes("Running"))', 'running shells');
  await shell(0, "printf 'LINUX_READY' > linux-ready.txt");
  await until(() => readFile(join(fixture, 'linux-ready.txt'), 'utf8').catch(e => {
    if (e.code === 'ENOENT') return ''; throw e;
  }), text => text === 'LINUX_READY', 'shell executes input');
  await shell(1, 'exit');
  await wait('return !!document.querySelectorAll(".pane.visible")[1].querySelector(".pane-head.stopped")', 'shell stopped');
  await click('[data-focus-id="restart-s2"]');
  await wait('return !document.querySelectorAll(".pane.visible")[1].querySelector(".pane-head.stopped")', 'shell restarted');

  console.log('Linux: sidebar actions and settings');
  await click('[data-focus-id="session-menu-s"]');
  await click('[role="menuitem"]'); // Rename is the first session action.
  await type('input.title-edit', 'Linux saved session\uE007', true);
  await wait('return document.querySelector("[data-focus-id=session-s]").textContent.includes("Linux saved session")', 'session renamed');
  await click('[data-focus-id="project-p"]');
  assert.equal(await evaluate('return document.querySelectorAll("#projects .session").length'), 0);
  await click('[data-focus-id="project-p"]');
  assert.equal(await evaluate('return document.querySelectorAll("#projects .session").length'), 2);
  await click('#btn-attention');
  await wait('return !!document.querySelector(".sidebar-empty")', 'attention filter');
  await click('#btn-attention');
  await click('#btn-settings');
  await click('#settings-tab-editor');
  await type('#settings-panel-editor input[type=number]', '18', true);
  await click('#settings-panel-editor input[type=checkbox]');
  await click('#overlay button.primary');
  await wait('return !document.querySelector("#settings-tab-editor")', 'settings saved');
  await shell(1, 'exit');
  await wait('return !!document.querySelectorAll(".pane.visible")[1].querySelector(".pane-head.stopped")', 'second shell intentionally stopped');
  await close();
  const checkpoint = await saved();
  assert.equal(checkpoint.sessions.find(s => s.id === 's').title, 'Linux saved session');
  assert.equal(checkpoint.sessions.find(s => s.id === 's2').stopped, true);
  assert.equal(checkpoint.settings.editorFontSize, 18);
  assert.equal(checkpoint.settings.editorWordWrap, true);

  console.log('Linux: relaunch, saved grid/settings, stopped session stays stopped');
  await launch();
  await wait('return document.querySelector(".pane.visible .pane-head").textContent.includes("Running")', 'running session restored');
  assert.equal(await evaluate('return !!document.querySelectorAll(".pane.visible")[1].querySelector(".pane-head.stopped")'), true);
  await shell(0, "printf 'LINUX_RESTORED' > linux-restored.txt");
  await until(() => readFile(join(fixture, 'linux-restored.txt'), 'utf8').catch(e => {
    if (e.code === 'ENOENT') return ''; throw e;
  }), text => text === 'LINUX_RESTORED', 'restored shell executes input');
  await close();
  const recovered = await saved();
  assert.deepEqual(recovered.ui.paneSlots, checkpoint.ui.paneSlots);
  assert.equal(recovered.ui.grid, true);
  assert.deepEqual(recovered.settings, checkpoint.settings);
  assert.deepEqual(recovered.closedSessions, checkpoint.closedSessions);
  assert.deepEqual(recovered.sessions.map(s => [s.id, s.title, s.stopped]), checkpoint.sessions.map(s => [s.id, s.title, s.stopped]));
  await exerciseLinuxCrash({ launch, close, shell, click, type, wait, until,
    saved, releaseSession, fixture, executable, artifacts });
  await writeFile(join(artifacts, 'result.txt'), 'PASS: Linux native PTYs, sidebar, settings, normal and crash recovery\n');
  console.log('PASS: Linux desktop smoke');
} catch (error) {
  if (sessionId) {
    await command('GET', '/screenshot').then(png => writeFile(join(artifacts, 'failure.png'), Buffer.from(png, 'base64'))).catch(() => {});
    await command('GET', '/source').then(html => writeFile(join(artifacts, 'failure.html'), html)).catch(() => {});
  }
  await writeFile(join(artifacts, 'failure.txt'), error.stack);
  await copyFile(statePath, join(artifacts, 'state.json')).catch(() => {});
  throw error;
} finally {
  if (sessionId) await close().catch(() => {});
  if (driver.pid && driver.exitCode === null) {
    try { process.kill(-driver.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await writeFile(join(artifacts, 'driver.log'), driverLog);
}
