import test from 'node:test';
import assert from 'node:assert/strict';

import { PRODUCT_NAME, pageTitle } from '../ui/lib/title.js';

const agents = [{ id: 'ava', name: 'Ava' }, { id: 'ben', name: 'Ben' }];

test('the product is called Stratus Agent', () => {
  assert.equal(PRODUCT_NAME, 'Stratus Agent');
});

test('each top-level page names itself before the product', () => {
  assert.equal(pageTitle({ name: 'home' }, agents), 'Home · Stratus Agent');
  assert.equal(pageTitle({ name: 'schedules' }, agents), 'Schedules · Stratus Agent');
  assert.equal(pageTitle({ name: 'tasks' }, agents), 'Tasks · Stratus Agent');
  assert.equal(pageTitle({ name: 'tools' }, agents), 'Tools · Stratus Agent');
  assert.equal(pageTitle({ name: 'permissions' }, agents), 'Permissions · Stratus Agent');
  assert.equal(pageTitle({ name: 'new' }, agents), 'New agent · Stratus Agent');
});

test('a Settings section is still the Settings page', () => {
  assert.equal(pageTitle({ name: 'settings' }, agents), 'Settings · Stratus Agent');
  assert.equal(pageTitle({ name: 'settings', section: 'channels' }, agents), 'Settings · Stratus Agent');
});

test("an agent's page is named for the agent, and its Settings tab says so", () => {
  assert.equal(pageTitle({ name: 'agent', agentId: 'ben' }, agents), 'Ben · Stratus Agent');
  assert.equal(pageTitle({ name: 'agent', agentId: 'ben', sessionId: 's1' }, agents), 'Ben · Stratus Agent');
  assert.equal(pageTitle({ name: 'agent', agentId: 'ava', tab: 'settings' }, agents), 'Ava settings · Stratus Agent');
});

test('an agent the roster does not list yet is named by its id', () => {
  // Before the first roster read lands, or for an id typed into the URL.
  assert.equal(pageTitle({ name: 'agent', agentId: 'cleo' }, []), 'cleo · Stratus Agent');
});

test('the signed-out page says so', () => {
  assert.equal(pageTitle({ name: 'signed-out' }, agents), 'Not signed in · Stratus Agent');
});

test('a route with no page of its own is just the product', () => {
  assert.equal(pageTitle({ name: 'nowhere' }, agents), 'Stratus Agent');
  assert.equal(pageTitle(undefined, agents), 'Stratus Agent');
});
