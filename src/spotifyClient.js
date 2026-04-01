const axios = require('axios');

const BASE_URL = 'https://api.spotify.com/v1';

// Refresh the access token and update the session in place
async function refreshAccessToken(session) {
  const res = await axios.post(
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

  session.accessToken = res.data.access_token;
  if (res.data.refresh_token) {
    session.refreshToken = res.data.refresh_token;
  }
  session.tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
}

// Ensure we have a valid token, refreshing if needed
async function ensureFreshToken(session) {
  if (session.tokenExpiresAt && Date.now() > session.tokenExpiresAt) {
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
  };
  if (data) config.data = data;

  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      // Token expired mid-request — refresh and retry once
      await refreshAccessToken(session);
      config.headers.Authorization = `Bearer ${session.accessToken}`;
      const res = await axios(config);
      return res.data;
    }
    if (err.response?.status === 429) {
      const retryAfter = parseInt(err.response.headers['retry-after'] || '2', 10);
      await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
      const res = await axios(config);
      return res.data;
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

  return items.map((p) => ({
    id: p.id,
    name: p.name,
    trackCount: p.tracks?.total ?? p.items?.total ?? 0,
    imageUrl: p.images?.[0]?.url || null,
    isOwned: p.owner.id === session.userId,
    public: p.public,
  }));
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

module.exports = { getPlaylists, getPlaylistTracks, reorderTrack };
