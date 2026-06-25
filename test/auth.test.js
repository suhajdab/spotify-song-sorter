const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const axios = require('axios');
const { encodeSession } = require('../src/session');

process.env.SESSION_SECRET = 'test-secret-with-at-least-32-bytes-of-entropy';
delete process.env.VERCEL;

const app = require('../server');
const SESSION_COOKIE = 'spotify_sorter_session';

test('OAuth callback rejects an omitted state before token exchange', async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/auth/callback?code=attacker-code`, {
      redirect: 'manual',
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/?error=state_mismatch');
  } finally {
    server.close();
  }
});

test('OAuth callback accepts a matching state', async () => {
  const originalPost = axios.post;
  const originalGet = axios.get;
  axios.post = async () => ({
    data: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    },
  });
  axios.get = async () => ({ data: { id: 'spotify-user', display_name: 'Test User' } });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const authorizeUrl = new URL(login.headers.get('location'));
    const state = authorizeUrl.searchParams.get('state');

    const callback = await fetch(
      `${baseUrl}/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie },
        redirect: 'manual',
      }
    );

    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/playlists.html');
  } finally {
    axios.post = originalPost;
    axios.get = originalGet;
    server.close();
  }
});

test('auth status clears the session when the Spotify refresh token is invalid', async () => {
  const originalPost = axios.post;
  axios.post = async () => {
    const err = new Error('invalid grant');
    err.response = { status: 400, data: { error: 'invalid_grant' } };
    throw err;
  };

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const session = encodeSession({
      accessToken: 'expired-access-token',
      refreshToken: 'invalid-refresh-token',
      tokenExpiresAt: Date.now() - 1000,
      displayName: 'Expired User',
    }, process.env.SESSION_SECRET);

    const response = await fetch(`${baseUrl}/auth/status`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { loggedIn: false, code: 'authentication_expired' });
    assert.match(response.headers.get('set-cookie'), /spotify_sorter_session=.*Max-Age=0/);
  } finally {
    axios.post = originalPost;
    server.close();
  }
});

test('playlist API clears the session and returns 401 when refresh token is invalid', async () => {
  const originalPost = axios.post;
  axios.post = async () => {
    const err = new Error('invalid grant');
    err.response = { status: 400, data: { error: 'invalid_grant' } };
    throw err;
  };

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const session = encodeSession({
      accessToken: 'expired-access-token',
      refreshToken: 'invalid-refresh-token',
      tokenExpiresAt: Date.now() - 1000,
      displayName: 'Expired User',
      userId: 'spotify-user',
    }, process.env.SESSION_SECRET);

    const response = await fetch(`${baseUrl}/api/playlists`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` },
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: 'Authentication expired', code: 'authentication_expired' });
    assert.match(response.headers.get('set-cookie'), /spotify_sorter_session=.*Max-Age=0/);
  } finally {
    axios.post = originalPost;
    server.close();
  }
});
