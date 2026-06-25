const axios = require('axios');

const BASE_URL = 'https://api.spotify.com/v1';

class AuthenticationExpiredError extends Error {
  constructor(message = 'Authentication expired', cause) {
    super(message);
    this.name = 'AuthenticationExpiredError';
    this.code = 'authentication_expired';
    this.cause = cause;
  }
}

function isRefreshAuthFailure(err) {
  const status = err.response?.status;
  const tokenError = err.response?.data?.error;
  return status === 401 ||
    (status === 400 && ['invalid_grant', 'invalid_client'].includes(tokenError));
}

function isAuthenticationExpiredError(err) {
  return err?.code === 'authentication_expired' || err instanceof AuthenticationExpiredError;
}

// Refresh the access token and update the session in place
async function refreshAccessToken(session) {
  if (!session.refreshToken) {
    throw new AuthenticationExpiredError();
  }

  let res;
  try {
    res = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString('base64'),
        },
      }
    );
  } catch (err) {
    if (isRefreshAuthFailure(err)) {
      throw new AuthenticationExpiredError('Authentication expired', err);
    }
    throw err;
  }

  session.accessToken = res.data.access_token;
  if (res.data.refresh_token) {
    session.refreshToken = res.data.refresh_token;
  }
  session.tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;

  if (typeof session.save === 'function') {
    await new Promise((resolve, reject) => {
      session.save((err) => (err ? reject(err) : resolve()));
    });
  }
}

// Ensure we have a valid token, refreshing if needed
async function ensureFreshToken(session) {
  if (!session.accessToken || (session.tokenExpiresAt && Date.now() > session.tokenExpiresAt)) {
    await refreshAccessToken(session);
  }
}

// Wrap an API call with automatic token refresh on 401
async function spotifyRequest(session, method, path, data = null, params = {}) {
  await ensureFreshToken(session);

  const config = {
    method,
    url: `${BASE_URL}${path}`,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    params,
    timeout: 10000,
  };
  if (data) config.data = data;

  const request = (cfg) => Promise.race([
    axios(cfg),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Spotify request timed out after 10s')), 10000)),
  ]);

  try {
    const res = await request(config);
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken(session);
      config.headers.Authorization = `Bearer ${session.accessToken}`;
      try {
        const res = await request(config);
        return res.data;
      } catch (retryErr) {
        if (retryErr.response?.status === 401) {
          throw new AuthenticationExpiredError('Authentication expired', retryErr);
        }
        throw retryErr;
      }
    }
    throw err;
  }
}

// Paginate through all items of a Spotify paged endpoint
async function fetchAllPages(session, path, params = {}, limitPerPage = 50) {
  const items = [];
  let offset = 0;

  while (true) {
    const data = await spotifyRequest(session, 'GET', path, null, {
      ...params,
      limit: limitPerPage,
      offset,
    });

    if (!data.items) break;

    items.push(...data.items);

    if (data.next === null || items.length >= data.total) break;
    offset += limitPerPage;
  }

  return items;
}

// Return simplified playlist objects for the current user
async function getPlaylists(session) {
  const items = await fetchAllPages(session, '/me/playlists', {}, 50);

  return items
    .filter((p) => p.owner.id === session.userId)
    .map((p) => ({
      id: p.id,
      name: p.name,
      snapshotId: p.snapshot_id,
      trackCount: p.tracks?.total ?? p.items?.total ?? 0,
      imageUrl: p.images?.[0]?.url || null,
      public: p.public,
    }));
}

async function getPlaylistSummary(session, playlistId) {
  const playlist = await spotifyRequest(session, 'GET', `/playlists/${playlistId}`, null, {
    fields: 'id,name,snapshot_id,tracks.total,owner.id',
  });

  return {
    id: playlist.id,
    name: playlist.name,
    snapshotId: playlist.snapshot_id,
    trackCount: playlist.tracks?.total ?? 0,
    ownerId: playlist.owner?.id,
  };
}

// Return all tracks in a playlist with position, added_at, uri
async function getPlaylistTracks(session, playlistId) {
  const items = await fetchAllPages(
    session,
    `/playlists/${playlistId}/items`,
    {},
    100
  );

  return items
    .filter((item) => item.item?.uri) // skip episodes and removed tracks
    .map((item, index) => ({
      position: index,
      uri: item.item.uri,
      name: item.item.name,
      addedAt: item.added_at ? new Date(item.added_at).getTime() : 0,
    }));
}

// Move a single track range to a new position, returns new snapshot_id
async function reorderTrack(session, playlistId, rangeStart, insertBefore, snapshotId) {
  const body = { range_start: rangeStart, insert_before: insertBefore, range_length: 1 };
  if (snapshotId) body.snapshot_id = snapshotId;

  const data = await spotifyRequest(session, 'PUT', `/playlists/${playlistId}/items`, body);
  return data.snapshot_id;
}

module.exports = {
  ensureFreshToken,
  getPlaylists,
  getPlaylistSummary,
  getPlaylistTracks,
  refreshAccessToken,
  reorderTrack,
  AuthenticationExpiredError,
  isAuthenticationExpiredError,
};
