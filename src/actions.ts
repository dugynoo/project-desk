import { el } from './dom.ts';
import { t, type Key } from './i18n.ts';
import { ACTION_IDS, bindingFor, bindingFromEvent, shortcutConflict, type ActionId, type Shortcuts } from './model.ts';
import type { createDialogs } from './dialogs.ts';

export function actionLabel(id: ActionId): string {
  if (id.startsWith('session')) return id === 'session9' ? t('actions.last') : t('actions.session', { n: id.slice(7) });
  if (['claude', 'codex', 'antigravity', 'shell'].includes(id)) return t('actions.new', { provider: { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', shell: 'Shell' }[id as 'claude' | 'codex' | 'antigravity' | 'shell']! });
  const labels: Partial<Record<ActionId, Key>> = {
    fontIncrease: 'actions.fontIncrease', fontDecrease: 'actions.fontDecrease', fontReset: 'actions.fontReset',
    palette: 'actions.palette', shortcuts: 'actions.shortcuts', switch: 'html.switch', grid: 'html.grid',
    search: 'actions.search', templates: 'html.templates', attention: 'attention.next', zoom: 'actions.zoom',
    settings: 'settings.title', layouts: 'layouts.title', notifications: 'notifications.title',
    history: 'session.history', editor: 'actions.editor', addProject: 'html.addProject', sidebar: 'sidebar.autoHide',
  };
  return t(labels[id]!, { n: '' }).replace(/\s*\(\s*\)$/, '');
}
export const bindingLabel = (value: string, mac: boolean) => value.replace('Mod', mac ? 'Cmd' : 'Ctrl').replace('Plus', '+').replace('Minus', '-');

/** A settings subview: retain the actual parent inputs, including unsaved edits. */
export function editShortcuts(box: HTMLElement, current: Shortcuts, mac: boolean, done: (value: Shortcuts) => void) {
  const previous = document.createDocumentFragment();
  previous.append(...Array.from(box.childNodes));
  let draft = { ...current };
  const back = (value: Shortcuts) => { box.replaceChildren(previous); done(value); box.querySelector<HTMLButtonElement>('#edit-shortcuts')?.focus(); };
  const heading = el('h3', '', t('actions.shortcuts'));
  heading.id = 'settings-title';
  box.append(heading, el('p', 'note', t('keys.help')));
  const filter = el('input');
  filter.placeholder = t('actions.find');
  filter.setAttribute('aria-label', t('actions.find'));
  const list = el('div', 'shortcut-list');
  const message = el('div', 'note');
  message.setAttribute('role', 'status');
  const finish = el('button', 'primary', t('keys.done'));
  const draw = () => {
    list.replaceChildren();
    for (const id of ACTION_IDS.filter(id => actionLabel(id).toLocaleLowerCase().includes(filter.value.toLocaleLowerCase()))) {
      const row = el('div', 'shortcut-row');
      const label = el('span', '', actionLabel(id));
      const record = el('button', 'shortcut-record', bindingLabel(bindingFor(id, draft), mac) || t('keys.none'));
      record.setAttribute('aria-label', `${actionLabel(id)}: ${record.textContent}`);
      record.onclick = () => { record.textContent = t('keys.record'); record.dataset.recording = 'true'; };
      record.onblur = () => { record.dataset.recording = ''; record.textContent = bindingLabel(bindingFor(id, draft), mac) || t('keys.none'); };
      record.onkeydown = e => {
        if (record.dataset.recording !== 'true' || e.key === 'Tab' || e.key === 'Escape') return;
        e.preventDefault(); e.stopPropagation();
        if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return;
        const value = bindingFromEvent(e);
        if (!value) { message.textContent = t('keys.invalid'); return; }
        const other = ACTION_IDS.find(other => other !== id && bindingFor(other, draft) === value);
        if (other) { message.textContent = t('keys.conflict', { name: actionLabel(other) }); return; }
        draft[id] = value; message.textContent = ''; record.blur(); draw();
      };
      const disable = el('button', '', t('keys.disable'));
      disable.onclick = () => { draft[id] = ''; message.textContent = ''; draw(); };
      const reset = el('button', '', t('keys.reset'));
      reset.onclick = () => {
        const next = { ...draft }; delete next[id];
        const conflict = shortcutConflict(next);
        if (conflict) { message.textContent = t('keys.conflict', { name: actionLabel(conflict) }); return; }
        draft = next; message.textContent = ''; draw();
      };
      row.append(label, record, disable, reset); list.append(row);
    }
  };
  filter.oninput = draw;
  const resetAll = el('button', '', t('keys.resetAll'));
  resetAll.onclick = () => { draft = {}; message.textContent = ''; draw(); };
  const cancel = el('button', '', t('common.cancel')); cancel.onclick = () => back(current);
  finish.onclick = () => back(draft);
  const footer = el('div', 'actions'); footer.append(resetAll, cancel, finish);
  box.append(filter, list, message, footer); draw(); filter.focus();
}

export interface PaletteAction { id: ActionId; enabled: boolean; run: () => void }
export function showPalette(modal: ReturnType<typeof createDialogs>['modal'], actions: PaletteAction[], bindings: Shortcuts, mac: boolean, context: string) {
  modal((box, close) => {
    box.append(el('h3', '', t('actions.palette')), el('p', 'note', context));
    const input = el('input'); input.placeholder = t('actions.find');
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', t('actions.find'));
    input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'palette-results'); input.setAttribute('aria-autocomplete', 'list');
    const list = el('div', 'palette-list'); list.id = 'palette-results'; list.setAttribute('role', 'listbox');
    let selected = 0;
    let results: PaletteAction[] = [];
    const run = (action: PaletteAction) => { close(); action.run(); };
    const draw = () => {
      results = actions.filter(a => a.enabled && actionLabel(a.id).toLocaleLowerCase().includes(input.value.toLocaleLowerCase()));
      selected = Math.max(0, Math.min(selected, results.length - 1)); list.replaceChildren();
      results.forEach((action, index) => {
        const row = el('div', 'palette-option'); row.id = `action-${action.id}`;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected));
        row.append(el('span', '', actionLabel(action.id)), el('kbd', '', bindingLabel(bindingFor(action.id, bindings), mac)));
        row.onmousedown = e => e.preventDefault(); row.onclick = () => run(action); list.append(row);
      });
      if (!results.length) { list.append(el('p', 'note', t('actions.empty'))); input.removeAttribute('aria-activedescendant'); }
      else { input.setAttribute('aria-activedescendant', `action-${results[selected].id}`); list.children[selected]?.scrollIntoView({ block: 'nearest' }); }
    };
    input.oninput = () => { selected = 0; draw(); };
    input.onkeydown = e => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); selected += e.key === 'ArrowDown' ? 1 : -1; draw(); }
      if (e.key === 'Enter') { e.preventDefault(); if (results[selected]) run(results[selected]); }
    };
    const cancel = el('button', '', t('common.cancel')); cancel.onclick = close;
    box.append(input, list, cancel); draw(); input.focus();
  }, () => {});
}
