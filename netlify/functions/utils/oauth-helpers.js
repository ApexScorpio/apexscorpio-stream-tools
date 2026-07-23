const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

/**
 * Comparação segura no tempo (Timing-Safe) usando hashes SHA-256 de comprimento fixo
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Obter Store do Netlify Blobs (Fail-Closed)
 */
function getBlobsStore(storeName, customStore = null) {
  if (customStore) return customStore;
  try {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) {
      return getStore({ name: storeName, siteID, token });
    }
    return getStore(storeName);
  } catch (err) {
    throw new Error(`Netlify Blobs Indisponível [${storeName}]: ${err.message}`);
  }
}

/**
 * Cifrar Refresh Token usando AES-256-GCM
 */
function encryptRefreshToken(token, secretKeyStr) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token inválido para cifragem');
  }
  if (!secretKeyStr || typeof secretKeyStr !== 'string') {
    throw new Error('Chave de cifragem ausente');
  }
  const key = crypto.createHash('sha256').update(secretKeyStr).digest(); // 32 bytes
  const iv = crypto.randomBytes(12); // 12 bytes IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    version: '1.0',
    iv: iv.toString('hex'),
    authTag: authTag,
    ciphertext: encrypted,
    createdAt: new Date().toISOString(),
    scope: 'https://www.googleapis.com/auth/youtube.readonly'
  };
}

/**
 * Decifrar Refresh Token usando AES-256-GCM
 */
function decryptRefreshToken(encryptedPayload, secretKeyStr) {
  if (!encryptedPayload || !encryptedPayload.iv || !encryptedPayload.authTag || !encryptedPayload.ciphertext) {
    return null;
  }
  if (!secretKeyStr || typeof secretKeyStr !== 'string') {
    return null;
  }
  try {
    const key = crypto.createHash('sha256').update(secretKeyStr).digest();
    const iv = Buffer.from(encryptedPayload.iv, 'hex');
    const authTag = Buffer.from(encryptedPayload.authTag, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedPayload.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    return null;
  }
}

/**
 * Parse Cookie Header
 */
function parseCookieHeader(cookieHeader, name) {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';');
  for (const c of cookies) {
    const [k, v] = c.trim().split('=');
    if (k === name) return v;
  }
  return null;
}

/**
 * Check Rate Limit via Netlify Blobs (Fail-Closed)
 */
async function checkRateLimit(ipAddress, ratelimitStore) {
  const windowMs = 15 * 60 * 1000; // 15 minutos
  const maxAttempts = 5;
  const now = Date.now();

  const ipHash = crypto.createHash('sha256').update(ipAddress || 'unknown-ip').digest('hex');
  const key = `ratelimit-setup-${ipHash}`;

  const record = await ratelimitStore.getJSON(key);
  if (!record) {
    return { allowed: true, record: { count: 0, resetAt: now + windowMs } };
  }

  if (now > record.resetAt) {
    return { allowed: true, record: { count: 0, resetAt: now + windowMs } };
  }

  if (record.count >= maxAttempts) {
    return { allowed: false, record };
  }

  return { allowed: true, record };
}

/**
 * Record Failed Attempt via Netlify Blobs (Fail-Closed - Não esconde erros)
 */
async function recordFailedAttempt(ipAddress, ratelimitStore) {
  const windowMs = 15 * 60 * 1000;
  const now = Date.now();
  const ipHash = crypto.createHash('sha256').update(ipAddress || 'unknown-ip').digest('hex');
  const key = `ratelimit-setup-${ipHash}`;

  const record = await ratelimitStore.getJSON(key);
  const count = (record && now <= record.resetAt) ? record.count + 1 : 1;
  const resetAt = (record && now <= record.resetAt) ? record.resetAt : now + windowMs;

  // Await e propaga erro se a gravação no Blob falhar (Fail Closed)
  await ratelimitStore.setJSON(key, { count, resetAt });
}

module.exports = {
  safeCompare,
  getBlobsStore,
  encryptRefreshToken,
  decryptRefreshToken,
  parseCookieHeader,
  checkRateLimit,
  recordFailedAttempt
};
