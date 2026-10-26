import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStat, sameLiveProcess, processStat } from './linux-process.mjs';

test('proc stat handles spaces/parentheses and preserves large start times', () => {
  const text = `123 (odd ) name) S 42 ${Array(17).fill('0').join(' ')} 90071992547409930 0\n`;
  assert.deepEqual(parseStat(text), { pid: 123, parent: 42, state: 'S', started: '90071992547409930' });
  assert.throws(() => parseStat('123 (truncated) S 42'));
});

test('process checks distinguish PID reuse and exited zombies from live processes', () => {
  const original = { pid: 123, started: '999', state: 'S' };
  assert.equal(sameLiveProcess(original, { ...original, state: 'R' }), true);
  for (const actual of [null, { ...original, started: '1000' }, { ...original, pid: 124 },
    { ...original, state: 'Z' }, { ...original, state: 'X' }]) {
    assert.equal(sameLiveProcess(original, actual), false);
  }
});

test('proc lookup rejects unsafe PID values before accessing the filesystem', async () => {
  for (const pid of [0, 1, -3, NaN, 1.5, '123']) await assert.rejects(processStat(pid));
});
