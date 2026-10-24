/** Debounce ordinary changes, serialize writes, and explicitly flush on exit. */
export function createSaveQueue(snapshot: () => string, write: (json: string) => Promise<void>, onError: (error: unknown) => void, delay = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const json = snapshot();
    const next = queue.catch(() => {}).then(() => write(json));
    queue = next;
    return next;
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(onError); }, delay);
  };
  return { schedule, flush };
}

/** Acknowledge native shutdown only after the serialized disk write completes. */
export function createShutdownHandler(flush: () => Promise<void>, acknowledge: (id: string, saved: boolean) => Promise<void>,
  preparing: () => void, onError: (error: unknown) => void) {
  const pending = new Set<string>();
  return async (id: string) => {
    if (pending.has(id)) return;
    pending.add(id);
    preparing();
    let saved = false;
    try { await flush(); saved = true; }
    catch (error) { onError(error); }
    try { await acknowledge(id, saved); }
    catch (error) { onError(error); }
    finally { pending.delete(id); }
  };
}
