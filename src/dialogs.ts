import { $, el } from "./dom.ts";
import { t } from "./i18n.ts";

export function createDialogs(restoreFocus: () => void) {
  function modal(build: (box: HTMLElement, close: () => void) => void, onClose: () => void) {
    const overlay = $("#overlay");
    const box = el("div", "modal");
    overlay.replaceChildren(box);
    overlay.hidden = false;
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      overlay.hidden = true;
      overlay.replaceChildren();
      document.removeEventListener("keydown", esc, true);
      onClose();
      restoreFocus();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", esc, true);
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };
    build(box, close);
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
