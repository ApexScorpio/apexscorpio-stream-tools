const { test } = require('node:test');
const assert = require('node:assert/strict');
const FacebookService = require('../services/facebook');

test('FacebookService initializes and handles fallback when token is missing', () => {
  let statusUpdate = null;
  const service = new FacebookService(
    '111315703596465',
    null,
    (status) => { statusUpdate = status; },
    null
  );

  service.start();
  assert.equal(service.isLive, false);
  assert.equal(service.viewers, 0);
  assert.deepEqual(statusUpdate, {
    platform: 'facebook',
    isLive: false,
    viewers: 0
  });
  service.stop();
});

test('FacebookService loads token from setToken', () => {
  const service = new FacebookService('111315703596465', null, null, null);
  service.setToken('test_dummy_token_1234567890');
  assert.equal(service.token, 'test_dummy_token_1234567890');
  service.stop();
});
