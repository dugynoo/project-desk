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
    }, { capture: true, signal: controller.signal });
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };
    try {
      build(box, close, controller.signal);
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
