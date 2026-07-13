// Notificaciones web push desde el Worker (VAPID con WebCrypto)
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { getConfig, setConfig } from './db.js';
import { b64url } from './auth.js';

// Llaves VAPID persistentes en la base (se generan una sola vez)
export async function getVapid(env) {
  let publicKey = await getConfig(env, 'vapid_public');
  let privateKey = await getConfig(env, 'vapid_private');
  if (!publicKey || !privateKey) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    publicKey = b64url(await crypto.subtle.exportKey('raw', kp.publicKey));
    privateKey = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
    await setConfig(env, 'vapid_public', publicKey);
    await setConfig(env, 'vapid_private', privateKey);
  }
  return { subject: 'mailto:admin@quiniela.mx', publicKey, privateKey };
}

export async function saveSubscription(env, userId, subscription) {
  await env.DB.prepare(`INSERT INTO push_subs (user_id, endpoint, subscription) VALUES (?, ?, ?)
                        ON CONFLICT(user_id, endpoint) DO UPDATE SET subscription = excluded.subscription`)
    .bind(userId, subscription.endpoint, JSON.stringify(subscription)).run();
}

export async function removeSubscription(env, userId, endpoint) {
  await env.DB.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').bind(userId, endpoint).run();
}

// Envía a todos los suscritos; limpia suscripciones muertas
export async function broadcast(env, title, body, tag) {
  const { results: subs } = await env.DB.prepare('SELECT user_id, endpoint, subscription FROM push_subs').all();
  if (!subs.length) return;
  const vapid = await getVapid(env);
  const message = { data: JSON.stringify({ title, body, tag }), options: { ttl: 3600, urgency: 'high' } };
  await Promise.allSettled(subs.map(async s => {
    try {
      const sub = JSON.parse(s.subscription);
      const payload = await buildPushPayload(message, sub, vapid);
      const res = await fetch(sub.endpoint, payload);
      if (res.status === 404 || res.status === 410) await removeSubscription(env, s.user_id, s.endpoint);
    } catch (err) {
      console.error('push error:', err.message);
    }
  }));
}
