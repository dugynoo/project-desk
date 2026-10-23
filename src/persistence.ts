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
