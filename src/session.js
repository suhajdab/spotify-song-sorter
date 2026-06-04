const crypto = require('crypto');

const COOKIE_NAME = 'spotify_sorter_session';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_COOKIE_VALUE_LENGTH = 3800;
const REVOCATION_KEY_PREFIX = 'spotify-sorter:revoked:';

function getKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function createSessionEnvelope(data, metadata = {}) {
  const issuedAt = metadata.issuedAt || Date.now();
  return {
    sessionId: metadata.sessionId || crypto.randomBytes(32).toString('base64url'),
    issuedAt,
    expiresAt: metadata.expiresAt || issuedAt + MAX_AGE_MS,
    data,
  };
}

function encodeSession(data, secret, metadata) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(secret), iv);
  const payload = JSON.stringify(createSessionEnvelope(data, metadata));
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const value = Buffer.concat([iv, authTag, encrypted]).toString('base64url');

  if (value.length > MAX_COOKIE_VALUE_LENGTH) {
    throw new Error('Session data is too large to store in a cookie');
  }

  return value;
}

function decodeSessionEnvelope(value, secret) {
  if (!value) return null;

  try {
    const buffer = Buffer.from(value, 'base64url');
    if (buffer.length < 29) return null;

    const iv = buffer.subarray(0, 12);
    const authTag = buffer.subarray(12, 28);
    const encrypted = buffer.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(secret), iv);
    decipher.setAuthTag(authTag);

    const payload = JSON.parse(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    );

    if (
      !payload.sessionId ||
      !payload.issuedAt ||
      !payload.expiresAt ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt > payload.issuedAt + MAX_AGE_MS
    ) {
      return null;
    }

    if (!payload.data || typeof payload.data !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

function decodeSession(value, secret) {
  return decodeSessionEnvelope(value, secret)?.data || {};
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        const name = separator === -1 ? part : part.slice(0, separator);
        const value = separator === -1 ? '' : part.slice(separator + 1);
        try {
          return [name, decodeURIComponent(value)];
        } catch {
          return [name, ''];
        }
      })
  );
}

function isSecureRequest(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https';
}

function serializeCookie(value, req, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

class MemoryRevocationStore {
  constructor() {
    this.revokedUntil = new Map();
  }

  async isRevoked(sessionId) {
    const expiresAt = this.revokedUntil.get(sessionId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.revokedUntil.delete(sessionId);
      return false;
    }
    return true;
  }

  async revoke(sessionId, ttlSeconds) {
    this.revokedUntil.set(sessionId, Date.now() + ttlSeconds * 1000);
  }
}

class UpstashRevocationStore {
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
      throw new Error(`Session revocation store failed: ${body.error || response.status}`);
    }
    return body.result;
  }

  async isRevoked(sessionId) {
    return (await this.command(['EXISTS', REVOCATION_KEY_PREFIX + sessionId])) === 1;
  }

  async revoke(sessionId, ttlSeconds) {
    await this.command(['SET', REVOCATION_KEY_PREFIX + sessionId, '1', 'EX', ttlSeconds]);
  }
}

function createRevocationStoreFromEnv(env) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) return new UpstashRevocationStore({ url, token });
  if (url || token) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together'
    );
  }
  if (env.VERCEL) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required on Vercel'
    );
  }
  return new MemoryRevocationStore();
}

function encryptedCookieSession(options) {
  if (!options?.secret) {
    throw new Error('encryptedCookieSession requires a secret');
  }
  if (!options.revocationStore) {
    throw new Error('encryptedCookieSession requires a revocationStore');
  }

  return async function sessionMiddleware(req, res, next) {
    let envelope;
    let revoked;
    try {
      const cookies = parseCookies(req.get('cookie'));
      envelope = decodeSessionEnvelope(cookies[COOKIE_NAME], options.secret);
      revoked = envelope && await options.revocationStore.isRevoked(envelope.sessionId);
    } catch (err) {
      next(err);
      return;
    }

    const session = revoked ? {} : (envelope?.data || {});
    const metadata = revoked || !envelope ? createSessionEnvelope({}) : envelope;
    let destroyed = false;

    const originalWriteHead = res.writeHead;
    res.writeHead = function writeHead(...args) {
      if (!destroyed && Object.keys(session).length > 0 && !res.headersSent) {
        const value = encodeSession(session, options.secret, metadata);
        const maxAgeSeconds = Math.max(0, Math.ceil((metadata.expiresAt - Date.now()) / 1000));
        res.setHeader('Set-Cookie', serializeCookie(value, req, maxAgeSeconds));
      }
      return originalWriteHead.apply(this, args);
    };

    Object.defineProperties(session, {
      save: {
        enumerable: false,
        value(callback = () => {}) {
          if (res.headersSent) {
            callback();
            return;
          }

          try {
            const value = encodeSession(session, options.secret, metadata);
            const decoded = decodeSessionEnvelope(value, options.secret);
            Object.assign(metadata, decoded);
            const maxAgeSeconds = Math.max(0, Math.ceil((metadata.expiresAt - Date.now()) / 1000));
            res.setHeader('Set-Cookie', serializeCookie(value, req, maxAgeSeconds));
            callback();
          } catch (err) {
            callback(err);
          }
        },
      },
      destroy: {
        enumerable: false,
        async value(callback = () => {}) {
          destroyed = true;
          try {
            if (metadata.sessionId && metadata.expiresAt > Date.now()) {
              const ttlSeconds = Math.ceil((metadata.expiresAt - Date.now()) / 1000);
              await options.revocationStore.revoke(metadata.sessionId, ttlSeconds);
            }
            res.setHeader('Set-Cookie', serializeCookie('', req, 0));
            callback();
          } catch (err) {
            callback(err);
          }
        },
      },
    });

    req.session = session;
    next();
  };
}

module.exports = {
  encryptedCookieSession,
  createRevocationStoreFromEnv,
  MemoryRevocationStore,
  UpstashRevocationStore,
  encodeSession,
  decodeSession,
  decodeSessionEnvelope,
};
