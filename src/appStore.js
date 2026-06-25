const KEY_PREFIX = 'spotify-sorter:';

class MemoryAppStore {
  constructor() {
    this.users = new Map();
    this.trackedPlaylists = new Map();
    this.pushSubscriptions = new Map();
  }

  async saveUser(user) {
    const current = this.users.get(user.id) || {};
    this.users.set(user.id, { ...current, ...user, updatedAt: new Date().toISOString() });
  }

  async getUser(userId) {
    return this.users.get(userId) || null;
  }

  async listUserIds() {
    return [...this.users.keys()];
  }

  async upsertTrackedPlaylist(userId, playlist) {
    const current = await this.listTrackedPlaylists(userId);
    const existing = current.find((item) => item.id === playlist.id) || {};
    const next = { ...existing, ...playlist, updatedAt: new Date().toISOString() };
    this.trackedPlaylists.set(userId, [
      ...current.filter((item) => item.id !== playlist.id),
      next,
    ]);
    return next;
  }

  async listTrackedPlaylists(userId) {
    return this.trackedPlaylists.get(userId) || [];
  }

  async savePushSubscription(userId, subscription) {
    const current = await this.listPushSubscriptions(userId);
    const next = {
      ...subscription,
      createdAt: subscription.createdAt || new Date().toISOString(),
    };
    this.pushSubscriptions.set(userId, [
      ...current.filter((item) => item.endpoint !== subscription.endpoint),
      next,
    ]);
  }

  async removePushSubscription(userId, endpoint) {
    const current = await this.listPushSubscriptions(userId);
    this.pushSubscriptions.set(
      userId,
      current.filter((subscription) => subscription.endpoint !== endpoint)
    );
  }

  async listPushSubscriptions(userId) {
    return this.pushSubscriptions.get(userId) || [];
  }
}

class UpstashAppStore {
  constructor({ url, token }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  async command(command) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      throw new Error(`App store failed: ${body.error || response.status}`);
    }
    return body.result;
  }

  async getJson(key, fallback) {
    const value = await this.command(['GET', key]);
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  async setJson(key, value) {
    await this.command(['SET', key, JSON.stringify(value)]);
  }

  async saveUser(user) {
    const current = await this.getUser(user.id);
    const next = { ...current, ...user, updatedAt: new Date().toISOString() };
    await this.command(['SADD', KEY_PREFIX + 'users', user.id]);
    await this.setJson(KEY_PREFIX + `user:${user.id}`, next);
  }

  async getUser(userId) {
    return this.getJson(KEY_PREFIX + `user:${userId}`, null);
  }

  async listUserIds() {
    return this.command(['SMEMBERS', KEY_PREFIX + 'users']);
  }

  async upsertTrackedPlaylist(userId, playlist) {
    const current = await this.listTrackedPlaylists(userId);
    const existing = current.find((item) => item.id === playlist.id) || {};
    const next = { ...existing, ...playlist, updatedAt: new Date().toISOString() };
    await this.setJson(KEY_PREFIX + `tracked:${userId}`, [
      ...current.filter((item) => item.id !== playlist.id),
      next,
    ]);
    return next;
  }

  async listTrackedPlaylists(userId) {
    return this.getJson(KEY_PREFIX + `tracked:${userId}`, []);
  }

  async savePushSubscription(userId, subscription) {
    const current = await this.listPushSubscriptions(userId);
    await this.setJson(KEY_PREFIX + `push:${userId}`, [
      ...current.filter((item) => item.endpoint !== subscription.endpoint),
      {
        ...subscription,
        createdAt: subscription.createdAt || new Date().toISOString(),
      },
    ]);
  }

  async removePushSubscription(userId, endpoint) {
    const current = await this.listPushSubscriptions(userId);
    await this.setJson(
      KEY_PREFIX + `push:${userId}`,
      current.filter((subscription) => subscription.endpoint !== endpoint)
    );
  }

  async listPushSubscriptions(userId) {
    return this.getJson(KEY_PREFIX + `push:${userId}`, []);
  }
}

function createAppStoreFromEnv(env) {
  const url = env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

  if (url && token) return new UpstashAppStore({ url, token });
  if (url || token) {
    throw new Error(
      'UPSTASH_REDIS_REST_KV_REST_API_URL and UPSTASH_REDIS_REST_KV_REST_API_TOKEN must be configured together'
    );
  }
  if (env.VERCEL) {
    throw new Error(
      'UPSTASH_REDIS_REST_KV_REST_API_URL and UPSTASH_REDIS_REST_KV_REST_API_TOKEN are required on Vercel'
    );
  }
  return new MemoryAppStore();
}

module.exports = {
  createAppStoreFromEnv,
  MemoryAppStore,
  UpstashAppStore,
};
