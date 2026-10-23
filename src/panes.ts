import { el } from "./dom.ts";
import { t } from "./i18n.ts";
import { paneGeometry, paneWeights, resizePaneTracks, type PaneLayout } from "./model.ts";

/** Owns split handles; terminals stay mounted when the geometry changes. */
export function createPaneLayout(stage: HTMLElement, fit: () => void, save: () => void) {
  let cancelDrag: (() => void) | undefined;
  let frame = 0;
  const fitSoon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  };
  function apply(mode: PaneLayout, count: number, sizes: Record<string, number[]>) {
    cancelDrag?.();
    stage.querySelectorAll(".pane-divider").forEach(node => node.remove());
    const geometry = paneGeometry(mode, Math.max(1, count));
    let x = paneWeights(sizes[geometry.xKey], geometry.columns);
    let y = paneWeights(sizes[geometry.yKey], geometry.rows);
    const tracks = (weights: number[]) => weights.map(w => `minmax(0, ${w}fr)`).join(" 6px ");
    const draw = () => {
      stage.style.gridTemplateColumns = tracks(x);
      stage.style.gridTemplateRows = tracks(y);
      fitSoon();
    };
    const divider = (axis: "x" | "y", boundary: number) => {
      const node = el("div", `pane-divider ${axis}`);
      node.tabIndex = 0;
      node.setAttribute("role", "separator");
      node.setAttribute("aria-label", t(axis === "x" ? "panes.resizeWidth" : "panes.resizeHeight"));
      node.setAttribute("aria-orientation", axis === "x" ? "vertical" : "horizontal");
      node.title = t("panes.resizeHint");
      if (axis === "x") {
        node.style.gridColumn = String(boundary * 2 + 2);
        node.style.gridRow = mode === "grid" && count === 3 ? "1" : "1 / -1";
      } else {
        node.style.gridRow = String(boundary * 2 + 2);
        node.style.gridColumn = "1 / -1";
      }
      const weights = () => axis === "x" ? x : y;
      const position = () => weights().slice(0, boundary + 1).reduce((a, b) => a + b, 0);
      const update = (value: number) => {
        const next = resizePaneTracks(weights(), boundary, value);
        if (axis === "x") x = next; else y = next;
        sizes[axis === "x" ? geometry.xKey : geometry.yKey] = next;
        draw();
        for (const handle of stage.querySelectorAll<HTMLElement>(`.pane-divider.${axis}`)) {
          const i = Number(handle.dataset.boundary);
          handle.setAttribute("aria-valuenow", String(Math.round(weights().slice(0, i + 1).reduce((a, b) => a + b, 0) * 100)));
        }
      };
      node.dataset.boundary = String(boundary);
      node.setAttribute("aria-valuemin", "10");
      node.setAttribute("aria-valuemax", "90");
      node.setAttribute("aria-valuenow", String(Math.round(position() * 100)));
      node.onpointerdown = event => {
        if (event.button !== 0) return;
        event.preventDefault();
        cancelDrag?.();
        node.focus();
        node.setPointerCapture(event.pointerId);
        node.classList.add("drag");
        const rect = stage.getBoundingClientRect();
        const length = (axis === "x" ? rect.width : rect.height) - (weights().length - 1) * 6;
        const start = axis === "x" ? event.clientX : event.clientY;
        const original = position();
        node.onpointermove = move => {
          if (length > 0) update(original + ((axis === "x" ? move.clientX : move.clientY) - start) / length);
        };
        const stop = () => {
          node.onpointermove = null;
          node.onpointerup = node.onpointercancel = node.onlostpointercapture = null;
          if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
          node.classList.remove("drag");
          cancelDrag = undefined;
          save();
        };
        cancelDrag = stop;
        node.onpointerup = node.onpointercancel = node.onlostpointercapture = stop;
      };
      node.onkeydown = event => {
        const decrease = axis === "x" ? "ArrowLeft" : "ArrowUp";
        const increase = axis === "x" ? "ArrowRight" : "ArrowDown";
        if (![decrease, increase, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        update(event.key === "Home" ? 0 : event.key === "End" ? 1 : position() + (event.key === decrease ? -0.02 : 0.02));
        save();
      };
      stage.append(node);
    };
    for (let i = 0; i < geometry.columns - 1; i++) divider("x", i);
    for (let i = 0; i < geometry.rows - 1; i++) divider("y", i);
    draw();
    return geometry.cells;
  }
  return { apply };
}
