import { $, el } from "./dom.ts";
import { t } from "./i18n.ts";

export function createDialogs(restoreFocus: () => void) {
  let activeClose: ((focus: boolean) => void) | undefined;
  let generation = 0;

  function modal(build: (box: HTMLElement, close: () => void, signal: AbortSignal) => void, onClose: () => void) {
    const request = ++generation;
    activeClose?.(false);
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
    overlay.replaceChildren(box);
    overlay.hidden = false;
    let done = false;
    const dismiss = (focus: boolean) => {
      if (done) return;
      done = true;
      activeClose = undefined;
      overlay.onclick = null;
      overlay.hidden = true;
      overlay.replaceChildren();
      app.inert = false;
      controller.abort();
      try {
        onClose();
      } finally {
        if (focus && !activeClose) restoreFocus();
      }
    };
    const close = () => dismiss(true);
    activeClose = dismiss;
    document.addEventListener("keydown", (e: KeyboardEvent) => {
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
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };
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

  function confirmBox(heading: string, text: string, okLabel: string, notes = ""): Promise<boolean> {
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
      );
    });
  }

  return { modal, confirmBox };
}
