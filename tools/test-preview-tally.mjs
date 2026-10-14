import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeResults } from './preview-tally.mjs';

test('all executed checks passing with a skip is not a complete pass', () => {
  const summary = summarizeResults([{ status: 'passed' }, { status: 'passed' }, { status: 'skipped' }]);
  assert.equal(summary.passed, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.succeeded, true);
  assert.equal(summary.complete, false, 'a skipped check must keep the run from claiming full coverage');
});

test('a failure still fails when other checks are skipped', () => {
  const summary = summarizeResults([{ status: 'passed' }, { status: 'failed' }, { status: 'skipped' }]);
  assert.equal(summary.succeeded, false);
  assert.equal(summary.complete, false);
  assert.equal(summary.failed, 1);
});

test('all skipped is not an executed success', () => {
  const summary = summarizeResults([{ status: 'skipped' }, { status: 'skipped' }]);
  assert.equal(summary.passed, 0);
  assert.equal(summary.succeeded, false);
  assert.equal(summary.complete, false);
});

test('a clean run of executed checks reports complete success', () => {
  const summary = summarizeResults([{ status: 'passed' }, { status: 'passed' }]);
  assert.equal(summary.succeeded, true);
  assert.equal(summary.complete, true);
});

test('unknown statuses are treated as failures, never as passes', () => {
  const summary = summarizeResults([{ status: 'ok' }, { status: 'passed' }]);
  assert.equal(summary.failed, 1);
  assert.equal(summary.succeeded, false);
});
