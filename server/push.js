const webpush = require('web-push');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

// Llaves VAPID persistentes (se generan una sola vez)
const vapidFile = path.join(DATA_DIR, 'vapid.json');
let vapid;
if (fs.existsSync(vapidFile)) {
  vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
} else {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidFile, JSON.stringify(vapid));
}
webpush.setVapidDetails('mailto:admin@quiniela.local', vapid.publicKey, vapid.privateKey);

function publicKey() { return vapid.publicKey; }

function saveSubscription(userId, subscription) {
  db.prepare(`INSERT INTO push_subs (user_id, endpoint, subscription) VALUES (?, ?, ?)
              ON CONFLICT(user_id, endpoint) DO UPDATE SET subscription = excluded.subscription`)
    .run(userId, subscription.endpoint, JSON.stringify(subscription));
}

function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

// Envía a todos los usuarios suscritos; limpia suscripciones muertas
async function broadcast(title, body, tag) {
  const subs = db.prepare('SELECT user_id, endpoint, subscription FROM push_subs').all();
  const payload = JSON.stringify({ title, body, tag });
  await Promise.allSettled(subs.map(async s => {
    try {
      await webpush.sendNotification(JSON.parse(s.subscription), payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        removeSubscription(s.user_id, s.endpoint);
      }
    }
  }));
}

module.exports = { publicKey, saveSubscription, removeSubscription, broadcast };
