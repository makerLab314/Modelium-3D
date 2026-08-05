import assert from 'node:assert/strict';
import test from 'node:test';

import { checkLocalRequest, hostnameOf, isLoopbackAddress } from '../server/lib/guard.js';

/** A request that passes every check, so each test can spoil exactly one thing. */
function req(overrides = {}) {
  const { headers = {}, method = 'GET', remoteAddress = '127.0.0.1' } = overrides;
  return {
    method,
    socket: { remoteAddress },
    headers: {
      host: 'localhost:8787',
      'sec-fetch-site': 'same-origin',
      ...(method === 'GET' ? {} : { 'x-modelium-settings': '1' }),
      ...headers,
    },
  };
}

test('hostnameOf handles the bracketed IPv6 form that split(":") mangles', () => {
  assert.equal(hostnameOf('localhost:8787'), 'localhost');
  assert.equal(hostnameOf('127.0.0.1'), '127.0.0.1');
  // The bug this replaced: '[::1]:8787'.split(':')[0] === '[' — so the whole
  // IPv6 branch of the old check was unreachable.
  assert.equal(hostnameOf('[::1]:8787'), '[::1]');
  assert.equal(hostnameOf('[::1]'), '[::1]');
  assert.equal(hostnameOf('EXAMPLE.com:80'), 'example.com');
  assert.equal(hostnameOf(''), '');
  assert.equal(hostnameOf('a b'), '');
  assert.equal(hostnameOf(undefined), '');
});

test('isLoopbackAddress covers the whole 127/8 block and the IPv6 forms', () => {
  for (const good of ['127.0.0.1', '127.0.0.53', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(good), true, good);
  }
  for (const bad of ['172.17.0.1', '192.168.1.5', '10.0.0.1', '128.0.0.1', '', undefined]) {
    assert.equal(isLoopbackAddress(bad), false, String(bad));
  }
});

test('a request from this machine over a loopback name is allowed', () => {
  assert.equal(checkLocalRequest(req()), null);
  assert.equal(checkLocalRequest(req({ headers: { host: '127.0.0.1:8787' } })), null);
  assert.equal(checkLocalRequest(req({ headers: { host: '[::1]:8787' }, remoteAddress: '::1' })), null);
});

test('a script with no browser headers is allowed — curl on this machine is fine', () => {
  const bare = {
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:8787' },
  };
  assert.equal(checkLocalRequest(bare), null);
});

test('a request from off this machine is refused', () => {
  assert.match(checkLocalRequest(req({ remoteAddress: '192.168.1.20' })), /only available from/);
});

/**
 * Plain Docker port mapping makes the peer address the bridge gateway. Failing
 * here is correct and is the reason `server` mode exists — the panel is not
 * supposed to be quietly reachable from a container network.
 */
test('a request through a Docker bridge is refused rather than trusted', () => {
  assert.match(checkLocalRequest(req({ remoteAddress: '172.17.0.1' })), /only available from/);
});

test('a name on the open web pointed at 127.0.0.1 is refused', () => {
  // DNS rebinding: the socket really is loopback, the Host header is not.
  assert.match(checkLocalRequest(req({ headers: { host: 'evil.com' } })), /loopback address/);
  assert.match(checkLocalRequest(req({ headers: { host: 'modelium.evil.com:8787' } })), /loopback/);
});

test('X-Forwarded-For is never believed', () => {
  const spoofed = req({
    remoteAddress: '203.0.113.9',
    headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
  });
  assert.match(checkLocalRequest(spoofed), /only available from/);
});

test('a cross-site request is refused even from loopback', () => {
  assert.match(checkLocalRequest(req({ headers: { 'sec-fetch-site': 'cross-site' } })), /another site/);
  assert.match(checkLocalRequest(req({ headers: { origin: 'https://evil.com' } })), /another site/);
});

/**
 * The control that actually stops a cross-site write: a page on another origin
 * cannot set a custom header without a CORS preflight, and this server answers
 * none. Sec-Fetch-Site alone depends on the browser being recent enough to send it.
 */
test('a write without the custom header is refused', () => {
  assert.match(
    checkLocalRequest(req({ method: 'PUT', headers: { 'x-modelium-settings': undefined } })),
    /X-Modelium-Settings/,
  );
  assert.equal(checkLocalRequest(req({ method: 'PUT' })), null);
  assert.equal(checkLocalRequest(req({ method: 'POST' })), null);
});
