require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const { createRevocationStoreFromEnv, encryptedCookieSession } = require('./src/session');
const { createAppStoreFromEnv } = require('./src/appStore');
const {
  ensureFreshToken,
  getPlaylistSummary,
  getPlaylists,
  isAuthenticationExpiredError,
} = require('./src/spotifyClient');
const {
  getVapidPublicKey,
  isPushConfigured,
  sendPushNotification,
} = require('./src/push');
const { sortPlaylist } = require('./src/sorter');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const appStore = createAppStoreFromEnv(process.env);

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

// ── Security headers ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://*.scdn.co https://*.spotifycdn.com data:; style-src 'self' 'unsafe-inline'");
  next();
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use(encryptedCookieSession({
  secret: process.env.SESSION_SECRET,
  revocationStore: createRevocationStoreFromEnv(process.env),
}));

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
    await persistUserSession(req.session);

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

async function destroySession(req, res) {
  if (res?.headersSent) return;
  if (typeof req.session?.destroy !== 'function') return;

  await new Promise((resolve) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('Failed to clear expired session:', err.message);
      }
      resolve();
    });
  });
}

async function sendAuthExpired(req, res) {
  await destroySession(req, res);
  res.status(401).json({ error: 'Authentication expired', code: 'authentication_expired' });
}

async function persistUserSession(session) {
  if (!session?.userId || !session.refreshToken) return;

  await appStore.saveUser({
    id: session.userId,
    displayName: session.displayName || session.userId,
    accessToken: session.accessToken || null,
    refreshToken: session.refreshToken,
    tokenExpiresAt: session.tokenExpiresAt || 0,
  });
}

function isValidPlaylistId(id) {
  return /^[A-Za-z0-9]{22}$/.test(id);
}

function isValidPushSubscription(subscription) {
  return Boolean(
    subscription &&
    typeof subscription.endpoint === 'string' &&
    subscription.keys &&
    typeof subscription.keys.p256dh === 'string' &&
    typeof subscription.keys.auth === 'string'
  );
}

app.get('/auth/status', async (req, res) => {
  if (!req.session.accessToken) {
    res.json({ loggedIn: false });
    return;
  }

  try {
    await ensureFreshToken(req.session);
    await persistUserSession(req.session);
    res.json({ loggedIn: true, displayName: req.session.displayName });
  } catch (err) {
    console.error('Failed to refresh Spotify access token:', err.response?.data || err.message);
    if (isAuthenticationExpiredError(err)) {
      await destroySession(req, res);
      res.json({ loggedIn: false, code: 'authentication_expired' });
      return;
    }
    res.status(503).json({ error: 'Unable to verify authentication status' });
  }
});

// ── API routes ─────────────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    await ensureFreshToken(req.session);
    await persistUserSession(req.session);
    next();
  } catch (err) {
    console.error('Failed to refresh Spotify access token:', err.response?.data || err.message);
    if (isAuthenticationExpiredError(err)) {
      await sendAuthExpired(req, res);
      return;
    }
    res.status(502).json({ error: 'Failed to refresh Spotify access token' });
  }
}

app.get('/api/playlists', requireAuth, async (req, res) => {
  try {
    const playlists = await getPlaylists(req.session);
    res.json(playlists);
  } catch (err) {
    console.error('Failed to fetch playlists:', err.response?.status, err.response?.data || err.message);
    if (isAuthenticationExpiredError(err)) {
      await sendAuthExpired(req, res);
      return;
    }
    if (err.response?.status === 429) {
      const retryAfter = err.response.headers['retry-after'] || '?';
      return res.status(429).json({ error: 'rate_limited', retryAfter });
    }
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

app.get('/api/tracked-playlists', requireAuth, async (req, res) => {
  const playlists = await appStore.listTrackedPlaylists(req.session.userId);
  res.json({ playlists });
});

app.get('/api/notifications/status', requireAuth, async (req, res) => {
  const subscriptions = await appStore.listPushSubscriptions(req.session.userId);
  const tracked = await appStore.listTrackedPlaylists(req.session.userId);
  res.json({
    configured: isPushConfigured(),
    publicKey: getVapidPublicKey(),
    subscribed: subscriptions.length > 0,
    trackedCount: tracked.length,
  });
});

app.post('/api/notifications/subscribe', requireAuth, async (req, res) => {
  if (!isPushConfigured()) {
    return res.status(503).json({ error: 'Push notifications are not configured' });
  }

  if (!isValidPushSubscription(req.body?.subscription)) {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }

  await appStore.savePushSubscription(req.session.userId, req.body.subscription);
  res.status(201).json({ ok: true });
});

app.delete('/api/notifications/subscribe', requireAuth, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'Missing subscription endpoint' });
  }

  await appStore.removePushSubscription(req.session.userId, endpoint);
  res.json({ ok: true });
});

app.get('/api/cron/check-resort-needed', async (req, res) => {
  if (!process.env.CRON_SECRET || req.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const summary = {
    users: 0,
    trackedPlaylists: 0,
    changedPlaylists: 0,
    notificationsSent: 0,
    notificationsRemoved: 0,
    errors: [],
  };

  const userIds = await appStore.listUserIds();
  for (const userId of userIds) {
    summary.users++;

    try {
      const [user, tracked] = await Promise.all([
        appStore.getUser(userId),
        appStore.listTrackedPlaylists(userId),
      ]);
      if (!user || tracked.length === 0) continue;

      summary.trackedPlaylists += tracked.length;

      const session = {
        ...user,
        userId,
        async save(callback = () => {}) {
          try {
            await persistUserSession(this);
            callback();
          } catch (err) {
            callback(err);
          }
        },
      };
      const currentPlaylists = await getPlaylists(session);
      await persistUserSession(session);
      const currentById = new Map(currentPlaylists.map((playlist) => [playlist.id, playlist]));
      const subscriptions = await appStore.listPushSubscriptions(userId);

      for (const trackedPlaylist of tracked) {
        const current = currentById.get(trackedPlaylist.id);
        if (!current) continue;

        if (current.snapshotId === trackedPlaylist.lastSortedSnapshotId) {
          if (trackedPlaylist.needsResort) {
            await appStore.upsertTrackedPlaylist(userId, {
              ...trackedPlaylist,
              name: current.name,
              lastSeenSnapshotId: current.snapshotId,
              needsResort: false,
            });
          }
          continue;
        }

        summary.changedPlaylists++;
        const canNotify = isPushConfigured() && subscriptions.length > 0;
        const alreadyNotified = canNotify && trackedPlaylist.notifiedSnapshotId === current.snapshotId;
        await appStore.upsertTrackedPlaylist(userId, {
          ...trackedPlaylist,
          name: current.name,
          trackCount: current.trackCount,
          lastSeenSnapshotId: current.snapshotId,
          needsResort: true,
          notifiedSnapshotId: trackedPlaylist.notifiedSnapshotId,
        });

        if (!canNotify || alreadyNotified) continue;

        let sentToAtLeastOneSubscription = false;
        for (const subscription of subscriptions) {
          try {
            await sendPushNotification(subscription, {
              title: 'Song Sorter',
              body: `${current.name} needs re-sorting.`,
              url: '/playlists.html?filter=needs-resorting',
              playlistId: current.id,
            });
            sentToAtLeastOneSubscription = true;
            summary.notificationsSent++;
          } catch (err) {
            if ([404, 410].includes(err.statusCode)) {
              await appStore.removePushSubscription(userId, subscription.endpoint);
              summary.notificationsRemoved++;
            } else {
              summary.errors.push({
                userId,
                playlistId: current.id,
                message: err.message,
              });
            }
          }
        }

        if (sentToAtLeastOneSubscription) {
          await appStore.upsertTrackedPlaylist(userId, {
            ...trackedPlaylist,
            name: current.name,
            trackCount: current.trackCount,
            lastSeenSnapshotId: current.snapshotId,
            needsResort: true,
            notifiedSnapshotId: current.snapshotId,
          });
        }
      }
    } catch (err) {
      summary.errors.push({ userId, message: err.message });
    }
  }

  res.json(summary);
});

// SSE endpoint — streams sort progress back to the client
app.post('/api/playlists/:id/sort', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (!isValidPlaylistId(req.params.id)) {
    send({ type: 'error', message: 'Invalid playlist ID' });
    return res.end();
  }

  try {
    const sortResult = await sortPlaylist(req.session, req.params.id, send);
    try {
      const playlist = await getPlaylistSummary(req.session, req.params.id);
      if (playlist.ownerId === req.session.userId) {
        await appStore.upsertTrackedPlaylist(req.session.userId, {
          id: playlist.id,
          name: playlist.name,
          trackCount: playlist.trackCount,
          lastSortedSnapshotId: playlist.snapshotId || sortResult?.snapshotId,
          lastSeenSnapshotId: playlist.snapshotId || sortResult?.snapshotId,
          needsResort: false,
          notifiedSnapshotId: null,
          sortedAt: new Date().toISOString(),
        });
        send({ type: 'tracking', snapshotId: playlist.snapshotId || sortResult?.snapshotId });
      }
    } catch (err) {
      console.error('Failed to save playlist tracking:', err.response?.data || err.message);
      send({ type: 'tracking_error', message: 'Sorted, but background tracking could not be saved.' });
    }
    send({ type: 'done' });
  } catch (err) {
    console.error('Sort failed:', err.response?.data || err.message);
    if (isAuthenticationExpiredError(err)) {
      await destroySession(req, res);
      send({ type: 'auth_expired', message: 'Authentication expired' });
    } else {
      send({ type: 'error', message: err.response?.data?.error?.message || err.message });
    }
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
