import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { el } from "./dom.ts";
import { cliChecks } from "./cli-check.ts";
import { t, errorText, LANGUAGES } from "./i18n.ts";
import { CUSTOM_EDITOR, PROVIDERS, PROVIDER_LABEL, settingsDraft, type Provider, type Settings, type EditorInfo } from "./model.ts";
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
    select.append(new Option(t("editor.searching"), st.editorId));
    const note = el("div", "note");

    const custom = el("div", "custom-editor");
    const program = el("input");
    program.type = "text";
    program.value = st.customEditorPath;
    program.placeholder = info.platform === "windows" ? "C:\\Program Files\\…\\editor.exe" : "/Applications/Editor.app";
    const browse = el("button", "", t("editor.browse"));
    const programRow = el("div", "input-row");
    programRow.append(program, browse);
    const args = el("input");
    args.type = "text";
    args.value = st.customEditorArgs;
    custom.append(
      el("label", "", t("editor.program")),
      programRow,
      el("label", "", t("editor.args")),
      args,
      el("div", "note", t("editor.argsNote")),
    );
    box.append(el("label", "", t("editor.label")), select, note, custom);

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


  function openSettings(info: SettingsInfo) {
    const st = getSettings();
    modal(
      (box, close, signal) => {
        const field = (label: string, value: string, placeholder = "") => {
          const input = el("input");
          input.type = "text";
          input.value = value;
          input.placeholder = placeholder;
          box.append(el("label", "", label), input);
          return input;
        };
        box.append(el("h3", "", t("settings.title")));
        const language = el("select");
        for (const l of LANGUAGES) language.append(new Option(l.label, l.id, false, l.id === st.language));
        box.append(el("label", "", t("settings.language")), language);
        const defaultProvider = el("select");
        defaultProvider.id = "default-provider";
        for (const p of PROVIDERS) defaultProvider.append(new Option(PROVIDER_LABEL[p], p, false, p === st.defaultProvider));
        const defaultLabel = el("label", "", t("settings.defaultProvider"));
        defaultLabel.htmlFor = defaultProvider.id;
        box.append(defaultLabel, defaultProvider);
        const claude = field(t("settings.claude"), st.claudeCommand, "claude");
        const codex = field(t("settings.codex"), st.codexCommand, "codex");
        const codexResume = field(t("settings.codexResume"), st.codexResumeCommand, "codex resume");
        const antigravity = field(t("settings.antigravity"), st.antigravityCommand, "agy");
        box.append(el("div", "note", t("info.noteAntigravity")));
        const shell = field(t("settings.shell"), st.shell, info.platform === "windows" ? "powershell.exe" : "$SHELL");
        cliChecks(box, [claude, codex, antigravity], shell, signal);
        const editor = editorPicker(box, st, info, signal);
        const systemExts = field(t("settings.systemOpen"), st.systemOpenExts, "html pdf png");
        box.append(el("div", "note", t("settings.systemOpenNote")));
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
        box.append(notifLabel, resumeLabel);
        box.append(
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
          actions.append(checkBtn);
        }
        actions.append(cancel, save_);
        box.append(actions);
        cancel.onclick = close;
        save_.onclick = () => {
          const draft = settingsDraft(st, {
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
          if (typeof draft === "string") return toast(draft);
          const langChanged = st.language !== draft.language;
          commit(draft, langChanged);
          close();
        };
        claude.focus();
      },
      () => {},
    );
  }

  return openSettings;
}
