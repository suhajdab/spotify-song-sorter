const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryAppStore } = require('../src/appStore');

test('memory app store tracks users, playlists, and deduped subscriptions', async () => {
  const store = new MemoryAppStore();

  await store.saveUser({
    id: 'spotify-user',
    refreshToken: 'refresh-token',
    displayName: 'Test User',
  });
  await store.upsertTrackedPlaylist('spotify-user', {
    id: 'playlist-id',
    name: 'Inbox',
    lastSortedSnapshotId: 'snapshot-1',
    needsResort: false,
  });
  await store.upsertTrackedPlaylist('spotify-user', {
    id: 'playlist-id',
    needsResort: true,
    lastSeenSnapshotId: 'snapshot-2',
  });
  await store.savePushSubscription('spotify-user', {
    endpoint: 'https://push.example/subscription',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  await store.savePushSubscription('spotify-user', {
    endpoint: 'https://push.example/subscription',
    keys: { p256dh: 'new-key', auth: 'new-auth' },
  });

  assert.deepEqual(await store.listUserIds(), ['spotify-user']);
  assert.equal((await store.getUser('spotify-user')).displayName, 'Test User');

  const playlists = await store.listTrackedPlaylists('spotify-user');
  assert.equal(playlists.length, 1);
  assert.equal(playlists[0].name, 'Inbox');
  assert.equal(playlists[0].needsResort, true);
  assert.equal(playlists[0].lastSeenSnapshotId, 'snapshot-2');

  const subscriptions = await store.listPushSubscriptions('spotify-user');
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].keys.p256dh, 'new-key');
});
