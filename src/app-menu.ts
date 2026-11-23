import { Menu } from "@tauri-apps/api/menu";
import { t } from "./i18n.ts";

interface Actions {
  settings(): void;
  /** Closes the active session the same way as its close button (asks while it runs). */
  closeSession(): void;
  closeWindow(): void;
  find(): void;
}

/**
 * macOS menu bar. It replaces Tauri's default menu, where ⌘W closed the window and with it every
 * session. Keys the page handles first (copy, paste, app shortcuts) never reach these items.
 */
export async function installMacMenu(actions: Actions) {
  const menu = await Menu.new({
    items: [
      {
        text: "Project Desk",
        items: [
          { item: { About: null } },
          { item: "Separator" },
          { id: "settings", text: t("appMenu.settings"), accelerator: "Cmd+,", action: actions.settings },
          { item: "Separator" },
          { item: "Services", text: t("appMenu.services") },
          { item: "Separator" },
          { item: "Hide", text: t("appMenu.hide") },
          { item: "HideOthers", text: t("appMenu.hideOthers") },
          { item: "ShowAll", text: t("appMenu.showAll") },
          { item: "Separator" },
          { item: "Quit", text: t("appMenu.quit") },
        ],
      },
      {
        text: t("appMenu.file"),
        items: [
          { id: "closeSession", text: t("appMenu.closeSession"), accelerator: "Cmd+W", action: actions.closeSession },
          { id: "closeWindow", text: t("appMenu.closeWindow"), accelerator: "Cmd+Shift+W", action: actions.closeWindow },
        ],
      },
      {
        text: t("appMenu.edit"),
        items: [
          { item: "Undo", text: t("appMenu.undo") },
          { item: "Redo", text: t("appMenu.redo") },
          { item: "Separator" },
          { item: "Cut", text: t("appMenu.cut") },
          { item: "Copy", text: t("appMenu.copy") },
          { item: "Paste", text: t("appMenu.paste") },
          { item: "SelectAll", text: t("appMenu.selectAll") },
        ],
      },
      {
        text: t("appMenu.view"),
        items: [
          { id: "find", text: t("appMenu.find"), accelerator: "Cmd+F", action: actions.find },
          { item: "Separator" },
          { item: "Fullscreen", text: t("appMenu.fullscreen") },
        ],
      },
      {
        text: t("appMenu.window"),
        items: [
          { item: "Minimize", text: t("appMenu.minimize") },
          { item: "Maximize", text: t("appMenu.zoom") },
          { item: "Separator" },
          { item: "BringAllToFront", text: t("appMenu.bringAllToFront") },
        ],
      },
    ],
  });
  await menu.setAsAppMenu();
}
