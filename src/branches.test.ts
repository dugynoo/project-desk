import test from 'node:test';
import assert from 'node:assert/strict';
import { createBranches } from './branches.ts';
import { parseState, emptyState } from './model.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('branch setting defaults off and persists explicit choices', () => {
  assert.equal(parseState('{}').state.settings.showGitBranch, false);
  const state = emptyState(); state.settings.showGitBranch = true;
  assert.equal(parseState(JSON.stringify(state)).state.settings.showGitBranch, true);
});
test('branches are opt-in, serial, cached, refreshed on events and invalidated when disabled', async () => {
  let now = 0, changed = 0;
  const calls: string[] = [];
  const pending: ((value: string | null) => void)[] = [];
  const cache = createBranches(path => { calls.push(path); return new Promise(resolve => pending.push(resolve)); }, () => changed++, () => now);
  cache.refresh(['a', 'b']); assert.deepEqual(calls, []);
  cache.configure(true, ['a', 'b']); cache.refresh(['a', 'b']);
  cache.refresh(['a', 'b']); assert.deepEqual(calls, ['a']);
  pending.shift()!('main'); await tick(); assert.deepEqual(calls, ['a', 'b']);
  pending.shift()!(null); await tick();
  assert.equal(cache.get('a'), 'main'); assert.equal(changed, 2);
  cache.refresh(['a', 'b'], true); assert.equal(calls.length, 2);
  now = 3001; cache.refresh(['a'], true); assert.equal(calls.length, 3);
  cache.configure(false, ['a']); assert.equal(cache.get('a'), undefined);
  cache.configure(true, ['a']); cache.refresh(['a']);
  pending.shift()!('stale'); await tick(); assert.equal(cache.get('a'), undefined);
  assert.equal(calls.length, 4);
  pending.shift()!('fresh'); await tick(); assert.equal(cache.get('a'), 'fresh');
  cache.configure(false, []); cache.refresh(['a'], true); assert.equal(calls.length, 4);
});
