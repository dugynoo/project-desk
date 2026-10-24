import { el } from "./dom.ts";
import { t } from "./i18n.ts";
import { applyPanePreset, savePanePreset, type PersistedState } from "./model.ts";

export function showSavedLayouts(
  state: PersistedState,
  modal: (build: (box: HTMLElement, close: () => void) => void, onClose: () => void) => void,
  save: () => void,
  restore: () => void,
) {
  modal((box, close) => {
    box.append(el("h3", "", t("layouts.title")), el("p", "hint", t("layouts.help")));
    const form = el("form", "layout-create");
    const name = el("input");
    name.type = "text";
    name.maxLength = 80;
    name.placeholder = t("layouts.name");
    name.setAttribute("aria-label", t("layouts.name"));
    const add = el("button", "primary", t("layouts.saveNew"));
    add.type = "submit";
    add.disabled = true;
    name.oninput = () => { add.disabled = !name.value.trim(); };
    form.append(name, add);
    const list = el("div", "saved-layout-list");
    const draw = () => {
      list.replaceChildren();
      for (const preset of state.savedLayouts) {
        const row = el("div", "saved-layout-row");
        const title = el("input");
        title.type = "text";
        title.value = preset.name;
        title.maxLength = 80;
        title.setAttribute("aria-label", t("layouts.name"));
        title.onchange = () => {
          if (title.value.trim()) preset.name = title.value.trim();
          title.value = preset.name;
          save();
        };
        const info = el("p", "hint", `${t(`panes.${preset.paneLayout}`)} · ${preset.paneSlots.length}`);
        const actions = el("div", "actions");
        const load = el("button", "primary", t("layouts.open"));
        load.onclick = () => { applyPanePreset(state, preset.id); close(); restore(); };
        const update = el("button", "", t("layouts.update"));
        update.onclick = () => { savePanePreset(state, preset.id, title.value || preset.name); save(); draw(); };
        const remove = el("button", "danger", t("layouts.delete"));
        remove.onclick = () => {
          if (remove.dataset.confirm !== "yes") {
            remove.dataset.confirm = "yes";
            remove.textContent = t("layouts.confirmDelete");
            return;
          }
          state.savedLayouts = state.savedLayouts.filter(item => item.id !== preset.id);
          save(); draw();
        };
        actions.append(load, update, remove);
        row.append(title, info, actions);
        list.append(row);
      }
      if (!state.savedLayouts.length) list.append(el("p", "hint", t("layouts.empty")));
    };
    form.onsubmit = event => {
      event.preventDefault();
      if (savePanePreset(state, crypto.randomUUID(), name.value)) {
        save(); name.value = ""; add.disabled = true; draw(); name.focus();
      }
    };
    const done = el("button", "", t("common.close"));
    done.onclick = close;
    const footer = el("div", "actions");
    footer.append(done);
    box.append(form, list, footer);
    draw(); name.focus();
  }, () => {});
}
