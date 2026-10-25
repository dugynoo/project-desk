import { editShortcuts } from "./actions.ts";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { el } from "./dom.ts";
import { cliChecks } from "./cli-check.ts";
import { t, errorText, LANGUAGES, type Key } from "./i18n.ts";
import { MIN_FONT_SIZE, MAX_FONT_SIZE, CUSTOM_EDITOR, PROVIDERS, PROVIDER_LABEL, settingsDraft, type Provider, type Settings, type EditorInfo } from "./model.ts";
import type { createDialogs } from "./dialogs.ts";

interface SettingsInfo { platform: string; hooksEnabled: boolean; stateFile: string; updates: boolean }

export function createSettings(
  getSettings: () => Settings,
  commit: (settings: Settings, languageChanged: boolean) => void,
  modal: ReturnType<typeof createDialogs>["modal"],
  toast: (message: string) => void,
  checkUpdate: (manual: boolean) => Promise<boolean>,
  installUpdate: () => Promise<void>,
) {
  type EditorPick = Pick<Settings, "editorId" | "customEditorPath" | "customEditorArgs">;

  /**
   * Výber editora: nainštalované editory (z registra / bundle ID / PATH) a „Iný program…“
   * s cestou k programu a argumentmi. Vráti funkciu, ktorá prečíta výber, alebo chybu.
   */
  function editorPicker(box: HTMLElement, st: Settings, info: SettingsInfo, signal: AbortSignal): () => EditorPick | string {
    const select = el("select");
    select.id = "settings-editor";
    select.append(new Option(t("editor.searching"), st.editorId));
    const note = el("div", "note");

    const custom = el("div", "custom-editor");
    const program = el("input");
    program.type = "text";
    program.id = "settings-editor-program";
    program.value = st.customEditorPath;
    program.placeholder = info.platform === "windows" ? "C:\\Program Files\\…\\editor.exe" : "/Applications/Editor.app";
    const browse = el("button", "", t("editor.browse"));
    const programRow = el("div", "input-row");
    programRow.append(program, browse);
    const args = el("input");
    args.type = "text";
    args.id = "settings-editor-args";
    args.value = st.customEditorArgs;
    const programLabel = el("label", "", t("editor.program")); programLabel.htmlFor = program.id;
    const argsLabel = el("label", "", t("editor.args")); argsLabel.htmlFor = args.id;
    custom.append(
      programLabel,
      programRow,
      argsLabel,
      args,
      el("div", "note", t("editor.argsNote")),
    );
    const editorLabel = el("label", "", t("editor.label")); editorLabel.htmlFor = select.id;
    box.append(editorLabel, select, note, custom);

    const sync = () => {
      custom.hidden = select.value !== CUSTOM_EDITOR;
    };
    select.onchange = sync;
    browse.onclick = async () => {
      const picked = await openDialog({
        multiple: false,
        title: t("editor.pickTitle"),
        filters: info.platform === "windows" ? [{ name: t("editor.programs"), extensions: ["exe", "com"] }] : undefined,
      });
      if (!signal.aborted && typeof picked === "string") program.value = picked;
    };
    for (const [input, key] of [[select, "editor.label"], [program, "editor.program"], [args, "editor.args"]] as const) {
      input.setAttribute("aria-label", t(key));
    }
    sync();

    invoke<EditorInfo[]>("list_editors")
      .then((found) => {
        if (signal.aborted) return;
        select.replaceChildren();
        for (const f of found) select.append(new Option(f.label, f.id));
        const known = st.editorId === "" || st.editorId === CUSTOM_EDITOR || found.some((f) => f.id === st.editorId);
        if (!known) select.append(new Option(t("editor.notFound", { id: st.editorId }), st.editorId));
        select.append(new Option(t("editor.other"), CUSTOM_EDITOR));
        select.value = st.editorId || found[0]?.id || CUSTOM_EDITOR;
        sync();
        note.textContent = t(found.length ? "editor.lineNote" : "editor.noneFound");
      })
      .catch((e) => { if (!signal.aborted) note.textContent = errorText(e); });

    return () => {
      if (select.value !== CUSTOM_EDITOR) {
        return { editorId: select.value, customEditorPath: st.customEditorPath, customEditorArgs: st.customEditorArgs };
      }
      const path = program.value.trim().replace(/^"(.*)"$/, "$1");
      if (!path) return t("err.editor.needProgram");
      return { editorId: CUSTOM_EDITOR, customEditorPath: path, customEditorArgs: args.value.trim() || "%TARGET_PATH%" };
    };
  }


  function openSettings(info: SettingsInfo, keyboard = false) {
    const st = getSettings();
    let shortcuts = { ...st.shortcuts };
    modal(
      (box, close, signal) => {
        box.classList.add("settings-modal");
        const title = el("h3", "", t("settings.title"));
        title.id = "settings-title";
        box.setAttribute("aria-labelledby", title.id);
        const tabs = el("div", "settings-tabs");
        tabs.setAttribute("role", "tablist");
        tabs.setAttribute("aria-label", t("settings.title"));
        const content = el("div", "settings-content");
        const panels: HTMLElement[] = [], buttons: HTMLButtonElement[] = [];
        const activate = (index: number) => {
          panels.forEach((panel, i) => { panel.hidden = i !== index; });
          buttons.forEach((button, i) => {
            button.setAttribute("aria-selected", String(i === index));
            button.tabIndex = i === index ? 0 : -1;
          });
          content.scrollTop = 0;
        };
        const page = (id: string, key: Key) => {
          const index = panels.length;
          const button = el("button", "", t(key));
          button.id = `settings-tab-${id}`;
          button.setAttribute("role", "tab");
          button.setAttribute("aria-controls", `settings-panel-${id}`);
          button.onclick = () => activate(index);
          button.onkeydown = e => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
              : (index + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
            activate(next); buttons[next].focus();
          };
          const panel = el("section", "settings-panel");
          panel.id = `settings-panel-${id}`;
          panel.setAttribute("role", "tabpanel");
          panel.setAttribute("aria-labelledby", button.id);
          panels.push(panel); buttons.push(button); tabs.append(button); content.append(panel);
          return panel;
        };
        const general = page("general", "settings.general");
        const display = page("display", "settings.display");
        const agents = page("agents", "settings.agents");
        const editors = page("editor", "settings.editorTab");
        const about = page("about", "settings.about");
        about.tabIndex = 0;
        box.append(title, tabs, content);
        let fieldId = 0;
        const field = (parent: HTMLElement, label: string, value: string, placeholder = "") => {
          const input = el("input");
          input.type = "text";
          input.value = value;
          input.placeholder = placeholder;
          input.id = `settings-field-${++fieldId}`;
          const caption = el("label", "", label); caption.htmlFor = input.id;
          parent.append(caption, input);
          return input;
        };
        const keys = el("button", "", t("actions.shortcuts"));
        keys.id = "edit-shortcuts";
        keys.onclick = () => editShortcuts(box, shortcuts, info.platform === "macos", value => { shortcuts = value; });
        general.append(el("p", "note", t("settings.saveHint")));
        const fontSize = el("input");
        fontSize.id = "terminal-font-size";
        fontSize.type = "number";
        fontSize.min = String(MIN_FONT_SIZE);
        fontSize.max = String(MAX_FONT_SIZE);
        fontSize.step = "1";
        fontSize.value = String(st.fontSize);
        const fontLabel = el("label", "", t("settings.fontSize"));
        fontLabel.htmlFor = fontSize.id;
        display.append(fontLabel, fontSize);
        const gitBranch = el("input");
        gitBranch.type = "checkbox";
        gitBranch.id = "show-git-branch";
        gitBranch.checked = st.showGitBranch;
        const gitLabel = el("label", "check");
        gitLabel.append(gitBranch, document.createTextNode(t("settings.gitBranch")));
        display.append(gitLabel, el("div", "note", t("settings.gitBranchNote")));
        const language = el("select");
        for (const l of LANGUAGES) language.append(new Option(l.label, l.id, false, l.id === st.language));
        language.id = "settings-language";
        const languageLabel = el("label", "", t("settings.language")); languageLabel.htmlFor = language.id;
        general.append(languageLabel, language);
        const defaultProvider = el("select");
        defaultProvider.id = "default-provider";
        for (const p of PROVIDERS) defaultProvider.append(new Option(PROVIDER_LABEL[p], p, false, p === st.defaultProvider));
        const defaultLabel = el("label", "", t("settings.defaultProvider"));
        defaultLabel.htmlFor = defaultProvider.id;
        general.append(defaultLabel, defaultProvider);
        const claude = field(agents, t("settings.claude"), st.claudeCommand, "claude");
        const codex = field(agents, t("settings.codex"), st.codexCommand, "codex");
        const codexResume = field(agents, t("settings.codexResume"), st.codexResumeCommand, "codex resume");
        const antigravity = field(agents, t("settings.antigravity"), st.antigravityCommand, "agy");
        agents.append(el("div", "note", t("info.noteAntigravity")));
        const shell = field(agents, t("settings.shell"), st.shell, info.platform === "windows" ? "powershell.exe" : "$SHELL");
        cliChecks(agents, [claude, codex, antigravity], shell, signal);
        const editor = editorPicker(editors, st, info, signal);
        const systemExts = field(editors, t("settings.systemOpen"), st.systemOpenExts, "html pdf png");
        editors.append(el("div", "note", t("settings.systemOpenNote")));
        const notifLabel = el("label", "check");
        const notif = el("input");
        notif.type = "checkbox";
        notif.checked = st.notifications;
        notifLabel.append(notif, document.createTextNode(t("settings.notifications")));
        const resumeLabel = el("label", "check");
        const resume = el("input");
        resume.type = "checkbox";
        resume.checked = st.autoResume;
        resumeLabel.append(resume, document.createTextNode(t("settings.autoResume")));
        general.append(notifLabel, resumeLabel, keys);
        about.append(
          el(
            "div",
            "note",
            `${t(info.hooksEnabled ? "settings.hooksOn" : "settings.hooksOff")} ${t("settings.footer", { file: info.stateFile })}`,
          ),
        );
        const save_ = el("button", "primary", t("common.save"));
        const cancel = el("button", "", t("common.cancel"));
        const actions = el("div", "actions");
        if (info.updates) {
          const checkBtn = el("button", "left", t("update.check"));
          checkBtn.onclick = async () => {
            checkBtn.disabled = true;
            checkBtn.textContent = t("update.checking");
            try {
              const available = await checkUpdate(true);
              if (signal.aborted) return;
              if (available) {
                close();
                return installUpdate();
              }
            } finally {
              if (!signal.aborted) {
                checkBtn.disabled = false;
                checkBtn.textContent = t("update.check");
              }
            }
          };
          about.append(checkBtn);
        }
        actions.append(cancel, save_);
        box.append(actions);
        cancel.onclick = close;
        save_.onclick = () => {
          if (!fontSize.value || !fontSize.checkValidity()) {
            activate(1); fontSize.focus(); fontSize.reportValidity(); return;
          }
          const draft = settingsDraft(st, {
            fontSize: Number(fontSize.value),
            showGitBranch: gitBranch.checked,
            shortcuts,
            defaultProvider: defaultProvider.value as Provider,
            antigravityCommand: antigravity.value.trim() || "agy",
            claudeCommand: claude.value.trim() || "claude",
            codexCommand: codex.value.trim() || "codex",
            codexResumeCommand: codexResume.value.trim() || "codex resume",
            shell: shell.value.trim(),
            systemOpenExts: systemExts.value.trim(),
            notifications: notif.checked,
            autoResume: resume.checked,
            language: language.value,
          }, editor());
          if (typeof draft === "string") { activate(3); editors.querySelector("input")?.focus(); return toast(draft); }
          const langChanged = st.language !== draft.language;
          commit(draft, langChanged);
          close();
        };
        activate(0);
        if (keyboard) keys.click(); else buttons[0].focus();
      },
      () => {},
    );
  }

  return openSettings;
}
