import assert from 'node:assert/strict';
import { readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processStat, sameLiveProcess } from './linux-process.mjs';

export async function exerciseLinuxCrash({ launch, close, shell, click, type, wait, until,
  saved, releaseSession, fixture, executable, artifacts }) {
  const optionalFile = name => readFile(join(fixture, name), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  const ready = async () => {
    await wait('return document.querySelector(".pane.visible .pane-head").textContent.includes("Running")', 'restored running shell');
    await wait('return !!document.querySelectorAll(".pane.visible")[1].querySelector(".pane-head.stopped")', 'intentionally stopped shell');
  };
  console.log('Linux crash: ordinary save, real foreground child, SIGKILL of app only');
  await launch();
  await ready();
  await click('[data-focus-id="session-menu-s"]');
  await click('[role="menuitem"]');
  await type('input.title-edit', 'Linux crash checkpoint\uE007', true);
  // Observe the ordinary debounced save. No close handler or test IPC flush.
  const checkpoint = await until(saved, state =>
    state.sessions.find(s => s.id === 's')?.title === 'Linux crash checkpoint', 'crash checkpoint saved');
  assert.equal(checkpoint.sessions.find(s => s.id === 's').stopped, false);
  assert.equal(checkpoint.sessions.find(s => s.id === 's2').stopped, true);

  // Only constant fixture commands. The foreground child has a finite lifetime
  // even if cleanup regresses. No traps or runner-side child kills mask failure.
  await shell(0, `printf '%s\\n' "$$" > crash-shell.pid; bash -c 'echo $$ > crash-child.pid; exec sleep 120'`);
  const pids = await until(async () => Promise.all(['crash-shell.pid', 'crash-child.pid'].map(optionalFile)),
    values => values.every(value => /^\d+\n$/.test(value)), 'shell and child PID files');
  const processes = await Promise.all(pids.map(value => processStat(Number(value.trim()))));
  assert.ok(processes.every(Boolean), 'Both PTY processes must exist before crash');
  const [terminal, child] = processes;
  assert.equal(child.parent, terminal.pid);
  assert.notEqual(child.pid, terminal.pid);
  const app = await processStat(terminal.parent);
  assert.ok(app && sameLiveProcess(app, app), 'Parent application is alive');
  assert.equal(await readlink(`/proc/${app.pid}/exe`), executable, 'Only kill our copied executable');
  for (const identity of processes) {
    assert.ok(sameLiveProcess(identity, await processStat(identity.pid)), 'PTY process alive before crash');
  }
  await writeFile(join(artifacts, 'crash-processes.json'), JSON.stringify({ app, processes }, null, 2));
  assert.ok(sameLiveProcess(app, await processStat(app.pid)), 'Application identity unchanged');
  process.kill(app.pid, 'SIGKILL');
  // Check BEFORE WebDriver session deletion: driver cleanup must not make this pass.
  await until(async () => Promise.all([app, ...processes].map(async identity => ({
    ...identity, current: await processStat(identity.pid),
  }))), values => values.every(value => !sameLiveProcess(value, value.current)), 'app and PTY processes exit after crash');
  const crashed = await saved();
  assert.deepEqual(crashed.sessions, checkpoint.sessions);
  assert.deepEqual(crashed.closedSessions, checkpoint.closedSessions);
  await releaseSession();

  console.log('Linux crash: relaunch same fixture, lock release and usable restored shell');
  await launch();
  await ready();
  await wait('return document.querySelector("[data-focus-id=session-s]").textContent.includes("Linux crash checkpoint")', 'crash checkpoint title restored');
  await shell(0, "printf 'CRASH_RESTORED' > linux-crash-restored.txt");
  await until(() => optionalFile('linux-crash-restored.txt'), text => text === 'CRASH_RESTORED', 'shell usable after crash');
  await close();
  const recovered = await saved();
  assert.deepEqual(recovered.ui.paneSlots, checkpoint.ui.paneSlots);
  assert.equal(recovered.ui.grid, checkpoint.ui.grid);
  assert.deepEqual(recovered.settings, checkpoint.settings);
  assert.deepEqual(recovered.closedSessions, checkpoint.closedSessions);
  assert.deepEqual(recovered.sessions.map(s => [s.id, s.title, s.stopped]),
    checkpoint.sessions.map(s => [s.id, s.title, s.stopped]));
}
