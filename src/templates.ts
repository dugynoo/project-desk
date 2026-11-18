import { call } from "./ipc.ts";
import { el, iconButton } from "./dom.ts";
import { errorText, t } from "./i18n.ts";
import { pasteSequence, searchTemplates, templatesFor, type PersistedState, type Project, type PromptTemplate, type Session } from "./model.ts";
import type { createDialogs } from "./dialogs.ts";

interface Dependencies {
  getState(): PersistedState;
  runtimes: ReadonlyMap<string, { running: boolean; term: { focus(): void } }>;
  modal: ReturnType<typeof createDialogs>["modal"];
  save(): void;
  toast(message: string): void;
}

/** Prompt templates: the picker, the editor and pasting into the active terminal. */
export function createTemplates({ getState, runtimes, modal, save, toast }: Dependencies) {
  const project = (id: string) => getState().projects.find(p => p.id === id);
  const session = (id: string | undefined): Session | undefined => (id ? getState().sessions.find(s => s.id === id) : undefined);

  /** Vloží šablónu do aktívneho terminálu ako jeden paste; voliteľne ju hneď odošle. */
  function insertTemplate(tpl: PromptTemplate) {
    const id = getState().ui.activeSessionId;
    const rt = id ? runtimes.get(id) : undefined;
    if (!id || !rt?.running) return toast(t("tpl.needSession"));
    void call("pty_write", { id, data: pasteSequence(tpl.text) })
      .then(() => {
        if (tpl.send) window.setTimeout(() => {
          void call("pty_write", { id, data: "\r" }).catch((e) => toast(errorText(e)));
        }, 150);
      })
      .catch((e) => toast(errorText(e)));
    rt.term.focus();
  }

  function openTemplates() {
    const active = session(getState().ui.activeSessionId);
    const p = active ? project(active.projectId) : undefined;
    modal(
      (box, close) => {
        const input = el("input");
        input.type = "text";
        input.placeholder = t("tpl.search");
        const list = el("div", "switch-list");
        box.append(el("h3", "", p ? t("tpl.titleProject", { name: p.name }) : t("tpl.title")), input, list);
        let items: PromptTemplate[] = [];
        let sel = 0;
        const pick = (tpl: PromptTemplate) => {
          close();
          insertTemplate(tpl);
        };
        const edit = (tpl?: PromptTemplate) => {
          close();
          editTemplate(tpl, p);
        };
        const draw = () => {
          items = searchTemplates(templatesFor(getState().templates, p?.id), input.value);
          sel = Math.min(sel, Math.max(0, items.length - 1));
          list.replaceChildren(
            ...items.map((tpl, i) => {
              const row = el("div", `switch-item${i === sel ? " sel" : ""}`);
              const actions = el("span", "row-actions");
              actions.append(
                iconButton("✎", t("tpl.edit"), () => edit(tpl)),
                iconButton("✕", t("tpl.delete"), () => {
                  getState().templates = getState().templates.filter((x) => x.id !== tpl.id);
                  save();
                  draw();
                }),
              );
              row.append(
                el("span", "", `${tpl.send ? "⏎ " : ""}${tpl.name}`),
                el("span", "meta", t(tpl.projectId ? "tpl.thisProject" : "tpl.allProjects")),
                actions,
              );
              row.title = tpl.text;
              row.onclick = () => pick(tpl);
              return row;
            }),
          );
          if (!items.length) list.append(el("p", "", t(getState().templates.length ? "common.noResults" : "tpl.empty")));
        };
        input.oninput = () => {
          sel = 0;
          draw();
        };
        input.onkeydown = (e) => {
          if (e.key === "ArrowDown") sel = Math.min(sel + 1, items.length - 1);
          else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
          else if (e.key === "Enter" && items[sel]) return pick(items[sel]);
          else return;
          e.preventDefault();
          draw();
        };
        const add = el("button", "", t("tpl.new"));
        add.onclick = () => edit();
        const actions = el("div", "actions");
        actions.append(add);
        box.append(actions, el("div", "note", t("tpl.note")));
        draw();
        input.focus();
      },
      () => {},
    );
  }

  function editTemplate(tpl: PromptTemplate | undefined, p: Project | undefined) {
    modal(
      (box, close) => {
        box.append(el("h3", "", t(tpl ? "tpl.editTitle" : "tpl.newTitle")));
        const name = el("input");
        name.type = "text";
        name.value = tpl?.name ?? "";
        name.placeholder = t("tpl.namePlaceholder");
        const text = el("textarea");
        text.value = tpl?.text ?? "";
        text.rows = 8;
        text.placeholder = t("tpl.textPlaceholder");
        text.spellcheck = false;
        const scope = el("select");
        const projectId = tpl ? tpl.projectId : p?.id;
        const scopeProject = tpl?.projectId ? project(tpl.projectId) : p;
        if (scopeProject) {
          scope.append(
            new Option(t("tpl.only", { name: scopeProject.name }), scopeProject.id, false, projectId === scopeProject.id),
          );
        }
        scope.append(new Option(t("tpl.allScope"), "", false, !projectId));
        const sendLabel = el("label", "check");
        const send = el("input");
        send.type = "checkbox";
        send.checked = tpl?.send ?? false;
        sendLabel.append(send, document.createTextNode(t("tpl.send")));
        box.append(
          el("label", "", t("tpl.name")),
          name,
          el("label", "", t("tpl.text")),
          text,
          el("label", "", t("tpl.scope")),
          scope,
          sendLabel,
        );
        const ok = el("button", "primary", t("common.save"));
        const cancel = el("button", "", t("common.cancel"));
        const actions = el("div", "actions");
        actions.append(cancel, ok);
        box.append(actions);
        // Enter v textarea je nový riadok, Esc rieši modal.
        text.addEventListener("keydown", (e) => e.stopPropagation());
        cancel.onclick = () => {
          close();
          openTemplates();
        };
        ok.onclick = () => {
          if (!name.value.trim() || !text.value.trim()) return toast(t("tpl.invalid"));
          const next: PromptTemplate = {
            id: tpl?.id ?? crypto.randomUUID(),
            name: name.value.trim(),
            text: text.value.replace(/\s+$/, ""),
            send: send.checked,
            projectId: scope.value || undefined,
          };
          getState().templates = tpl ? getState().templates.map((x) => (x.id === tpl.id ? next : x)) : [...getState().templates, next];
          save();
          close();
          openTemplates();
        };
        name.focus();
      },
      () => {},
    );
  }

  return { openTemplates, insertTemplate };
}
