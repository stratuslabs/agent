import test from 'node:test';
import assert from 'node:assert/strict';

import { applyStyle } from '../ui/lib/dom.js';

const recorder = () => {
  const set: Array<[string, string, string]> = [];
  return { set, node: { style: { setProperty: (name: string, value: string, priority: string) => { set.push([name, value, priority]); } } } };
};

test('a style string is applied one property at a time, never as cssText or an attribute', () => {
  // The page's CSP has no 'unsafe-inline' for styles. Single properties on
  // the CSSOM are allowed in every engine; an inline style attribute is not,
  // and MDN lists a cssText assignment with it.
  const { set, node } = recorder();
  applyStyle(node, 'display: flex; gap: 6px;margin: 0 4px 0 0 ;  border-top: 1px solid var(--border)');
  assert.deepEqual(set, [
    ['display', 'flex', ''],
    ['gap', '6px', ''],
    ['margin', '0 4px 0 0', ''],
    ['border-top', '1px solid var(--border)', ''],
  ]);
});

test('an !important survives, and empty or malformed parts are skipped', () => {
  const { set, node } = recorder();
  applyStyle(node, 'width: auto !important; ; nonsense; color:red');
  assert.deepEqual(set, [['width', 'auto', 'important'], ['color', 'red', '']]);
});
