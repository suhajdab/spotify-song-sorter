const webPush = require('web-push');

function getVapidPublicKey(env = process.env) {
  return env.VAPID_PUBLIC_KEY || null;
}

function configureWebPush(env = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;

  webPush.setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:notifications@spotify-song-sorter.local',
    publicKey,
    privateKey
  );
  return true;
}

function isPushConfigured(env = process.env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

async function sendPushNotification(subscription, payload) {
  if (!configureWebPush()) {
    return { skipped: true, reason: 'not_configured' };
  }

  return webPush.sendNotification(subscription, JSON.stringify(payload));
}

module.exports = {
  configureWebPush,
  getVapidPublicKey,
  isPushConfigured,
  sendPushNotification,
};
