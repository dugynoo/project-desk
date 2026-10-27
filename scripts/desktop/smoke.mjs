import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function exerciseDesktop({ launch, close, fixture, statePath }) {
  console.log('Smoke: shell startup, exit and restart');
  let page = await launch();
  const wait = expression => page.waitForFunction(expression);
  const panes = () => page.locator('.pane.visible');
  const command = async (index, text) => {
    const input = panes().nth(index).locator('textarea');
    await input.focus(); await page.keyboard.insertText(text); await page.keyboard.press('Enter');
  };
  const saved = async () => JSON.parse(await readFile(statePath, 'utf8'));
  await wait(() => document.querySelectorAll('.pane.visible').length === 2);
  await wait(() => [...document.querySelectorAll('.pane.visible .pane-head')].every(head => head.textContent.includes('Running')));
  await command(1, 'exit');
  await panes().nth(1).locator('.pane-head.stopped').waitFor();
  await panes().nth(1).getByRole('button', { name: 'Start again / resume conversation' }).click();
  await wait(() => !document.querySelectorAll('.pane.visible')[1].querySelector('.pane-head.stopped'));
  console.log('Smoke: terminal search opens, finds output and returns focus');
  await command(0, "Write-Output 'PD_SEARCH_FIXTURE'");
  await page.keyboard.press('Control+Shift+f');
  const search = panes().first().locator('.search-bar');
  await search.waitFor({ state: 'visible' });
  await search.locator('input').fill('PD_SEARCH_FIXTURE');
  await wait(() => /\d+\/\d+/.test(document.querySelector('.pane.visible .search-bar .count')?.textContent ?? ''));
  await search.locator('input').press('Escape');
  await search.waitFor({ state: 'hidden' });
  assert.equal(await panes().first().locator('textarea').evaluate(el => el === document.activeElement), true);
  console.log('Smoke: oversized terminal paste reports an error and leaves the UI usable');
  // Exercise xterm's paste listener and the real native input queue, without
  // changing the user's clipboard or adding application-only test APIs.
  await panes().first().locator('textarea').evaluate(input => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'x'.repeat(1024 * 1024 + 1));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.locator('.toast').filter({ hasText: 'exceeds the 1 MiB terminal input limit' }).waitFor();
  console.log('Smoke: sidebar rename, keyboard menu, collapse and attention filter');
  await page.locator('[data-focus-id="session-s"]').dblclick();
  await page.locator('input.title-edit').fill('Local development');
  await page.locator('input.title-edit').press('Enter');
  await page.locator('[data-focus-id="session-s"]').getByText('Local development').waitFor();
  // A late terminal focus on the CI runner can take the key; retry until the keyboard opens the menu.
  for (let attempt = 1; ; attempt++) {
    await page.locator('[data-focus-id="session-menu-s"]').focus();
    await page.keyboard.press('ArrowDown');
    try { await page.getByRole('menu').waitFor({ timeout: 5000 }); break; } catch (error) { if (attempt === 3) throw error; }
  }
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await page.locator('[data-focus-id="project-p"]').press('Enter');
  assert.equal(await page.locator('#projects .session').count(), 0);
  await page.locator('[data-focus-id="project-p"]').press('Enter');
  assert.equal(await page.locator('#projects .session').count(), 2);
  await page.locator('#btn-attention').click();
  await page.locator('.sidebar-empty').waitFor();
  await page.locator('#btn-attention').click();
  assert.equal(await page.locator('#projects .session').count(), 2);
  // Opening a real xterm link exercises link resolution, lazy editor loading and grid ownership.
  console.log('Smoke: terminal link and editor');
  await command(0, "Write-Host (([char]27)+'[2J'+([char]27)+'[H') -NoNewline; Write-Host './editor-smoke.md'");
  const screen = panes().first().locator('.xterm-screen');
  let bounds;
  // PTY output can repaint under the pointer. Re-enter the line until xterm has
  // resolved its file link; one early hover can otherwise cache the old contents.
  const hoverDeadline = Date.now() + 15_000;
  while (!await panes().first().locator('.term').getAttribute('title')) {
    if (Date.now() > hoverDeadline) {
      console.log(await page.evaluate(({ x, y }) => ({ hit: document.elementFromPoint(x + 45, y + 8)?.outerHTML.slice(0, 300),
        terms: [...document.querySelectorAll('.term')].map(t => ({ title: t.title, rect: t.getBoundingClientRect().toJSON() })) }), bounds));
      throw Error(`Terminal file link did not become interactive: ${JSON.stringify(bounds)}`);
    }
    bounds = await screen.boundingBox();
    await page.mouse.move(bounds.x + 45, bounds.y + 45);
    await page.mouse.move(bounds.x + 45, bounds.y + 8);
    await page.waitForFunction(() => !!document.querySelector('.pane.visible .term')?.title,
      null, { timeout: 1000 }).catch(error => { if (error.name !== 'TimeoutError') throw error; });
  }
  await page.keyboard.down('Control');
  await page.mouse.click(bounds.x + 45, bounds.y + 8); await page.keyboard.up('Control');
  const editor = page.locator('.text-editor');
  await editor.waitFor({ state: 'visible' });
  assert.equal(await panes().count(), 1);
  if (process.env.PROJECT_DESK_SCREENSHOT) {
    await command(0, "function prompt { 'demo> ' }; Clear-Host; Write-Output 'Project Desk - local shell and built-in editor'");
    await page.waitForTimeout(500);
    await page.screenshot({ path: process.env.PROJECT_DESK_SCREENSHOT });
  }
  // Markdown links open as a rendered preview; switch to editable text.
  await editor.locator('.markdown-preview h1', { hasText: 'Smoke editor' }).waitFor();
  await editor.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.locator('.cm-content').click(); await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('Saved edit\n');
  await editor.getByRole('button', { name: 'Save', exact: true }).and(page.locator(':enabled')).waitFor();
  await page.keyboard.press('Control+s');
  await editor.getByRole('button', { name: 'Save', exact: true }).waitFor();
  // Save is disabled both during the native write and after success. Reload
  // becomes enabled again only after that write has actually completed.
  await wait(() => {
    const [save, reload] = document.querySelectorAll('.text-editor-bar button:not([aria-pressed])');
    return save.disabled && !reload.disabled;
  });
  assert.equal(await readFile(join(fixture, 'editor-smoke.md'), 'utf8'), 'Saved edit\n# Smoke editor\n');
  await page.keyboard.insertText('Unsaved edit');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#overlay').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.match(await editor.locator('.cm-content').innerText(), /Unsaved edit/);
  await page.locator('#btn-settings').click(); await page.locator('#settings-tab-editor').click();
  await page.locator('#file-editor').selectOption('external');
  await page.locator('#settings-panel-editor input[type=number]').fill('18');
  await page.locator('#settings-panel-editor input[type=checkbox]').check();
  await page.locator('#overlay').getByRole('button', { name: 'Save', exact: true }).click();
  await wait(() => getComputedStyle(document.querySelector('.cm-editor')).fontSize === '18px');
  assert.match(await editor.locator('.cm-content').getAttribute('class'), /cm-lineWrapping/);
  assert.match(await editor.locator('.cm-content').innerText(), /Unsaved edit/);
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#overlay').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await wait(() => document.querySelectorAll('.pane.visible').length === 2);
  await command(1, 'exit');
  await panes().nth(1).locator('.pane-head.stopped').waitFor();
  await close();
  console.log('Smoke: persisted state and application relaunch');
  const before = await saved();
  assert.equal(before.sessions.find(s => s.id === 's2').stopped, true);
  assert.equal(before.sessions.find(s => s.id === 's').title, 'Local development');
  assert.equal(before.settings.editorFontSize, 18);
  assert.equal(before.settings.fileEditor, 'external');
  page = await launch();
  await wait(() => document.querySelectorAll('.pane.visible').length === 2);
  await wait(() => document.querySelector('.pane.visible .pane-head').textContent.includes('Running'));
  await panes().nth(1).locator('.pane-head.stopped').waitFor();
  assert.equal(await panes().first().locator('.pane-head.stopped').count(), 0);
  // Prove the auto-restored shell accepts input, not merely that a pane is visible.
  await command(0, "Write-Output 'RESTORED' | Set-Content -LiteralPath restored.txt");
  const deadline = Date.now() + 15_000;
  while (true) {
    if (await readFile(join(fixture, 'restored.txt'), 'utf8').then(t => t.includes('RESTORED')).catch(() => false)) break;
    if (Date.now() > deadline) throw Error('Restored shell did not execute input');
    await new Promise(r => setTimeout(r, 100));
  }
  await close();
  const after = await saved();
  assert.deepEqual(after.ui.paneSlots, before.ui.paneSlots);
  assert.equal(after.settings.editorWordWrap, true);
  assert.equal(after.sessions.length, 2);
  assert.equal(await readFile(join(fixture, 'editor-smoke.md'), 'utf8'), 'Saved edit\n# Smoke editor\n');
}
