require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const { createRevocationStoreFromEnv, encryptedCookieSession } = require('./src/session');
const { ensureFreshToken, getPlaylists } = require('./src/spotifyClient');
const { sortPlaylist } = require('./src/sorter');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERCEL_ANALYTICS_MODULE = path.join(
  path.dirname(require.resolve('@vercel/analytics/package.json')),
  'dist',
  'index.mjs'
);

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
].join(' ');

if (!process.env.SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET is not set. Copy .env.example to .env and set a strong secret.');
  process.exit(1);
}

app.use(express.json());
app.get('/vendor/vercel-analytics.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(VERCEL_ANALYTICS_MODULE);
});
app.use(express.static(PUBLIC_DIR));
app.use(encryptedCookieSession({
  secret: process.env.SESSION_SECRET,
  revocationStore: createRevocationStoreFromEnv(process.env),
}));

// ── Security headers ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://i.scdn.co data:; style-src 'self' 'unsafe-inline'");
  next();
});

// ── Auth routes ────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/playlists.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'playlists.html'));
});

app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
  });

  req.session.save(() => {
    res.redirect(`https://accounts.spotify.com/authorize?${params}`);
  });
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/?error=' + encodeURIComponent(error));
  }

  if (!state || !req.session.oauthState || state !== req.session.oauthState) {
    return res.redirect('/?error=state_mismatch');
  }

  delete req.session.oauthState;

  try {
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(
            `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
          ).toString('base64'),
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    req.session.accessToken = access_token;
    req.session.refreshToken = refresh_token;
    req.session.tokenExpiresAt = Date.now() + (expires_in - 60) * 1000;

    // Fetch and store display name
    const meRes = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    req.session.displayName = meRes.data.display_name || meRes.data.id;
    req.session.userId = meRes.data.id;

    req.session.save(() => {
      res.redirect('/playlists.html');
    });
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Failed to revoke session:', err.message);
      return res.redirect('/?error=logout_failed');
    }
    res.redirect('/');
  });
});

app.get('/auth/status', (req, res) => {
  if (req.session.accessToken) {
    res.json({ loggedIn: true, displayName: req.session.displayName });
  } else {
    res.json({ loggedIn: false });
  }
});

// ── API routes ─────────────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    await ensureFreshToken(req.session);
    next();
  } catch (err) {
    console.error('Failed to refresh Spotify access token:', err.response?.data || err.message);
    res.status(401).json({ error: 'Authentication expired' });
  }
}

app.get('/api/playlists', requireAuth, async (req, res) => {
  try {
    const playlists = await getPlaylists(req.session);
    res.json(playlists);
  } catch (err) {
    console.error('Failed to fetch playlists:', err.response?.status, err.response?.data || err.message);
    if (err.response?.status === 429) {
      const retryAfter = err.response.headers['retry-after'] || '?';
      return res.status(429).json({ error: 'rate_limited', retryAfter });
    }
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// SSE endpoint — streams sort progress back to the client
app.post('/api/playlists/:id/sort', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (!/^[A-Za-z0-9]{22}$/.test(req.params.id)) {
    send({ type: 'error', message: 'Invalid playlist ID' });
    return res.end();
  }

  try {
    await sortPlaylist(req.session, req.params.id, send);
    send({ type: 'done' });
  } catch (err) {
    console.error('Sort failed:', err.response?.data || err.message);
    send({ type: 'error', message: err.response?.data?.error?.message || err.message });
  } finally {
    res.end();
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Spotify Song Sorter running at http://localhost:${PORT}`);
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      console.warn('WARNING: SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET is not set. Copy .env.example to .env and fill in your credentials.');
    }
  });
}

module.exports = app;
