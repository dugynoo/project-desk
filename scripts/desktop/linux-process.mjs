import { readFile } from 'node:fs/promises';

// comm may contain spaces and parentheses. Fields after its LAST ')' start at 3.
export function parseStat(text) {
  const match = /^(\d+) \(.*\) (\S[\s\S]*)$/.exec(text);
  if (!match) throw Error('Invalid /proc stat');
  const fields = match[2].trim().split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19]) || !/^\d+$/.test(fields[1])) {
    throw Error('Incomplete /proc stat');
  }
  return { pid: Number(match[1]), parent: Number(fields[1]), state: fields[0], started: fields[19] };
}

export async function processStat(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw Error(`Unsafe process ID: ${pid}`);
  try { return parseStat(await readFile(`/proc/${pid}/stat`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

export function sameLiveProcess(expected, actual) {
  return !!actual && expected.pid === actual.pid && expected.started === actual.started &&
    !['Z', 'X', 'x'].includes(actual.state);
}
