const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const {
  decodeSession,
  decodeSessionEnvelope,
  encodeSession,
  encryptedCookieSession,
  MemoryRevocationStore,
  createRevocationStoreFromEnv,
} = require('../src/session');

const SECRET = 'test-secret-with-at-least-32-bytes-of-entropy';

test('encrypted sessions round trip', () => {
  const session = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    displayName: 'Test User',
  };

  const encoded = encodeSession(session, SECRET);

  assert.notEqual(encoded, JSON.stringify(session));
  assert.deepEqual(decodeSession(encoded, SECRET), session);
});

test('encrypted sessions reject tampering', () => {
  const encoded = encodeSession({ accessToken: 'access-token' }, SECRET);
  const index = Math.floor(encoded.length / 2);
  const replacement = encoded[index] === 'a' ? 'b' : 'a';
  const tampered = encoded.slice(0, index) + replacement + encoded.slice(index + 1);

  assert.deepEqual(decodeSession(tampered, SECRET), {});
});

test('encrypted sessions reject the wrong secret', () => {
  const encoded = encodeSession({ accessToken: 'access-token' }, SECRET);

  assert.deepEqual(decodeSession(encoded, 'different-secret'), {});
});

test('encrypted sessions preserve their absolute expiry when re-encoded', () => {
  const expiresAt = Date.now() + 60_000;
  const metadata = {
    sessionId: 'stable-session-id',
    issuedAt: Date.now(),
    expiresAt,
  };

  const first = decodeSessionEnvelope(encodeSession({ accessToken: 'one' }, SECRET, metadata), SECRET);
  const second = decodeSessionEnvelope(encodeSession({ accessToken: 'two' }, SECRET, first), SECRET);

  assert.equal(second.sessionId, 'stable-session-id');
  assert.equal(second.expiresAt, expiresAt);
});

test('Vercel deployments require a shared revocation store', () => {
  assert.throws(
    () => createRevocationStoreFromEnv({ VERCEL: '1' }),
    /UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required/
  );
});

test('logout revokes copied session cookies', async () => {
  const app = express();
  const revocationStore = new MemoryRevocationStore();
  app.use(encryptedCookieSession({ secret: SECRET, revocationStore }));
  app.get('/login', (req, res) => {
    req.session.accessToken = 'access-token';
    req.session.save(() => res.sendStatus(204));
  });
  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.sendStatus(204));
  });
  app.get('/private', (req, res) => {
    res.status(req.session.accessToken ? 200 : 401).end();
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await fetch(`${baseUrl}/login`);
    const copiedCookie = login.headers.get('set-cookie').split(';')[0];

    assert.equal((await fetch(`${baseUrl}/private`, {
      headers: { cookie: copiedCookie },
    })).status, 200);

    assert.equal((await fetch(`${baseUrl}/logout`, {
      headers: { cookie: copiedCookie },
    })).status, 204);

    assert.equal((await fetch(`${baseUrl}/private`, {
      headers: { cookie: copiedCookie },
    })).status, 401);
  } finally {
    server.close();
  }
});
