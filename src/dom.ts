export const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** Coalesce visual work; state changes and event handling stay synchronous. */
export function onNextFrame(draw: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      draw();
    });
  };
}
/**
 * Holds back re-renders while a press that started on a guarded control is down. A node replaced
 * between pointerdown and pointerup never gets its click, and status updates re-render the sidebar
 * and pane heads every few seconds while an agent works. Deferred renders run right after the
 * click: `pointerup` precedes `click` in the same input, and the timeout runs after both.
 */
export function createPressGuard(guarded: (target: EventTarget | null) => boolean, events: EventTarget = window) {
  let pressing = false;
  const pending = new Set<() => void>();
  const release = () => {
    if (!pressing) return;
    pressing = false;
    if (!pending.size) return;
    const run = [...pending];
    pending.clear();
    setTimeout(() => { for (const render of run) render(); }, 0);
  };
  events.addEventListener("pointerdown", e => { if (guarded(e.target)) pressing = true; }, { capture: true });
  for (const type of ["pointerup", "pointercancel", "blur"]) events.addEventListener(type, release, { capture: true });
  return {
    /** `true` when `render` was postponed until the press ends; the caller then returns. */
    defer(render: () => void): boolean {
      if (!pressing) return false;
      pending.add(render);
      return true;
    },
  };
}

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function iconButton(label: string, title: string, onClick: () => void) {
  const b = el("button", "icon", label);
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export type MenuItem = [label: string, run: () => void];

/** Malé kontextové menu na pozícii myši. Zavrie ho klik mimo, Escape alebo strata fokusu okna. */
export function popupMenu(x: number, y: number, items: MenuItem[]) {
  document.querySelector(".ctxmenu")?.remove();
  const menu = el("div", "ctxmenu");
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
    window.removeEventListener("blur", close);
  };
  const outside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    close();
  };
  for (const [label, run] of items) {
    const b = el("button", "", label);
    b.onclick = () => {
      close();
      run();
    };
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", esc, true);
  window.addEventListener("blur", close);
}
