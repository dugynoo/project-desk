import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { PROVIDER_LABEL, type Project, type Session, type Status } from "./model.ts";

interface Dependencies {
  enabled: () => boolean;
  session: (id: string) => Session | undefined;
  project: (id: string) => Project | undefined;
  statusLabel: (status: Status) => string;
}

export function createSystemNotifications({ enabled, session, project, statusLabel }: Dependencies) {
  return async function notify(id: string, status: Status) {
    const s = session(id);
    if (!s || !enabled()) return;
    try {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      if (!ok) return;
      const p = project(s.projectId);
      sendNotification({ title: `${statusLabel(status)} · ${s.title}`, body: `${p?.name ?? ""} · ${PROVIDER_LABEL[s.provider]}` });
    } catch {
      // Notifikácie sú bonus; keď nejdú, ostane bodka v zozname.
    }
  };

}
