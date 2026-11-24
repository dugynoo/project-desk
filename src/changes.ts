// Prehľad zmien projektu (od HEAD alebo od snímky na začiatku ťahu agenta). Len na čítanie.
import { el } from "./dom.ts";
import { call, type GitChanges } from "./ipc.ts";
import { errorText, t } from "./i18n.ts";
import { diffLines } from "./model.ts";

type Modal = (build: (box: HTMLElement, close: () => void, signal: AbortSignal) => void, onClose: () => void) => void;

const STATUS_LABEL: Record<string, "changes.added" | "changes.modified" | "changes.deleted"> = {
  A: "changes.added", M: "changes.modified", D: "changes.deleted",
};

export interface ChangesOptions {
  /** Priečinok projektu; Git nájde koreň repozitára sám. */
  path: string;
  heading: string;
  /** Snímka zo začiatku ťahu; bez nej sa porovnáva s posledným commitom. */
  base?: string;
  openFile(path: string): void;
}

export function showChanges(modal: Modal, options: ChangesOptions) {
  modal((box, close, signal) => {
    box.classList.add("changes-modal");
    const refresh = el("button", "", t("changes.refresh"));
    const dismiss = el("button", "", t("common.close"));
    const head = el("div", "changes-head");
    head.append(el("h3", "", options.heading), refresh, dismiss);
    const status = el("p", "changes-status");
    status.setAttribute("role", "status");
    const list = el("div", "changes-list");
    const view = el("div", "changes-diff");
    const body = el("div", "changes-body");
    body.append(list, view);
    box.append(head, status, body);
    let changes: GitChanges | undefined;
    let selected = "";
    let listRequest = 0, diffRequest = 0;

    function markSelected() {
      for (const item of list.children) {
        (item as HTMLElement).setAttribute("aria-current", String((item as HTMLElement).dataset.path === selected));
      }
    }

    async function show(file: string) {
      selected = file;
      markSelected();
      const snapshot = changes;
      if (!snapshot) return;
      const request = ++diffRequest;
      view.replaceChildren(el("p", "note", t("changes.loading")));
      try {
        const patch = await call("git_diff", { path: options.path, base: snapshot.base, current: snapshot.current, file });
        if (request !== diffRequest || signal.aborted) return;
        const bar = el("div", "changes-file");
        bar.append(el("span", "", file));
        if (snapshot.files.find(f => f.path === file)?.status !== "D") {
          const open = el("button", "", t("changes.open"));
          // Editor je pod oknom, preto sa najprv zavrie.
          open.onclick = () => { close(); options.openFile(`${snapshot.root}/${file}`); };
          bar.append(open);
        }
        const lines = diffLines(patch);
        const code = el("div", "diff-lines");
        for (const line of lines) code.append(el("div", `diff-${line.kind}`, line.text || " "));
        view.replaceChildren(bar, lines.length ? code : el("p", "note", t("changes.noText")));
      } catch (e) {
        if (request === diffRequest && !signal.aborted) view.replaceChildren(el("p", "note", errorText(e)));
      }
    }

    async function load() {
      const request = ++listRequest;
      refresh.disabled = true;
      status.textContent = t("changes.loading");
      try {
        const next = await call("git_changes", { path: options.path, base: options.base ?? null });
        if (request !== listRequest || signal.aborted) return;
        changes = next;
        status.textContent = !next.files.length ? t("changes.empty")
          : next.truncated ? t("changes.truncated", { n: next.files.length }) : "";
        list.replaceChildren(...next.files.map(f => {
          const item = el("button", "changes-item");
          item.dataset.path = f.path;
          const letter = el("span", `changes-letter s-${f.status[0]}`, f.status[0]);
          letter.title = t(STATUS_LABEL[f.status[0]] ?? "changes.other");
          item.append(letter, el("span", "changes-path", f.path));
          item.title = f.path;
          item.onclick = () => void show(f.path);
          return item;
        }));
        if (!next.files.some(f => f.path === selected)) selected = next.files[0]?.path ?? "";
        if (selected) void show(selected);
        else view.replaceChildren(el("p", "note", next.files.length ? t("changes.pick") : ""));
      } catch (e) {
        if (request === listRequest && !signal.aborted) { status.textContent = errorText(e); list.replaceChildren(); view.replaceChildren(); }
      } finally {
        if (request === listRequest) refresh.disabled = false;
      }
    }

    refresh.onclick = () => void load();
    dismiss.onclick = close;
    list.addEventListener("keydown", e => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...list.children] as HTMLElement[];
      const next = items[items.indexOf(document.activeElement as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      next.focus();
      next.click();
    });
    void load();
  }, () => {});
}
