import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Shared real-WebView scenario. Never invoke app IPC or mutate CodeMirror internals.
// macOS supplies a modifier-click adapter for its driver's missing pointer flags.
export async function exerciseEditor({ fixture, platform, command, evaluate, wait, until, shell, click, type, modifiedClick }) {
  console.log(`${platform}: terminal link, editor save/dirty/conflict and grid restoration`);
  const file = join(fixture, 'editor-smoke.md');
  await writeFile(file, '# Smoke editor\n');
  await wait('return [...document.querySelectorAll(".pane.visible .pane-head")].every(el => el.textContent.includes("Running"))', 'both shells running before editor');
  const heads = () => evaluate('return [...document.querySelectorAll(".pane.visible .pane-head")].map(el => el.textContent)');
  const originalHeads = await heads();
  assert.equal(originalHeads.length, 2);
  const mod = platform === 'macOS' ? '\uE03D' : '\uE009';
  const keys = actions => command('POST', '/actions', { actions: [{ type: 'key', id: 'editor-keyboard', actions }] });
  const move = (x, y) => command('POST', '/actions', { actions: [{ type: 'pointer', id: 'editor-mouse',
    parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: 'viewport', duration: 0, x, y }] }] });
  // Fixed shell text; no paths from users are interpolated into commands.
  await shell(0, "printf '\\033[2J\\033[H./editor-smoke.md\\n'");
  let point;
  await until(async () => {
    point = await evaluate('const r = document.querySelector(".pane.visible .xterm-screen").getBoundingClientRect(); return { x: Math.round(r.x + 45), y: Math.round(r.y + 8) }');
    // Re-enter after PTY repaint: xterm can cache the line seen by an early hover.
    await move(point.x, point.y + 35);
    await move(point.x, point.y);
    return evaluate('return document.querySelector(".pane.visible .term").title');
  }, Boolean, 'terminal file link resolved');
  if (modifiedClick) {
    await modifiedClick(point);
  } else {
    await keys([{ type: 'keyDown', value: mod }]);
    try {
      await command('POST', '/actions', { actions: [{ type: 'pointer', id: 'editor-mouse',
        parameters: { pointerType: 'mouse' }, actions: [
          { type: 'pointerMove', origin: 'viewport', duration: 0, ...point },
          { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
        ] }] });
    } finally { await keys([{ type: 'keyUp', value: mod }]); }
  }
  await wait('return !!document.querySelector(".text-editor:not([hidden]) .cm-content")', 'editor opens from terminal link');
  assert.equal(await evaluate('return document.querySelectorAll(".pane.visible").length'), 1);
  assert.equal(await evaluate('return document.querySelector(".text-editor-title").textContent'), 'editor-smoke.md');
  // Markdown links open as a rendered preview; switch to editable text.
  const mode = '.text-editor-bar button[aria-pressed]';
  await wait('return document.querySelector(".markdown-preview:not([hidden]) h1")?.textContent === "Smoke editor"', 'markdown preview renders');
  await click(mode);
  await wait('return !!document.querySelector(".text-editor-host:not([hidden])") && !!document.querySelector(".markdown-preview[hidden]")', 'editor switches to editable text');
  const content = '.text-editor .cm-content';
  const save = '.text-editor-bar button:nth-of-type(2)';
  const reload = '.text-editor-bar button:nth-of-type(3)';
  const close = '.text-editor-bar button[aria-label="Close"]';
  const text = () => evaluate('return document.querySelector(".text-editor .cm-content").innerText');
  assert.match(await text(), /# Smoke editor/);
  // Put the caret at the document start after the mode switch. Use keyboard input, not contenteditable clear.
  await keys([{ type: 'keyDown', value: mod }, { type: 'keyDown', value: '\uE011' },
    { type: 'keyUp', value: '\uE011' }, { type: 'keyUp', value: mod }]);
  await type(content, 'Saved edit\uE007');
  await wait(`return !document.querySelector('${save}').disabled`, 'document dirty');
  await keys([{ type: 'keyDown', value: mod }, { type: 'keyDown', value: 's' },
    { type: 'keyUp', value: 's' }, { type: 'keyUp', value: mod }]);
  await until(() => readFile(file, 'utf8'), value => value === 'Saved edit\n# Smoke editor\n', 'editor shortcut writes file');
  await wait(`return document.querySelector('${save}').disabled && !document.querySelector('${reload}').disabled`, 'save finishes');
  await type(content, 'Unsaved edit');
  await click(close);
  await wait('return !!document.querySelector("#overlay .actions button:not(.danger)")', 'discard confirmation');
  await click('#overlay .actions button:not(.danger)');
  assert.match(await text(), /Unsaved edit/);
  assert.equal(await readFile(file, 'utf8'), 'Saved edit\n# Smoke editor\n');

  // An actual external writer changes the fixture; native text_save must refuse
  // to overwrite it even without an OS focus event notifying the editor first.
  const external = '# External revision\n';
  await writeFile(file, external);
  await click(save);
  await wait('return document.querySelector(".text-editor-message").textContent.includes("This file changed on disk")', 'external modification rejected');
  assert.equal(await readFile(file, 'utf8'), external);
  assert.match(await text(), /Unsaved edit/);
  await click(reload);
  await wait('return !!document.querySelector("#overlay .actions button:not(.danger)")', 'reload asks before losing edits');
  await click('#overlay .actions button:not(.danger)');
  assert.match(await text(), /Unsaved edit/);
  await click(reload);
  await wait('return !!document.querySelector("#overlay .actions button.danger")', 'reload discard confirmation');
  await click('#overlay .actions button.danger');
  await until(text, value => value.trim() === external.trim(), 'reload reads external version');
  assert.equal(await evaluate(`return document.querySelector('${save}').disabled`), true);
  // Closing dirty content via Discard must restore exactly the original grid.
  await type(content, 'Discard this');
  await click(close);
  await wait('return !!document.querySelector("#overlay .actions button.danger")', 'close discard confirmation');
  await click('#overlay .actions button.danger');
  await wait('return !!document.querySelector(".text-editor[hidden]") && document.querySelectorAll(".pane.visible").length === 2', 'original grid returns');
  assert.deepEqual(await heads(), originalHeads);
  assert.equal(await readFile(file, 'utf8'), external);
}
