require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const axios = require('axios');
const { getPlaylists } = require('./src/spotifyClient');
const { sortPlaylist } = require('./src/sorter');

const app = express();
const PORT = process.env.PORT || 3000;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
].join(' ');

app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));

// ── Auth routes ────────────────────────────────────────────────────────────────

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

  if (state !== req.session.oauthState) {
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
  req.session.destroy(() => res.redirect('/'));
});

app.get('/auth/status', (req, res) => {
  if (req.session.accessToken) {
    res.json({ loggedIn: true, displayName: req.session.displayName });
  } else {
    res.json({ loggedIn: false });
  }
});

// ── API routes ─────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

app.get('/api/playlists', requireAuth, async (req, res) => {
  try {
    const playlists = await getPlaylists(req.session);
    res.json(playlists);
  } catch (err) {
    console.error('Failed to fetch playlists:', err.response?.data || err.message);
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

app.listen(PORT, () => {
  console.log(`Spotify Song Sorter running at http://localhost:${PORT}`);
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.warn('WARNING: SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET is not set. Copy .env.example to .env and fill in your credentials.');
  }
});
