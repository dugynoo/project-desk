import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function eventually(read, accepts, description) {
  const deadline = Date.now() + 15_000;
  while (true) {
    const value = await read();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function exerciseCrashRecovery({ launch, close, crash, checkProcesses, fixture, statePath }) {
  console.log('Crash: save checkpoint, start descendant, terminate app without close handlers');
  const saved = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const optionalFile = async name => readFile(join(fixture, name), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  let page = await launch();
  const ready = async () => {
    await page.waitForFunction(() => document.querySelectorAll('.pane.visible').length === 2 &&
      document.querySelector('.pane.visible .pane-head')?.textContent.includes('Running'));
    await page.locator('.pane.visible').nth(1).locator('.pane-head.stopped').waitFor();
  };
  const command = async text => {
    await page.locator('.pane.visible').first().locator('textarea').focus();
    await page.keyboard.insertText(text); await page.keyboard.press('Enter');
  };
  await ready();
  await page.locator('[data-focus-id="session-s"]').dblclick();
  await page.locator('input.title-edit').fill('Crash recovery checkpoint');
  await page.locator('input.title-edit').press('Enter');
  // Wait for the ordinary debounce to reach disk; no close handler or test IPC flush.
  const checkpoint = await eventually(saved,
    state => state.sessions.find(s => s.id === 's')?.title === 'Crash recovery checkpoint', 'saved rename');
  assert.equal(checkpoint.sessions.find(s => s.id === 's').stopped, false);
  assert.equal(checkpoint.sessions.find(s => s.id === 's2').stopped, true);
  // A finite child prevents an endless orphan even if the cleanup regression fires.
  // Record exact identities from inside the actual PTY, not a process-name search.
  await command("$pdChild = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep 120' -WindowStyle Hidden -PassThru; $pdSelf = Get-Process -Id $PID; @($pdSelf, $pdChild) | ForEach-Object { @{ id = $_.Id; started = $_.StartTime.ToUniversalTime().Ticks.ToString() } } | ConvertTo-Json -Compress | Set-Content -LiteralPath crash-processes.json -Encoding UTF8");
  const raw = await eventually(() => optionalFile('crash-processes.json'), text => text.trim().endsWith(']'), 'PTY process identities');
  const processes = JSON.parse(raw.replace(/^\uFEFF/, ''));
  assert.equal(processes.length, 2);
  assert.notEqual(processes[0].id, processes[1].id);
  await checkProcesses(processes, false);
  await crash();
  await checkProcesses(processes, true);
  const crashed = await saved();
  assert.deepEqual(crashed.sessions, checkpoint.sessions);
  assert.deepEqual(crashed.closedSessions, checkpoint.closedSessions);

  console.log('Crash: relaunch same state, verify lock release, restored shell and stopped session');
  page = await launch();
  await ready();
  await page.locator('[data-focus-id="session-s"]').getByText('Crash recovery checkpoint').waitFor();
  await command("Write-Output 'CRASH_RESTORED' | Set-Content -LiteralPath crash-restored.txt");
  await eventually(() => optionalFile('crash-restored.txt'), text => text.includes('CRASH_RESTORED'), 'restored shell executes input');
  await close();
  const recovered = await saved();
  assert.deepEqual(recovered.ui.paneSlots, checkpoint.ui.paneSlots);
  assert.equal(recovered.ui.grid, checkpoint.ui.grid);
  assert.deepEqual(recovered.settings, checkpoint.settings);
  assert.deepEqual(recovered.closedSessions, checkpoint.closedSessions);
  assert.deepEqual(recovered.sessions.map(s => s.id), checkpoint.sessions.map(s => s.id));
  assert.equal(recovered.sessions.find(s => s.id === 's2').stopped, true);
  assert.equal(await optionalFile('editor-smoke.md'), 'Saved edit\n# Smoke editor\n');
}
