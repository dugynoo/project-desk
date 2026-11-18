import { $, el } from "./dom.ts";
import { t } from "./i18n.ts";

interface Open { box: HTMLElement; dismiss: (focus: boolean) => void; backdrop: (e: { target: unknown }) => void }

export interface ModalOptions {
  /**
   * Open above the current dialog instead of replacing it; closing returns to the one below.
   * For questions that arrive from outside (quit), so they never discard an open dialog's draft.
   */
  stack?: boolean;
}

export function createDialogs(restoreFocus: () => void) {
  const open: Open[] = [];
  let generation = 0;

  function modal(build: (box: HTMLElement, close: () => void, signal: AbortSignal) => void, onClose: () => void, options: ModalOptions = {}) {
    const request = ++generation;
    if (!options.stack) open.at(-1)?.dismiss(false);
    // A cleanup callback may itself open another dialog.
    if (request !== generation) { onClose(); return; }
    const overlay = $("#overlay");
    const box = el("div", "modal");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.tabIndex = -1;
    const app = $("#app");
    app.inert = true;
    const controller = new AbortController();
    const below = open.at(-1);
    if (below) below.box.hidden = true;
    if (below) overlay.append(box); else overlay.replaceChildren(box);
    overlay.hidden = false;
    let done = false;
    const dismiss = (focus: boolean) => {
      if (done) return;
      done = true;
      open.splice(open.indexOf(entry), 1);
      controller.abort();
      const top = open.at(-1);
      if (top) {
        overlay.replaceChildren(...open.map(item => item.box));
        top.box.hidden = false;
        overlay.onclick = top.backdrop;
        top.box.focus();
      } else {
        overlay.onclick = null;
        overlay.hidden = true;
        overlay.replaceChildren();
        app.inert = false;
      }
      try {
        onClose();
      } finally {
        if (focus && !open.length) restoreFocus();
      }
    };
    const close = () => dismiss(true);
    const backdrop = (e: { target: unknown }) => {
      if (e.target === overlay) close();
    };
    const entry: Open = { box, dismiss, backdrop };
    open.push(entry);
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      // Only the top dialog answers keys; the ones below wait.
      if (open.at(-1) !== entry) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const items = Array.from(box.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"))
          .filter(item => item.tabIndex >= 0 && !item.matches(":disabled") && item.getClientRects().length > 0);
        const first = items[0], last = items.at(-1);
        if (!first) { e.preventDefault(); box.focus(); }
        else if (e.shiftKey && (document.activeElement === first || !items.includes(document.activeElement as HTMLElement))) {
          e.preventDefault(); last?.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !items.includes(document.activeElement as HTMLElement))) {
          e.preventDefault(); first.focus();
        }
      }
    }, { capture: true, signal: controller.signal });
    overlay.onclick = backdrop;
    try {
      build(box, close, controller.signal);
      const heading = box.querySelector("h3");
      if (heading) {
        heading.id ||= "dialog-heading";
        box.setAttribute("aria-labelledby", heading.id);
      }
      if (!box.contains(document.activeElement)) box.focus();
    } catch (error) {
      close();
      throw error;
    }
  }

  function confirmBox(heading: string, text: string, okLabel: string, notes = "", options: ModalOptions = {}): Promise<boolean> {
    return new Promise((resolve) => {
      let result = false;
      modal(
        (box, close) => {
          const ok = el("button", "danger", okLabel);
          const cancel = el("button", "", t("common.cancel"));
          const actions = el("div", "actions");
          actions.append(cancel, ok);
          box.append(el("h3", "", heading), el("p", "", text));
          if (notes) box.append(el("div", "notes", notes));
          box.append(actions);
          ok.onclick = () => {
            result = true;
            close();
          };
          cancel.onclick = close;
          cancel.focus();
        },
        () => resolve(result),
        options,
      );
    });
  }

  return { modal, confirmBox };
}
