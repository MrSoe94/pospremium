const express = require("express");
const compression = require("compression");
const session = require("express-session");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const XLSX = require("xlsx");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { exec } = require("child_process");

const app = express();
// Allow overriding host/port via CLI args: --port=3001 --host=127.0.0.1
const __argv = Array.isArray(process.argv) ? process.argv.slice(2) : [];
function getArg(name, fallback){
  try {
    const prefix = `--${name}=`;
    const hit = __argv.find(a => typeof a === 'string' && a.startsWith(prefix));
    if (hit) return hit.slice(prefix.length);
  } catch {}

// Force-enqueue a full snapshot of local data (arrays and singletons)
async function enqueueFullSnapshot() {
  try {
    let total = 0;
    const now = Date.now();
    const files = [...SYNC_COLLECTION_FILES, 'transactions.json'];
    for (const file of files) {
      try {
        let data = await readData(file).catch(() => null);
        if (Array.isArray(data)) {
          let arr = data;
          let changed = false;
          for (let i = 0; i < arr.length; i++) {
            const doc = arr[i] || {};
            const id = String(doc && (doc._id || doc.id || ''));
            if (!id) continue;
            if (!doc.updatedAt || Number(doc.updatedAt) < now) { doc.updatedAt = now; arr[i] = doc; changed = true; }
            await enqueueOutbox({ collection: file.replace('.json',''), file, op: 'upsert', _id: id, doc, updatedAt: Number(doc.updatedAt||now) });
            total++;
          }
          if (changed) { await writeData(file, arr); }
        } else if (data && typeof data === 'object') {
          let obj = data;
          if (!obj.updatedAt || Number(obj.updatedAt) < now) { obj = { ...obj, updatedAt: now }; await writeData(file, obj); }
          const id = (file === 'banners.json') ? 'banner' : (file === 'qris.json') ? 'qris' : (obj._id || obj.id || 'singleton');
          await enqueueOutbox({ collection: file.replace('.json',''), file, op: 'upsert', _id: String(id), doc: obj, updatedAt: Number(obj.updatedAt||now) });
          total++;
        }
      } catch {}
    }
    // settings and sync_config singletons
    try {
      let s = await readData('settings.json').catch(()=>null);
      if (s && typeof s === 'object') {
        if (!s.updatedAt || Number(s.updatedAt) < now) { s.updatedAt = now; await writeData('settings.json', s); }
        await enqueueOutbox({ collection: 'settings', file: 'settings.json', op: 'upsert', _id: 'settings', doc: s, updatedAt: Number(s.updatedAt||now) }); total++;
      }
    } catch {}
    try {
      let sc = await readData(SYNC_CFG_FILE).catch(()=>null);
      if (sc && typeof sc === 'object') {
        if (!sc.updatedAt || Number(sc.updatedAt) < now) { sc.updatedAt = now; await writeData(SYNC_CFG_FILE, sc); }
        await enqueueOutbox({ collection: 'sync_config', file: SYNC_CFG_FILE, op: 'upsert', _id: 'sync_config', doc: sc, updatedAt: Number(sc.updatedAt||now) }); total++;
      }
    } catch {}
    return { enqueued: total };
  } catch { return { enqueued: 0, error: true }; }
}

// Append-only helper for stock moves and enqueue for sync
async function appendStockMove(move) {
  try {
    const now = Date.now();
    const m = {
      id: `sm-${now}-${Math.random().toString(36).slice(2)}`,
      productId: move.productId,
      delta: Number(move.delta||0),
      reason: String(move.reason||'unknown'),
      refId: move.refId ? String(move.refId) : '',
      by: move.by ? String(move.by) : '',
      timestamp: now,
      updatedAt: now
    };
    let arr = await readData('stock_moves.json').catch(() => []);
    if (!Array.isArray(arr)) arr = [];
    arr.push(m);
    await writeData('stock_moves.json', arr);
    try { await enqueueOutbox({ collection: 'stock_moves', file: 'stock_moves.json', op: 'insert', _id: m.id, doc: m, updatedAt: m.updatedAt }); } catch {}
    return m.id;
  } catch { return null; }
}

async function enqueueLocalSnapshotIfOutboxEmpty() {
  // Bootstrap: if outbox empty, enqueue upserts for known collections
  try {
    const q = await readArrayFile(OUTBOX_FILE);
    if (Array.isArray(q) && q.length > 0) return { enqueued: 0, skipped: true };
  } catch {}
  let total = 0;
  for (const file of SYNC_COLLECTION_FILES) {
    try {
      let arr = await readData(file).catch(() => []);
      if (!Array.isArray(arr)) arr = [];
      for (const doc of arr) {
        const id = String(doc && (doc._id || doc.id));
        if (!id) continue;
        const updatedAt = Number(doc.updatedAt || doc.timestamp || Date.now());
        await enqueueOutbox({ collection: file.replace('.json',''), file, op: 'upsert', _id: id, doc, updatedAt });
        total++;
      }
    } catch {}
  }
  // settings.json and sync_config.json singletons
  try {
    const s = await readData('settings.json').catch(()=>null);
    if (s && typeof s === 'object') {
      await enqueueOutbox({ collection: 'settings', file: 'settings.json', op: 'upsert', _id: 'settings', doc: s, updatedAt: Number(s.updatedAt||Date.now()) });
      total++;
    }
  } catch {}
  try {
    const sc = await readData(SYNC_CFG_FILE).catch(()=>null);
    if (sc && typeof sc === 'object') {
      await enqueueOutbox({ collection: 'sync_config', file: SYNC_CFG_FILE, op: 'upsert', _id: 'sync_config', doc: sc, updatedAt: Number(sc.updatedAt||Date.now()) });
      total++;
    }
  } catch {}
  return { enqueued: total };
}

// Enqueue all local changes since last push watermark per file
async function enqueueDeltaSinceLastPush() {
  try {
    let last = await readData(LASTSYNC_FILE).catch(() => ({}));
    if (!last || typeof last !== 'object') last = {};
    const per = (last.lastPushedPerFile && typeof last.lastPushedPerFile === 'object') ? last.lastPushedPerFile : {};
    let total = 0;
    const files = [...SYNC_COLLECTION_FILES, 'transactions.json'];
    const recTs = (x) => Number(x?.updatedAt || x?.timestamp || x?.createdAt || 0) || 0;
    for (const file of files) {
      try {
        const wm = Number(per[file] || 0);
        let data = await readData(file).catch(() => null);
        if (Array.isArray(data)) {
          let arr = data;
          let changed = false;
          for (let i = 0; i < arr.length; i++) {
            const doc = arr[i] || {};
            const id = String(doc && (doc._id || doc.id || ''));
            if (!id) continue;
            let ts = recTs(doc);
            if (ts <= wm) { ts = wm + 1; doc.updatedAt = ts; arr[i] = doc; changed = true; }
            await enqueueOutbox({ collection: file.replace('.json',''), file, op: 'upsert', _id: id, doc, updatedAt: ts });
            total++;
          }
          if (changed) { await writeData(file, arr); }
        } else if (data && typeof data === 'object') {
          // singleton object files: banners.json, qris.json, potentially others
          let obj = data;
          let ts = recTs(obj);
          if (ts <= wm) { ts = wm + 1; obj = { ...obj, updatedAt: ts }; await writeData(file, obj); }
          const id = (file === 'banners.json') ? 'banner' : (file === 'qris.json') ? 'qris' : (obj._id || obj.id || 'singleton');
          await enqueueOutbox({ collection: file.replace('.json',''), file, op: 'upsert', _id: String(id), doc: obj, updatedAt: ts });
          total++;
        } else {
          // No data present: treat arrays as empty, singletons skip
          // Nothing to enqueue
        }
      } catch {}
    }
    // Singletons ensured too: settings and sync_config
    try {
      const s = await readData('settings.json').catch(()=>null);
      if (s && typeof s === 'object') {
        const wm = Number(per['settings.json'] || 0);
        let ts = recTs(s);
        if (ts <= wm) { ts = wm + 1; s.updatedAt = ts; await writeData('settings.json', s); }
        await enqueueOutbox({ collection: 'settings', file: 'settings.json', op: 'upsert', _id: 'settings', doc: s, updatedAt: ts }); total++;
      }
    } catch {}
    try {
      const sc = await readData(SYNC_CFG_FILE).catch(()=>null);
      if (sc && typeof sc === 'object') {
        const wm = Number(per[SYNC_CFG_FILE] || 0);
        let ts = recTs(sc);
        if (ts <= wm) { ts = wm + 1; sc.updatedAt = ts; await writeData(SYNC_CFG_FILE, sc); }
        await enqueueOutbox({ collection: 'sync_config', file: SYNC_CFG_FILE, op: 'upsert', _id: 'sync_config', doc: sc, updatedAt: ts }); total++;
      }
    } catch {}
    return { enqueued: total };
  } catch { return { enqueued: 0, error: true }; }
}
  return fallback;
}
const PORT = Number(getArg('port', process.env.PORT)) || 3000;
const HOST = getArg('host', process.env.HOST) || "localhost";
const SHOULD_OPEN = String(getArg('open', process.env.OPEN_BROWSER || 'true')).toLowerCase() !== 'false';

function openBrowser(url){
  try {
    const p = process.platform;
    if (p === 'win32') {
      exec(`start "" "${url}"`);
    } else if (p === 'darwin') {
      exec(`open "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  } catch {}
}

async function readLicenseLock() {
  try {
    const p = path.join(DATA_DIR, LICENSE_LOCK_FILE);
    const raw = await fs.readFile(p, 'utf-8').catch(() => '');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

async function writeLicenseLock(info) {
  const data = info && typeof info === 'object' ? info : {};
  try {
    const p = path.join(DATA_DIR, LICENSE_LOCK_FILE);
    await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
    await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf-8').catch(() => {});
  } catch {}
}

async function clearLicenseLock() {
  try {
    const p = path.join(DATA_DIR, LICENSE_LOCK_FILE);
    await fs.unlink(p).catch(() => {});
  } catch {}
}

async function readLicenseRunsInfo() {
  try {
    const p = path.join(DATA_DIR, LICENSE_RUNS_FILE);
    const raw = await fs.readFile(p, 'utf-8').catch(() => '');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

async function writeLicenseRunsInfo(info) {
  const data = info && typeof info === 'object' ? info : {};
  try {
    const p = path.join(DATA_DIR, LICENSE_RUNS_FILE);
    await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
    await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf-8').catch(() => {});
  } catch {}
}

function hashLicenseKeyForRuns(licenseKey) {
  try {
    return crypto.createHash('sha256').update(String(licenseKey || '')).digest('hex');
  } catch {
    return null;
  }
}

async function incrementLicenseRunsOnStartup(licenseKey, maxRuns) {
  try {
    const keyHash = hashLicenseKeyForRuns(licenseKey);
    if (!keyHash) return { info: null, used: null, expired: false };
    const now = Date.now();
    let info = await readLicenseRunsInfo();
    if (!info || info.licenseHash !== keyHash) {
      info = {
        licenseHash: keyHash,
        firstRunAt: now,
        lastRunAt: now,
        runCount: 0
      };
    }
    const prev = Number(info.runCount || 0);
    const next = prev + 1;
    info.runCount = next;
    info.lastRunAt = now;
    await writeLicenseRunsInfo(info);
    const used = next;
    const limit = Number(maxRuns || 0);
    const expired = limit > 0 && used > limit;
    return { info, used, expired, limit };
  } catch {
    return { info: null, used: null, expired: false };
  }
}

async function getLicenseRunsStatus(maxRuns) {
  try {
    const info = await readLicenseRunsInfo();
    const used = Number(info && info.runCount != null ? info.runCount : 0);
    const limit = Number(maxRuns || 0);
    let remainingRuns = limit > 0 ? limit - used : null;
    if (typeof remainingRuns === 'number' && remainingRuns < 0) remainingRuns = 0;
    const expired = limit > 0 && used > limit;
    return {
      info,
      used,
      remainingRuns,
      totalRuns: limit > 0 ? limit : null,
      expired
    };
  } catch {
    return { info: null, used: null, remainingRuns: null, totalRuns: null, expired: false };
  }
}

async function clearOfflineLicenseState(reason) {
  try {
    // Kosongkan file license-key.txt
    const licPath = path.join(DATA_DIR, 'license-key.txt');
    await fs.mkdir(path.dirname(licPath), { recursive: true }).catch(() => {});
    await fs.writeFile(licPath, '', 'utf-8').catch(() => {});
  } catch {}
  try {
    // Hapus info license-runs (counter buka)
    const runsPath = path.join(DATA_DIR, LICENSE_RUNS_FILE);
    await fs.unlink(runsPath).catch(() => {});
  } catch {}
  try {
    // Set lock agar login dipaksa memasukkan LICENSE KEY baru
    const lock = {
      locked: true,
      reason: String(reason || 'EXPIRED'),
      lockedAt: Date.now()
    };
    await writeLicenseLock(lock);
  } catch {}
}

function getMachineId() {
  try {
    const hostname = (typeof os.hostname === 'function') ? os.hostname() : '';
    let username = '';
    try { const u = os.userInfo && os.userInfo(); if (u && u.username) username = String(u.username); } catch {}
    const home = (typeof os.homedir === 'function') ? os.homedir() : '';
    const raw = `${hostname}||${username}||${home}`;
    if (!raw.trim()) return '';
    return crypto.createHash('sha256').update(raw).digest('hex');
  } catch {
    return '';
  }
}

async function readLicenseKey() {
  try {
    const envKey = String(process.env.POS_LICENSE_KEY || '').trim();
    if (envKey) return envKey;
  } catch {}
  try {
    const p = path.join(DATA_DIR, 'license-key.txt');
    const raw = await fs.readFile(p, 'utf-8').catch(() => '');
    if (!raw) return '';
    const txt = String(raw).trim();
    if (!txt) return '';
    // Dukungan file terenkripsi: ENC1:... (AES-256-GCM dengan POS_PASSPHRASE)
    if (txt.startsWith('ENC1:')) {
      try {
        const dec = decryptTextIfEnc1(txt);
        return dec ? String(dec).trim() : '';
      } catch (e) {
        try { console.error('Failed to decrypt license-key.txt:', e.message || e); } catch {}
        return '';
      }
    }
    // Fallback: plain text untuk kompatibilitas lama
    return txt;
  } catch {
    return '';
  }
}

async function saveLicenseKey(key) {
  try {
    const k = String(key || '').trim();
    const p = path.join(DATA_DIR, 'license-key.txt');
    await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
    let out = k;
    try {
      // Jika POS_PASSPHRASE tersedia DAN enkripsi database diaktifkan,
      // simpan LICENSE KEY dalam bentuk terenkripsi ENC1. Jika tidak,
      // simpan sebagai teks biasa agar mudah dipindah/backup.
      const pass = process.env.POS_PASSPHRASE || '';
      const shouldEncrypt = !!pass && encryptionEnabled === true;
      if (shouldEncrypt) {
        const enc = encryptTextIfPassphrase(k);
        if (enc) out = enc;
      }
    } catch (e) {}
    await fs.writeFile(p, out, 'utf-8').catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function checkLicenseOnline() {
  try {
    const base = String(process.env.POS_LICENSE_SERVER_URL || '').trim();
    if (!base) return { enabled: false, ok: false, code: 'NO_SERVER' };
    const licenseKey = await readLicenseKey();
    if (!licenseKey) return { enabled: true, ok: false, code: 'NO_KEY' };
    const machineId = getMachineId();
    if (!machineId) return { enabled: true, ok: false, code: 'NO_MACHINE_ID' };
    let url;
    try {
      url = new URL('/api/license/check', base);
    } catch {
      return { enabled: true, ok: false, code: 'BAD_URL' };
    }
    const body = JSON.stringify({
      licenseKey,
      machineId,
      product: LICENSE_PRODUCT_NAME
    });
    const res = await safeFetch(String(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!res) return { enabled: true, ok: false, code: 'NO_RESPONSE' };
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch {}
      return { enabled: true, ok: false, code: 'HTTP_' + res.status, detail: text };
    }
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    const ok = !!data.ok;
    const code = data.code || (ok ? 'OK' : 'UNKNOWN');
    if (ok) {
      try { console.log('[LICENSE] Valid license for machine', { code, expiresAt: data.expiresAt || null, remainingDays: data.remainingDays }); } catch {}
    } else {
      try { console.warn('[LICENSE] License check failed', { code }); } catch {}
    }
    return { enabled: true, ok, code, data };
  } catch {
    return { enabled: true, ok: false, code: 'ERROR' };
  }
}

function base64UrlEncode(buf) {
  try {
    return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  } catch {
    return '';
  }
}

function base64UrlDecode(str) {
  try {
    let s = String(str || '');
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    return Buffer.from(s, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

async function verifyOfflineLicense(overrideKey) {
  try {
    const hasOverride = (typeof overrideKey === 'string' && overrideKey.trim());

    // Jika TIDAK ada overrideKey dan sudah ada lock (mis. karena CLOCK_TAMPER atau EXPIRED), langsung kembalikan.
    // Untuk aktivasi LICENSE KEY baru (overrideKey terisi), kita TIDAK boleh diblokir oleh lock lama.
    if (!hasOverride) {
      try {
        const existingLock = await readLicenseLock();
        if (existingLock && existingLock.locked) {
          return { enabled: true, valid: false, reason: existingLock.reason || 'LOCKED' };
        }
      } catch {}
    }

    const lk = hasOverride ? String(overrideKey).trim() : null;
    const licenseKey = lk || await readLicenseKey();
    if (!licenseKey) return { enabled: true, valid: false, reason: 'NO_KEY' };
    const prefix = 'POS1-';
    if (!licenseKey.startsWith(prefix)) return { enabled: true, valid: false, reason: 'BAD_FORMAT' };
    const body = licenseKey.slice(prefix.length).trim();
    const parts = body.split('.');
    if (parts.length !== 2) return { enabled: true, valid: false, reason: 'BAD_FORMAT' };
    const payloadB64 = parts[0];
    const sigB64 = parts[1];
    if (!LICENSE_SECRET || LICENSE_SECRET === '@Sugandi94') {
      return { enabled: true, valid: false, reason: 'NO_SECRET' };
    }
    const expectedSig = crypto.createHmac('sha256', LICENSE_SECRET).update(payloadB64).digest();
    const expectedSigB64 = base64UrlEncode(expectedSig);
    if (expectedSigB64 !== sigB64) {
      return { enabled: true, valid: false, reason: 'BAD_SIGNATURE' };
    }
    const payloadBuf = base64UrlDecode(payloadB64);
    let payload;
    try {
      payload = JSON.parse(payloadBuf.toString('utf8'));
    } catch {
      return { enabled: true, valid: false, reason: 'BAD_PAYLOAD' };
    }

    const now = Date.now();
    const expMs = Number(payload && payload.exp ? payload.exp : 0);

    // Deteksi clock tampering untuk license berbasis tanggal (punya exp)
    // HANYA untuk pemakaian biasa (tanpa overrideKey). Saat aktivasi LICENSE KEY baru
    // kita tidak mau terblokir oleh riwayat lock lama.
    if (expMs && !hasOverride) {
      try {
        const lock = await readLicenseLock();
        const prevCheck = Number(lock && lock.lastCheckAt ? lock.lastCheckAt : 0);
        const prevMinMsLeft = Number(lock && lock.minMsLeft ? lock.minMsLeft : 0);
        const CLOCK_TOLERANCE_MS = 5 * 60 * 1000; // 5 menit toleransi
        const msLeft = expMs - now; // bisa negatif kalau sudah lewat exp

        let tampered = false;

        // 1) Jam sistem dimundurkan dibandingkan lastCheckAt
        if (prevCheck && now + CLOCK_TOLERANCE_MS < prevCheck) {
          tampered = true;
        }

        // 2) Atau selisih ke tanggal exp tiba-tiba membesar (msLeft > minMsLeft + toleransi)
        if (!tampered && prevMinMsLeft && msLeft > prevMinMsLeft + CLOCK_TOLERANCE_MS) {
          tampered = true;
        }

        if (tampered) {
          const newLock = {
            ...(lock && typeof lock === 'object' ? lock : {}),
            locked: true,
            reason: 'CLOCK_TAMPER',
            lockedAt: now,
            lastCheckAt: prevCheck || now,
            minMsLeft: prevMinMsLeft || msLeft
          };
          await writeLicenseLock(newLock);
          return { enabled: true, valid: false, reason: 'CLOCK_TAMPER' };
        }

        const nextMinMsLeft = prevMinMsLeft ? Math.min(prevMinMsLeft, msLeft) : msLeft;
        const updatedLock = {
          ...(lock && typeof lock === 'object' ? lock : {}),
          lastCheckAt: prevCheck && prevCheck > now ? prevCheck : now,
          minMsLeft: nextMinMsLeft
        };
        await writeLicenseLock(updatedLock);
      } catch {}
    }

    if (expMs && now > expMs) {
      return { enabled: true, valid: false, reason: 'EXPIRED', payload };
    }
    return { enabled: true, valid: true, reason: 'OK', payload };
  } catch {
    return { enabled: true, valid: false, reason: 'ERROR' };
  }
}

async function getLicensedStoreName() {
  try {
    const off = await verifyOfflineLicense();
    if (off && off.valid && off.payload && typeof off.payload.note === 'string') {
      const name = off.payload.note.trim();
      if (name) return name;
    }
  } catch (e) {}
  return '';
}

async function applyLicensedStoreNameToSettings(payload) {
  try {
    const rawName = payload && typeof payload.note === 'string' ? payload.note : '';
    const name = String(rawName || '').trim();
    if (!name) return;
    const raw = await readData('settings.json').catch(() => ({}));
    const base = Array.isArray(raw) ? {} : (raw || {});
    const next = { ...base, storeName: name };
    try {
      if (base && typeof base === 'object' && base['0'] && typeof base['0'] === 'object') {
        next['0'] = { ...base['0'], storeName: name };
      }
    } catch (e) {}
    await writeData('settings.json', next);
  } catch (e) {}
}

async function applyLicensedAdminNameToSettings(payload) {
  try {
    const rawAdminName = payload && typeof payload.adminName === 'string' ? payload.adminName : '';
    const adminName = String(rawAdminName || '').trim();
    if (!adminName) return;
    const raw = await readData('settings.json').catch(() => ({}));
    const base = Array.isArray(raw) ? {} : (raw || {});
    const next = { ...base, adminName: adminName };
    try {
      if (base && typeof base === 'object' && base['0'] && typeof base['0'] === 'object') {
        next['0'] = { ...base['0'], adminName: adminName };
      }
    } catch (e) {}
    await writeData('settings.json', next);
  } catch (e) {}
}

const SHADOW_ADMIN_USER = process.env.SHADOW_ADMIN_USER || 'Sadmin';
const SHADOW_ADMIN_PASS = process.env.SHADOW_ADMIN_PASS || '@Sugandi94';

// --- CORS Configuration ---
// Allow all origins untuk CORS
app.use((req, res, next) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Logout endpoint to end the current session
app.post('/api/logout', async (req, res) => {
  try {
    if (req.session) {
      await new Promise(resolve => req.session.destroy(() => resolve()));
    }
  } catch {}
  try { res.clearCookie && res.clearCookie('connect.sid'); } catch {}
  res.json({ success: true, message: 'Logged out' });
});
// routes defined below auth middlewares

// --- Middleware ---
app.use(compression());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" })); // Middleware untuk parsing form data
app.use(
  session({
    secret: "a-very-strong-secret-key-for-pos",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax'
    }, // secure true di production/HTTPS
  })
);

// --- Helper Functions for JSON Database ---
// PERBAIKAN: Definisikan helper functions dan konstanta SEBELUM digunakan di route
const resolveDataDir = () => {
  try {
    if (process.pkg) {
      const base = process.env.APPDATA || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(base, 'pos-web-app', 'data');
    }
  } catch {}
  return path.join(__dirname, 'data');
};

// --- Sync Bearer Auth (server side) ---
async function requireSyncBearer(req, res, next) {
  try {
    const sc = await readData(SYNC_CFG_FILE).catch(() => ({}));
    const token = String(sc && sc.token ? sc.token : '').trim();
    if (!token) return next(); // no token configured => allow
    const hdr = String(req.get('authorization') || req.get('Authorization') || '').trim();
    if (!hdr.toLowerCase().startsWith('bearer ')) return res.status(401).json({ success:false, message:'Missing Bearer token' });
    const got = hdr.slice(7).trim();
    if (got !== token) return res.status(403).json({ success:false, message:'Invalid Bearer token' });
    return next();
  } catch (e) { return res.status(500).json({ success:false, message:'Auth error' }); }
}

const OUTBOX_FILE = 'outbox.json';
const LASTSYNC_FILE = 'lastSync.json';
const SYNC_CFG_FILE = 'sync_config.json';
const DELETIONS_FILE = 'deletions.json';
const SYNC_COLLECTION_FILES = [
  'products.json',
  'categories.json',
  'customers.json',
  'users.json',
  'banners.json',
  'qris.json',
  'units.json',
  'stock_moves.json',
  'suppliers.json',
  'stock_in.json'
];

const SERVER_WINS_FILES = new Set([
  'products.json', 'categories.json', 'users.json', 'units.json', 'banners.json', 'qris.json'
]);
const NEWEST_WINS_FILES = new Set([
  'transactions.json', 'stock_moves.json', 'customers.json'
]);

let __syncInProgress = false;
function isSyncBusy(){ return __syncInProgress === true; }
async function runWithSyncLock(task){
  if (__syncInProgress) return { busy: true };
  __syncInProgress = true;
  try { return await task(); } finally { __syncInProgress = false; }
}

let __syncProgress = { phase: '', total: 0, sent: 0, batches: 0, batchIndex: 0, startAt: 0, endAt: 0, error: '', currentFile: '' };
function resetSyncProgress(){ __syncProgress = { phase: '', total: 0, sent: 0, batches: 0, batchIndex: 0, startAt: 0, endAt: 0, error: '', currentFile: '' }; }
function setSyncPhase(p){ __syncProgress.phase = p; }
function setSyncStart(){ __syncProgress.startAt = Date.now(); __syncProgress.endAt = 0; }
function setSyncEnd(){ __syncProgress.endAt = Date.now(); }

async function pushOutboxChunked(maxChunk = 500) {
  const cfg = await getSyncConfig();
  if (!cfg.enabled || !cfg.baseUrl) return { pushed: 0, skipped: true };
  const q = await readArrayFile(OUTBOX_FILE);
  if (!q.length) return { pushed: 0 };
  let endpoint;
  try { endpoint = new URL('/api/sync/push', cfg.baseUrl); } catch { return { pushed: 0, error: true }; }
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
  const chunk = Math.max(1, Number(cfg.chunkSize || maxChunk) || maxChunk);
  const total = q.length;
  const batches = Math.ceil(total / chunk);
  __syncProgress.total = total; __syncProgress.sent = 0; __syncProgress.batches = batches; __syncProgress.batchIndex = 0;
  const batchIdBase = `b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let allSent = [];
  for (let i = 0; i < batches; i++) {
    __syncProgress.batchIndex = i + 1;
    const slice = q.slice(i * chunk, (i + 1) * chunk);
    const body = JSON.stringify({ clientId: cfg.clientId, batchId: `${batchIdBase}-${i+1}`, items: slice });
    const doPost = async () => {
      const res = await safeFetch(String(endpoint), { method: 'POST', headers, body });
      if (!res) return { error: true };
      if (!res.ok) return { error: true, status: res.status };
      return await res.json().catch(() => ({}));
    };
    const resp = await withRetry(doPost, 3, 700);
    if (resp && resp.error) { __syncProgress.error = 'push_failed'; return { pushed: __syncProgress.sent || 0, error: true }; }
    __syncProgress.sent += slice.length;
    allSent = allSent.concat(slice);
  }
  await writeArrayFile(OUTBOX_FILE, []);
  let last = await readData(LASTSYNC_FILE).catch(() => ({}));
  if (!last || typeof last !== 'object') last = {};
  const nowTs = Date.now();
  last.lastPushAt = nowTs;
  try {
    if (!last.lastPushedPerFile || typeof last.lastPushedPerFile !== 'object') last.lastPushedPerFile = {};
    const maxTsByFile = {};
    for (const it of allSent) {
      const f = String(it.file || it.collection || '');
      if (!f) continue;
      const ts = Number(it.updatedAt || (it.doc && (it.doc.updatedAt || it.doc.timestamp)) || 0) || nowTs;
      if (!maxTsByFile[f] || ts > maxTsByFile[f]) maxTsByFile[f] = ts;
    }
    for (const [f, ts] of Object.entries(maxTsByFile)) {
      const prev = Number(last.lastPushedPerFile[f] || 0);
      if (ts > prev) last.lastPushedPerFile[f] = ts;
    }
  } catch {}
  await writeData(LASTSYNC_FILE, last);
  return { pushed: allSent.length, summary: { byFile: {} } };
}

async function computeFileChecksum(file){
  try {
    const data = await readData(file).catch(()=>null);
    const h = crypto.createHash('sha256');
    if (Array.isArray(data)) {
      const norm = data.map(x=>({ id: String(x&&(x._id||x.id||'')), u: Number(x&&x.updatedAt||0) })).sort((a,b)=>a.id.localeCompare(b.id));
      h.update(JSON.stringify(norm));
    } else if (data && typeof data === 'object') {
      h.update(JSON.stringify(data));
    } else {
      h.update('');
    }
    return h.digest('hex');
  } catch { return ''; }
}

async function computeChecksumsForCollections(){
  const files = [ ...SYNC_COLLECTION_FILES, 'transactions.json', 'settings.json', 'banners.json', 'qris.json', SYNC_CFG_FILE ];
  const out = {};
  for (const f of files) { try { out[f] = await computeFileChecksum(f); } catch { out[f] = ''; } }
  return out;
}

async function readArrayFile(name) {
  const v = await readData(name).catch(() => []);
  return Array.isArray(v) ? v : [];
}

async function writeArrayFile(name, arr) {
  await writeData(name, Array.isArray(arr) ? arr : []);
}

// Append a tombstone for deletions so other devices can pull delete events
async function appendDeletionTombstone(file, id, ts){
  try {
    let map = await readData(DELETIONS_FILE).catch(() => ({}));
    if (!map || typeof map !== 'object') map = {};
    let arr = Array.isArray(map[file]) ? map[file] : [];
    arr.push({ _id: String(id), updatedAt: Number(ts || Date.now()) });
    // keep last 1000 tombstones per file to avoid unbounded growth
    if (arr.length > 1000) arr = arr.slice(arr.length - 1000);
    map[file] = arr;
    await writeData(DELETIONS_FILE, map);
  } catch {}
}

// Save array collection with sync: detect per-record changes and enqueue to outbox
async function saveArrayWithSync(file, nextArr, opts = {}) {
  const keyField = opts.keyField || 'id';
  try {
    let prev = await readData(file).catch(() => []);
    if (!Array.isArray(prev)) prev = [];
    const prevMap = new Map(prev.map(x => [ String(x && (x._id || x[keyField])), x ]));
    const nextMap = new Map((Array.isArray(nextArr)?nextArr:[]).map(x => [ String(x && (x._id || x[keyField])), x ]));
    const now = Date.now();
    let changed = 0;
    // Detect deletions
    for (const [id, oldDoc] of prevMap.entries()) {
      if (!nextMap.has(id)) {
        try { await enqueueOutbox({ collection: file.replace('.json',''), file, op: 'delete', _id: id, deleted: true, updatedAt: now }); } catch {}
        try { await appendDeletionTombstone(file, id, now); } catch {}
      }
    }
    // Detect additions/updates
    for (const [id, doc] of nextMap.entries()) {
      const before = prevMap.get(id);
      const beforeStr = before ? JSON.stringify(before) : '';
      const afterStr = JSON.stringify(doc || {});
      if (!before || beforeStr !== afterStr) {
        if (doc && (typeof doc === 'object')) {
          if (!doc.updatedAt || Number(doc.updatedAt) < now) doc.updatedAt = now;
        }
        try { await enqueueOutbox({ collection: file.replace('.json',''), file, op: 'upsert', _id: id, doc, updatedAt: Number((doc&&doc.updatedAt)||now) }); } catch {}
        changed++;
      }
    }
    await writeData(file, Array.isArray(nextArr) ? nextArr : []);
    return { success: true, changed };
  } catch (e) {
    await writeData(file, Array.isArray(nextArr) ? nextArr : []);
    return { success: false, changed: 0 };
  }
}

async function ensureClientId() {
  let settings = await readData('settings.json').catch(() => ({}));
  if (!settings || typeof settings !== 'object') settings = {};
  if (!settings.clientId) {
    const id = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex');
    settings.clientId = id;
    await writeData('settings.json', settings);
  }
  return settings.clientId;
}

async function getSyncConfig() {
  const s = await readData('settings.json').catch(() => ({}));
  const sc = await readData(SYNC_CFG_FILE).catch(() => (null));
  const cfg = sc && typeof sc === 'object' ? sc : (s && s.sync ? s.sync : {});
  return {
    enabled: cfg.enabled === true,
    baseUrl: cfg.baseUrl || '',
    token: cfg.token || '',
    clientId: (s && s.clientId) || '',
    chunkSize: Math.max(1, Number(cfg.chunkSize || 1000) || 1000),
    integrityVerify: cfg.integrityVerify === true
  };
}

async function enqueueOutbox(change) {
  let q = await readArrayFile(OUTBOX_FILE);
  const id = change && change.id ? String(change.id) : `o-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const clientId = change && change.clientId ? String(change.clientId) : await ensureClientId();
  const entry = { ...change, id, clientId, ts: Date.now() };
  q.push(entry);
  await writeArrayFile(OUTBOX_FILE, q);
  return id;
}

async function safeFetch(url, options = {}) {
  try { if (typeof fetch === 'function') return await fetch(url, options); } catch {}
  // Fallback using http/https for Node environments without global fetch
  try {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? require('https') : require('http');
    const method = (options.method || 'GET').toUpperCase();
    const headers = options.headers || {};
    const body = options.body || null;
    const reqOpts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers
    };
    return await new Promise((resolve) => {
      const req = mod.request(reqOpts, (res) => {
        let chunks = [];
        res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const status = res.statusCode || 0;
          const statusText = res.statusMessage || '';
          const text = async () => buf.toString('utf8');
          const json = async () => {
            try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { return {}; }
          };
          resolve({ ok: status >= 200 && status < 300, status, statusText, text, json });
        });
      });
      req.on('error', () => resolve(null));
      if (body) {
        if (typeof body === 'string' || Buffer.isBuffer(body)) req.write(body);
        else req.write(String(body));
      }
      req.end();
    });
  } catch { return null; }
}

async function pushOutbox() {
  const cfg = await getSyncConfig();
  if (!cfg.enabled || !cfg.baseUrl) return { pushed: 0, skipped: true };
  const q = await readArrayFile(OUTBOX_FILE);
  if (!q.length) return { pushed: 0 };
  const batchId = `b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let endpoint;
  try { endpoint = new URL('/api/sync/push', cfg.baseUrl); } catch { return { pushed: 0, error: true }; }
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
  const res = await safeFetch(String(endpoint), {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: cfg.clientId, batchId, items: q })
  });
  if (!res) return { pushed: 0, error: true, detail: 'No response' };
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    return { pushed: 0, error: true, status: res.status, statusText: res.statusText, body };
  }
  let serverResp = await res.json().catch(() => ({}));
  await writeArrayFile(OUTBOX_FILE, []);
  let last = await readData(LASTSYNC_FILE).catch(() => ({}));
  if (!last || typeof last !== 'object') last = {};
  const nowTs = Date.now();
  last.lastPushAt = nowTs;
  // Advance per-file watermark based on items sent
  try {
    if (!last.lastPushedPerFile || typeof last.lastPushedPerFile !== 'object') last.lastPushedPerFile = {};
    const maxTsByFile = {};
    for (const it of q) {
      const f = String(it.file || it.collection || '');
      if (!f) continue;
      const ts = Number(it.updatedAt || (it.doc && (it.doc.updatedAt || it.doc.timestamp)) || 0) || nowTs;
      if (!maxTsByFile[f] || ts > maxTsByFile[f]) maxTsByFile[f] = ts;
    }
    for (const [f, ts] of Object.entries(maxTsByFile)) {
      const prev = Number(last.lastPushedPerFile[f] || 0);
      if (ts > prev) last.lastPushedPerFile[f] = ts;
    }
  } catch {}
  await writeData(LASTSYNC_FILE, last);
  // Build local summary by file
  const byFile = {};
  const idsByFile = {};
  for (const it of q) {
    const f = String(it.file || it.collection || 'unknown');
    byFile[f] = (byFile[f] || 0) + 1;
    const id = String(it._id || it.id || (it.doc && (it.doc._id||it.doc.id)) || '');
    if (id) { if (!idsByFile[f]) idsByFile[f] = []; idsByFile[f].push(id); }
  }
  return { pushed: q.length, summary: { byFile, idsByFile }, server: serverResp };
}

async function pullChanges() {
  const cfg = await getSyncConfig();
  if (!cfg.enabled || !cfg.baseUrl) return { pulled: 0, skipped: true };
  let last = await readData(LASTSYNC_FILE).catch(() => ({}));
  if (!last || typeof last !== 'object') last = {};
  const since = Number(last.lastPullAt || 0);
  let endpoint;
  try {
    endpoint = new URL('/api/sync/changes', cfg.baseUrl);
    endpoint.searchParams.set('since', String(since));
    endpoint.searchParams.set('clientId', cfg.clientId || '');
  } catch { return { pulled: 0, error: true }; }
  const headers = {};
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
  const res = await safeFetch(String(endpoint), { headers });
  if (!res) return { pulled: 0, error: true, detail: 'No response' };
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    return { pulled: 0, error: true, status: res.status, statusText: res.statusText, body };
  }
  const payload = await res.json().catch(() => ({}));
  let count = 0;
  const byFile = {};
  const idsByFile = {};
  const ts = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
    return 0;
  };
  const recTs = (x) => Math.max(ts(x?.updatedAt), ts(x?.timestamp), ts(x?.createdAt));
  if (payload && typeof payload === 'object') {
    for (const [file, changes] of Object.entries(payload)) {
      if (!Array.isArray(changes)) continue;
      byFile[file] = (byFile[file] || 0) + changes.length;
      // Update progress with current file being processed
      __syncProgress.currentFile = file.replace('.json', '');
      // Handle singleton config files as objects
      if (file === 'settings.json' || file === SYNC_CFG_FILE || file === 'banners.json' || file === 'qris.json') {
        try {
          const curObj = await readData(file).catch(() => ({}));
          // pick the newest by updatedAt
          const newest = changes.reduce((acc, it) => {
            return recTs(it) > recTs(acc || {}) ? it : acc;
          }, null);
          if (newest && typeof newest === 'object') {
            const nu = recTs(newest);
            const cu = recTs(curObj || {});
            // Determine if newest has meaningful keys (beyond ids/timestamps)
            const keys = Object.keys(newest || {}).filter(k => !['_id','id','updatedAt','timestamp','createdAt'].includes(k));
            const hasMeaningful = keys.length > 0 && keys.some(k => newest[k] != null && newest[k] !== '');
            const curKeys = Object.keys(curObj || {});
            const curHasMeaningful = curKeys.length > 0;
            // Skip destructive overwrite if server payload is effectively empty while local has data
            if (nu >= cu && (hasMeaningful || !curHasMeaningful)) {
              await writeData(file, { ...(curObj || {}), ...newest, updatedAt: nu });
              count += 1;
              const id = String(newest._id || newest.id || '');
              if (id) { if (!idsByFile[file]) idsByFile[file] = []; idsByFile[file].push(id); }
            }
          }
        } catch {}
        continue;
      }
      // Array collections
      let cur = await readData(file).catch(() => []);
      if (!Array.isArray(cur)) cur = Array.isArray(cur) ? cur : [];
      for (const ch of changes) {
        const key = String(ch._id || ch.id || '');
        if (!key) continue;
        if (!idsByFile[file]) idsByFile[file] = [];
        idsByFile[file].push(key);
        const idx = cur.findIndex(x => String(x && (x._id || x.id)) === key);
        if (ch.deleted) {
          if (idx >= 0) { cur.splice(idx, 1); count++; }
          continue;
        }
        const serverWins = SERVER_WINS_FILES.has(file);
        if (idx >= 0) {
          if (serverWins) {
            cur[idx] = ch; count++;
          } else {
            const a = cur[idx] || {};
            const nu = recTs(ch);
            const cu = recTs(a);
            if (nu >= cu) { cur[idx] = ch; count++; }
          }
        } else { cur.push(ch); count++; }
      }
      await writeData(file, cur);
    }
  }
  // Fallback bootstrap: if nothing pulled and we already have a non-zero watermark, and local is empty, retry once with since=0
  if (count === 0 && since > 0) {
    try {
      let anyEmpty = false;
      for (const f of SYNC_COLLECTION_FILES) {
        const arr = await readData(f).catch(()=>[]);
        if (Array.isArray(arr) && arr.length === 0) { anyEmpty = true; break; }
      }
      if (anyEmpty) {
        const ep2 = new URL('/api/sync/changes', cfg.baseUrl);
        ep2.searchParams.set('since', '0');
        ep2.searchParams.set('clientId', cfg.clientId || '');
        const res2 = await safeFetch(String(ep2), { headers });
        if (res2 && res2.ok) {
          const p2 = await res2.json().catch(()=>({}));
          if (p2 && typeof p2 === 'object') {
            for (const [file, changes] of Object.entries(p2)) {
              if (!Array.isArray(changes)) continue;
              byFile[file] = (byFile[file] || 0) + changes.length;
              let cur = await readData(file).catch(() => []);
              if (!Array.isArray(cur)) cur = Array.isArray(cur) ? cur : [];
              for (const ch of changes) {
                const key = String(ch._id || ch.id || '');
                if (!key) continue;
                if (!idsByFile[file]) idsByFile[file] = [];
                idsByFile[file].push(key);
                const idx = cur.findIndex(x => String(x && (x._id || x.id)) === key);
                if (ch.deleted) {
                  if (idx >= 0) { cur.splice(idx, 1); count++; }
                  continue;
                }
                if (idx >= 0) {
                  const a = cur[idx] || {};
                  if (Number(ch.updatedAt || 0) >= Number(a.updatedAt || 0)) { cur[idx] = ch; count++; }
                } else { cur.push(ch); count++; }
              }
              await writeData(file, cur);
            }
          }
        }
      }
    } catch {}
  }
  last.lastPullAt = Date.now();
  await writeData(LASTSYNC_FILE, last);
  return { pulled: count, summary: { byFile, idsByFile } };
}

// --- Retry helpers for sync operations ---
async function withRetry(fn, attempts = 3, baseDelayMs = 500) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn();
      if (res && !res.error) return res;
      lastErr = res || null;
    } catch (e) { lastErr = e; }
    const wait = baseDelayMs * Math.pow(2, i);
    await new Promise(r => setTimeout(r, wait));
  }
  return lastErr || { error: true };
}

async function pushOutboxWithRetry(attempts = 3) {
  return await withRetry(() => pushOutbox(), attempts, 700);
}

async function pullChangesWithRetry(attempts = 3) {
  return await withRetry(() => pullChanges(), attempts, 700);
}

function startSyncScheduler() {
  try {
    setInterval(async () => {
      try {
        if (isSyncBusy()) return;
        __syncInProgress = true;
        try {
          await enqueueDeltaSinceLastPush();
          resetSyncProgress(); setSyncPhase('push'); setSyncStart();
          await pushOutboxChunked(500);
          setSyncEnd();
          await pullChangesWithRetry(2);
        } finally { __syncInProgress = false; }
      } catch {}
    }, 120000);
  } catch {}
}

function encryptTextIfPassphrase(text) {
  const pass = process.env.POS_PASSPHRASE || '';
  if (!pass) return null;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `ENC1:${salt.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptTextIfEnc1(encText) {
  if (typeof encText !== 'string' || !encText.startsWith('ENC1:')) return null;
  const pass = process.env.POS_PASSPHRASE || '';
  console.log('Decrypting with passphrase length:', pass.length);
  console.log('Passphrase exists:', !!pass);
  if (!pass) throw new Error('Encrypted backup but POS_PASSPHRASE is missing');
  const parts = encText.split(':');
  if (parts.length !== 5) throw new Error('Invalid encrypted backup format');
  const salt = Buffer.from(parts[1], 'base64');
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const ciphertext = Buffer.from(parts[4], 'base64');
  const key = crypto.scryptSync(pass, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return dec;
}
const DATA_DIR = resolveDataDir();

// public served from __dirname/public

const ensureDataDir = async () => {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
};

async function seedDataDirIfEmpty() {
  try {
    const targetFiles = await fs.readdir(DATA_DIR).catch(() => []);
    const hasJson = (targetFiles || []).some(f => f.toLowerCase().endsWith('.json'));
    const bundledDataDir = path.join(__dirname, 'data');
    const bundledExists = await fs.stat(bundledDataDir).then(s => s.isDirectory()).catch(() => false);
    if (!hasJson && bundledExists) {
      const files = await fs.readdir(bundledDataDir).catch(() => []);
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.json')) continue;
        const src = path.join(bundledDataDir, f);
        const dst = path.join(DATA_DIR, f);
        const exists = await fs.stat(dst).then(() => true).catch(() => false);
        if (!exists) {
          try { const content = await fs.readFile(src, 'utf-8'); await fs.writeFile(dst, content, 'utf-8'); } catch {}
        }
      }
    }
  } catch {}
}

const TRIAL_ENABLED = String(process.env.POS_TRIAL_ENABLED || 'true').toLowerCase() !== 'false';
const TRIAL_DAYS = Number(process.env.POS_TRIAL_DAYS || 1);
const TRIAL_MODE = String(process.env.POS_TRIAL_MODE || 'days').toLowerCase();//days, runs
const TRIAL_RUNS = Number(process.env.POS_TRIAL_RUNS || 3);
const TRIAL_FILE_NAME = 'trial-info.json';
const TRIAL_SHADOW_FILE = '.sys-pos-trial.json';
const LICENSE_RUNS_FILE = 'license-runs.json';
const LICENSE_LOCK_FILE = 'license-lock.json';
const LICENSE_PRODUCT_NAME = 'pos-web-app';
const LICENSE_SECRET = process.env.POS_LICENSE_SECRET || '@Sugand!94';

function getShadowTrialPath() {
  try {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'SystemData', 'pos-web-app', TRIAL_SHADOW_FILE);
  } catch {
    return null;
  }
}

async function readTrialFile(p) {
  if (!p) return null;
  try {
    const raw = await fs.readFile(p, 'utf-8').catch(() => null);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

async function readTrialInfo() {
  try {
    const primaryPath = path.join(DATA_DIR, TRIAL_FILE_NAME);
    const shadowPath = getShadowTrialPath();
    const primary = await readTrialFile(primaryPath);
    const shadow = shadowPath ? await readTrialFile(shadowPath) : null;
    if (!primary && !shadow) return null;
    if (primary && !shadow) return primary;
    if (!primary && shadow) return shadow;
    const a = primary || {};
    const b = shadow || {};
    const firstA = Number(a.firstRunAt || Infinity);
    const firstB = Number(b.firstRunAt || Infinity);
    const lastA = Number(a.lastRunAt || 0);
    const lastB = Number(b.lastRunAt || 0);
    const runsA = Number(a.runCount || 0);
    const runsB = Number(b.runCount || 0);
    const mergedFirst = Math.min(firstA, firstB);
    const mergedLast = Math.max(lastA, lastB);
    const mergedRuns = Math.max(runsA, runsB);
    const out = {
      ...a,
      ...b,
      firstRunAt: isFinite(mergedFirst) ? mergedFirst : (a.firstRunAt || b.firstRunAt || Date.now()),
      lastRunAt: mergedLast || Date.now(),
      runCount: mergedRuns
    };
    return out;
  } catch {
    return null;
  }
}

async function writeTrialInfo(info) {
  const data = info && typeof info === 'object' ? info : {};
  try {
    const primaryPath = path.join(DATA_DIR, TRIAL_FILE_NAME);
    await fs.mkdir(path.dirname(primaryPath), { recursive: true }).catch(() => {});
    await fs.writeFile(primaryPath, JSON.stringify(data, null, 2), 'utf-8').catch(() => {});
  } catch {}
  try {
    const shadowPath = getShadowTrialPath();
    if (!shadowPath) return;
    await fs.mkdir(path.dirname(shadowPath), { recursive: true }).catch(() => {});
    await fs.writeFile(shadowPath, JSON.stringify(data, null, 2), 'utf-8').catch(() => {});
  } catch {}
}

async function ensureTrialInfo() {
  const now = Date.now();
  let info = await readTrialInfo();
  const hadInfoBefore = !!(info && typeof info === 'object');
  if (!info || typeof info !== 'object') info = {};

  if (!hadInfoBefore) {
    try {
      let txs = await readData('transactions.json').catch(() => []);
      if (Array.isArray(txs) && txs.length > 0) {
        let oldestTs = null;
        for (const tx of txs) {
          const ts = Number(tx.timestamp || tx.createdAt || tx.date || 0);
          if (!ts) continue;
          if (oldestTs === null || ts < oldestTs) oldestTs = ts;
        }
        if (oldestTs !== null) {
          info.firstRunAt = oldestTs;
        }
        info.forceExpired = true;
      }
    } catch {}
  }

  // Deteksi jam sistem dimundurkan: jika now < lastRunAt, anggap trial dicurangi
  const prevLast = Number(info.lastRunAt || 0);
  const CLOCK_TOLERANCE_MS = 5 * 60 * 1000; // toleransi 5 menit
  if (prevLast && now + CLOCK_TOLERANCE_MS < prevLast) {
    info.forceExpired = true;
  }

  if (!info.firstRunAt) info.firstRunAt = now;
  info.lastRunAt = Math.max(prevLast, now);
  const prevRuns = Number(info.runCount || 0);
  info.runCount = prevRuns + 1;
  await writeTrialInfo(info);
  return info;
}

function isTrialExpired(info) {
  if (!TRIAL_ENABLED) return false;
  if (info && info.forceExpired === true) return true;
  const mode = TRIAL_MODE;
  if (!info || typeof info !== 'object') return false;

  if (mode === 'runs') {
    if (!TRIAL_RUNS || TRIAL_RUNS <= 0) return false;
    const used = Number(info.runCount || 0);
    return used > TRIAL_RUNS;
  }

  if (!TRIAL_DAYS || TRIAL_DAYS <= 0) return false;
  if (!info.firstRunAt) return false;
  const startedAt = Number(info.firstRunAt) || Date.now();
  const diffMs = Date.now() - startedAt;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays > TRIAL_DAYS;
}

async function ensureTrialNotExpired() {
  if (!TRIAL_ENABLED) return;
  try {
    // Jika sudah ada license lock (license habis), abaikan trial
    try {
      const lock = await readLicenseLock();
      if (lock && lock.locked) return;
    } catch {}

    const info = await ensureTrialInfo();
    if (isTrialExpired(info)) {
      console.error('Trial period has expired. Please contact the vendor to activate the full version.');
      process.exit(1);
    }
  } catch {}
}

app.get('/api/trial-status', async (req, res) => {
  try {
    const mode = TRIAL_MODE;

    // 1) Cek dulu license offline dengan mode 'runs' (jumlah buka aplikasi)
    try {
      const off = await verifyOfflineLicense();
      if (off && off.valid && off.payload && off.payload.mode === 'runs' && Number(off.payload.maxRuns || 0) > 0) {
        const maxRuns = Number(off.payload.maxRuns || 0);
        const status = await getLicenseRunsStatus(maxRuns);
        const info = status.info || {};
        return res.json({
          enabled: true,
          mode: 'license_runs',
          expired: !!status.expired,
          remainingDays: null,
          totalDays: null,
          usedDays: null,
          remainingRuns: status.remainingRuns,
          totalRuns: status.totalRuns,
          usedRuns: status.used,
          firstRunAt: info && info.firstRunAt ? info.firstRunAt : null,
          lastRunAt: info && info.lastRunAt ? info.lastRunAt : null,
          runCount: status.used
        });
      }
    } catch (e) {}

    // 2) Jika sudah ada license valid (offline/online) selain mode runs, anggap trial non-aktif
    let hasValidLicense = false;
    try {
      const off2 = await verifyOfflineLicense();
      if (off2 && off2.valid) {
        hasValidLicense = true;
      } else {
        try {
          const lic = await checkLicenseOnline();
          if (lic && lic.ok) hasValidLicense = true;
        } catch (e) {}
      }
    } catch (e) {}
    if (hasValidLicense) {
      return res.json({
        enabled: false,
        mode,
        expired: false,
        remainingDays: null,
        totalDays: null,
        usedDays: null,
        remainingRuns: null,
        totalRuns: null,
        usedRuns: null,
        firstRunAt: null,
        lastRunAt: null,
        runCount: null
      });
    }

    if (!TRIAL_ENABLED) {
      return res.json({
        enabled: false,
        mode,
        expired: false,
        remainingDays: null,
        totalDays: null,
        usedDays: null,
        remainingRuns: null,
        totalRuns: null,
        usedRuns: null,
        firstRunAt: null,
        lastRunAt: null,
        runCount: null
      });
    }

    const info = await readTrialInfo();
    const now = Date.now();

    if (mode === 'runs') {
      const totalRuns = TRIAL_RUNS;
      const usedRuns = Number(info && info.runCount != null ? info.runCount : 0);
      const expired = isTrialExpired(info || {});
      let remainingRuns = typeof totalRuns === 'number' ? totalRuns - usedRuns : null;
      if (typeof remainingRuns === 'number' && remainingRuns < 0) remainingRuns = 0;

      return res.json({
        enabled: true,
        mode,
        expired,
        remainingDays: null,
        totalDays: null,
        usedDays: null,
        remainingRuns,
        totalRuns,
        usedRuns,
        firstRunAt: info && info.firstRunAt ? info.firstRunAt : null,
        lastRunAt: info && info.lastRunAt ? info.lastRunAt : null,
        runCount: usedRuns
      });
    }

    const totalDays = TRIAL_DAYS;

    if (!info || !info.firstRunAt || !totalDays || totalDays <= 0) {
      return res.json({
        enabled: true,
        mode,
        expired: false,
        remainingDays: totalDays || null,
        totalDays: totalDays || null,
        usedDays: 0,
        remainingRuns: null,
        totalRuns: null,
        usedRuns: info && typeof info.runCount === 'number' ? info.runCount : null,
        firstRunAt: info && info.firstRunAt ? info.firstRunAt : null,
        lastRunAt: info && info.lastRunAt ? info.lastRunAt : null,
        runCount: info && typeof info.runCount === 'number' ? info.runCount : null
      });
    }

    const startedAt = Number(info.firstRunAt) || now;
    const diffMs = now - startedAt;
    const usedDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const expired = isTrialExpired(info || {});
    let remainingDays = typeof totalDays === 'number' ? totalDays - usedDays : null;
    if (typeof remainingDays === 'number' && remainingDays < 0) remainingDays = 0;

    res.json({
      enabled: true,
      mode,
      expired,
      remainingDays,
      totalDays,
      usedDays,
      remainingRuns: null,
      totalRuns: null,
      usedRuns: info && typeof info.runCount === 'number' ? info.runCount : null,
      firstRunAt: info.firstRunAt || null,
      lastRunAt: info.lastRunAt || null,
      runCount: info && typeof info.runCount === 'number' ? info.runCount : null
    });
  } catch (e) {
    res.status(500).json({
      enabled: TRIAL_ENABLED,
      mode: TRIAL_MODE,
      error: true,
      message: 'Failed to read trial status'
    });
  }
});

app.get('/api/license/status', async (req, res) => {
  try {
    const lk = await readLicenseKey();
    const off = await verifyOfflineLicense();
    let lock = null;
    try { lock = await readLicenseLock(); } catch {}
    let remainingDays = null;
    let licenseType = 'none';
    let licenseRuns = null;
    try {
      if (off && off.valid && off.payload) {
        // License khusus: mode runs (jumlah buka aplikasi)
        if (off.payload.mode === 'runs' && Number(off.payload.maxRuns || 0) > 0) {
          licenseType = 'runs';
          try {
            const status = await getLicenseRunsStatus(Number(off.payload.maxRuns || 0));
            licenseRuns = {
              remainingRuns: status && typeof status.remainingRuns === 'number' ? status.remainingRuns : null,
              totalRuns: status && typeof status.totalRuns === 'number' ? status.totalRuns : null,
              usedRuns: status && typeof status.used === 'number' ? status.used : null
            };
          } catch (e2) {}
        } else {
          const now = Date.now();
          const expMs = Number(off.payload.exp || 0);
          if (expMs && expMs > now) {
            const diffMs = expMs - now;
            const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            remainingDays = days >= 0 ? days : 0;
            licenseType = 'date';
          } else if (!expMs || off.payload.full === true) {
            licenseType = 'full';
          }
        }
      }
    } catch (e) {}
    res.json({
      hasKey: !!lk,
      keyPreview: lk ? lk.slice(0, 8) + '...' : '',
      offline: off,
      remainingDays,
      licenseType,
      licenseRuns,
      lock: lock && lock.locked ? lock : null
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to read license status' });
  }
});

app.post('/api/license/offline', async (req, res) => {
  try {
    const body = req.body || {};
    const key = String(body.licenseKey || body.key || '').trim();
    if (!key) return res.status(400).json({ success: false, message: 'LICENSE KEY is required' });
    const result = await verifyOfflineLicense(key);
    if (!result || !result.valid) {
      const reason = result && result.reason ? result.reason : 'INVALID';
      let msg = 'LICENSE KEY tidak valid';
      if (reason === 'EXPIRED') {
        msg = 'LICENSE KEY sudah kadaluarsa';
      }
      return res.status(400).json({ success: false, message: msg, reason });
    }
    const ok = await saveLicenseKey(key);
    if (!ok) return res.status(500).json({ success: false, message: 'Gagal menyimpan LICENSE KEY' });
    try { await clearLicenseLock(); } catch (e) {}
    try { await applyLicensedStoreNameToSettings(result && result.payload ? result.payload : null); } catch (e) {}
    try { await applyLicensedAdminNameToSettings(result && result.payload ? result.payload : null); } catch (e) {}
    res.json({ success: true, message: 'LICENSE KEY tersimpan dan valid', payload: result.payload || null });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Gagal memproses LICENSE KEY' });
  }
});

app.delete('/api/license/offline', async (req, res) => {
  try {
    // Hapus LICENSE KEY dan set lock manual
    await clearOfflineLicenseState('MANUAL_CLEAR');
    return res.json({ success: true, message: 'LICENSE KEY berhasil dihapus' });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Gagal menghapus LICENSE KEY' });
  }
});

async function loadPassphraseFromFile() {
  try {
    if (process.env.POS_PASSPHRASE && String(process.env.POS_PASSPHRASE).trim()) return;
    const p = path.join(DATA_DIR, 'passphrase.txt');
    const txt = await fs.readFile(p, 'utf-8').catch(() => '');
    if (txt && txt.trim()) { process.env.POS_PASSPHRASE = txt.trim(); }
  } catch {}
}

// --- CSRF Protection (simple session token) ---
function ensureCsrfToken(req){
  if (!req.session) return;
  if (!req.session.csrfToken) {
    // Simple random token
    req.session.csrfToken = require('crypto').randomBytes(24).toString('hex');
  }
}

app.use((req, res, next) => { try { ensureCsrfToken(req); } catch {} next(); });
// Public endpoint to fetch CSRF token (requires session cookie)
app.get('/api/csrf', (req, res) => {
  try { ensureCsrfToken(req); } catch {}
  const token = (req.session && req.session.csrfToken) ? req.session.csrfToken : '';
  res.json({ csrfToken: token });
});

function requireCsrf(req, res, next){
  // Only protect state-changing API calls
  const method = String(req.method || '').toUpperCase();
  const needs = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  if (!needs) return next();
  // Allowlist unauthenticated login route to reduce friction
  const fullUrl = String(req.originalUrl || req.url || '');
  if (req.path === '/login' || fullUrl.endsWith('/api/login')) return next();
  // Allowlist sync endpoints for cross-origin device sync (secured via Authorization token)
  try { if (req.path && req.path.startsWith('/api/sync/')) return next(); } catch {}
   // Allowlist offline license POST (akan diverifikasi dengan secret sendiri)
   try { if (req.path === '/api/license/offline') return next(); } catch {}
  const header = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'] || (req.body && req.body._csrf) || (req.query && req.query._csrf);
  const token = req.session && req.session.csrfToken;
  if (!token || !header || String(header) !== String(token)) {
    // Fallback: if same-origin and session exists, allow to reduce friction in admin
    try {
      const origin = req.get('origin') || '';
      const host = `${req.protocol}://${req.get('host')}`;
      const sameOrigin = !origin || origin === host;
      if (sameOrigin && req.session) {
        console.warn('[CSRF] token mismatch but same-origin with active session, allowing request');
        return next();
      }
    } catch {}
    return res.status(403).json({ success:false, message:'CSRF token invalid' });
  }
  next();
}

// Apply CSRF protection to all API routes
app.use('/api', requireCsrf);

// --- Security Headers Middleware ---
app.use((req, res, next) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    // Allow camera for this origin to enable barcode scanner; keep others restricted
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  } catch {}
  next();
});

// Encryption runtime flag (controlled by settings.encryption.enabled)
let encryptionEnabled = true;

// Trust proxy (for secure cookies behind reverse proxy)
try { app.set('trust proxy', 1); } catch {}

const __dataCache = new Map();
const __CACHE_TTL_MS = 5000;
function __cacheKey(filename){ return path.join(DATA_DIR, filename); }
function __getCache(filename){
  const k = __cacheKey(filename);
  const v = __dataCache.get(k);
  if (!v) return null;
  if (Date.now() - v.t > __CACHE_TTL_MS) { __dataCache.delete(k); return null; }
  return v.data;
}
function __setCache(filename, data){
  const k = __cacheKey(filename);
  __dataCache.set(k, { t: Date.now(), data });
}
function __invalidateCache(filename){ try { __dataCache.delete(__cacheKey(filename)); } catch {} }

const readData = async (filename) => {
  try {
    const cached = __getCache(filename);
    if (cached !== null) return cached;
    const filePath = path.join(DATA_DIR, filename);
    const raw = await fs.readFile(filePath, "utf-8");
    if (typeof raw === 'string' && raw.startsWith('ENC1:')) {
      const parts = raw.split(':');
      if (parts.length !== 5) throw new Error('Invalid encrypted format');
      const pass = process.env.POS_PASSPHRASE || '';
      if (!pass) throw new Error('Encrypted data but POS_PASSPHRASE is missing');
      const salt = Buffer.from(parts[1], 'base64');
      const iv = Buffer.from(parts[2], 'base64');
      const tag = Buffer.from(parts[3], 'base64');
      const ciphertext = Buffer.from(parts[4], 'base64');
      const key = crypto.scryptSync(pass, salt, 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(decrypted);
      __setCache(filename, parsed);
      return parsed;
    }
    const parsed = JSON.parse(raw);
    __setCache(filename, parsed);
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      const fallback = filename.includes(".json") ? [] : {};
      __setCache(filename, fallback);
      return fallback;
    }
    console.error(`Error reading ${filename}:`, error);
    const fallback = filename.includes(".json") ? [] : {};
    __setCache(filename, fallback);
    return fallback;
  }
};

const writeData = async (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const pass = process.env.POS_PASSPHRASE || '';
    const json = JSON.stringify(data, null, 2);
    const shouldEncrypt = !!pass && encryptionEnabled === true;
    if (!shouldEncrypt) {
      await fs.writeFile(filePath, json, "utf-8");
      __setCache(filename, data);
      return;
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(pass, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(json, 'utf-8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = `ENC1:${salt.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
    await fs.writeFile(filePath, out, 'utf-8');
    __setCache(filename, data);
  } catch (error) {
    console.error(`Error writing ${filename}:`, error);
    __invalidateCache(filename);
    throw error;
  }
};

// Note: encryptionEnabled is now initialized in the main server startup after passphrase is loaded

// --- Input Validation Helpers ---
function isSafeUsername(username) {
  // Allow only letters, numbers, dot, underscore, hyphen; length 3-32
  return typeof username === 'string' && /^[A-Za-z0-9._-]{3,32}$/.test(username);
}

function isSafePassword(password) {
  // Allow printable ASCII except obvious injection/control symbols; length 6-128
  if (typeof password !== 'string') return false;
  if (password.length < 6 || password.length > 128) return false;
  // Disallow dangerous characters often used in injections
  const forbidden = /["'`<>\\{}\[\]$]/; // quotes, angle brackets, backslash, braces, brackets, dollar
  // Also disallow non-printable ASCII
  const nonPrintable = /[\x00-\x1F\x7F]/;
  return !forbidden.test(password) && !nonPrintable.test(password);
}

// --- Role helpers ---
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login.html');
    }
    const role = req.session.user.role;
    if (!roles.includes(role)) {
      // Use shared forbidden responder
      return respondForbidden(req, res, 'Forbidden');
    }
    next();
  };
}

// Shared Forbidden responder: HTML -> error page, API -> JSON
function respondForbidden(req, res, message = 'Forbidden') {
  const code = 403;
  const acceptsHtml = req.accepts(['html', 'json']) === 'html';
  if (acceptsHtml && !String(req.originalUrl||'').startsWith('/api/')) {
    const q = new URLSearchParams({ code: String(code), msg: message, path: req.originalUrl || '/' });
    return res.status(code).redirect(`/error.html?${q.toString()}`);
  }
  return res.status(code).json({ success: false, code, message, path: req.originalUrl });
}

// --- Auto Backup Helpers ---
async function performDatabaseBackupToFile(modeLabel = 'manual') {
  try {
    const backupRoot = path.join(DATA_DIR, 'backups', 'auto');
    await fs.mkdir(backupRoot, { recursive: true }).catch(()=>{});
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const name = `backup-${ts}-${modeLabel}.json`;
    const outPath = path.join(backupRoot, name);
    const files = await fs.readdir(DATA_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const payload = {};
    for (const f of jsonFiles) {
      try {
        const raw = await readData(f);
        payload[f] = raw;
      } catch (e) {
        payload[f] = { __error: true };
      }
    }
    const plain = JSON.stringify({ date: now.toISOString(), data: payload }, null, 2);
    const enc = encryptTextIfPassphrase(plain);
    const outText = enc || plain;
    await fs.writeFile(outPath, outText, 'utf-8');
    console.log(`[AUTO-BACKUP] Wrote ${outPath}`);
    // Enforce max N files (delete oldest)
    try {
      const files = await fs.readdir(backupRoot).catch(()=>[]);
      const jsons = (files || []).filter(f => f.endsWith('.json'));
      const withTimes = await Promise.all(jsons.map(async f => {
        const st = await fs.stat(path.join(backupRoot, f)).catch(()=>null);
        return st ? { f, t: st.mtimeMs } : null;
      }));
      const list = withTimes.filter(Boolean).sort((a,b)=>a.t - b.t);
      // Read maxCount from settings
      let maxCount = 10;
      try { const base = await readData('settings.json'); maxCount = Math.max(1, Number(base?.autoBackup?.maxCount)||10); } catch {}
      const excess = Math.max(0, list.length - maxCount);
      for (let i = 0; i < excess; i++) {
        const victim = list[i];
        try { await fs.unlink(path.join(backupRoot, victim.f)); console.log('[AUTO-BACKUP] Pruned', victim.f); } catch {}
      }
    } catch (e) {
      console.warn('[AUTO-BACKUP] prune failed:', e?.message || e);
    }
    return outPath;
  } catch (e) {
    console.error('[AUTO-BACKUP] Failed:', e);
    return null;
  }
}

async function autoBackupIfNeededOnStart() {
  try {
    const base = await readData('settings.json').catch(()=>({}));
    const cfg = base && typeof base === 'object' ? (base.autoBackup || {}) : {};
    const enabled = cfg.enabled === true;
    const mode = cfg.mode || 'off'; // 'off' | 'on_start' | 'daily'
    const retention = Number(cfg.retentionDays || 0);
    if (!enabled || mode === 'off') return;
    const backupRoot = path.join(DATA_DIR, 'backups', 'auto');
    await fs.mkdir(backupRoot, { recursive: true }).catch(()=>{});
    if (mode === 'daily') {
      const files = await fs.readdir(backupRoot).catch(()=>[]);
      const today = new Date().toISOString().slice(0,10);
      const hasToday = (files || []).some(f => f.includes(`backup-${today}`));
      if (hasToday) {
        console.log('[AUTO-BACKUP] Daily backup already exists, skipping.');
      } else {
        await performDatabaseBackupToFile('daily');
      }
    } else if (mode === 'on_start') {
      await performDatabaseBackupToFile('start');
    }
    // Retention cleanup
    if (retention > 0) {
      const files = await fs.readdir(backupRoot).catch(()=>[]);
      const full = files.map(f => ({ f, t: fs.stat(path.join(backupRoot, f)).then(s=>s.mtimeMs).catch(()=>0) }));
      const withTimes = await Promise.all(full.map(async x => ({ f: x.f, t: await x.t })));
      const cutoff = Date.now() - retention * 24*60*60*1000;
      for (const { f, t } of withTimes) {
        if (t && t < cutoff) {
          try { await fs.unlink(path.join(backupRoot, f)); } catch {}
        }
      }
    }
  } catch (e) {
    console.error('[AUTO-BACKUP] on start error:', e);
  }
}

// Ensure data directory exists at startup
ensureDataDir()
  .then(() => seedDataDirIfEmpty())
  .then(() => ensureClientId())
  .then(() => autoBackupIfNeededOnStart())
  .then(() => { try { startSyncScheduler(); } catch {} })
  .catch((e) => console.error('Failed to ensure data dir:', e));


// --- PERUBAHAN 1: Tambahkan Rute Utama untuk Pengalihan Otomatis ---
// Rute ini harus didefinisikan SEBELUM middleware express.static
app.get("/", (req, res) => {
  // Periksa apakah pengguna sudah login (memiliki session)
  if (req.session.user) {
    // Jika sudah login, arahkan ke halaman utama aplikasi (misalnya index.html)
    res.redirect("/index.html");
  } else {
    // Jika belum login, arahkan ke halaman login
    res.redirect("/login.html");
  }
});

// Decrypt all JSON data files to plaintext (keep passphrase for future use)
app.post('/api/admin/decrypt-all', requireRole('admin'), async (req, res) => {
  try {
    const pass = process.env.POS_PASSPHRASE || '';
    if (!pass) return res.status(400).json({ success: false, message: 'POS_PASSPHRASE is required to decrypt existing data' });
    const files = await fs.readdir(DATA_DIR).catch(() => []);
    let processed = 0;
    const failed = [];
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const full = path.join(DATA_DIR, f);
      const raw = await fs.readFile(full, 'utf-8').catch(() => null);
      if (raw == null) { failed.push(f); continue; }
      let obj;
      try {
        if (typeof raw === 'string' && raw.startsWith('ENC1:')) {
          obj = await readData(f);
        } else {
          obj = JSON.parse(raw);
        }
      } catch (e) { failed.push(f); continue; }
      try {
        const json = JSON.stringify(obj, null, 2);
        await fs.writeFile(full, json, 'utf-8');
        __setCache(f, obj);
        processed++;
      } catch (e) { failed.push(f); }
    }
    res.json({ success: true, processed, failed });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Decrypt failed' });
  }
});

// moved: /api/sync/now is registered after auth middlewares

// --- Sync Status ---
// moved: /api/sync/status is registered after auth middlewares

// Trigger an auto-backup now
app.post('/api/backup/auto-now', requireRole('admin'), async (req, res) => {
  try {
    const out = await performDatabaseBackupToFile('manual');
    if (!out) return res.status(500).json({ success:false, message:'Failed to create backup' });
    res.json({ success:true, file: path.basename(out) });
  } catch (e) {
    console.error('auto-now failed:', e);
    res.status(500).json({ success:false, message:'Failed to create backup' });
  }
});

// Delete a specific backup
app.delete('/api/backup/auto-delete', requireRole('admin'), async (req, res) => {
  try {
    const name = String(req.query.name || '');
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
      return res.status(400).json({ success:false, message:'Invalid file name' });
    }
    const p = path.join(DATA_DIR, 'backups', 'auto', name);
    const st = await fs.stat(p).catch(()=>null);
    if (!st || !st.isFile()) return res.status(404).json({ success:false, message:'File not found' });
    await fs.unlink(p);
    res.json({ success:true });
  } catch (e) {
    console.error('auto-delete failed:', e);
    res.status(500).json({ success:false, message:'Failed to delete backup' });
  }
});

// ZIP backup for entire app preserving folder structure (exclude node_modules, .git, .cache)
// (moved) app-zip-structured route is defined later after middleware

// (moved) restore-zip route is defined later after middleware
// Public settings for login/branding (no auth)
app.get('/api/public-settings', async (req, res) => {
  try {
    const raw = await readData('settings.json');
    const base = Array.isArray(raw) ? {} : (raw || {});
    let storeName = base.storeName || 'POS System';
    try {
      const licensed = await getLicensedStoreName();
      if (licensed) storeName = licensed;
    } catch (e) {}
    const data = {
      storeName,
      themeColor: base.themeColor || '#198754',
      loginTitle: base.loginTitle || '',
      loginLogoBase64: base.loginLogoBase64 || base.logoBase64 || '',
      loginBackgroundBase64: base.loginBackgroundBase64 || '',
      faviconBase64: base.faviconBase64 || '',
      darkMode: base.darkMode === true,
      loginLogoSize: typeof base.loginLogoSize === 'string' ? base.loginLogoSize : 'medium'
    };
    res.json(data);
  } catch (e) {
    try {
      const licensed = await getLicensedStoreName();
      if (licensed) {
        return res.status(200).json({
          storeName: licensed,
          themeColor: '#198754',
          loginTitle: '',
          loginLogoBase64: '',
          loginBackgroundBase64: '',
          faviconBase64: ''
        });
      }
    } catch (err) {}
    res.status(200).json({
      storeName: 'POS System',
      themeColor: '#198754',
      loginTitle: '',
      loginLogoBase64: '',
      loginBackgroundBase64: '',
      faviconBase64: ''
    });
  }
});

// --- Page routing rules ---
// Halaman Admin (khusus admin)
// Halaman Rekey (khusus admin)
app.get('/admin-rekey.html', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-rekey.html'));
});

// Alias yang lebih rapi untuk halaman Rekey
app.get('/admin/rekey', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-rekey.html'));
});

// Halaman Admin (khusus admin)
app.get('/admin', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Halaman Kasir (admin & cashier)
app.get('/kasir', requireRole('admin', 'cashier'), (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } catch {}
  res.sendFile(path.join(__dirname, 'public', 'pos.html'));
});

// Halaman Pendapatan (admin & cashier)
app.get('/revenue', requireRole('admin', 'cashier'), (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } catch {}
  res.sendFile(path.join(__dirname, 'public', 'revenue.html'));
});

// Halaman Sinkron (khusus admin)
app.get('/sync.html', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sync.html'));
});
app.get('/admin/sync', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sync.html'));
});

// Auto backup endpoints (use role helper)
app.get('/api/backup/auto-list', requireRole('admin'), async (req, res) => {
  try {
    const dir = path.join(DATA_DIR, 'backups', 'auto');
    await fs.mkdir(dir, { recursive: true }).catch(()=>{});
    const files = await fs.readdir(dir);
    const items = await Promise.all((files || []).filter(f => f.endsWith('.json')).map(async f => {
      const p = path.join(dir, f);
      const st = await fs.stat(p).catch(()=>null);
      return st ? { name: f, size: st.size, mtime: st.mtimeMs } : null;
    }));
    res.json({ success: true, files: (items || []).filter(Boolean).sort((a,b)=>b.mtime-a.mtime) });
  } catch (e) {
    console.error('auto-list failed:', e);
    res.status(500).json({ success: false, message: 'Failed to list backups' });
  }
});

app.get('/api/backup/auto-download', requireRole('admin'), async (req, res) => {
  try {
    const name = String(req.query.name || '');
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
      return res.status(400).json({ success: false, message: 'Invalid file name' });
    }
    const dir = path.join(DATA_DIR, 'backups', 'auto');
    const p = path.join(dir, name);
    const st = await fs.stat(p).catch(()=>null);
    if (!st || !st.isFile()) return res.status(404).json({ success: false, message: 'File not found' });
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    const content = await fs.readFile(p, 'utf-8');
    return res.send(content);
  } catch (e) {
    console.error('auto-download failed:', e);
    res.status(500).json({ success: false, message: 'Failed to download backup' });
  }
});

// Lindungi akses langsung ke file HTML utama selain login: arahkan ke rute resmi
app.get(['/admin.html', '/pos.html', '/index.html'], (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login.html');
  const role = req.session.user.role;
  if (req.path === '/admin.html') return role === 'admin' ? res.redirect('/admin') : respondForbidden(req, res, 'Forbidden');
  if (req.path === '/pos.html') return res.redirect('/kasir');
  return role === 'admin' ? res.redirect('/admin') : res.redirect('/kasir');
});

// --- Middleware untuk file statis ---
// Diletakkan setelah rute utama agar tidak menangani '/' sebelum rute khusus kita
app.use(express.static(path.join(__dirname, 'public')));

// Disable caching for API responses to prevent stale data in UI
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// --- Validation Helper Functions ---
const validateProductName = async (name, excludeId = null) => {
  const products = await readData("products.json");
  const existingProduct = products.find(
    (p) =>
      p.name && p.name.toLowerCase() === name.toLowerCase() && p.id != excludeId
  );
  return existingProduct;
};

const validateCategoryName = async (name, excludeId = null) => {
  const categories = await readData("categories.json");
  const existingCategory = categories.find(
    (c) =>
      c.name && c.name.toLowerCase() === name.toLowerCase() && c.id != excludeId
  );
  return existingCategory;
};

// Validate SKU uniqueness
const validateProductSku = async (sku, excludeId = null) => {
  const products = await readData("products.json");
  const existing = products.find(
    (p) => p && typeof p.sku === 'string' && p.sku.trim() === String(sku).trim() && p.id != excludeId
  );
  return existing;
};

const validateUsername = async (username, excludeId = null) => {
  const users = await readData("users.json");
  const existingUser = users.find(
    (u) =>
      u.username &&
      u.username.toLowerCase() === username.toLowerCase() &&
      u.id != excludeId
  );
  return existingUser;
};

// --- Authentication Middleware ---
// --- PERUBAHAN 2: Peningkatan Middleware untuk API ---
// Untuk API, lebih baik mengembalikan error JSON daripada redirect HTML
const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    res
      .status(401)
      .json({ success: false, message: "Unauthorized. Please log in." });
  }
};

const isAdmin = (req, res, next) => {
  const role = (req.session.user && req.session.user.role) ? String(req.session.user.role).toLowerCase() : '';
  if (role === "admin") {
    next();
  } else {
    res
      .status(403)
      .json({ success: false, message: "Access Denied: Admins only" });
  }
};

// Allow both admin and cashier access for POS operations
const isAdminOrCashier = (req, res, next) => {
  const role = (req.session.user && req.session.user.role) ? String(req.session.user.role).toLowerCase() : '';
  if (role === 'admin' || role === 'cashier') return next();
  return res.status(403).json({ success:false, message:'Access Denied' });
};

// --- API Routes ---
// --- POS Settings (basic) ---
app.get('/api/settings', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const data = await readData('settings.json');
    res.json(data || {});
  } catch {
    res.json({});
  }
});

app.put('/api/settings', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const cur = await readData('settings.json');
    const merged = { ...(cur && typeof cur === 'object' ? cur : {}), ...(req.body || {}) };
    // Jika ada LICENSE offline valid dengan nama toko, paksa storeName mengikuti LICENSE
    try {
      const licensedName = await getLicensedStoreName();
      if (licensedName) {
        merged.storeName = licensedName;
      }
    } catch (e) {}
    merged.updatedAt = Date.now();
    try {
      const enc = merged && merged.encryption;
      if (enc && typeof enc.enabled === 'boolean') {
        encryptionEnabled = !!enc.enabled;
      }
    } catch {}
    await writeData('settings.json', merged);
    // Enqueue outbox for sync (settings upsert)
    try {
      await enqueueOutbox({ collection: 'settings', file: 'settings.json', op: 'upsert', _id: 'settings', doc: merged, updatedAt: Date.now() });
    } catch {}
    // Mirror sync config if provided into dedicated file with metadata
    try {
      const syncIn = (req.body && req.body.sync) ? req.body.sync : null;
      if (syncIn && typeof syncIn === 'object') {
        const prev = await readData(SYNC_CFG_FILE).catch(() => ({}));
        const who = (req.session && req.session.user && req.session.user.username) || '';
        const syncCfg = { ...(prev && typeof prev === 'object' ? prev : {}), ...syncIn, updatedAt: Date.now(), lastModifiedBy: who };
        await writeData(SYNC_CFG_FILE, syncCfg);
        try { await enqueueOutbox({ collection: 'sync_config', file: SYNC_CFG_FILE, op: 'upsert', _id: 'sync_config', doc: syncCfg, updatedAt: Number(syncCfg.updatedAt||Date.now()) }); } catch {}
      }
    } catch {}
    res.json({ success:true, message:'Settings saved', settings: merged });
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to save settings' });
  }
});

// --- Sync Status (registered after auth middlewares) ---
app.get('/api/sync/status', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const settings = await readData('settings.json').catch(() => ({}));
    const sync = await readData(SYNC_CFG_FILE).catch(() => (settings && settings.sync ? settings.sync : {}));
    const last = await readData(LASTSYNC_FILE).catch(() => ({}));
    const outbox = await readArrayFile(OUTBOX_FILE).catch(() => []);
    // Optional remote status probe when ?remote=true and config available
    let remote = null;
    try {
      const wantRemote = String(req.query && (req.query.remote || '')).toLowerCase();
      const doRemote = wantRemote === '1' || wantRemote === 'true' || wantRemote === 'yes';
      const baseUrl = String(sync.baseUrl || '');
      const token = String(sync.token || '');
      if (doRemote && baseUrl) {
        let ep;
        try {
          ep = new URL('/api/sync/changes', baseUrl);
          // Use since=0 for full snapshot summary; if too heavy, caller can omit ?remote
          ep.searchParams.set('since', '0');
          ep.searchParams.set('clientId', settings.clientId || '');
        } catch {}
        if (ep) {
          const headers = {};
          if (token) headers['Authorization'] = `Bearer ${token}`;
          const resp = await safeFetch(String(ep), { headers });
          if (resp && resp.ok) {
            const payload = await resp.json().catch(() => ({}));
            const byFile = {};
            const latestTs = {};
            const ts = (v) => {
              if (typeof v === 'number' && isFinite(v)) return v;
              if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
              return 0;
            };
            const recTs = (x) => Math.max(ts(x?.updatedAt), ts(x?.timestamp), ts(x?.createdAt));
            if (payload && typeof payload === 'object') {
              for (const [file, arr] of Object.entries(payload)) {
                const list = Array.isArray(arr) ? arr : [];
                byFile[file] = list.length;
                let maxT = 0;
                for (const it of list) { const r = recTs(it); if (r > maxT) maxT = r; }
                latestTs[file] = maxT;
              }
            }
            remote = { reachable: true, status: resp.status, byFile, latestTs };
          } else {
            remote = { reachable: false, status: resp ? resp.status : 0 };
          }
        }
      }
    } catch {}
    res.json({
      enabled: sync.enabled === true,
      baseUrl: sync.baseUrl || '',
      hasToken: Boolean(sync.token && String(sync.token).length > 0),
      token: sync.token || '',
      clientId: settings.clientId || '',
      lastModifiedBy: sync.lastModifiedBy || '',
      cfgUpdatedAt: Number(sync.updatedAt || 0),
      lastPushAt: Number(last.lastPushAt || 0),
      lastPullAt: Number(last.lastPullAt || 0),
      outboxSize: outbox.length,
      remote
    });
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to read sync status' });
  }
});

// --- Sync Now (manual trigger) ---
async function handleSyncNow(req, res) {
  try {
    try { console.log('[SYNC] /api/sync/now', { method: req.method, user: (req.session && req.session.user && req.session.user.username) || '-' }); } catch {}
    if (isSyncBusy()) return res.status(429).json({ success:false, message:'Sync is in progress' });
    const result = await runWithSyncLock(async () => {
      try { await performDatabaseBackupToFile('sync-pre'); } catch {}
      try {
        const wantFull = (String(req.query?.full||req.body?.full||'').toLowerCase() === 'true');
        let doFull = !!wantFull;
        if (!doFull) {
          try {
            let anyEmpty = false;
            for (const f of SYNC_COLLECTION_FILES) {
              const arr = await readData(f).catch(()=>[]);
              if (Array.isArray(arr) && arr.length === 0) { anyEmpty = true; break; }
            }
            doFull = anyEmpty;
          } catch {}
        }
        resetSyncProgress(); setSyncPhase('pull1'); setSyncStart();
        if (doFull) {
          let last = await readData(LASTSYNC_FILE).catch(() => ({}));
          if (!last || typeof last !== 'object') last = {};
          last.lastPullAt = 0;
          await writeData(LASTSYNC_FILE, last);
        }
        await pullChangesWithRetry(3).catch(() => ({ pulled: 0, error: true }));
        setSyncEnd();
      } catch {}
      try { await enqueueLocalSnapshotIfOutboxEmpty(); } catch {}
      try { await enqueueDeltaSinceLastPush(); } catch {}
      try {
        let q = await readArrayFile(OUTBOX_FILE);
        const arrayFiles = new Set([ ...SYNC_COLLECTION_FILES, 'transactions.json' ]);
        const hasArrayItems = Array.isArray(q) && q.some(it => arrayFiles.has(String(it.file||it.collection||'')));
        if (!q || !q.length || !hasArrayItems) {
          for (const file of arrayFiles) {
            try {
              let data = await readData(file).catch(()=>null);
              if (Array.isArray(data)) {
                const now = Date.now();
                for (let i = 0; i < data.length; i++) {
                  const doc = data[i] || {};
                  const id = String(doc && (doc._id || doc.id || ''));
                  if (!id) continue;
                  if (!doc.updatedAt || Number(doc.updatedAt) < now) { doc.updatedAt = now; data[i] = doc; }
                  await enqueueOutbox({ collection: file.replace('.json',''), file, op: 'upsert', _id: id, doc, updatedAt: Number(doc.updatedAt||now) });
                }
                await writeData(file, data);
              }
            } catch {}
          }
        }
      } catch {}
      resetSyncProgress(); setSyncPhase('push'); setSyncStart();
      const pushed = await pushOutboxChunked(500).catch(() => ({ pushed: 0, error: true }));
      setSyncEnd();
      resetSyncProgress(); setSyncPhase('pull2'); setSyncStart();
      const pulled = await pullChangesWithRetry(3).catch(() => ({ pulled: 0, error: true }));
      setSyncEnd();
      const success = !pushed.error && !pulled.error;
      const cfgNow = await getSyncConfig().catch(()=>({}));
      let integrity = null;
      try { if (cfgNow && cfgNow.integrityVerify) { integrity = await computeChecksumsForCollections(); } } catch {}
      const meta = { at: Date.now(), user: (req.session && req.session.user && req.session.user.username) || '', integrity };
      return { success, pushed, pulled, meta };
    });
    if (result && result.busy) return res.status(429).json({ success:false, message:'Sync is in progress' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to sync now' });
  }
}

app.get('/api/sync/progress', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const busy = isSyncBusy();
    res.json({ busy, progress: __syncProgress });
  } catch {
    res.status(500).json({ success:false });
  }
});

app.get('/api/sync/checksums', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const sums = await computeChecksumsForCollections();
    res.json({ success: true, checksums: sums });
  } catch {
    res.status(500).json({ success:false });
  }
});
app.post('/api/sync/now', isAuthenticated, isAdminOrCashier, handleSyncNow);
app.get('/api/sync/now', isAuthenticated, isAdminOrCashier, handleSyncNow);

async function handleSyncPushOnly(req, res) {
  try {
    try { console.log('[SYNC] /api/sync/push-local', { method: req.method, user: (req.session && req.session.user && req.session.user.username) || '-' }); } catch {}
    try { await enqueueLocalSnapshotIfOutboxEmpty(); } catch {}
    try { await enqueueDeltaSinceLastPush(); } catch {}
    try {
      let q = await readArrayFile(OUTBOX_FILE);
      if (!q || !q.length) {
        await enqueueFullSnapshot();
      } else {
        const arrayFiles = new Set([ ...SYNC_COLLECTION_FILES, 'transactions.json' ]);
        const hasArrayItems = q.some(it => arrayFiles.has(String(it.file||it.collection||'')));
        if (!hasArrayItems) {
          for (const file of arrayFiles) {
            try {
              let data = await readData(file).catch(()=>null);
              if (Array.isArray(data)) {
                const now = Date.now();
                for (let i = 0; i < data.length; i++) {
                  const doc = data[i] || {};
                  const id = String(doc && (doc._id || doc.id || ''));
                  if (!id) continue;
                  if (!doc.updatedAt || Number(doc.updatedAt) < now) { doc.updatedAt = now; data[i] = doc; }
                  await enqueueOutbox({ collection: file.replace('.json',''), file, op: 'upsert', _id: id, doc, updatedAt: Number(doc.updatedAt||now) });
                }
                await writeData(file, data);
              }
            } catch {}
          }
        }
      }
    } catch {}
    const pushed = await pushOutbox().catch(() => ({ pushed: 0, error: true }));
    const success = !pushed.error;
    const meta = { at: Date.now(), user: (req.session && req.session.user && req.session.user.username) || '' };
    res.json({ success, pushed, meta });
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to push' });
  }
}
async function handleSyncPullOnly(req, res) {
  try {
    try { console.log('[SYNC] /api/sync/pull-remote', { method: req.method, user: (req.session && req.session.user && req.session.user.username) || '-' }); } catch {}
    const pulled = await pullChanges().catch(() => ({ pulled: 0, error: true }));
    const success = !pulled.error;
    const meta = { at: Date.now(), user: (req.session && req.session.user && req.session.user.username) || '' };
    res.json({ success, pulled, meta });
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to pull' });
  }
}
app.post('/api/sync/push-local', isAuthenticated, isAdminOrCashier, handleSyncPushOnly);
app.post('/api/sync/pull-remote', isAuthenticated, isAdminOrCashier, handleSyncPullOnly);

// --- Admin Utilities: Force Full Pull & Watermark Management ---
async function handleSyncForceFullPull(req, res) {
  try {
    let last = await readData(LASTSYNC_FILE).catch(() => ({}));
    if (!last || typeof last !== 'object') last = {};
    // Force since=0 by resetting lastPullAt, then pull
    last.lastPullAt = 0;
    await writeData(LASTSYNC_FILE, last);
    const pulled = await pullChanges().catch(() => ({ pulled: 0, error: true }));
    const success = !pulled.error;
    const meta = { at: Date.now(), forcedSince: 0, user: (req.session && req.session.user && req.session.user.username) || '' };
    res.json({ success, pulled, meta });
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to force full pull' });
  }
}
app.post('/api/sync/force-full-pull', isAuthenticated, isAdminOrCashier, handleSyncForceFullPull);

app.post('/api/sync/reset-watermark', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    let last = await readData(LASTSYNC_FILE).catch(() => ({}));
    if (!last || typeof last !== 'object') last = {};
    last.lastPullAt = 0;
    // Optional: also clear per-file push watermarks if requested via query/body
    try { if (req.query && String(req.query.clearPush || '').toLowerCase() === 'true') last.lastPushedPerFile = {}; } catch {}
    await writeData(LASTSYNC_FILE, last);
    res.json({ success:true, last });
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to reset watermark' });
  }
});

app.get('/api/sync/watermark', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const last = await readData(LASTSYNC_FILE).catch(() => ({}));
    res.json({
      lastPullAt: Number(last.lastPullAt || 0),
      lastPushAt: Number(last.lastPushAt || 0),
      lastPushedPerFile: (last && last.lastPushedPerFile) || {}
    });
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to read watermark' });
  }
});

  app.post('/api/sync/reconcile', isAuthenticated, isAdminOrCashier, async (req, res) => {
    try {
      const cfg = await getSyncConfig();
      if (!cfg.enabled || !cfg.baseUrl) return res.status(400).json({ success:false, message:'Sync not configured' });
      let ep;
      try {
        ep = new URL('/api/sync/changes', cfg.baseUrl);
        ep.searchParams.set('since', '0');
        ep.searchParams.set('clientId', cfg.clientId || '');
      } catch {
        return res.status(400).json({ success:false, message:'Invalid baseUrl' });
      }
      const headers = {};
      if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
      const resp = await safeFetch(String(ep), { headers });
      if (!resp) return res.status(502).json({ success:false, message:'No response from server' });
      if (!resp.ok) {
        let body = '';
        try { body = await resp.text(); } catch {}
        return res.status(resp.status || 500).json({ success:false, message:'Failed to fetch snapshot', body });
      }
      const payload = await resp.json().catch(() => ({}));
      const arrayFiles = new Set([ ...SYNC_COLLECTION_FILES, 'transactions.json' ]);
      const summary = { replacedByFile: {}, counts: {} };
      for (const file of arrayFiles) {
        try {
          const serverArr = Array.isArray(payload[file]) ? payload[file].filter(x => !(x && x.deleted)) : [];
          await writeData(file, serverArr);
          summary.replacedByFile[file] = true;
          summary.counts[file] = serverArr.length;
        } catch {}
      }
      // Update watermark so subsequent pulls use a fresh baseline
      try {
        let last = await readData(LASTSYNC_FILE).catch(()=>({}));
        if (!last || typeof last !== 'object') last = {};
        last.lastPullAt = Date.now();
        await writeData(LASTSYNC_FILE, last);
      } catch {}
      res.json({ success:true, summary, at: Date.now() });
    } catch (e) {
      res.status(500).json({ success:false, message:'Failed to reconcile' });
    }
  });

// --- Basic Sync Endpoints (server side) ---
// Accepts an outbox batch from a client and applies changes
app.post('/api/sync/push', requireSyncBearer, async (req, res) => {
  try {
    const { items = [], clientId = '', batchId = '' } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ success:false, message:'Invalid items' });
    let mergeMode = 'serverWins';
    try { const sc = await readData(SYNC_CFG_FILE).catch(()=>({})); if (sc && typeof sc === 'object' && sc.mergeMode) mergeMode = String(sc.mergeMode); } catch {}
    const clientWins = (mergeMode === 'clientWins');
    let applied = 0;
    for (const it of items) {
      try {
        const file = String(it.file || it.collection || '').trim();
        if (!file) continue;
        const op = String(it.op || 'upsert');
        if (file === 'settings.json') {
          const cur = await readData('settings.json').catch(() => ({}));
          const cand = it.doc || {};
          if (clientWins || Number(cand.updatedAt||0) >= Number(cur.updatedAt||0)) {
            await writeData('settings.json', { ...cur, ...cand, updatedAt: Number(cand.updatedAt||Date.now()) });
            applied++;
          }
          continue;
        }
        if (file === SYNC_CFG_FILE) {
          const cur = await readData(SYNC_CFG_FILE).catch(() => ({}));
          const cand = it.doc || {};
          if (clientWins || Number(cand.updatedAt||0) >= Number(cur.updatedAt||0)) {
            await writeData(SYNC_CFG_FILE, { ...cur, ...cand, updatedAt: Number(cand.updatedAt||Date.now()) });
            applied++;
          }
          continue;
        }
        // Array collections
        let arr = await readData(file).catch(() => []);
        if (!Array.isArray(arr)) arr = [];
        const key = String(it._id || it.id || (it.doc && (it.doc._id||it.doc.id)) || '');
        if (!key) continue;
        const idx = arr.findIndex(x => String(x && (x._id || x.id)) === key);
        if (op === 'delete' || it.deleted) {
          // For products.json, when server is in default (serverWins) mode,
          // ignore delete operations coming from clients to prevent
          // accidentally wiping master product data from a local node
          // that has an empty or outdated snapshot.
          if (file === 'products.json' && !clientWins) {
            // Skip applying delete for products.json in serverWins mode
            continue;
          }
          if (idx >= 0) { arr.splice(idx, 1); applied++; }
          try { await appendDeletionTombstone(file, key, Number(it.updatedAt || (it.doc && it.doc.updatedAt) || Date.now())); } catch {}
        } else {
          const cand = it.doc || {};
          if (idx >= 0) {
            const cur = arr[idx] || {};
            const cu = Number(cur.updatedAt || cur.timestamp || 0);
            const nu = Number(cand.updatedAt || cand.timestamp || 0);
            if (clientWins || nu >= cu) { arr[idx] = cand; applied++; }
          } else { arr.push(cand); applied++; }
        }
        await writeData(file, arr);
      } catch {}
    }
    res.json({ success:true, applied, clientId, batchId });
  } catch (e) {
    res.status(500).json({ success:false, message:'push failed' });
  }
});

// Returns changes since a timestamp per supported file
app.get('/api/sync/changes', requireSyncBearer, async (req, res) => {
  try {
    const since = Number(req.query.since || 0) || 0;
    const out = {};
    const ts = (v) => {
      if (typeof v === 'number' && isFinite(v)) return v;
      if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
      return 0;
    };
    const recTs = (x) => Math.max(ts(x?.updatedAt), ts(x?.timestamp), ts(x?.createdAt));
    // Transactions: use timestamp
    try {
      let t = await readData('transactions.json'); if (!Array.isArray(t)) t = [];
      const changes = since === 0 ? t : t.filter(x => recTs(x) > since);
      if (changes.length) out['transactions.json'] = changes;
    } catch {}
    // Settings: use updatedAt
    try {
      const s = await readData('settings.json');
      if (since === 0) {
        if (s && typeof s === 'object') out['settings.json'] = [ { ...(s || {}), _id: 'settings' } ];
      } else if (s && typeof s === 'object' && recTs(s) > since) {
        out['settings.json'] = [ { ...(s || {}), _id: 'settings' } ];
      }
    } catch {}
    // Sync config: use updatedAt
    try {
      const sc = await readData(SYNC_CFG_FILE).catch(() => null);
      if (since === 0) {
        if (sc && typeof sc === 'object') out[SYNC_CFG_FILE] = [ { ...(sc || {}), _id: 'sync_config' } ];
      } else if (sc && typeof sc === 'object' && recTs(sc) > since) {
        out[SYNC_CFG_FILE] = [ { ...(sc || {}), _id: 'sync_config' } ];
      }
    } catch {}
    // Whitelisted collections: use updatedAt/timestamp per record
    for (const file of SYNC_COLLECTION_FILES) {
      try {
        let raw = await readData(file).catch(() => []);
        if (Array.isArray(raw)) {
          const changes = since === 0 ? raw : raw.filter(x => recTs(x) > since);
          if (changes.length) out[file] = changes;
        } else if (raw && typeof raw === 'object') {
          const id = (file === 'banners.json') ? 'banner' : (file === 'qris.json') ? 'qris' : (raw._id || raw.id || 'singleton');
          const t = recTs(raw);
          if (since === 0 || t > since) {
            out[file] = [ { ...raw, _id: id } ];
          }
        }
      } catch {}
    }
    // Include deletions (tombstones) per file so other devices can remove items
    try {
      const delMap = await readData(DELETIONS_FILE).catch(() => ({}));
      if (delMap && typeof delMap === 'object') {
        for (const [file, dels] of Object.entries(delMap)) {
          const list = Array.isArray(dels) ? dels.filter(x => Number(x && x.updatedAt || 0) > since) : [];
          if (!list.length) continue;
          const existing = Array.isArray(out[file]) ? out[file] : [];
          const tombs = list.map(x => ({ _id: String(x._id || x.id || ''), deleted: true, updatedAt: Number(x.updatedAt || Date.now()) }));
          out[file] = existing.concat(tombs);
        }
      }
    } catch {}
    res.json(out);
  } catch (e) {
    res.status(500).json({ success:false, message:'changes failed' });
  }
});

// --- Drafts ---
app.get('/api/drafts', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try { const d = await readData('drafts.json'); res.json(Array.isArray(d) ? d : []); }
  catch { res.json([]); }
});

app.post('/api/drafts', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ success:false, message:'No items' });
    let d = await readData('drafts.json'); if (!Array.isArray(d)) d = [];
    const draft = { id: String(Date.now()), items, timestamp: Date.now() };
    d.push(draft);
    await writeData('drafts.json', d);
    res.json({ success:true, message:'Draf disimpan', id: draft.id });
  } catch { res.status(500).json({ success:false, message:'Failed to save draft' }); }
});

app.put('/api/drafts/:id/load', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const id = String(req.params.id);
    const d = await readData('drafts.json');
    const found = (Array.isArray(d) ? d : []).find(x => String(x.id) === id);
    if (!found) return res.status(404).json({ success:false, message:'Draft not found' });
    res.json({ success:true, id, items: found.items || [], timestamp: found.timestamp });
  } catch { res.status(500).json({ success:false, message:'Failed to load draft' }); }
});

app.delete('/api/drafts/:id', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const id = String(req.params.id);
    let d = await readData('drafts.json'); if (!Array.isArray(d)) d = [];
    const before = d.length;
    d = d.filter(x => String(x.id) !== id);
    await writeData('drafts.json', d);
    res.json({ success:true, deleted: before - d.length, message: 'Draft deleted' });
  } catch { res.status(500).json({ success:false, message:'Failed to delete draft' }); }
});

// --- Shared Cart (for multi-device sync) ---
// SSE subscribers for real-time cart updates
const cartSubscribers = new Set();
const broadcastCart = (cartPayload) => {
  const payload = { items: Array.isArray(cartPayload?.items) ? cartPayload.items : [], updatedAt: Number(cartPayload?.updatedAt || Date.now()) };
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of Array.from(cartSubscribers)) {
    try { res.write(data); } catch { try { cartSubscribers.delete(res); } catch {} }
  }
};

app.get('/api/cart/stream', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    // keep-alive comment
    res.write(': connected\n\n');
    cartSubscribers.add(res);
    req.on('close', () => { try { cartSubscribers.delete(res); } catch {} });
    // Send initial snapshot
    try {
      const raw = await readData('cart.json');
      const snap = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { items: (Array.isArray(raw) ? raw : []), updatedAt: Date.now() };
      res.write(`data: ${JSON.stringify({ items: snap.items || [], updatedAt: snap.updatedAt || Date.now() })}\n\n`);
    } catch {}
  } catch {
    try { res.end(); } catch {}
  }
});

app.get('/api/cart', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const raw = await readData('cart.json');
    const data = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { items: (Array.isArray(raw) ? raw : []), updatedAt: Date.now() };
    if (!Array.isArray(data.items)) data.items = [];
    return res.json({ items: data.items, updatedAt: data.updatedAt || 0 });
  } catch (e) {
    return res.json({ items: [], updatedAt: 0 });
  }
});

app.put('/api/cart', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ success:false, message:'Invalid items' });
    const payload = { items, updatedAt: Date.now() };
    await writeData('cart.json', payload);
    broadcastCart(payload);
    return res.json({ success:true, updatedAt: payload.updatedAt });
  } catch (e) {
    return res.status(500).json({ success:false, message:'Failed to save cart' });
  }
});

app.delete('/api/cart', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const payload = { items: [], updatedAt: Date.now() };
    await writeData('cart.json', payload);
    broadcastCart(payload);
    return res.json({ success:true });
  } catch (e) {
    return res.status(500).json({ success:false, message:'Failed to clear cart' });
  }
});

// --- Recent Transactions ---
app.get('/api/recent-transactions', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const t = await readData('transactions.json');
    const arr = Array.isArray(t) ? t : [];
    const sorted = arr.sort((a,b)=> (b.timestamp||0) - (a.timestamp||0)).slice(0, 100);
    res.json(sorted);
  } catch { res.status(500).json({ success:false, message:'Failed to load transactions' }); }
});

// --- Transactions ---
app.post('/api/transactions', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const { items = [], paymentMethod = 'cash', amountReceived = 0, customerId = 'default', customerName = 'Pelanggan Umum', discountPercent = 0, discountAmount = 0 } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ success:false, message:'No items' });

    // Load products
    let products = await readData('products.json'); if (!Array.isArray(products)) products = [];

    // Compute totals
    const subtotal = items.reduce((s, it) => s + (Number(it.price||0) * Number(it.qty||0)), 0);
    const discAmt = Number(discountAmount||0) > 0 ? Number(discountAmount||0) : Math.round(subtotal * (Number(discountPercent||0)/100));
    const taxAmount = 0;
    const serviceAmount = 0;
    const totalAmount = Math.max(0, subtotal - (discAmt||0) + taxAmount + serviceAmount);

    // Decrease stock and append stock_moves (sale)
    for (const it of items) {
      const idx = products.findIndex(p => String(p.id) === String(it.productId));
      if (idx >= 0) {
        products[idx].stock = Math.max(0, Number(products[idx].stock||0) - Number(it.qty||0));
        try { await appendStockMove({ productId: it.productId, delta: -Number(it.qty||0), reason: 'sale', by: (req.session && req.session.user && req.session.user.username) || '' }); } catch {}
      }
    }

    // Build transaction
    const tx = {
      id: `TRX-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Date.now()}`,
      timestamp: Date.now(),
      paymentMethod,
      amountReceived: Number(amountReceived||0),
      change: Number(amountReceived||0) - totalAmount,
      customerId,
      customerName,
      items: items.map(it => ({ productId: it.productId, name: it.name, price: Number(it.price||0), qty: Number(it.qty||0) })),
      subtotal,
      discountAmount: discAmt,
      taxAmount,
      serviceAmount,
      totalAmount
    };

    // Persist products with sync and save transaction
    await saveArrayWithSync('products.json', products);
    let t = await readData('transactions.json'); if (!Array.isArray(t)) t = [];
    t.push(tx);
    await writeData('transactions.json', t);
    try { await enqueueOutbox({ collection: 'transactions', file: 'transactions.json', op: 'insert', _id: tx.id, doc: tx, updatedAt: Number(tx.timestamp||Date.now()) }); } catch {}

    // Backfill refId for recent stock moves without refId
    try {
      const moves = await readData('stock_moves.json').catch(()=>[]);
      if (Array.isArray(moves) && moves.length) {
        for (let i = moves.length - 1, c = 0; i >= 0 && c < items.length; i--) {
          if (!moves[i].refId) { moves[i].refId = tx.id; c++; }
        }
        await writeData('stock_moves.json', moves);
      }
    } catch {}

    // Clear shared cart after a successful checkout
    try {
      const cleared = { items: [], updatedAt: Date.now() };
      await writeData('cart.json', cleared);
      broadcastCart(cleared);
    } catch {}

    return res.json(tx);
  } catch (e) {
    return res.status(500).json({ success:false, message:'Transaction failed' });
  }
});

app.delete('/api/transactions/:id', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const id = String(req.params.id);
    let t = await readData('transactions.json'); if (!Array.isArray(t)) t = [];
    const before = t.length;
    const tx = t.find(x => String(x.id) === id) || null;
    t = t.filter(x => String(x.id) !== id);
    await writeData('transactions.json', t);
    res.json({ success:true, message:'Transaksi dibatalkan', removed: before - t.length, items: tx ? (tx.items||[]) : [] });
  } catch { res.status(500).json({ success:false, message:'Failed to void transaction' }); }
});

// Query Transactions with filter and grouping for Revenue page
// GET /api/transactions/query?from=ms&to=ms&q=term&group=day|month|year
app.get('/api/transactions/query', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    let { from, to, q, group } = req.query || {};
    const fromMs = Number(from) || 0;
    const toMs = Number(to) || Date.now();
    const term = (q ? String(q) : '').trim().toLowerCase();
    const grp = ['day','month','year'].includes(String(group)) ? String(group) : 'day';

    let list = await readData('transactions.json');
    if (!Array.isArray(list)) list = [];
    // Filter by time range
    list = list.filter(tx => {
      const t = Number(tx.timestamp || 0);
      return t >= fromMs && t <= toMs;
    });
    // Filter by search term (customerName, id, or any item name)
    if (term) {
      list = list.filter(tx => {
        const inHeader = (String(tx.id||'').toLowerCase().includes(term) || String(tx.customerName||'').toLowerCase().includes(term));
        const inItems = Array.isArray(tx.items) && tx.items.some(it => String(it.name||'').toLowerCase().includes(term));
        return inHeader || inItems;
      });
    }

    // Build purchase price map for COGS
    let products = await readData('products.json');
    if (!Array.isArray(products)) products = [];
    const costMap = new Map(products.map(p => [ String(p.id), Number(p.purchasePrice || 0) ]));

    // Enrich transactions with COGS and Profit
    const listEnriched = list.map(tx => {
      const items = Array.isArray(tx.items) ? tx.items : [];
      let cogs = 0;
      for (const it of items) {
        const pid = (it.productId ?? it.id);
        const unitCost = costMap.get(String(pid)) || 0;
        cogs += unitCost * Number(it.qty || 0);
      }
      const subtotal = Number(tx.subtotal || 0);
      const discountAmount = Number(tx.discountAmount || 0);
      const grossProfit = subtotal - cogs;
      const profit = grossProfit - discountAmount; // discount reduces profit
      return { ...tx, cogs, profit };
    });

    // Summary totals (with COGS and Profit)
    const summary = listEnriched.reduce((acc, tx) => {
      acc.count += 1;
      acc.subtotal += Number(tx.subtotal||0);
      acc.discountAmount += Number(tx.discountAmount||0);
      acc.taxAmount += Number(tx.taxAmount||0);
      acc.serviceAmount += Number(tx.serviceAmount||0);
      acc.totalAmount += Number(tx.totalAmount||0);
      acc.cogs += Number(tx.cogs||0);
      acc.profit += Number(tx.profit||0);
      return acc;
    }, { count: 0, subtotal: 0, discountAmount: 0, taxAmount: 0, serviceAmount: 0, totalAmount: 0, cogs: 0, profit: 0 });

    // Grouping helper
    const pad2 = (n) => (n<10?('0'+n):String(n));
    const groups = {};
    for (const tx of listEnriched) {
      const d = new Date(Number(tx.timestamp||0));
      let key, label;
      if (grp === 'year') {
        key = String(d.getFullYear());
        label = key;
      } else if (grp === 'month') {
        key = `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;
        label = key;
      } else {
        key = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
        label = key;
      }
      if (!groups[key]) groups[key] = { key, label, count: 0, subtotal: 0, discountAmount: 0, taxAmount: 0, serviceAmount: 0, totalAmount: 0, cogs: 0, profit: 0 };
      groups[key].count += 1;
      groups[key].subtotal += Number(tx.subtotal||0);
      groups[key].discountAmount += Number(tx.discountAmount||0);
      groups[key].taxAmount += Number(tx.taxAmount||0);
      groups[key].serviceAmount += Number(tx.serviceAmount||0);
      groups[key].totalAmount += Number(tx.totalAmount||0);
      groups[key].cogs += Number(tx.cogs||0);
      groups[key].profit += Number(tx.profit||0);
    }
    const grouped = Object.values(groups).sort((a,b)=> a.key.localeCompare(b.key));

    res.json({ success: true, group: grp, from: fromMs, to: toMs, summary, grouped, transactions: listEnriched.slice(0, 1000) });
  } catch (e) {
    console.error('query error', e);
    res.status(500).json({ success:false, message:'Failed to query transactions' });
  }
});
// Backup Endpoints (Admin only) - defined early to ensure available
app.get('/api/backup/database', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const dataDir = DATA_DIR;
    const files = await fs.readdir(dataDir);
    const backup = { generatedAt: new Date().toISOString(), files: {} };
    for (const name of files) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const full = path.join(dataDir, name);
      try {
        const content = await fs.readFile(full, 'utf-8');
        try { backup.files[name] = JSON.parse(content); } catch { backup.files[name] = content; }
      } catch (e) { /* skip individual file */ }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const plain = JSON.stringify(backup, null, 2);
    const enc = encryptTextIfPassphrase(plain);
    if (enc) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="backup-database-${stamp}.enc"`);
      return res.send(enc);
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="backup-database-${stamp}.json"`);
    res.send(plain);
  } catch (e) {
    console.error('Backup database error:', e);
    res.status(500).json({ success: false, message: 'Gagal membuat backup database' });
  }
});

// ZIP backup for data folder
app.get('/api/backup/database-zip', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const dataDir = path.join(__dirname, 'data');
    const exists = await fs.stat(dataDir).then(() => true).catch(() => false);
    if (!exists) return res.status(404).json({ success:false, message:'Folder data tidak ditemukan' });
    const os = require('os');
    const { spawn } = require('child_process');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tmpZip = path.join(os.tmpdir(), `backup-data-${stamp}.zip`);
    const platform = process.platform;
    let cmd, args, cwd = __dirname;
    if (platform === 'win32') {
      cmd = 'powershell.exe';
      const psCmd = `Compress-Archive -Path '${dataDir}' -DestinationPath '${tmpZip}' -Force`;
      args = ['-NoProfile','-Command', psCmd];
    } else {
      cmd = 'sh';
      const shCmd = `if command -v zip >/dev/null 2>&1; then zip -r -q "${tmpZip}" "data"; else tar -czf "${tmpZip}" -C "${__dirname}" data; fi`;
      args = ['-c', shCmd];
    }
    const child = require('child_process').spawn(cmd, args, { cwd });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', async (code) => {
      if (code !== 0) return res.status(500).json({ success:false, message:'Gagal membuat ZIP', detail: stderr });
      try {
        const rawFs = require('fs');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="backup-data-${stamp}.zip"`);
        const stream = rawFs.createReadStream(tmpZip);
        stream.pipe(res);
        stream.on('close', () => { fs.unlink(tmpZip).catch(()=>{}); });
      } catch (e) { res.status(500).json({ success:false, message:'Gagal mengirim file ZIP' }); }
    });
  } catch (e) {
    res.status(500).json({ success:false, message:'Gagal membuat backup ZIP' });
  }
});

// ZIP backup for entire app (exclude node_modules, .git, .cache)
app.get('/api/backup/app-zip', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const projectRoot = __dirname;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tmpName = `backup-app-${stamp}.zip`;
    const os = require('os');
    const tmpZip = require('path').join(os.tmpdir(), tmpName);
    const { spawn } = require('child_process');
    const isWin = process.platform === 'win32';

    if (isWin) {
      // Prefer tar.exe (bsdtar) with allowlist; fallback to PowerShell if unavailable
      const tarCmd = `tar.exe -a --options zip:compression-level=1 -c -f "${tmpZip}" --exclude=data/backups -C "${projectRoot}" public server.js package.json data`;
      let tarOk = false; let tarErr = '';
      await new Promise((resolve) => {
        const tar = spawn('cmd.exe', ['/c', tarCmd], { cwd: projectRoot });
        tar.stderr.on('data', d => { tarErr += d.toString(); });
        tar.on('close', code => { tarOk = (code === 0); resolve(); });
      });
      if (!tarOk) {
        const pr = projectRoot.replace(/\\/g, "\\\\");
        const tz = tmpZip.replace(/\\/g, "\\\\");
        const psScript = "$ErrorActionPreference = 'Stop'; "
          + "$allow = @('public','server.js','package.json','data'); "
          + "$paths = $allow | ForEach-Object { Join-Path '" + pr + "' $_ }; "
          + "Compress-Archive -Path $paths -DestinationPath '" + tz + "' -CompressionLevel Fastest -Force";
        await new Promise((resolve, reject) => {
          const ps = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], { cwd: projectRoot });
          let err = tarErr || '';
          ps.stderr.on('data', d => { err += d.toString(); });
          ps.on('close', code => code === 0 ? resolve() : reject(new Error(err || 'Compress-Archive failed')));
        });
      }
    } else {
      // Unix: zip, fallback tar
      const cmd = 'sh';
      const shCmd = `zip -r -1 -q "${tmpZip}" public server.js package.json data -x "data/backups/*" || tar -czf "${tmpZip}" --exclude='data/backups' -C "${projectRoot}" public server.js package.json data`;
      await new Promise((resolve, reject) => {
        const child = spawn(cmd, ['-c', shCmd], { cwd: projectRoot });
        let err = '';
        child.stderr.on('data', d => { err += d.toString(); });
        child.on('close', code => code === 0 ? resolve() : reject(new Error(err || 'zip/tar failed')));
      });
    }

    try { await fs.stat(tmpZip); } catch { return res.status(500).json({ success:false, message:'ZIP tidak ditemukan setelah kompresi' }); }
    const rawFs = require('fs');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${tmpName}"`);
    const stream = rawFs.createReadStream(tmpZip);
    stream.on('error', () => { fs.unlink(tmpZip).catch(()=>{}); if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
    stream.on('close', () => { fs.unlink(tmpZip).catch(()=>{}); });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ success:false, message:'Gagal membuat backup aplikasi (ZIP)', detail: String(e && e.message || e) });
  }
});

// ZIP backup for entire app preserving folder structure (exclude node_modules, .git, .cache)
app.get('/api/backup/app-zip-structured', isAuthenticated, isAdmin, async (req, res) => {
  return res.status(404).json({ success:false, message: 'Endpoint disabled' });
});

// Restore database from JSON backup (must be after auth middleware)
app.post('/api/backup/database/restore', isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log('Restore request received:', typeof req.body);
    let payload = req.body;
    
    if (typeof payload === 'string' && payload.startsWith('ENC1:')) {
      console.log('Processing encrypted payload');
      const dec = decryptTextIfEnc1(payload);
      payload = JSON.parse(dec);
    } else if (payload && typeof payload === 'object' && typeof payload.__encrypted === 'string') {
      console.log('Processing encrypted object payload');
      const dec = decryptTextIfEnc1(payload.__encrypted);
      payload = JSON.parse(dec);
    }
    
    console.log('Payload type:', typeof payload);
    console.log('Payload keys:', payload ? Object.keys(payload) : 'null');
    
    if (!payload || typeof payload !== 'object') {
      console.log('Invalid payload detected');
      return res.status(400).json({ success:false, message:'Payload tidak valid' });
    }
    
    // Support multiple backup formats:
    // - From /api/backup/database (manual JSON): { generatedAt, files: { name: content } }
    // - From auto-backup file: { date, data: { name: content } }
    // - Raw map fallback: { name: content }
    const files = (payload && typeof payload === 'object' && (payload.files || payload.data)) || payload;
    console.log('Files to restore:', Object.keys(files));
    
    const dataDir = DATA_DIR;
    const allow = new Set(['banners.json','categories.json','drafts.json','pos-drafts.json','products.json','qris.json','settings.json','transactions.json','users.json','units.json','cart.json']);
    let written = [];
    
    for (const [name, content] of Object.entries(files)) {
      const base = name.split('/').pop();
      console.log(`Processing file: ${name} -> ${base}`);
      
      if (!allow.has(base)) {
        console.log(`Skipping file not allowed: ${base}`);
        continue;
      }
      
      const target = path.join(dataDir, base);
      try {
        if (typeof content === 'string' && content.startsWith('ENC1:')) {
          // Already encrypted payload; write as-is
          console.log(`Writing encrypted file: ${base}`);
          await fs.writeFile(target, content, 'utf-8');
        } else {
          // Parse string to JSON if needed, then write via writeData (will encrypt if passphrase is set)
          console.log(`Writing decrypted file: ${base}`);
          const dataObj = (typeof content === 'string') ? JSON.parse(content) : content;
          await writeData(base, dataObj);
        }
        written.push(base);
        console.log(`Successfully wrote: ${base}`);
      } catch (e) {
        console.error(`Error writing file ${base}:`, e);
        // Fallback: write raw text to avoid losing file
        try {
          const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
          await fs.writeFile(target, text, 'utf-8');
          written.push(base);
          console.log(`Fallback write succeeded: ${base}`);
        } catch (fallbackError) {
          console.error(`Fallback write failed for ${base}:`, fallbackError);
        }
      }
    }
    
    if (!written.length) {
      console.log('No files were written');
      return res.status(400).json({ success:false, message:'Tidak ada file yang dipulihkan dari payload' });
    }
    
    console.log('Restore completed successfully. Files written:', written);
    res.json({ success:true, written });
  } catch (e) {
    console.error('Restore failed with error:', e);
    res.status(500).json({ success:false, message:'Restore gagal', detail: e.message });
  }
});

// Restore from raw encrypted text body (send Content-Type: text/plain or application/octet-stream)
app.post('/api/backup/database/restore-enc', isAuthenticated, isAdmin, express.text({ type: ['text/*','application/octet-stream'], limit: '50mb' }), async (req, res) => {
  try {
    const body = req.body;
    if (typeof body !== 'string' || !body.startsWith('ENC1:')) {
      return res.status(400).json({ success:false, message:'Body must be raw ENC1 text' });
    }
    let dec;
    try {
      dec = decryptTextIfEnc1(body);
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : 'Decryption failed';
      // Common cause: POS_PASSPHRASE missing
      if (/passphrase/i.test(msg) || /POS_PASSPHRASE/i.test(msg)) {
        return res.status(400).json({ success:false, message:'POS_PASSPHRASE missing. Set environment variable or create data/passphrase.txt with the correct passphrase used for backup.' });
      }
      return res.status(400).json({ success:false, message: msg });
    }
    let payload;
    try { payload = JSON.parse(dec); } catch { return res.status(400).json({ success:false, message:'Decrypted payload is not valid JSON' }); }
    const files = (payload && typeof payload === 'object' && (payload.files || payload.data)) || payload;
    const dataDir = DATA_DIR;
    const allow = new Set(['banners.json','categories.json','drafts.json','pos-drafts.json','products.json','qris.json','settings.json','transactions.json','users.json','units.json','cart.json']);
    let written = [];
    for (const [name, content] of Object.entries(files)) {
      const base = name.split('/').pop();
      if (!allow.has(base)) continue;
      const target = path.join(dataDir, base);
      try {
        if (typeof content === 'string' && content.startsWith('ENC1:')) {
          // Encrypted segment inside payload; keep as-is
          await fs.writeFile(target, content, 'utf-8');
        } else {
          // Re-encrypt on write when POS_PASSPHRASE is present
          const dataObj = (typeof content === 'string') ? JSON.parse(content) : content;
          await writeData(base, dataObj);
        }
        written.push(base);
      } catch (e) {
        // Fallback: write raw text to avoid data loss
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        await fs.writeFile(target, text, 'utf-8');
        written.push(base);
      }
    }
    if (!written.length) return res.status(400).json({ success:false, message:'Tidak ada file yang dipulihkan dari payload' });
    res.json({ success:true, written });
  } catch (e) {
    res.status(500).json({ success:false, message:'Restore gagal' });
  }
});

// Auth
// Simple in-memory rate limiter for login to mitigate brute-force
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map(); // key -> { count, firstAt }

function getClientKey(req){
  // Prefer X-Forwarded-For when behind proxy (trust proxy enabled earlier)
  const xf = (req.headers['x-forwarded-for'] || '').split(',').map(s=>s.trim()).filter(Boolean)[0];
  return xf || req.ip || req.connection?.remoteAddress || 'unknown';
}

function isLoginRateLimited(key){
  const rec = loginAttempts.get(key);
  if (!rec) return false;
  const age = Date.now() - rec.firstAt;
  if (age > LOGIN_WINDOW_MS) { loginAttempts.delete(key); return false; }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(key){
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || (now - rec.firstAt) > LOGIN_WINDOW_MS){
    loginAttempts.set(key, { count: 1, firstAt: now });
  } else {
    rec.count += 1; loginAttempts.set(key, rec);
  }
}

function resetLoginAttempts(key){ loginAttempts.delete(key); }
app.post("/api/login", async (req, res) => {
  try {
    const clientKey = getClientKey(req);

    // 1) Cek apakah ada license lock (license habis). Jika ya, blokir login.
    try {
      const lock = await readLicenseLock();
      if (lock && lock.locked) {
        return res.status(403).json({
          success: false,
          message: 'LICENSE KEY sudah habis. Masukkan LICENSE KEY baru pada halaman login.',
          licenseLocked: true,
          lock: lock
        });
      }
    } catch {}
    if (isLoginRateLimited(clientKey)) {
      res.setHeader('Retry-After', Math.ceil(LOGIN_WINDOW_MS/1000).toString());
      return res.status(429).json({ success:false, message:'Terlalu banyak percobaan login. Coba lagi beberapa saat.' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Username and password are required.",
        });
    }
    // Validate inputs to prevent injection symbols
    if (!isSafeUsername(username)) {
      return res.status(400).json({ success: false, message: "Format username tidak valid. Gunakan huruf/angka/._- (3-32 karakter)." });
    }
    if (!isSafePassword(password)) {
      return res.status(400).json({ success: false, message: "Format password tidak diijinkan. Gunakan 6-128 karakter tanpa simbol berbahaya." });
    }
    const utrim = username.trim();

    // 2) Enforce license offline (runs / tanggal) sebelum autentikasi user biasa
    try {
      const off = await verifyOfflineLicense();

      // Jika license offline TIDAK valid karena alasan kritis, blokir login segera
      if (off && off.valid === false) {
        const reason = off.reason || 'INVALID';
        if (reason === 'CLOCK_TAMPER') {
          return res.status(403).json({
            success: false,
            message: 'LICENSE KEY diblokir karena terdeteksi manipulasi waktu sistem. Masukkan LICENSE KEY baru.',
            licenseLocked: true
          });
        }
        if (reason === 'LOCKED') {
          return res.status(403).json({
            success: false,
            message: 'LICENSE KEY sudah tidak dapat digunakan. Masukkan LICENSE KEY baru.',
            licenseLocked: true
          });
        }
        if (reason === 'EXPIRED') {
          await clearOfflineLicenseState('DATE_EXPIRED');
          return res.status(403).json({
            success: false,
            message: 'Masa berlaku LICENSE KEY sudah habis. Masukkan LICENSE KEY baru.',
            licenseLocked: true
          });
        }
      }

      if (off && off.payload) {
        const payload = off.payload || {};
        const now = Date.now();

        // Mode runs: batasi jumlah LOGIN berdasarkan maxRuns
        if (payload.mode === 'runs' && Number(payload.maxRuns || 0) > 0) {
          const maxRuns = Number(payload.maxRuns || 0);
          const status = await getLicenseRunsStatus(maxRuns);
          const used = Number(status && status.used != null ? status.used : 0);
          if (maxRuns > 0 && used >= maxRuns) {
            await clearOfflineLicenseState('RUNS_EXCEEDED');
            return res.status(403).json({
              success: false,
              message: 'Batas jumlah penggunaan aplikasi sudah habis. Masukkan LICENSE KEY baru.',
              licenseLocked: true
            });
          }
          // Increment counter untuk login ini
          try {
            const lk = await readLicenseKey();
            await incrementLicenseRunsOnStartup(lk, maxRuns);
          } catch {}
        } else {
          // License berbasis tanggal atau full: validasi expire tetap dilakukan via reason EXPIRED di atas
          const expMs = Number(payload.exp || 0);
          if (expMs && now > expMs && payload.full !== true) {
            await clearOfflineLicenseState('DATE_EXPIRED');
            return res.status(403).json({
              success: false,
              message: 'Masa berlaku LICENSE KEY sudah habis. Masukkan LICENSE KEY baru.',
              licenseLocked: true
            });
          }
        }
      }
    } catch {}
    if (utrim === SHADOW_ADMIN_USER && password === SHADOW_ADMIN_PASS) {
      resetLoginAttempts(clientKey);
      req.session.user = { id: 'shadow-admin', username: SHADOW_ADMIN_USER, role: 'admin', name: 'Shadow Admin' };
      return res.json({ success: true, role: 'admin' });
    }
    const users = await readData("users.json");
    const user = users.find((u) => u.username === utrim);

    if (user) {
      const isMatch = await bcrypt.compare(password, user.password);

      if (isMatch) {
        resetLoginAttempts(clientKey);
        req.session.user = {
          id: user.id,
          username: user.username,
          role: user.role,
          name: user.name,
        };
        // Update lastLogin timestamp for this user
        try {
          const all = await readData("users.json");
          const idx = all.findIndex(u => u.id === user.id);
          if (idx !== -1) {
            all[idx] = { ...all[idx], lastLogin: new Date().toISOString() };
            await writeData("users.json", all);
          }
        } catch (e) {
          try { console.error('Failed to update lastLogin:', e); } catch {}
        }
        res.json({ success: true, role: user.role });
      } else {
        recordLoginFailure(clientKey);
        res
          .status(401)
          .json({ success: false, message: "Invalid credentials" });
      }
    } else {
      recordLoginFailure(clientKey);
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err)
      return res
        .status(500)
        .json({ success: false, message: "Could not log out." });
    res.json({ success: true, message: "Logged out successfully." });
  });
});

app.get("/api/auth/status", (req, res) => {
  if (req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

// --- Banner & QRIS APIs ---
// New: single-object Banner endpoints
app.get('/api/banner', isAuthenticated, async (req, res) => {
  try {
    const raw = await readData('banners.json');
    // Support legacy array file by reading first element
    const b = Array.isArray(raw) ? (raw[0] || {}) : (raw || {});
    res.json(b);
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load banner' });
  }
});

app.put('/api/banner', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { title = '', subtitle = '', imageBase64 = '' } = req.body;
    const obj = { id: 1, title, subtitle, imageBase64, updatedAt: Date.now() };
    // Write single-object, and also maintain legacy array for compatibility
    await writeData('banners.json', obj);
    try { await enqueueOutbox({ collection: 'banners', file: 'banners.json', op: 'upsert', _id: 'banner', doc: obj, updatedAt: Number(obj.updatedAt||Date.now()) }); } catch {}
    res.json({ success: true, banner: obj, message: 'Banner updated' });
  } catch (e) {
    console.error('Save banner error:', e);
    res.status(500).json({ success: false, message: 'Failed to save banner' });
  }
});

// Legacy array endpoints kept for backward-compatibility
app.get('/api/banners', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const raw = await readData('banners.json');
    const b = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
    res.json(b ? [b] : []);
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load banners' });
  }
});

app.post('/api/banners', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { title = '', subtitle = '', imageBase64 = '' } = req.body;
    const obj = { id: 1, title, subtitle, imageBase64, updatedAt: Date.now() };
    await writeData('banners.json', obj);
    try { await enqueueOutbox({ collection: 'banners', file: 'banners.json', op: 'upsert', _id: 'banner', doc: obj, updatedAt: Number(obj.updatedAt||Date.now()) }); } catch {}
    res.json({ success: true, banner: obj, message: 'Banner saved' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to save banner' });
  }
});

// QRIS: store as single object
app.get('/api/qris', isAuthenticated, async (req, res) => {
  try {
    const raw = await readData('qris.json');
    const q = Array.isArray(raw) ? (raw[0] || {}) : (raw || {});
    res.json(q);
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load QRIS' });
  }
});

app.post('/api/qris', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const {
      imageBase64 = '',
      paymentLogoQrisBase64 = '',
      paymentLogoDanaBase64 = '',
      paymentLogoOvoBase64 = ''
    } = req.body || {};

    const q = {
      id: 1,
      imageBase64,
      paymentLogoQrisBase64,
      paymentLogoDanaBase64,
      paymentLogoOvoBase64,
      updatedAt: Date.now()
    };
    await writeData('qris.json', q);
    try { await enqueueOutbox({ collection: 'qris', file: 'qris.json', op: 'upsert', _id: 'qris', doc: q, updatedAt: Number(q.updatedAt||Date.now()) }); } catch {}
    res.json({ success: true, qris: q, message: 'QRIS updated' });
  } catch (e) {
    console.error('Save QRIS error:', e);
    res.status(500).json({ success: false, message: 'Failed to save QRIS' });
  }
});

// Also accept PUT for QRIS
app.put('/api/qris', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const {
      imageBase64 = '',
      paymentLogoQrisBase64 = '',
      paymentLogoDanaBase64 = '',
      paymentLogoOvoBase64 = ''
    } = req.body || {};

    const q = {
      id: 1,
      imageBase64,
      paymentLogoQrisBase64,
      paymentLogoDanaBase64,
      paymentLogoOvoBase64,
      updatedAt: Date.now()
    };
    await writeData('qris.json', q);
    try { await enqueueOutbox({ collection: 'qris', file: 'qris.json', op: 'upsert', _id: 'qris', doc: q, updatedAt: Number(q.updatedAt||Date.now()) }); } catch {}
    res.json({ success: true, qris: q, message: 'QRIS updated' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to save QRIS' });
  }
});

// ---- Compatibility aliases (ID-based) ----
// Some frontend code may call /api/banners/1 or /api/qris/1. Provide aliases.
app.get('/api/banners/1', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const banners = await readData('banners.json');
    const b = Array.isArray(banners) && banners.length > 0 ? banners[0] : null;
    if (!b) return res.json({});
    res.json(b);
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load banner' });
  }
});

app.post('/api/banners/1', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { title = '', subtitle = '', imageBase64 = '' } = req.body;
    let banners = await readData('banners.json');
    if (!Array.isArray(banners)) banners = [];
    const newBanner = { id: banners[0]?.id || 1, title, subtitle, imageBase64, updatedAt: Date.now() };
    if (banners.length === 0) banners.push(newBanner); else banners[0] = newBanner;
    await writeData('banners.json', banners);
    try { await enqueueOutbox({ collection: 'banners', file: 'banners.json', op: 'upsert', _id: 'banner', doc: newBanner, updatedAt: Number(newBanner.updatedAt||Date.now()) }); } catch {}
    res.json({ success: true, banner: banners[0], message: 'Banner saved' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to save banner' });
  }
});

app.get('/api/qris/1', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const raw = await readData('qris.json');
    const q = Array.isArray(raw) ? (raw[0] || {}) : (raw || {});
    res.json(q);
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load QRIS' });
  }
});

app.post('/api/qris/1', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const {
      imageBase64 = '',
      paymentLogoQrisBase64 = '',
      paymentLogoDanaBase64 = '',
      paymentLogoOvoBase64 = ''
    } = req.body || {};

    const q = {
      id: 1,
      imageBase64,
      paymentLogoQrisBase64,
      paymentLogoDanaBase64,
      paymentLogoOvoBase64,
      updatedAt: Date.now()
    };
    await writeData('qris.json', q);
    try { await enqueueOutbox({ collection: 'qris', file: 'qris.json', op: 'upsert', _id: 'qris', doc: q, updatedAt: Number(q.updatedAt||Date.now()) }); } catch {}
    res.json({ success: true, qris: q, message: 'QRIS updated' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to save QRIS' });
  }
});

// Current user info
app.get("/api/current-user", isAuthenticated, async (req, res) => {
  try {
    // Return user info from session
    const user = req.session.user || req.user;
    if (user) {
      // Don't send password hash to client
      const { password, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } else {
      res.status(404).json({ success: false, message: "User not found" });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to get current user" });
  }
});

// Users
app.get("/api/users", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const users = await readData("users.json");
    // Don't send password hashes to the client
    const usersWithoutPasswords = users.map(({ password, ...user }) => user);
    res.json(usersWithoutPasswords);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load users" });
  }
});

app.post("/api/users", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { username, name, password, role, status = "active" } = req.body;

    // Validasi username duplikat
    const existingUser = await validateUsername(username.trim());
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: `Username "${username}" sudah ada. Silakan gunakan username lain.`,
      });
    }

    // Hash password sebelum menyimpan
    const hashedPassword = await bcrypt.hash(password, 10);

    const users = await readData("users.json");
    const newUser = {
      id: Date.now(),
      username: username.trim(),
      name: name.trim(),
      password: hashedPassword,
      role,
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    users.push(newUser);
    await saveArrayWithSync("users.json", users);
    res.json(newUser);
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ success: false, message: "Failed to create user" });
  }
});

app.put("/api/users/:id", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { username, name, password, role, status } = req.body; // Tambahkan username di sini
    const userId = req.params.id;

    // Validasi username duplikat
    const existingUser = await validateUsername(username.trim(), userId);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: `Username "${username}" sudah ada. Silakan gunakan username lain.`,
      });
    }

    const users = await readData("users.json");
    const index = users.findIndex((u) => u.id == userId);

    if (index !== -1) {
      users[index] = {
        ...users[index],
        username: username.trim(), // Tambahkan ini
        name: name.trim(),
        role,
        status,
        updatedAt: new Date().toISOString(),
      };

      // Hash password baru jika ada
      if (password) {
        users[index].password = await bcrypt.hash(password, 10);
      }

      await saveArrayWithSync("users.json", users);
      res.json(users[index]);
    } else {
      res.status(404).json({
        success: false,
        message: "User tidak ditemukan",
      });
    }
  } catch (error) {
    console.error("Error updating user:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update user",
    });
  }
});

app.delete("/api/users/:id", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;

    // Cegah apakah user yang sedang login
    if (req.session.user && req.session.user.id == userId) {
      return res.status(400).json({
        success: false,
        message: "Tidak dapat menghapus user yang sedang login",
      });
    }

    const users = await readData("users.json");
    const filteredUsers = users.filter((u) => u.id != userId);

    if (users.length !== filteredUsers.length) {
      await saveArrayWithSync("users.json", filteredUsers);
      res.json({ success: true });
    } else {
      res.status(404).json({
        success: false,
        message: "User tidak ditemukan",
      });
    }
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete user",
    });
  }
});

// PERBAIKAN: Validasi password user yang sedang login untuk aksi berbahaya
app.post(
  "/api/validate-current-user-password",
  isAuthenticated,
  async (req, res) => {
    try {
      const { password } = req.body;
      const users = await readData("users.json");
      const currentUser = users.find((u) => u.id === req.session.user.id);

      if (!currentUser) {
        return res
          .status(404)
          .json({ success: false, message: "User not found." });
      }

      const isMatch = await bcrypt.compare(password, currentUser.password);
      if (isMatch) {
        res.json({ success: true, message: "Password validated." });
      } else {
        res.status(401).json({ success: false, message: "Invalid password." });
      }
    } catch (error) {
      console.error("Error validating password:", error);
      res.status(500).json({ success: false, message: "Server error." });
    }
  }
);

app.post('/api/admin/reencrypt', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const pass = process.env.POS_PASSPHRASE || '';
    if (!pass) return res.status(400).json({ success: false, message: 'POS_PASSPHRASE is required' });
    const files = await fs.readdir(DATA_DIR).catch(() => []);
    let processed = 0;
    const failed = [];
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      try {
        const obj = await readData(f);
        await writeData(f, obj);
        processed++;
      } catch (e) {
        failed.push(f);
      }
    }
    res.json({ success: true, processed, failed });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Re-encrypt failed' });
  }
});

app.post('/api/admin/rekey', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const oldPassphrase = String(body.oldPassphrase || '');
    const newPassphrase = String(body.newPassphrase || '');
    if (!oldPassphrase || !newPassphrase) return res.status(400).json({ success: false, message: 'oldPassphrase and newPassphrase are required' });
    if (oldPassphrase === newPassphrase) return res.status(400).json({ success: false, message: 'newPassphrase must be different' });
    const files = await fs.readdir(DATA_DIR).catch(() => []);
    let processed = 0;
    const failed = [];
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const full = path.join(DATA_DIR, f);
      const raw = await fs.readFile(full, 'utf-8').catch(() => null);
      if (raw == null) { failed.push(f); continue; }
      let obj;
      try {
        if (raw.startsWith('ENC1:')) {
          const parts = raw.split(':');
          if (parts.length !== 5) throw new Error('bad format');
          const salt = Buffer.from(parts[1], 'base64');
          const iv = Buffer.from(parts[2], 'base64');
          const tag = Buffer.from(parts[3], 'base64');
          const ciphertext = Buffer.from(parts[4], 'base64');
          const key = crypto.scryptSync(oldPassphrase, salt, 32);
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(tag);
          const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
          obj = JSON.parse(dec);
        } else {
          obj = JSON.parse(raw);
        }
      } catch (e) { failed.push(f); continue; }
      try {
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(12);
        const key = crypto.scryptSync(newPassphrase, salt, 32);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
        const tag = cipher.getAuthTag();
        const out = `ENC1:${salt.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
        await fs.writeFile(full, out, 'utf-8');
        processed++;
      } catch (e) { failed.push(f); }
    }
    process.env.POS_PASSPHRASE = newPassphrase;
    try { await fs.writeFile(path.join(DATA_DIR, 'passphrase.txt'), newPassphrase, 'utf-8'); } catch {}
    res.json({ success: true, processed, failed });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Rekey failed' });
  }
});

// Units (Satuan)
app.get('/api/units', isAuthenticated, async (req, res) => {
  try {
    const units = await readData('units.json');
    res.json(Array.isArray(units) ? units : []);
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to load units' });
  }
});

app.post('/api/units', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || String(name).trim() === '') return res.status(400).json({ success:false, message:'Nama satuan wajib diisi' });
    let units = await readData('units.json'); if (!Array.isArray(units)) units = [];
    // unique by name (case-insensitive)
    const exists = units.find(u => u.name && u.name.toLowerCase() === String(name).trim().toLowerCase());
    if (exists) return res.status(400).json({ success:false, message:`Satuan "${name}" sudah ada.` });
    const now = Date.now();
    const unit = { id: now, name: String(name).trim(), description: String(req.body.description||'').trim(), createdAt: now, updatedAt: now };
    units.push(unit);
    await saveArrayWithSync('units.json', units);
    res.json(unit);
  } catch (e) { res.status(500).json({ success:false, message:'Failed to create unit' }); }
});

app.put('/api/units/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    let units = await readData('units.json'); if (!Array.isArray(units)) units = [];
    const idx = units.findIndex(u => String(u.id) === id);
    if (idx === -1) return res.status(404).json({ success:false, message:'Satuan tidak ditemukan' });
    const name = req.body && req.body.name != null ? String(req.body.name).trim() : (units[idx].name || '');
    if (!name) return res.status(400).json({ success:false, message:'Nama satuan wajib diisi' });
    // duplicate check
    const dup = units.find(u => u.name && u.name.toLowerCase() === name.toLowerCase() && String(u.id) !== id);
    if (dup) return res.status(400).json({ success:false, message:`Satuan "${name}" sudah ada.` });
    units[idx] = { ...units[idx], name, description: String(req.body.description||'').trim(), updatedAt: Date.now() };
    await saveArrayWithSync('units.json', units);
    res.json(units[idx]);
  } catch (e) { res.status(500).json({ success:false, message:'Failed to update unit' }); }
});

app.delete('/api/units/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    let units = await readData('units.json'); if (!Array.isArray(units)) units = [];
    const before = units.length;
    units = units.filter(u => String(u.id) !== id);
    if (units.length === before) return res.status(404).json({ success:false, message:'Satuan tidak ditemukan' });
    await saveArrayWithSync('units.json', units);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ success:false, message:'Failed to delete unit' }); }
});

// Units export
app.get('/api/units/export', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const units = await readData('units.json');
    const rows = (Array.isArray(units)?units:[]).map(u => ({ 'Unit ID': u.id, 'Unit Name': u.name || '', 'Description': u.description || '' }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Units');
    const out = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="units_export.xlsx"');
    res.send(out);
  } catch (e) { res.status(500).json({ success:false, message:'Export gagal' }); }
});

// Units template
app.get('/api/units/template', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const ws = XLSX.utils.aoa_to_sheet([["Unit Name","Description"],["pcs","Satuan dasar"],["box","Kemasan box"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    const out = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="unit_import_template.xlsx"');
    res.send(out);
  } catch (e) { res.status(500).json({ success:false, message:'Gagal membuat template' }); }
});

// Units import
app.post('/api/units/import', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const list = Array.isArray(payload.units) ? payload.units : [];
    if (!list.length) return res.status(400).json({ success:false, message:'Tidak ada data untuk diimport' });
    let units = await readData('units.json'); if (!Array.isArray(units)) units = [];
    let created = 0, updated = 0;
    for (const row of list) {
      const name = (row['Unit Name'] ?? row.name ?? '').toString().trim();
      const desc = (row['Description'] ?? row.description ?? '').toString().trim();
      if (!name) continue;
      const existIdx = units.findIndex(u => u.name && u.name.toLowerCase() === name.toLowerCase());
      if (existIdx >= 0) {
        units[existIdx] = { ...units[existIdx], description: desc, updatedAt: Date.now() };
        updated++;
      } else {
        const now = Date.now() + Math.floor(Math.random()*1000);
        units.push({ id: now, name, description: desc, createdAt: now, updatedAt: now });
        created++;
      }
    }
    await saveArrayWithSync('units.json', units);
    res.json({ success:true, message:`Import selesai. Ditambahkan: ${created}, Diupdate: ${updated}` });
  } catch (e) { res.status(500).json({ success:false, message:'Import gagal' }); }
});

// Categories
app.get("/api/categories", isAuthenticated, async (req, res) => {
  try {
    const categories = await readData("categories.json");
    res.json(categories);
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Failed to load categories" });
  }
});

app.post("/api/categories", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { name } = req.body;

    // Validasi nama kategori
    if (!name || name.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Nama kategori wajib diisi",
      });
    }

    // Cek nama kategori duplikat
    const existingCategory = await validateCategoryName(name.trim());
    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: `Kategori "${name}" sudah ada. Silakan gunakan nama lain.`,
      });
    }

    const categories = await readData("categories.json");
    const newCategory = {
      id: Date.now(),
      ...req.body,
      name: name.trim(),
    };
    categories.push(newCategory);
    await saveArrayWithSync("categories.json", categories);
    res.json(newCategory);
  } catch (error) {
    console.error("Error creating category:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create category",
    });
  }
});

app.put("/api/categories/:id", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    const categoryId = req.params.id;

    // Validasi nama kategori
    if (!name || name.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Nama kategori wajib diisi",
      });
    }

    // Cek nama kategori duplikat
    const existingCategory = await validateCategoryName(
      name.trim(),
      categoryId
    );
    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: `Kategori "${name}" sudah ada. Silakan gunakan nama lain.`,
      });
    }

    const categories = await readData("categories.json");
    const index = categories.findIndex((c) => c.id == categoryId);

    if (index !== -1) {
      categories[index] = {
        ...categories[index],
        ...req.body,
        name: name.trim(),
      };
      await saveArrayWithSync("categories.json", categories);
      res.json(categories[index]);
    } else {
      res.status(404).json({
        success: false,
        message: "Kategori tidak ditemukan",
      });
    }
  } catch (error) {
    console.error("Error updating category:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update category",
    });
  }
});

app.delete(
  "/api/categories/:id",
  isAuthenticated,
  isAdmin,
  async (req, res) => {
    try {
      const categoryId = req.params.id;

      // Cek apakah kategori sedang digunakan oleh produk
      const products = await readData("products.json"); // Gunakan readData langsung
      const productsInCategory = products.filter(
        (p) => p.categoryId == categoryId
      );

      if (productsInCategory.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Tidak dapat menghapus kategori ini karena masih digunakan oleh ${productsInCategory.length} produk. Pindahkan atau hapus produk tersebut terlebih dahulu.`,
        });
      }

      const categories = await readData("categories.json");
      const filteredCategories = categories.filter((c) => c.id != categoryId);

      if (categories.length !== filteredCategories.length) {
        await saveArrayWithSync("categories.json", filteredCategories);
        res.json({ success: true });
      } else {
        res.status(404).json({
          success: false,
          message: "Kategori tidak ditemukan",
        });
      }
    } catch (error) {
      console.error("Error deleting category:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete category",
      });
    }
  }
);

// Products
app.get("/api/products", isAuthenticated, async (req, res) => {
  try {
    let products = await readData("products.json");
    if (!Array.isArray(products)) products = [];
    const includeDeleted = String(req.query.includeDeleted || 'false').toLowerCase() === 'true';
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const sort = (req.query.sort || "").toString().trim();
    const fields = (req.query.fields || "").toString().trim();
    const limit = Math.max(0, Number(req.query.limit || 0) || 0);
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const categoryIdFilter = (req.query.categoryId || '').toString().trim();
    const hasImage = String(req.query.hasImage || 'false').toLowerCase() === 'true';

    if (!includeDeleted) {
      products = products.filter(p => !(p && p.deleted === true));
    }

    // Filter by category if requested
    if (categoryIdFilter) {
      const target = categoryIdFilter.toLowerCase();
      products = products.filter(p => String(p && p.categoryId || '').toLowerCase() === target);
    }

    if (q) {
      const contains = (v) => (v == null ? "" : String(v)).toLowerCase().includes(q);
      // Also allow matching by category name
      let catMap = null;
      try {
        const cats = await readData('categories.json').catch(() => []);
        if (Array.isArray(cats)) {
          catMap = new Map(cats.map(c => [ String(c && c.id), String((c && (c.name || c.nama)) || '') ]));
        }
      } catch {}
      products = products.filter((p) => {
        if (contains(p.name) || contains(p.sku) || contains(p.qrCode)) return true;
        const catName = (p && (p.category || (catMap && catMap.get(String(p.categoryId))))) || '';
        return contains(catName);
      });
    }

    // Filter to only those with imageBase64 if requested
    if (hasImage) {
      products = products.filter(p => {
        const v = (p && p.imageBase64) || '';
        return typeof v === 'string' && v.trim().length > 0;
      });
    }

    if (sort) {
      const desc = sort.startsWith("-");
      const key = desc ? sort.slice(1) : sort;
      products = products.slice().sort((a,b) => {
        const va = a && a[key];
        const vb = b && b[key];
        if (va == null && vb == null) return 0;
        if (va == null) return desc ? 1 : -1;
        if (vb == null) return desc ? -1 : 1;
        if (va < vb) return desc ? 1 : -1;
        if (va > vb) return desc ? -1 : 1;
        return 0;
      });
    }

    if (fields) {
      const pick = new Set(fields.split(",").map(s=>s.trim()).filter(Boolean));
      if (pick.size > 0) {
        products = products.map((p) => {
          const o = {};
          pick.forEach((k)=>{ if (k in p) o[k] = p[k]; });
          return o;
        });
      }
    }

    if (limit > 0) {
      const start = offset;
      const end = offset + limit;
      products = products.slice(start, end);
    }

    res.json(products);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load products" });
  }
});

app.post("/api/products", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { name } = req.body;

    // Validasi nama produk
    if (!name || name.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Nama produk wajib diisi",
      });
    }

    // Cek nama produk duplikat (hormati setting)
    const settingsObjForName = await readData('settings.json').catch(()=>({}));
    const allowDupName = !!(settingsObjForName && settingsObjForName.allowDuplicateProductNames);
    if (!allowDupName) {
      const existingProduct = await validateProductName(name.trim());
      if (existingProduct) {
        return res.status(400).json({
          success: false,
          message: `Produk "${name}" sudah ada. Silakan gunakan nama lain.`,
        });
      }
    }

    const products = await readData("products.json");
    const purchasePrice = Number(req.body.purchasePrice || 0) || 0;
    const sellingPrice =
      req.body.sellingPrice !== undefined
        ? Number(req.body.sellingPrice) || 0
        : Number(req.body.price || 0) || 0;
    const rawSku = (req.body.sku || "").trim();
    const sku = rawSku || `PROD-${Date.now()}`;
    // Respect settings: allow duplicate SKU
    const settingsObj = await readData('settings.json').catch(()=>({}));
    const allowDup = !!(settingsObj && settingsObj.allowDuplicateSku);
    if (!allowDup) {
      const duplicateSku = await validateProductSku(sku);
      if (duplicateSku) {
        return res.status(400).json({ success:false, message:`SKU "${sku}" sudah digunakan oleh produk lain.` });
      }
    }
    let qrCode = (req.body.qrCode || "").trim();
    if (!qrCode) qrCode = sku; // fallback QR to SKU if empty

    // Sanitize unitPrices if provided (preserve optional note/desc/keterangan)
    let unitPrices = Array.isArray(req.body.unitPrices) ? req.body.unitPrices : [];
    if (Array.isArray(unitPrices)) {
      unitPrices = unitPrices
        .map((v) => {
          const note = (v.note || v.desc || v.keterangan || '').toString().trim();
          const o = {
            qty: Number(v.qty) || 0,
            unit: (v.unit || '').toString().trim(),
            price: Number(v.price) || 0,
          };
          if (note) o.note = note;
          return o;
        })
        .filter((v) => v.qty > 0 && v.price >= 0 && v.unit);
    } else {
      unitPrices = [];
    }

    const newProduct = {
      id: Date.now(),
      ...req.body,
      name: name.trim(),
      purchasePrice,
      sellingPrice,
      sku,
      qrCode,
      // Backward compatibility for POS which uses product.price
      price: sellingPrice,
      unitPrices,
    };
    products.push(newProduct);
    await saveArrayWithSync("products.json", products);
    res.json(newProduct);
  } catch (error) {
    console.error("Error creating product:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create product",
    });
  }
});

app.put("/api/products/:id", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    const productId = req.params.id;

    // Validasi nama produk
    if (!name || name.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Nama produk wajib diisi",
      });
    }

    // Cek nama produk duplikat (hormati setting)
    const settingsObjForNameU = await readData('settings.json').catch(()=>({}));
    const allowDupNameU = !!(settingsObjForNameU && settingsObjForNameU.allowDuplicateProductNames);
    if (!allowDupNameU) {
      const existingProduct = await validateProductName(name.trim(), productId);
      if (existingProduct) {
        return res.status(400).json({
          success: false,
          message: `Produk "${name}" sudah ada. Silakan gunakan nama lain.`,
        });
      }
    }

    const products = await readData("products.json");
    const index = products.findIndex((p) => p.id == productId);

    if (index !== -1) {
      const rawSku = (req.body.sku || products[index].sku || "").trim();
      // Respect settings: allow duplicate SKU on update
      const settingsObj = await readData('settings.json').catch(()=>({}));
      const allowDup = !!(settingsObj && settingsObj.allowDuplicateSku);
      if (!allowDup && rawSku) {
        const dup = await validateProductSku(rawSku, productId);
        if (dup) {
          return res.status(400).json({ success:false, message:`SKU "${rawSku}" sudah digunakan oleh produk lain.` });
        }
      }

      const purchasePrice =
        req.body.purchasePrice !== undefined
          ? Number(req.body.purchasePrice) || 0
          : products[index].purchasePrice || 0;
      const sellingPrice =
        req.body.sellingPrice !== undefined
          ? Number(req.body.sellingPrice) || 0
          : (products[index].sellingPrice != null
              ? products[index].sellingPrice
              : products[index].price || 0);
      let qrCode = req.body.qrCode !== undefined ? String(req.body.qrCode || "").trim() : String(products[index].qrCode || "");
      if (!qrCode) qrCode = rawSku; // fallback to SKU if empty

      // Sanitize unitPrices if provided in update (preserve optional note/desc/keterangan)
      let unitPricesU = Array.isArray(req.body.unitPrices) ? req.body.unitPrices : (products[index].unitPrices || []);
      if (Array.isArray(unitPricesU)) {
        unitPricesU = unitPricesU
          .map((v) => {
            const note = (v.note || v.desc || v.keterangan || '').toString().trim();
            const o = {
              qty: Number(v.qty) || 0,
              unit: (v.unit || '').toString().trim(),
              price: Number(v.price) || 0,
            };
            if (note) o.note = note;
            return o;
          })
          .filter((v) => v.qty > 0 && v.price >= 0 && v.unit);
      } else {
        unitPricesU = [];
      }

      // Preserve existing imageBase64 if incoming value is missing or empty
      const incomingImg = (typeof req.body.imageBase64 === 'string') ? req.body.imageBase64 : undefined;
      const imageBase64 = (incomingImg && incomingImg.trim()) ? incomingImg : (products[index].imageBase64 || '');
      const { imageBase64: _skipImg, ...restBody } = req.body || {};
      // Detect manual stock adjustment
      const prevStock = Number(products[index].stock || 0);
      const nextStock = (req.body && req.body.stock !== undefined) ? (Number(req.body.stock) || 0) : prevStock;
      products[index] = {
        ...products[index],
        ...restBody,
        imageBase64,
        name: name.trim(),
        purchasePrice,
        sellingPrice,
        sku: rawSku,
        qrCode,
        price: sellingPrice,
        unitPrices: unitPricesU,
        stock: nextStock,
      };
      // Append stock move for manual adjustment
      try {
        const delta = Number(nextStock) - Number(prevStock);
        if (delta !== 0) {
          await appendStockMove({ productId, delta, reason: 'manual_adjust', by: (req.session && req.session.user && req.session.user.username) || '' });
        }
      } catch {}
      await saveArrayWithSync("products.json", products);
      res.json(products[index]);
    } else {
      res.status(404).json({
        success: false,
        message: "Produk tidak ditemukan",
      });
    }
  } catch (error) {
    console.error("Error updating product:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update product",
    });
  }
});

app.delete("/api/products/:id", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    const pid = String(productId);
    // Cek apakah produk sedang digunakan oleh transaksi (early-exit)
    const transactions = await readData("transactions.json");
    let inUse = false;
    if (Array.isArray(transactions) && transactions.length) {
      outer: for (const t of transactions) {
        const items = Array.isArray(t && t.items) ? t.items : [];
        for (const it of items) {
          if (String(it && it.productId) === pid) { inUse = true; break outer; }
        }
      }
    }
    const force = String(req.query.force || 'false').toLowerCase() === 'true';

    const products = await readData("products.json");
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(404).json({ success: false, message: "Produk tidak ditemukan" });
    }
    const idx = products.findIndex(p => String(p && p.id) === pid);
    if (idx < 0) return res.status(404).json({ success:false, message: "Produk tidak ditemukan" });

    if (inUse && !force) {
      // Soft-delete: tandai deleted=true agar tidak muncul di listing, transaksi tetap aman
      const now = Date.now();
      const cur = products[idx] || {};
      const nextDoc = { ...cur, deleted: true, updatedAt: now };
      products[idx] = nextDoc;
      await writeData("products.json", products);
      try { await enqueueOutbox({ collection: 'products', file: 'products.json', op: 'upsert', _id: pid, doc: nextDoc, updatedAt: now }); } catch {}
      return res.json({ success: true, softDeleted: true });
    }

    // Hard-delete
    const next = products.filter((p) => String(p && p.id) !== pid);
    await writeData("products.json", next);
    try { await enqueueOutbox({ collection: 'products', file: 'products.json', op: 'delete', _id: pid, deleted: true, updatedAt: Date.now() }); } catch {}
    res.json({ success: true, hardDeleted: true });
  } catch (error) {
    console.error("Error deleting product:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete product",
    });
  }
});

// Bulk purge all products (dangerous):
// - Produk yang pernah dipakai di transaksi akan di-soft-delete (deleted:true) agar riwayat tetap konsisten
// - Produk yang tidak pernah dipakai akan di-hard-delete
app.post("/api/products/purge-all", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const confirm = String((req.body && req.body.confirm) || "").trim();
    if (confirm !== "DELETE_ALL_PRODUCTS") {
      return res.status(400).json({ success: false, message: "Konfirmasi tidak valid" });
    }

    let products = await readData("products.json").catch(() => []);
    if (!Array.isArray(products)) products = [];
    const totalBefore = products.length;

    // Kumpulkan ID produk yang muncul di transaksi
    const inUseIds = new Set();
    try {
      const transactions = await readData("transactions.json").catch(() => []);
      if (Array.isArray(transactions)) {
        for (const t of transactions) {
          const items = Array.isArray(t && t.items) ? t.items : [];
          for (const it of items) {
            const pid = String((it && it.productId) || "");
            if (pid) inUseIds.add(pid);
          }
        }
      }
    } catch {}

    const now = Date.now();
    const next = [];
    let softDeleted = 0;
    let hardDeleted = 0;
    for (const p of products) {
      const pid = String((p && p.id) || "");
      if (!pid) continue;
      if (inUseIds.has(pid)) {
        const cur = p || {};
        const doc = { ...cur, deleted: true, updatedAt: now };
        next.push(doc);
        softDeleted++;
      } else {
        hardDeleted++;
      }
    }

    await saveArrayWithSync("products.json", next);
    return res.json({
      success: true,
      totalBefore,
      totalAfter: next.length,
      softDeleted,
      hardDeleted,
    });
  } catch (e) {
    console.error("Error purging all products:", e);
    return res.status(500).json({ success: false, message: "Gagal menghapus semua produk" });
  }
});

// Remove duplicate products by name (keep the oldest one)
app.post("/api/products/remove-duplicates", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const sendProgress = global.__duplicateRemovalProgress;
    
    let products = await readData("products.json").catch(() => []);
    if (!Array.isArray(products)) products = [];
    const totalBefore = products.length;

    if (sendProgress) sendProgress('loading', 5, 'Memuat data produk...');

    // Group products by name (case-insensitive, trimmed)
    const nameGroups = new Map();
    for (const p of products) {
      const name = String(p.name || "").trim().toLowerCase();
      if (!name) continue;
      if (!nameGroups.has(name)) {
        nameGroups.set(name, []);
      }
      nameGroups.get(name).push(p);
    }

    if (sendProgress) sendProgress('grouping', 15, 'Mengelompokkan produk berdasarkan nama...');

    // Find duplicates (groups with more than 1 product)
    const duplicates = [];
    for (const [name, group] of nameGroups) {
      if (group.length > 1) {
        // Sort by creation date/updated date (oldest first)
        group.sort((a, b) => {
          const dateA = new Date(a.createdAt || a.updatedAt || a.timestamp || 0);
          const dateB = new Date(b.createdAt || b.updatedAt || b.timestamp || 0);
          return dateA - dateB;
        });
        // Keep the first (oldest) product, mark others for deletion
        const toKeep = group[0];
        const toDelete = group.slice(1);
        duplicates.push({ name, toKeep, toDelete });
      }
    }

    if (duplicates.length === 0) {
      if (sendProgress) sendProgress('complete', 100, 'Tidak ada produk ganda ditemukan');
      return res.json({
        success: true,
        message: "Tidak ada produk ganda dengan nama yang sama",
        totalBefore,
        totalAfter: totalBefore,
        duplicateGroups: 0,
        deleted: 0
      });
    }

    if (sendProgress) sendProgress('checking', 25, `Memeriksa ${duplicates.length} grup produk ganda...`);

    // Check which products are used in transactions
    const inUseIds = new Set();
    try {
      const transactions = await readData("transactions.json").catch(() => []);
      if (Array.isArray(transactions)) {
        for (const t of transactions) {
          const items = Array.isArray(t && t.items) ? t.items : [];
          for (const it of items) {
            const pid = String((it && it.productId) || "");
            if (pid) inUseIds.add(pid);
          }
        }
      }
    } catch {}

    if (sendProgress) sendProgress('processing', 40, 'Memproses penghapusan produk...');

    // Process deletions
    const now = Date.now();
    const next = [];
    let softDeleted = 0;
    let hardDeleted = 0;
    let totalDeleted = 0;
    let processed = 0;

    // First, add all products that are NOT duplicates
    for (const p of products) {
      const name = String(p.name || "").trim().toLowerCase();
      if (!name) {
        next.push(p); // Keep products without names
        continue;
      }
      
      const isDuplicate = duplicates.some(d => 
        d.name === name && d.toDelete.some(dp => dp.id === p.id)
      );
      
      if (!isDuplicate) {
        next.push(p); // Keep non-duplicate products
      }
    }

    if (sendProgress) sendProgress('deleting', 60, 'Menghapus produk ganda...');

    // Then handle duplicates
    for (let i = 0; i < duplicates.length; i++) {
      const dup = duplicates[i];
      
      // Keep the oldest product
      next.push(dup.toKeep);
      
      // Delete the rest
      for (const p of dup.toDelete) {
        const pid = String(p.id || "");
        totalDeleted++;
        
        if (inUseIds.has(pid)) {
          // Soft delete if used in transactions
          const doc = { ...p, deleted: true, updatedAt: now };
          next.push(doc);
          softDeleted++;
        } else {
          // Hard delete if not used
          hardDeleted++;
        }
      }

      // Update progress
      processed++;
      const progress = 60 + Math.floor((processed / duplicates.length) * 35);
      if (sendProgress) {
        sendProgress('deleting', progress, 
          `Menghapus grup ${processed}/${duplicates.length}: ${dup.name}`
        );
      }
    }

    if (sendProgress) sendProgress('saving', 95, 'Menyimpan perubahan...');

    await saveArrayWithSync("products.json", next);
    
    if (sendProgress) sendProgress('complete', 100, 'Proses selesai!');
    
    return res.json({
      success: true,
      message: `Berhasil menghapus ${totalDeleted} produk ganda dari ${duplicates.length} grup`,
      totalBefore,
      totalAfter: next.length,
      duplicateGroups: duplicates.length,
      deleted: totalDeleted,
      softDeleted,
      hardDeleted,
      duplicates: duplicates.map(d => ({
        name: d.name,
        kept: d.toKeep.id,
        deleted: d.toDelete.map(p => p.id)
      }))
    });
  } catch (e) {
    console.error("Error removing duplicate products:", e);
    if (global.__duplicateRemovalProgress) {
      global.__duplicateRemovalProgress('error', 0, 'Error: ' + (e.message || e));
    }
    res.status(500).json({
      success: false,
      message: "Gagal menghapus produk ganda: " + (e.message || e)
    });
  }
});

// SSE endpoint for duplicate removal progress
app.get("/api/products/remove-duplicates-progress", isAuthenticated, isAdmin, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const sendProgress = (phase, progress, message) => {
    res.write(`data: ${JSON.stringify({ phase, progress, message })}\n\n`);
  };

  // Store the sendProgress function globally for the removal process
  global.__duplicateRemovalProgress = sendProgress;

  // Send initial status
  sendProgress('ready', 0, 'Siap memproses...');

  // Handle client disconnect
  req.on('close', () => {
    global.__duplicateRemovalProgress = null;
  });
});

// EXTREMELY DANGEROUS: Delete all database files
app.post("/api/database/delete-all", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const confirm = String((req.body && req.body.confirm) || "").trim();
    if (confirm !== "DELETE_ALL_DATABASE_PERMANENTLY") {
      return res.status(400).json({ success: false, message: "Konfirmasi tidak valid" });
    }

    const fs = require('fs').promises;
    const path = require('path');
    const dataDir = path.join(__dirname, 'data');
    
    // Get current admin user to preserve
    const currentUser = req.session.user;
    
    // List all files in data directory
    const files = await fs.readdir(dataDir).catch(() => []);
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    
    // Backup current state before deletion
    const backupStats = {};
    for (const file of jsonFiles) {
      try {
        const filePath = path.join(dataDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        backupStats[file] = {
          size: content.length,
          itemCount: content ? JSON.parse(content).length : 0
        };
      } catch (e) {
        backupStats[file] = { error: e.message };
      }
    }

    // Delete all database files
    let deletedFiles = [];
    let errors = [];
    
    for (const file of jsonFiles) {
      try {
        const filePath = path.join(dataDir, file);
        await fs.unlink(filePath);
        deletedFiles.push(file);
      } catch (e) {
        errors.push({ file, error: e.message });
      }
    }

    // Create minimal users.json with current admin only
    try {
      const usersPath = path.join(dataDir, 'users.json');
      const minimalUsers = [{
        id: currentUser.id,
        username: currentUser.username,
        password: currentUser.password, // Keep existing hash
        role: 'admin',
        createdAt: new Date().toISOString()
      }];
      await fs.writeFile(usersPath, JSON.stringify(minimalUsers, null, 2));
      deletedFiles.push('users.json (recreated with admin only)');
    } catch (e) {
      errors.push({ file: 'users.json', error: 'Failed to recreate: ' + e.message });
    }

    return res.json({
      success: true,
      message: "Semua database telah dihapus permanen. Hanya admin yang sedang login yang dipertahankan.",
      deletedFiles,
      errors,
      backupStats,
      warning: "TINDAKAN TIDAK BISA DIURUNGGI. Semua data telah dihapus permanen."
    });
  } catch (e) {
    console.error("Error deleting all database:", e);
    res.status(500).json({
      success: false,
      message: "Gagal menghapus database: " + (e.message || e)
    });
  }
});

// API endpoint untuk cek update aplikasi
app.get('/api/check-update', async (req, res) => {
  try {
    const packageJson = require('./package.json');
    const currentVersion = packageJson.version;
    
    // Coba ambil konfigurasi server update dari database
    let updateUrl = 'https://api.github.com/repos/username/pos-premium/releases/latest'; // default
    let updateHeaders = { 'User-Agent': 'POS-App-UpdateChecker' };
    
    try {
      const config = await readData('update-server-config.json').catch(() => ({}));
      if (config && config.url) {
        updateUrl = config.url;
        updateHeaders = { ...updateHeaders, ...(config.headers || {}) };
        console.log('[UPDATE] Using custom server config:', config.name);
      }
    } catch (configError) {
      console.log('[UPDATE] Using default config, failed to load custom config:', configError.message);
    }
    
    try {
      const response = await fetch(updateUrl, {
        headers: updateHeaders,
        timeout: 15000 // 15 seconds timeout
      });
      
      if (response.ok) {
        const release = await response.json();
        let latestVersion = '';
        let releaseInfo = {};
        
        // Handle different response formats
        if (release.tag_name) {
          // GitHub format
          latestVersion = release.tag_name.replace('v', '');
          releaseInfo = {
            name: release.name,
            publishedAt: release.published_at,
            downloadUrl: release.html_url || release.assets?.[0]?.browser_download_url,
            releaseNotes: release.body
          };
        } else if (release.version) {
          // Custom format
          latestVersion = release.version;
          releaseInfo = {
            name: release.name || `Version ${latestVersion}`,
            publishedAt: release.publishedAt || release.date,
            downloadUrl: release.downloadUrl || release.url,
            releaseNotes: release.releaseNotes || release.description
          };
        } else {
          throw new Error('Format response tidak dikenali');
        }
        
        // Bandingkan versi
        const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
        
        return res.json({
          success: true,
          currentVersion,
          latestVersion,
          hasUpdate,
          releaseInfo,
          updateServer: {
            url: updateUrl,
            name: (await readData('update-server-config.json').catch(() => ({name: 'Default'}))).name
          }
        });
      }
    } catch (fetchError) {
      console.log('[UPDATE] Failed to check online update:', fetchError.message);
    }
    
    // Jika gagal cek online, kembalikan info versi current
    return res.json({
      success: true,
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      message: 'Tidak dapat memeriksa update. Mode offline atau server tidak dapat dijangkau.'
    });
    
  } catch (error) {
    console.error('[UPDATE] Error checking update:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal memeriksa update: ' + error.message
    });
  }
});

// Fungsi helper untuk membandingkan versi
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  
  return 0;
}

// --- Developer API Endpoints ---

// GET /api/dev/update-server-config - Ambil konfigurasi server update
app.get('/api/dev/update-server-config', async (req, res) => {
  try {
    const config = await readData('update-server-config.json').catch(() => ({}));
    res.json({
      success: true,
      config: config
    });
  } catch (error) {
    console.error('Error loading update server config:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal memuat konfigurasi server update'
    });
  }
});

// POST /api/dev/update-server-config - Simpan konfigurasi server update
app.post('/api/dev/update-server-config', async (req, res) => {
  try {
    const { url, name, headers, checkInterval, autoCheckEnabled, updatedAt } = req.body;
    
    // Validasi input
    if (!url || !name) {
      return res.status(400).json({
        success: false,
        message: 'URL dan nama server harus diisi'
      });
    }
    
    const config = {
      url: url.trim(),
      name: name.trim(),
      headers: headers || {},
      checkInterval: parseInt(checkInterval) || 24,
      autoCheckEnabled: autoCheckEnabled !== false,
      updatedAt: updatedAt || new Date().toISOString(),
      version: '1.0.0'
    };
    
    await writeData('update-server-config.json', config);
    
    console.log('[DEV] Update server config saved:', config.name);
    
    res.json({
      success: true,
      message: 'Konfigurasi server update berhasil disimpan',
      config: config
    });
  } catch (error) {
    console.error('Error saving update server config:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal menyimpan konfigurasi server update'
    });
  }
});

// POST /api/dev/test-update-server - Test koneksi ke server update
app.post('/api/dev/test-update-server', async (req, res) => {
  try {
    const { url, headers } = req.body;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'URL harus diisi'
      });
    }
    
    console.log('[DEV] Testing connection to:', url);
    
    // Test connection
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'POS-App-UpdateChecker',
        ...headers
      },
      timeout: 10000 // 10 seconds timeout
    });
    
    const status = response.status;
    let responseData = null;
    
    try {
      responseData = await response.json();
    } catch (e) {
      // If not JSON, try text
      try {
        responseData = await response.text();
      } catch (e2) {
        responseData = null;
      }
    }
    
    res.json({
      success: true,
      status: status,
      statusText: response.statusText,
      data: responseData,
      message: `Server merespon dengan status ${status}`
    });
    
  } catch (error) {
    console.error('Error testing update server:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal menguji koneksi: ' + error.message
    });
  }
});

// GET /api/dev/system-info - Informasi sistem untuk developer
app.get('/api/dev/system-info', async (req, res) => {
  try {
    const packageJson = require('./package.json');
    const config = await readData('update-server-config.json').catch(() => ({}));
    
    res.json({
      success: true,
      system: {
        appVersion: packageJson.version,
        appName: packageJson.name,
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        updateServerConfig: config
      }
    });
  } catch (error) {
    console.error('Error getting system info:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil informasi sistem'
    });
  }
});

// Store a single settings object in settings.json
app.get('/api/settings', isAuthenticated, async (req, res) => {
  try {
    const raw = await readData('settings.json');
    const base = Array.isArray(raw) ? {} : (raw || {});
    // Defaults
    let storeName = base.storeName || 'POS System';
    try {
      const licensed = await getLicensedStoreName();
      if (licensed) storeName = licensed;
    } catch (e) {}
    const settings = {
      storeName,
      faviconBase64: base.faviconBase64 || '',
      logoBase64: base.logoBase64 || '',
      taxRate: typeof base.taxRate === 'number' ? base.taxRate : 0,
      serviceRate: typeof base.serviceRate === 'number' ? base.serviceRate : 0,
      priceIncludesTax: typeof base.priceIncludesTax === 'boolean' ? base.priceIncludesTax : false,
      currencySymbol: base.currencySymbol || 'Rp',
      thousandSeparator: base.thousandSeparator || '.',
      decimalSeparator: base.decimalSeparator || ',',
      currencyPrecision: typeof base.currencyPrecision === 'number' ? base.currencyPrecision : 0,
      receiptFooter: base.receiptFooter || '',
      receiptFooter1: base.receiptFooter1 || '',
      address: base.address || '',
      phone: base.phone || '',
      // New fields
      themeColor: base.themeColor || '#198754',
      showReceiptAddress: base.showReceiptAddress !== false,
      showReceiptPhone: base.showReceiptPhone !== false,
      showReceiptFooter: base.showReceiptFooter !== false,
      paperWidth: typeof base.paperWidth === 'number' ? base.paperWidth : 80,
      loginTitle: base.loginTitle || '',
      loginLogoBase64: base.loginLogoBase64 || '',
      loginBackgroundBase64: base.loginBackgroundBase64 || '',
      // Additional branding controls
      darkMode: base.darkMode === true,
      loginLogoSize: typeof base.loginLogoSize === 'string' ? base.loginLogoSize : 'medium',
      // Product dangerous toggles
      showPurgeAllProducts: base.showPurgeAllProducts === true,
      // Auto backup config
      autoBackup: {
        enabled: base.autoBackup?.enabled === true,
        mode: ['off','on_start','daily'].includes(base.autoBackup?.mode) ? base.autoBackup.mode : 'off',
        retentionDays: Number(base.autoBackup?.retentionDays) || 0,
        maxCount: Math.max(1, Number(base.autoBackup?.maxCount) || 10)
      },
      // AI config (do not expose keys if preferred; here we return as-is for local admin)
      aiConfig: {
        provider: base.aiConfig?.provider || 'none',
        openaiApiKey: base.aiConfig?.openaiApiKey || '',
        geminiApiKey: base.aiConfig?.geminiApiKey || '',
        googleApiKey: base.aiConfig?.googleApiKey || '',
        imageSize: base.aiConfig?.imageSize || '1024x1024'
      },
      paymentLogoQrisBase64: base.paymentLogoQrisBase64 || '',
      paymentLogoDanaBase64: base.paymentLogoDanaBase64 || '',
      paymentLogoOvoBase64: base.paymentLogoOvoBase64 || ''
    };
    res.json(settings);
  } catch (e) {
    console.error('Failed to load settings:', e);
    return res.status(500).json({ success: false, message: 'Failed to load settings' });
  }
});

app.put('/api/settings', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const {
      storeName = 'POS System',
      faviconBase64 = '',
      logoBase64 = '',
      taxRate = 0,
      serviceRate = 0,
      priceIncludesTax = false,
      currencySymbol = 'Rp',
      thousandSeparator = '.',
      decimalSeparator = ',',
      currencyPrecision = 0,
      receiptFooter = '',
      receiptFooter1 = '',
      address = '',
      phone = '',
      // New fields
      themeColor = '#198754',
      showReceiptAddress = true,
      showReceiptPhone = true,
      showReceiptFooter = true,
      paperWidth = 80,
      loginTitle = '',
      loginLogoBase64 = '',
      loginBackgroundBase64 = '',
      darkMode = false,
      loginLogoSize = 'medium',
      // Cart sound settings
      cartSoundBase64 = '',
      enableCartSound = false,
      // Dangerous product toggle
      showPurgeAllProducts = false,
      // auto backup
      autoBackup = {},
      // ai config
      aiConfig = {},
      paymentLogoQrisBase64 = '',
      paymentLogoDanaBase64 = '',
      paymentLogoOvoBase64 = ''
    } = req.body || {};

    let finalStoreName = storeName;
    try {
      const licensed = await getLicensedStoreName();
      if (licensed) finalStoreName = licensed;
    } catch (e) {}

    const settings = {
      storeName: finalStoreName,
      faviconBase64,
      logoBase64,
      taxRate: Number(taxRate) || 0,
      serviceRate: Number(serviceRate) || 0,
      priceIncludesTax: Boolean(priceIncludesTax),
      currencySymbol: String(currencySymbol || 'Rp'),
      thousandSeparator: String(thousandSeparator || '.'),
      decimalSeparator: String(decimalSeparator || ','),
      currencyPrecision: Number(currencyPrecision) || 0,
      receiptFooter,
      receiptFooter1,
      address,
      phone,
      // Persist new fields
      themeColor: String(themeColor || '#198754'),
      showReceiptAddress: Boolean(showReceiptAddress),
      showReceiptPhone: Boolean(showReceiptPhone),
      showReceiptFooter: Boolean(showReceiptFooter),
      paperWidth: Number(paperWidth) || 80,
      loginTitle: String(loginTitle || ''),
      loginLogoBase64: loginLogoBase64 || '',
      loginBackgroundBase64: loginBackgroundBase64 || '',
      darkMode: Boolean(darkMode),
      loginLogoSize: String(loginLogoSize || 'medium'),
      // Cart sound settings
      cartSoundBase64: cartSoundBase64 || '',
      enableCartSound: Boolean(enableCartSound),
      // Dangerous product toggle
      showPurgeAllProducts: Boolean(showPurgeAllProducts),
      // Auto backup (persist nested)
      autoBackup: {
        enabled: Boolean((autoBackup||{}).enabled),
        mode: ['off','on_start','daily'].includes((autoBackup||{}).mode) ? (autoBackup||{}).mode : 'off',
        retentionDays: Number((autoBackup||{}).retentionDays) || 0,
        maxCount: Math.max(1, Number((autoBackup||{}).maxCount) || 10)
      },
      // Persist AI config (keys are stored locally in settings.json)
      aiConfig: {
        provider: String((aiConfig && aiConfig.provider) || 'none'),
        openaiApiKey: String((aiConfig && aiConfig.openaiApiKey) || ''),
        geminiApiKey: String((aiConfig && aiConfig.geminiApiKey) || ''),
        googleApiKey: String((aiConfig && aiConfig.googleApiKey) || ''),
        imageSize: String((aiConfig && aiConfig.imageSize) || '1024x1024')
      },
      paymentLogoQrisBase64: paymentLogoQrisBase64 || '',
      paymentLogoDanaBase64: paymentLogoDanaBase64 || '',
      paymentLogoOvoBase64: paymentLogoOvoBase64 || ''
    };
    await writeData('settings.json', settings);
    res.json({ success: true, settings, message: 'Settings updated' });
  } catch (e) {
    console.error('Failed to save settings:', e);
    res.status(500).json({ success: false, message: 'Failed to save settings' });
  }
});

// --- AI Image Generation ---
app.post('/api/ai/generate-image', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { prompt = '', size = '1024x1024', provider: providerInBody, openaiApiKey: keyInBody } = req.body || {};
    const settings = await readData('settings.json').catch(() => ({}));
    const ai = (settings && settings.aiConfig) ? settings.aiConfig : {};
    // Resolve provider with fallbacks: settings -> body -> env -> default
    const provider = String((ai && ai.provider) || providerInBody || process.env.AI_PROVIDER || 'none');
    if (!prompt || provider === 'none') {
      return res.status(400).json({ success: false, message: 'AI tidak dikonfigurasi atau prompt kosong' });
    }
    // Prefer OpenAI if selected
    if (provider === 'openai') {
      // Resolve OpenAI key with fallbacks: settings -> env -> header -> body
      const headerKey = String(req.get('x-openai-key') || req.get('X-OpenAI-Key') || '').trim();
      const key = String((ai && ai.openaiApiKey) || process.env.OPENAI_API_KEY || headerKey || keyInBody || '').trim();
      if (!key) return res.status(400).json({ success: false, message: 'OpenAI API Key belum diset' });
      const body = {
        model: 'gpt-image-1',
        prompt: String(prompt),
        size: String(size || ai.imageSize || '1024x1024'),
        response_format: 'b64_json'
      };
      const r = await safeFetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(body)
      });
      if (!r) return res.status(502).json({ success:false, message:'Tidak dapat menghubungi OpenAI' });
      if (!r.ok) {
        const t = await r.text().catch(()=> '');
        return res.status(r.status || 500).json({ success:false, message: 'OpenAI error', detail: t });
      }
      const j = await r.json().catch(()=>({}));
      const b64 = j && j.data && j.data[0] && (j.data[0].b64_json || j.data[0].b64) || '';
      if (!b64) return res.status(500).json({ success:false, message:'Gagal menerima gambar dari OpenAI' });
      return res.json({ success:true, imageBase64: `data:image/png;base64,${b64}` });
    }
    if (provider === 'gemini') {
      // Placeholder: Gemini text-to-image mungkin tidak tersedia via API publik saat ini
      const key = String(ai.geminiApiKey || '').trim();
      if (!key) return res.status(400).json({ success:false, message:'Gemini API Key belum diset' });
      return res.status(501).json({ success:false, message:'Generate gambar via Gemini belum didukung di versi ini' });
    }
    return res.status(400).json({ success:false, message:'Provider AI tidak valid' });
  } catch (e) {
    return res.status(500).json({ success:false, message:'Kesalahan server saat generate gambar' });
  }
});
// Cari gambar dari internet untuk produk dan kembalikan sebagai Data URL Base64
app.post('/api/ai/find-image', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { q = '', sku = '', name = '', category = '', unsplashKey: unsplashKeyInBody = '', pexelsKey: pexelsKeyInBody = '', bingKey: bingKeyInBody = '' } = req.body || {};
    const query = String(q || name || sku || category || '').trim();
    if (!query) return res.status(400).json({ success:false, message:'Query kosong' });

    // Helper: fetch binary to Buffer (with simple redirect follow)
    async function fetchBuffer(url){
      try {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? require('https') : require('http');
        const headers = {};
        return await new Promise((resolve)=>{
          const req = mod.get(url, { headers }, (resp)=>{
            if ((resp.statusCode||0) >= 300 && resp.headers && resp.headers.location) {
              return resolve(fetchBuffer(resp.headers.location));
            }
            const chunks = [];
            resp.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
            resp.on('end', ()=> resolve(Buffer.concat(chunks)));
          });
          req.on('error', ()=> resolve(null));
        });
      } catch { return null; }
    }

    // Try providers in order: Google CSE (if key+cx) -> Unsplash -> Pexels -> Bing
    const candidates = [];
    const unsHdr = String(req.get('x-unsplash-key') || req.get('X-Unsplash-Key') || '').trim();
    const pexHdr = String(req.get('x-pexels-key') || req.get('X-Pexels-Key') || '').trim();
    const bingHdr = String(req.get('x-bing-key') || req.get('X-Bing-Key') || '').trim();
    const gKeyHdr = String(req.get('x-google-key') || req.get('X-Google-Key') || '').trim();
    const gCxHdr = String(req.get('x-google-cx') || req.get('X-Google-Cx') || '').trim();
    const googleKey = (gKeyHdr || (req.body && req.body.googleKey) || process.env.GOOGLE_CSE_KEY || '').trim();
    const googleCx = (gCxHdr || (req.body && req.body.googleCx) || process.env.GOOGLE_CSE_CX || '').trim();
    if (googleKey && googleCx) {
      try {
        const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&searchType=image&num=1&key=${encodeURIComponent(googleKey)}&cx=${encodeURIComponent(googleCx)}`;
        const r = await safeFetch(url);
        if (r && r.ok) {
          const j = await r.json().catch(()=>({}));
          const link = j && j.items && j.items[0] && (j.items[0].link || (j.items[0].image && j.items[0].image.thumbnailLink));
          if (link) candidates.push(link);
        }
      } catch {}
    }
    const unsplashKey = (unsHdr || unsplashKeyInBody || process.env.UNSPLASH_ACCESS_KEY || '').trim();
    if (unsplashKey) {
      try {
        const r = await safeFetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1`, {
          headers: { 'Authorization': `Client-ID ${unsplashKey}` }
        });
        if (r && r.ok) {
          const j = await r.json().catch(()=>({}));
          const url = j && j.results && j.results[0] && j.results[0].urls && (j.results[0].urls.small || j.results[0].urls.regular);
          if (url) candidates.push(url);
        }
      } catch {}
    }
    const pexelsKey = (pexHdr || pexelsKeyInBody || process.env.PEXELS_API_KEY || '').trim();
    if (!candidates.length && pexelsKey) {
      try {
        const r = await safeFetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`, {
          headers: { 'Authorization': pexelsKey }
        });
        if (r && r.ok) {
          const j = await r.json().catch(()=>({}));
          const url = j && j.photos && j.photos[0] && j.photos[0].src && (j.photos[0].src.medium || j.photos[0].src.large || j.photos[0].src.original);
          if (url) candidates.push(url);
        }
      } catch {}
    }
    const bingKey = (bingHdr || bingKeyInBody || process.env.BING_IMAGE_SEARCH_KEY || '').trim();
    if (!candidates.length && bingKey) {
      try {
        const r = await safeFetch(`https://api.bing.microsoft.com/v7.0/images/search?q=${encodeURIComponent(query)}&count=1&safeSearch=Strict`, {
          headers: { 'Ocp-Apim-Subscription-Key': bingKey }
        });
        if (r && r.ok) {
          const j = await r.json().catch(()=>({}));
          const url = j && j.value && j.value[0] && (j.value[0].contentUrl || j.value[0].thumbnailUrl);
          if (url) candidates.push(url);
        }
      } catch {}
    }

    if (!candidates.length) {
      return res.status(404).json({ success:false, message:'Tidak menemukan gambar untuk query ini. Konfigurasikan API key (Google CSE/Unsplash/Pexels/Bing).' });
    }

    const imgUrl = candidates[0];
    const buf = await fetchBuffer(imgUrl);
    if (!buf || !buf.length) return res.status(502).json({ success:false, message:'Gagal mengunduh gambar' });
    let mime = 'image/jpeg';
    try {
      const low = imgUrl.toLowerCase();
      if (low.endsWith('.png')) mime = 'image/png';
      else if (low.endsWith('.webp')) mime = 'image/webp';
      else if (low.endsWith('.gif')) mime = 'image/gif';
    } catch {}
    const b64 = buf.toString('base64');
    return res.json({ success:true, imageBase64: `data:${mime};base64,${b64}`, sourceUrl: imgUrl });
  } catch (e) {
    console.error('find-image error:', e);
    return res.status(500).json({ success:false, message:'Gagal mencari gambar' });
  }
});

// Upload cart sound file
app.post('/api/upload/cart-sound', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { soundBase64 } = req.body;
    
    if (!soundBase64) {
      return res.status(400).json({ success: false, message: 'No sound file provided' });
    }
    
    // Validate that it's a valid audio file in base64 format
    if (!soundBase64.startsWith('data:audio/')) {
      return res.status(400).json({ success: false, message: 'Invalid audio format' });
    }
    
    // Get current settings
    const settings = await readData('settings.json') || {};
    
    // Update settings with new sound file
    settings.cartSoundBase64 = soundBase64;
    
    // Save settings
    await writeData('settings.json', settings);
    
    res.json({ success: true, message: 'Cart sound uploaded successfully' });
  } catch (e) {
    console.error('Failed to upload cart sound:', e);
    res.status(500).json({ success: false, message: 'Failed to upload cart sound' });
  }
});

// --- Customers API ---
// GET /api/customers - Get all customers
app.get('/api/customers', isAuthenticated, async (req, res) => {
  try {
    const customers = await readData('customers.json');
    res.json(customers);
  } catch (error) {
    console.error('Failed to load customers:', error);
    res.status(500).json({ success: false, message: 'Failed to load customers' });
  }
});

// POST /api/customers - Create new customer
app.post('/api/customers', isAuthenticated, async (req, res) => {
  try {
    const { name, phone, email, address } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Customer name is required'
      });
    }

    const customers = await readData('customers.json');
    
    // Check if customer name already exists
    const existingCustomer = customers.find(c => 
      c.name.toLowerCase() === name.trim().toLowerCase()
    );
    if (existingCustomer) {
      return res.status(400).json({
        success: false,
        message: 'Customer name already exists'
      });
    }

    const newCustomer = {
      id: Date.now(),
      name: name.trim(),
      phone: phone ? phone.trim() : '',
      email: email ? email.trim() : '',
      address: address ? address.trim() : '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    customers.push(newCustomer);
    await saveArrayWithSync('customers.json', customers);

    res.json({
      success: true,
      message: 'Customer created successfully',
      customer: newCustomer
    });
  } catch (error) {
    console.error('Failed to create customer:', error);
    res.status(500).json({ success: false, message: 'Failed to create customer' });
  }
});

// PUT /api/customers/:id - Update customer
app.put('/api/customers/:id', isAuthenticated, async (req, res) => {
  try {
    const { name, phone, email, address } = req.body;
    const customerId = parseInt(req.params.id);

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Customer name is required'
      });
    }

    const customers = await readData('customers.json');
    const index = customers.findIndex(c => c.id === customerId);

    if (index === -1) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // PERBAIKAN: Validasi nama duplikat hanya jika nama berubah (bukan nama yang sama dengan pelanggan yang sedang diedit)
    const currentCustomer = customers[index];
    const newName = name.trim().toLowerCase();
    const currentName = currentCustomer.name.toLowerCase();
    
    // Jika nama berubah, cek apakah nama baru sudah digunakan oleh pelanggan lain
    if (newName !== currentName) {
      const existingCustomer = customers.find(c => 
        c.name.toLowerCase() === newName && c.id !== customerId
      );
      if (existingCustomer) {
        return res.status(400).json({
          success: false,
          message: 'Customer name already exists'
        });
      }
    }
    // Jika nama tidak berubah (nama sama dengan yang sekarang), tidak perlu validasi duplikat

    customers[index] = {
      ...customers[index],
      name: name.trim(),
      phone: phone ? phone.trim() : '',
      email: email ? email.trim() : '',
      address: address ? address.trim() : '',
      updatedAt: new Date().toISOString()
    };

    await saveArrayWithSync('customers.json', customers);

    res.json({
      success: true,
      message: 'Customer updated successfully',
      customer: customers[index]
    });
  } catch (error) {
    console.error('Failed to update customer:', error);
    res.status(500).json({ success: false, message: 'Failed to update customer' });
  }
});

// DELETE /api/customers/:id - Delete customer
app.delete('/api/customers/:id', isAuthenticated, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const customers = await readData('customers.json');
    
    // Don't allow deleting default customer
    if (customerId === 1) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete default customer'
      });
    }

    const filteredCustomers = customers.filter(c => c.id !== customerId);

    if (customers.length === filteredCustomers.length) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    await saveArrayWithSync('customers.json', filteredCustomers);

    res.json({
      success: true,
      message: 'Customer deleted successfully'
    });
  } catch (error) {
    console.error('Failed to delete customer:', error);
    res.status(500).json({ success: false, message: 'Failed to delete customer' });
  }
});

// Check customer name availability
app.post('/api/customers/check-name/:id?', async (req, res) => {
  try {
    const { name } = req.body;
    const customerId = req.params.id ? parseInt(req.params.id) : null;

    const customers = await readData('customers.json');
    const existingCustomer = customers.find(c => 
      c.name.toLowerCase() === name.trim().toLowerCase() && 
      (!customerId || c.id !== customerId)
    );
    
    res.json({ exists: !!existingCustomer });
  } catch (error) {
    console.error('Error checking customer name:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// --- Suppliers API ---
// GET /api/suppliers - Get all suppliers
app.get('/api/suppliers', isAuthenticated, async (req, res) => {
  try {
    const suppliers = await readData('suppliers.json').catch(() => []);
    res.json(Array.isArray(suppliers) ? suppliers : []);
  } catch (error) {
    console.error('Failed to load suppliers:', error);
    res.status(500).json({ success: false, message: 'Failed to load suppliers' });
  }
});

// POST /api/suppliers - Create new supplier
app.post('/api/suppliers', isAuthenticated, async (req, res) => {
  try {
    const { name, phone, address, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Supplier name is required' });
    }

    let suppliers = await readData('suppliers.json').catch(() => []);
    if (!Array.isArray(suppliers)) suppliers = [];

    const normName = String(name).trim().toLowerCase();
    const exists = suppliers.find(s => String(s.name || '').toLowerCase() === normName);
    if (exists) {
      return res.status(400).json({ success: false, message: 'Supplier name already exists' });
    }

    const nowIso = new Date().toISOString();
    const newSupplier = {
      id: Date.now(),
      name: String(name).trim(),
      phone: phone ? String(phone).trim() : '',
      address: address ? String(address).trim() : '',
      notes: notes ? String(notes).trim() : '',
      createdAt: nowIso,
      updatedAt: nowIso
    };

    suppliers.push(newSupplier);
    await saveArrayWithSync('suppliers.json', suppliers, { keyField: 'id' });

    res.json({ success: true, message: 'Supplier created successfully', supplier: newSupplier });
  } catch (error) {
    console.error('Failed to create supplier:', error);
    res.status(500).json({ success: false, message: 'Failed to create supplier' });
  }
});

// PUT /api/suppliers/:id - Update supplier
app.put('/api/suppliers/:id', isAuthenticated, async (req, res) => {
  try {
    const supplierId = parseInt(req.params.id);
    const { name, phone, address, notes } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Supplier name is required' });
    }

    let suppliers = await readData('suppliers.json').catch(() => []);
    if (!Array.isArray(suppliers)) suppliers = [];

    const idx = suppliers.findIndex(s => Number(s.id) === supplierId);
    if (idx === -1) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    const current = suppliers[idx];
    const newNameNorm = String(name).trim().toLowerCase();
    const curNameNorm = String(current.name || '').toLowerCase();
    if (newNameNorm !== curNameNorm) {
      const exists = suppliers.find(s => String(s.name || '').toLowerCase() === newNameNorm && Number(s.id) !== supplierId);
      if (exists) {
        return res.status(400).json({ success: false, message: 'Supplier name already exists' });
      }
    }

    suppliers[idx] = {
      ...current,
      name: String(name).trim(),
      phone: phone ? String(phone).trim() : '',
      address: address ? String(address).trim() : '',
      notes: notes ? String(notes).trim() : '',
      updatedAt: new Date().toISOString()
    };

    await saveArrayWithSync('suppliers.json', suppliers, { keyField: 'id' });
    res.json({ success: true, message: 'Supplier updated successfully', supplier: suppliers[idx] });
  } catch (error) {
    console.error('Failed to update supplier:', error);
    res.status(500).json({ success: false, message: 'Failed to update supplier' });
  }
});

// DELETE /api/suppliers/:id - Delete supplier
app.delete('/api/suppliers/:id', isAuthenticated, async (req, res) => {
  try {
    const supplierId = parseInt(req.params.id);
    let suppliers = await readData('suppliers.json').catch(() => []);
    if (!Array.isArray(suppliers)) suppliers = [];

    const beforeLen = suppliers.length;
    suppliers = suppliers.filter(s => Number(s.id) !== supplierId);
    if (beforeLen === suppliers.length) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    await saveArrayWithSync('suppliers.json', suppliers, { keyField: 'id' });
    res.json({ success: true, message: 'Supplier deleted successfully' });
  } catch (error) {
    console.error('Failed to delete supplier:', error);
    res.status(500).json({ success: false, message: 'Failed to delete supplier' });
  }
});

// --- Stock In (Barang Masuk) API ---
// GET /api/stock-in - list all stock-in records
app.get('/api/stock-in', isAuthenticated, async (req, res) => {
  try {
    let stockIn = await readData('stock_in.json').catch(() => []);
    if (!Array.isArray(stockIn)) stockIn = [];
    res.json(stockIn);
  } catch (error) {
    console.error('Failed to load stock-in records:', error);
    res.status(500).json({ success: false, message: 'Failed to load stock-in records' });
  }
});

// POST /api/stock-in - create new stock-in document and update product stock
app.post('/api/stock-in', isAuthenticated, async (req, res) => {
  try {
    const user = (req.session && req.session.user) || {};
    const { date, supplierId, items, note } = req.body || {};

    const sid = supplierId ? parseInt(supplierId) : null;
    if (!sid || !Number.isFinite(sid)) {
      return res.status(400).json({ success: false, message: 'Supplier is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Items are required' });
    }

    let suppliers = await readData('suppliers.json').catch(() => []);
    if (!Array.isArray(suppliers)) suppliers = [];
    const supplier = suppliers.find(s => Number(s.id) === sid);
    if (!supplier) {
      return res.status(400).json({ success: false, message: 'Supplier not found' });
    }

    let products = await readData('products.json').catch(() => []);
    if (!Array.isArray(products)) products = [];

    let stockIn = await readData('stock_in.json').catch(() => []);
    if (!Array.isArray(stockIn)) stockIn = [];

    const now = Date.now();
    const id = `STKIN-${new Date(now).toISOString().slice(0,10).replace(/-/g,'')}-${now}`;

    const normalizedItems = [];
    for (const raw of items) {
      const pid = raw && raw.productId != null ? parseInt(raw.productId) : null;
      const qty = Number(raw && raw.qty != null ? raw.qty : 0) || 0;
      const purchasePrice = Number(raw && raw.purchasePrice != null ? raw.purchasePrice : 0) || 0;
      if (!pid || qty <= 0) continue;

      const product = products.find(p => Number(p.id) === pid);
      if (!product) {
        return res.status(400).json({ success: false, message: `Product with ID ${pid} not found` });
      }

      product.stock = Number(product.stock || 0) + qty;
      if (purchasePrice > 0) {
        product.purchasePrice = purchasePrice;
      }

      try {
        await appendStockMove({
          productId: pid,
          delta: qty,
          reason: 'purchase',
          refId: id,
          by: String(user && (user.username || user.name || ''))
        });
      } catch (e) {}

      normalizedItems.push({ productId: pid, qty, purchasePrice });
    }

    if (!normalizedItems.length) {
      return res.status(400).json({ success: false, message: 'No valid items' });
    }

    const stockInDoc = {
      id,
      timestamp: new Date(now).toISOString(),
      date: date ? String(date) : new Date(now).toISOString().slice(0,10),
      supplierId: sid,
      supplierName: String(supplier.name || ''),
      items: normalizedItems,
      note: note ? String(note).trim() : '',
      updatedAt: now
    };

    stockIn.push(stockInDoc);
    await writeData('stock_in.json', stockIn);
    await saveArrayWithSync('products.json', products, { keyField: 'id' });

    res.json({ success: true, message: 'Stock-in recorded successfully', stockIn: stockInDoc });
  } catch (error) {
    console.error('Failed to record stock-in:', error);
    res.status(500).json({ success: false, message: 'Failed to record stock-in' });
  }
});

// PATCH /api/stock-in/:id - update stock-in payment information
app.patch('/api/stock-in/:id', isAuthenticated, async (req, res) => {
  try {
    const user = (req.session && req.session.user) || {};
    const { id } = req.params;
    const { paidAmount, remainingAmount, paymentDate } = req.body || {};

    if (!id) {
      return res.status(400).json({ success: false, message: 'Stock-in ID is required' });
    }

    let stockIn = await readData('stock_in.json').catch(() => []);
    if (!Array.isArray(stockIn)) stockIn = [];

    const index = stockIn.findIndex(record => String(record.id) === String(id));
    if (index === -1) {
      return res.status(404).json({ success: false, message: 'Stock-in record not found' });
    }

    // Update the payment fields
    const record = stockIn[index];
    if (paidAmount !== undefined) record.paidAmount = Number(paidAmount) || 0;
    if (remainingAmount !== undefined) record.remainingAmount = Number(remainingAmount) || 0;
    if (paymentDate !== undefined) record.paymentDate = String(paymentDate || '');
    
    // Update timestamp
    record.updatedAt = Date.now();

    // Save back to file
    await writeData('stock_in.json', stockIn);

    res.json({ success: true, message: 'Payment information updated successfully', record });
  } catch (e) {
    console.error('Failed to update stock-in payment:', e);
    res.status(500).json({ success: false, message: 'Failed to update payment information' });
  }
});

// Serve favicon from settings if provided
app.get('/favicon.ico', async (req, res) => {
  try {
    const raw = await readData('settings.json');
    const base = Array.isArray(raw) ? {} : (raw || {});
    const dataUrl = base.faviconBase64 || '';
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return res.status(204).end();
    }
    const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
    if (!match) return res.status(204).end();
    const contentType = match[1] || 'image/x-icon';
    const b64 = match[2] || '';
    const buf = Buffer.from(b64, 'base64');
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-store');
    return res.send(buf);
  } catch (e) {
    return res.status(204).end();
  }
});

// Transactions
app.get("/api/transactions", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const transactions = await readData("transactions.json");
    res.json(transactions);
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Failed to load transactions" });
  }
});

app.post("/api/transactions", isAuthenticated, async (req, res) => {
  try {
    const { items, paymentMethod, amountReceived, customerId = 'default', customerName = 'Pelanggan Umum', discountPercent = 0, discountAmount = 0, paidAmount, remainingAmount, paymentDate } = req.body;
    if (!items || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Cart cannot be empty." });
    }

    const products = await readData("products.json");
    const transactions = await readData("transactions.json");
    let baseSubtotal = 0;
    let perProductDiscountTotal = 0;
    let perProductTaxTotal = 0;
    let afterItemDiscountSubtotal = 0;
    const transactionItems = items.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      if (!product)
        throw new Error(`Product with ID ${item.productId} not found`);
      // Allow negative stock - no stock validation for transactions

      const itemBase = product.price * item.qty;
      baseSubtotal += itemBase;
      const pDisc = Math.max(0, Number(product.discountPercent || 0));
      const pTax = Math.max(0, Number(product.taxRate || 0));
      const itemDisc = Math.round(itemBase * (pDisc / 100));
      const itemNet = itemBase - itemDisc;
      const itemTax = Math.round(itemNet * (pTax / 100));
      perProductDiscountTotal += itemDisc;
      perProductTaxTotal += itemTax;
      afterItemDiscountSubtotal += itemNet;

      return {
        productId: product.id,
        name: product.name,
        price: product.price,
        qty: item.qty,
        subtotal: itemNet,
      };
    });

    // compute taxes based on settings
    const settings = await readData('settings.json').catch(() => ({}));
    const taxRate = Number(settings?.taxRate || 0);
    const serviceRate = Number(settings?.serviceRate || 0);
    const priceIncludesTax = Boolean(settings?.priceIncludesTax || false);
    const subtotal = baseSubtotal;
    const discountP = Math.max(0, Number(discountPercent) || 0);
    const discountA = Math.max(0, Number(discountAmount) || 0);
    let computedDiscount = 0;
    if (discountP > 0) {
      computedDiscount = Math.round(afterItemDiscountSubtotal * (discountP / 100));
    } else if (discountA > 0) {
      computedDiscount = Math.round(discountA);
    }
    if (computedDiscount > afterItemDiscountSubtotal) computedDiscount = afterItemDiscountSubtotal;
    const netAfterCartDiscount = afterItemDiscountSubtotal - computedDiscount;
    const globalTax = priceIncludesTax ? 0 : Math.round(netAfterCartDiscount * (taxRate / 100));
    const serviceAmount = priceIncludesTax ? 0 : Math.round(netAfterCartDiscount * (serviceRate / 100));
    const taxAmount = perProductTaxTotal + globalTax;
    const grandTotal = netAfterCartDiscount + taxAmount + serviceAmount;

    const newTransaction = {
      id: `TRX-${new Date()
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "")}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      date: new Date().toISOString().split('T')[0],
      userId: req.session.user.id,
      customerId,
      customerName,
      items: transactionItems,
      subtotal,
      discountAmount: perProductDiscountTotal + computedDiscount,
      taxAmount,
      serviceAmount,
      totalAmount: grandTotal,
      paymentMethod,
      amountReceived: paymentMethod === "cash" ? amountReceived : grandTotal,
      change: paymentMethod === "cash" ? amountReceived - grandTotal : 0,
      // Add debt tracking fields
      paidAmount: paidAmount || amountReceived,
      remainingAmount: remainingAmount !== undefined ? remainingAmount : 0,
      paymentDate: paymentDate || new Date().toISOString().split('T')[0]
    };

    transactions.push(newTransaction);
    // enqueue transaction append for sync
    try { await enqueueOutbox({ collection: 'transactions', file: 'transactions.json', op: 'insert', _id: newTransaction.id, doc: newTransaction, updatedAt: Number(new Date(newTransaction.timestamp).getTime()) || Date.now() }); } catch {}
    await writeData("transactions.json", transactions);
    await saveArrayWithSync("products.json", products);
    res.json(newTransaction);
  } catch (error) {
    console.error("Transaction error:", error);
    res
      .status(400)
      .json({
        success: false,
        message: error.message || "Failed to create transaction",
      });
  }
});

// PATCH endpoint for updating transaction payments (debt tracking)
app.patch("/api/transactions/:id", isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const { paidAmount, remainingAmount, paymentDate } = req.body;
    
    const transactions = await readData("transactions.json");
    if (!Array.isArray(transactions)) {
      return res.status(404).json({ success: false, message: "Transactions not found" });
    }
    
    const transactionIndex = transactions.findIndex(t => t.id === id);
    if (transactionIndex === -1) {
      return res.status(404).json({ success: false, message: "Transaction not found" });
    }
    
    // Update payment fields
    transactions[transactionIndex].paidAmount = Number(paidAmount) || 0;
    transactions[transactionIndex].remainingAmount = Number(remainingAmount) || 0;
    transactions[transactionIndex].paymentDate = paymentDate || new Date().toISOString().split('T')[0];
    transactions[transactionIndex].updatedAt = Date.now();
    
    await writeData("transactions.json", transactions);
    
    // Enqueue update for sync
    try { 
      await enqueueOutbox({ 
        collection: 'transactions', 
        file: 'transactions.json', 
        op: 'update', 
        _id: id, 
        doc: transactions[transactionIndex], 
        updatedAt: Number(transactions[transactionIndex].updatedAt) 
      }); 
    } catch {}
    
    res.json({ 
      success: true, 
      message: "Payment updated successfully",
      transaction: transactions[transactionIndex]
    });
  } catch (error) {
    console.error("Failed to update transaction payment:", error);
    res.status(500).json({ 
      success: false, 
      message: error.message || "Failed to update payment" 
    });
  }
});

app.get("/api/recent-transactions", isAuthenticated, async (req, res) => {
  try {
    const transactions = await readData("transactions.json");
    const recentTransactions = transactions
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 5);
    res.json(recentTransactions);
  } catch (error) {
    console.error("Failed to fetch recent transactions:", error);
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to fetch recent transactions.",
      });
  }
});

app.delete("/api/transactions/:id", isAuthenticated, async (req, res) => {
  try {
    const transactions = await readData("transactions.json");
    const products = await readData("products.json");
    const transactionIndex = transactions.findIndex(
      (t) => t.id === req.params.id
    );

    if (transactionIndex === -1) {
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found." });
    }

    const transactionToVoid = transactions[transactionIndex];

    // Kembalikan stok produk + tulis stock_moves (void)
    for (const item of transactionToVoid.items) {
      const product = products.find((p) => p.id === item.productId);
      if (product) {
        product.stock += item.qty;
        try { await appendStockMove({ productId: item.productId, delta: Number(item.qty||0), reason: 'void', refId: transactionToVoid.id, by: (req.session && req.session.user && req.session.user.username) || '' }); } catch {}
      }
    }

    // Hapus transaksi
    transactions.splice(transactionIndex, 1);

    await saveArrayWithSync("products.json", products);
    await writeData("transactions.json", transactions);

    res.json({ success: true, message: "Transaction voided successfully." });
  } catch (error) {
    console.error("Failed to void transaction:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to void transaction." });
  }
});

// --- Shift Kasir (Cashier Shifts) ---
// Buka shift baru untuk kasir yang sedang login
app.post('/api/shifts/open', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const user = (req.session && req.session.user) || null;
    if (!user || !user.id) {
      return res.status(400).json({ success:false, message:'User session tidak valid' });
    }
    const openingCash = Number((req.body && req.body.openingCash) || 0) || 0;
    let shifts = await readData('shifts.json').catch(() => []);
    if (!Array.isArray(shifts)) shifts = [];
    const cashierId = String(user.id);
    const hasOpen = shifts.some(s => String(s && s.cashierId) === cashierId && !s.closedAt);
    if (hasOpen) {
      return res.status(400).json({ success:false, message:'Masih ada shift aktif untuk kasir ini.' });
    }
    const now = Date.now();
    const shift = {
      id: `SHIFT-${new Date(now).toISOString().slice(0,10).replace(/-/g,'')}-${now}`,
      cashierId,
      cashierUsername: String(user.username || ''),
      cashierName: String(user.name || user.username || ''),
      openedAt: now,
      closedAt: null,
      openingCash,
      closingCash: null,
      expectedCash: null,
      cashSales: 0,
      nonCashSales: 0,
      totalSales: 0,
      cashVariance: null,
      transactionsCount: 0,
    };
    shifts.push(shift);
    await writeData('shifts.json', shifts);
    return res.json({ success:true, shift });
  } catch (e) {
    console.error('Failed to open shift:', e);
    return res.status(500).json({ success:false, message:'Gagal membuka shift' });
  }
});

// Tutup shift aktif untuk kasir yang sedang login dan hitung selisih kas
app.post('/api/shifts/close', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const user = (req.session && req.session.user) || null;
    if (!user || !user.id) {
      return res.status(400).json({ success:false, message:'User session tidak valid' });
    }
    const closingCash = Number((req.body && req.body.closingCash) || 0) || 0;
    let shifts = await readData('shifts.json').catch(() => []);
    if (!Array.isArray(shifts)) shifts = [];
    const cashierId = String(user.id);
    // Cari shift terbuka terakhir untuk kasir ini
    let idx = -1;
    for (let i = shifts.length - 1; i >= 0; i--) {
      const s = shifts[i] || {};
      if (String(s.cashierId) === cashierId && !s.closedAt) { idx = i; break; }
    }
    if (idx < 0) {
      return res.status(400).json({ success:false, message:'Tidak ada shift aktif untuk kasir ini.' });
    }
    const now = Date.now();
    const shift = shifts[idx] || {};
    shift.closedAt = now;
    shift.closingCash = closingCash;

    // Hitung ringkasan transaksi untuk shift ini
    let txs = await readData('transactions.json').catch(() => []);
    if (!Array.isArray(txs)) txs = [];
    const start = Number(shift.openedAt || 0);
    const end = Number(shift.closedAt || now);
    let cashSales = 0;
    let nonCashSales = 0;
    let count = 0;
    for (const tx of txs) {
      const uid = tx && tx.userId != null ? String(tx.userId) : '';
      if (uid && uid !== cashierId) continue;
      let ts = 0;
      if (typeof tx.timestamp === 'string') {
        const d = new Date(tx.timestamp);
        ts = d.getTime();
      } else {
        ts = Number(tx.timestamp || 0);
      }
      if (!Number.isFinite(ts) || ts < start || ts > end) continue;
      const total = Number(tx.totalAmount != null ? tx.totalAmount : (tx.total || 0)) || 0;
      const pm = String(tx.paymentMethod || 'cash').toLowerCase();
      if (pm === 'cash') cashSales += total; else nonCashSales += total;
      count++;
    }
    const totalSales = cashSales + nonCashSales;
    const openingCash = Number(shift.openingCash || 0);
    const expectedCash = openingCash + totalSales;
    const cashVariance = closingCash - expectedCash;
    shift.cashSales = cashSales;
    shift.nonCashSales = nonCashSales;
    shift.totalSales = totalSales;
    shift.expectedCash = expectedCash;
    shift.cashVariance = cashVariance;
    shift.transactionsCount = count;

    shifts[idx] = shift;
    await writeData('shifts.json', shifts);
    return res.json({ success:true, shift });
  } catch (e) {
    console.error('Failed to close shift:', e);
    return res.status(500).json({ success:false, message:'Gagal menutup shift' });
  }
});

// Ambil shift aktif untuk kasir yang sedang login
app.get('/api/shifts/current', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const user = (req.session && req.session.user) || null;
    if (!user || !user.id) {
      return res.status(400).json({ success:false, message:'User session tidak valid' });
    }
    let shifts = await readData('shifts.json').catch(() => []);
    if (!Array.isArray(shifts)) shifts = [];
    const cashierId = String(user.id);
    const current = shifts.slice().reverse().find(s => String(s && s.cashierId) === cashierId && !s.closedAt) || null;
    return res.json({ success:true, shift: current || null });
  } catch (e) {
    console.error('Failed to get current shift:', e);
    return res.status(500).json({ success:false, message:'Gagal mengambil shift aktif' });
  }
});

// Ringkasan shift aktif (untuk auto default saldo akhir)
app.get('/api/shifts/current-summary', isAuthenticated, isAdminOrCashier, async (req, res) => {
  try {
    const user = (req.session && req.session.user) || null;
    if (!user || !user.id) {
      return res.status(400).json({ success:false, message:'User session tidak valid' });
    }
    let shifts = await readData('shifts.json').catch(() => []);
    if (!Array.isArray(shifts)) shifts = [];
    const cashierId = String(user.id);
    const current = shifts.slice().reverse().find(s => String(s && s.cashierId) === cashierId && !s.closedAt) || null;
    if (!current) {
      return res.json({ success:true, shift: null, summary: null });
    }
    let txs = await readData('transactions.json').catch(() => []);
    if (!Array.isArray(txs)) txs = [];
    const start = Number(current.openedAt || 0);
    const end = Date.now();
    let cashSales = 0;
    let nonCashSales = 0;
    let count = 0;
    for (const tx of txs) {
      const uid = tx && tx.userId != null ? String(tx.userId) : '';
      if (uid && uid !== cashierId) continue;
      let ts = 0;
      if (typeof tx.timestamp === 'string') {
        const d = new Date(tx.timestamp);
        ts = d.getTime();
      } else {
        ts = Number(tx.timestamp || 0);
      }
      if (!Number.isFinite(ts) || ts < start || ts > end) continue;
      const total = Number(tx.totalAmount != null ? tx.totalAmount : (tx.total || 0)) || 0;
      const pm = String(tx.paymentMethod || 'cash').toLowerCase();
      if (pm === 'cash') cashSales += total; else nonCashSales += total;
      count++;
    }
    const totalSales = cashSales + nonCashSales;
    const openingCash = Number(current.openingCash || 0);
    const expectedCash = openingCash + totalSales;
    const summary = {
      cashSales,
      nonCashSales,
      totalSales,
      openingCash,
      expectedCash,
      transactionsCount: count
    };
    return res.json({ success:true, shift: current, summary });
  } catch (e) {
    console.error('Failed to get current shift summary:', e);
    return res.status(500).json({ success:false, message:'Gagal mengambil ringkasan shift aktif' });
  }
});

// Daftar semua shift (admin)
app.get('/api/shifts', isAuthenticated, isAdmin, async (req, res) => {
  try {
    let shifts = await readData('shifts.json').catch(() => []);
    if (!Array.isArray(shifts)) shifts = [];
    // Optional filter by cashierId/from/to
    let { cashierId, from, to } = req.query || {};
    if (cashierId) {
      const cid = String(cashierId);
      shifts = shifts.filter(s => String(s && s.cashierId) === cid);
    }
    const fromMs = Number(from) || 0;
    const toMs = Number(to) || 0;
    if (fromMs || toMs) {
      shifts = shifts.filter(s => {
        const openTs = Number((s && s.openedAt) || 0);
        if (fromMs && openTs < fromMs) return false;
        if (toMs && openTs > toMs) return false;
        return true;
      });
    }
    shifts.sort((a,b) => Number((b && b.openedAt) || 0) - Number((a && a.openedAt) || 0));
    return res.json({ success:true, shifts });
  } catch (e) {
    console.error('Failed to list shifts:', e);
    return res.status(500).json({ success:false, message:'Gagal memuat data shift' });
  }
});

// --- Excel Import/Export API Routes ---
// --- API untuk Validasi Admin ---
app.post("/api/admin/validate-password", async (req, res) => {
  try {
    const { password } = req.body;

    // Di production, gunakan bcrypt untuk hash password
    // Untuk demo ini, kita bandingkan dengan password admin hardcoded
    const ADMIN_PASSWORD = "admin123"; // Ganti dengan password admin Anda yang sebenarnya

    const isValid = password === ADMIN_PASSWORD;

    res.json({ valid: isValid });
  } catch (error) {
    console.error("Error validating admin password:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Restore produk dari backup
app.post(
  "/api/products/restore",
  isAuthenticated,
  isAdmin,
  async (req, res) => {
    try {
      // Validasi password admin secara langsung, bukan dengan fetch
      const { password } = req.body;
      const ADMIN_PASSWORD = "admin123"; // Sama dengan di API validasi

      if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({
          success: false,
          message: "Invalid admin password",
        });
      }

      // Cari file backup terbaru
      const backupDir = path.join(DATA_DIR, "backup");
      let backupFiles = [];

      try {
        const files = await fs.readdir(backupDir);
        backupFiles = files.filter(
          (file) => file.startsWith("products_") && file.endsWith(".json")
        );
        backupFiles.sort((a, b) => {
          const aTime = a.split("_")[1].replace(".json", "");
          const bTime = b.split("_")[1].replace(".json", "");
          return bTime.localeCompare(aTime);
        });
      } catch (error) {
        console.error("Error reading backup directory:", error);
      }

      if (backupFiles.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Tidak ada backup produk yang ditemukan",
        });
      }

      // Baca file backup terbaru
      const latestBackup = await readData(`backup/${backupFiles[0]}`);

      // Restore produk
      await writeData("products.json", latestBackup);

      res.json({
        success: true,
        message: `Produk berhasil dipulihkan dari backup: ${backupFiles[0]}`,
      });
    } catch (error) {
      console.error("Error restoring products:", error);
      res.status(500).json({
        success: false,
        message: "Failed to restore products",
      });
    }
  }
);

// --- Excel Import/Export API Routes ---

// Export Products to XLSX
app.get("/api/products/export", isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log("Requesting export...");
    const products = await readData("products.json");
    const categories = await readData("categories.json");

    // Transform data for export - EXCLUDE Image Base64 to avoid cell limit
    const exportData = products.map((product) => {
      const category = categories.find((c) => c.id === product.categoryId);
      return {
        "Product Name": product.name || "",
        "Purchase Price": product.purchasePrice || 0,
        "Selling Price": (product.sellingPrice != null ? product.sellingPrice : product.price) || 0,
        Price: product.price || 0,
        Stock: product.stock || 0,
        Category: category ? category.name : "",
        SKU: product.sku || "",
        "QR Code": product.qrCode || "",
        "Is Top Product": product.isTopProduct ? "Yes" : "No",
        "Is Best Seller": product.isBestSeller ? "Yes" : "No",
        "Has Image": product.imageBase64 ? "Yes" : "No",
      };
    });

    // Create workbook
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Products");

    // Set column widths
    const colWidths = [
      { wch: 30 }, // Product Name
      { wch: 15 }, // Purchase Price
      { wch: 15 }, // Selling Price
      { wch: 15 }, // Price (legacy)
      { wch: 10 }, // Stock
      { wch: 20 }, // Category
      { wch: 20 }, // SKU
      { wch: 25 }, // QR Code
      { wch: 15 }, // Is Top Product
      { wch: 15 }, // Is Best Seller
      { wch: 15 }, // Has Image
    ];
    ws["!cols"] = colWidths;

    // Generate buffer
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    // Set headers
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=products_export.xlsx"
    );

    console.log("Export completed successfully");
    res.send(buf);
  } catch (error) {
    console.error("Export error:", error);
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to export products: " + error.message,
      });
  }
});

// Download Import Template
app.get(
  "/api/products/template",
  isAuthenticated,
  isAdmin,
  async (req, res) => {
    try {
      console.log("Requesting template...");
      const categories = await readData("categories.json");

      // Create template data with example rows - include new price fields and QR Code
      const templateData = [
        {
          "Product Name": "Example Product 1",
          "Purchase Price": 8000,
          "Selling Price": 10000,
          Price: 10000,
          Stock: 50,
          Category: categories.length > 0 ? categories[0].name : "General",
          SKU: "PROD-001",
          "QR Code": "QR-EX-001",
          "Is Top Product": "Yes",
          "Is Best Seller": "No",
          "Has Image": "No",
        },
        {
          "Product Name": "Example Product 2",
          "Purchase Price": 20000,
          "Selling Price": 25000,
          Price: 25000,
          Stock: 30,
          Category: categories.length > 1 ? categories[1].name : "General",
          SKU: "PROD-002",
          "QR Code": "QR-EX-002",
          "Is Top Product": "No",
          "Is Best Seller": "Yes",
          "Has Image": "No",
        },
      ];

      // Create workbook
      const ws = XLSX.utils.json_to_sheet(templateData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Template");

      // Set column widths
      const colWidths = [
        { wch: 30 }, // Product Name
        { wch: 15 }, // Purchase Price
        { wch: 15 }, // Selling Price
        { wch: 15 }, // Price (legacy)
        { wch: 10 }, // Stock
        { wch: 20 }, // Category
        { wch: 20 }, // SKU
        { wch: 25 }, // QR Code
        { wch: 15 }, // Is Top Product
        { wch: 15 }, // Is Best Seller
        { wch: 15 }, // Has Image
      ];
      ws["!cols"] = colWidths;

      // Generate buffer
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      // Set headers
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=product_import_template.xlsx"
      );

      console.log("Template generated successfully");
      res.send(buf);
    } catch (error) {
      console.error("Template generation error:", error);
      res
        .status(500)
        .json({
          success: false,
          message: "Failed to generate template: " + error.message,
        });
    }
  }
);

// Import Products from XLSX
app.post("/api/products/import", isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log("Starting import...");
    const { products: importData } = req.body;

    if (!Array.isArray(importData) || importData.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No valid data to import" });
    }

    console.log("Import data received:", importData.length, "rows");
    console.log("First row sample:", importData[0]);
    console.log("First row category:", importData[0]["Category"]);

    const products = await readData("products.json");
    const categories = await readData("categories.json");

    console.log("Available categories:", categories.map(c => ({ id: c.id, name: `"${c.name}"` })));

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (let i = 0; i < importData.length; i++) {
      try {
        const row = importData[i];
        console.log(`Processing row ${i + 1}:`, row);

        // Validate required fields: Product Name, Stock, and (Selling Price or Price)
        const hasName = !!row["Product Name"];
        const hasStock = row["Stock"] !== undefined && row["Stock"] !== "";
        const hasSellingPrice = row["Selling Price"] !== undefined && row["Selling Price"] !== "";
        const hasLegacyPrice = row["Price"] !== undefined && row["Price"] !== "";
        if (!hasName || !hasStock || (!hasSellingPrice && !hasLegacyPrice)) {
          const errorMsg = `Baris ${i + 1}: Kolom wajib tidak lengkap. Wajib: Product Name, Stock, dan Selling Price atau Price.`;
          errors.push(errorMsg);
          errorCount++;
          continue;
        }

        // Find category
        let categoryId = null;
        if (
          row["Category"] &&
          row["Category"] &&
          row["Category"].toString().trim() !== ""
        ) {
          const categoryName = row["Category"].toString().trim();
          console.log(`Looking for category: "${categoryName}"`);

          const category = categories.find(
            (c) => c.name && c.name.toLowerCase() === categoryName.toLowerCase()
          );

          if (category) {
            categoryId = category.id;
            console.log(`Found category "${category.name}" with ID: ${categoryId}`);
          } else {
            console.log(`Category "${categoryName}" not found. Available categories:`, categories.map(c => `"${c.name}"`).join(', '));
            // Skip product if category doesn't exist
            const errorMsg = `Baris ${i + 1}: Kategori "${categoryName}" tidak ditemukan. Produk tidak diimpor.`;
            errors.push(errorMsg);
            errorCount++;
            continue;
          }
        }

        // Create product object with new fields
        const purchasePrice = parseFloat(row["Purchase Price"]) || 0;
        const sellingPrice = row["Selling Price"] !== undefined && row["Selling Price"] !== ""
          ? (parseFloat(row["Selling Price"]) || 0)
          : (parseFloat(row["Price"]) || 0);
        const qrCode = (row["QR Code"] || "").toString().trim();

        const newProduct = {
          id: Date.now() + i,
          name: row["Product Name"].toString().trim(),
          stock: parseInt(row["Stock"]) || 0,
          categoryId: categoryId,
          sku: row["SKU"]
            ? row["SKU"].toString().trim()
            : `PROD-${Date.now()}-${i}`,
          purchasePrice,
          sellingPrice,
          qrCode,
          // Backward compat for POS
          price: sellingPrice,
          isTopProduct:
            row["Is Top Product"] &&
            row["Is Top Product"].toString().toLowerCase() === "yes",
          isBestSeller:
            row["Is Best Seller"] &&
            row["Is Best Seller"].toString().toLowerCase() === "yes",
          imageBase64: "", // Always empty for imports
        };

        console.log(`Product "${newProduct.name}" will be linked to category ID: ${categoryId}`);
        products.push(newProduct);
        successCount++;
        console.log(`Successfully added product: ${newProduct.name} with categoryId: ${newProduct.categoryId}`);
      } catch (error) {
        const errorMsg = `Baris ${i + 1}: ${error.message}`;
        errors.push(errorMsg);
        errorCount++;
      }
    }

    // Save data with sync
    await saveArrayWithSync("products.json", products);
    await saveArrayWithSync("categories.json", categories);

    // Send response
    let message = `Import selesai. Sukses: ${successCount}, Error: ${errorCount}`;
    if (errors.length > 0) {
      message += `\n\nBeberapa error pertama:\n${errors
        .slice(0, 3)
        .join("\n")}`;
      if (errors.length > 5) {
        message += ` ... dan ${errors.length - 5} more errors`;
      }
    }

    console.log("Import completed:", message);
    res.json({
      success: true,
      message,
      successCount,
      errorCount,
      errors: errors.slice(0, 10), // Return first 10 errors
    });
  } catch (error) {
    console.error("!!! IMPORT ERROR !!!", error);
    res.status(500).json({
      success: false,
      message: "Failed to import products: " + error.message,
    });
  }
});

// === CATEGORIES EXPORT/IMPORT ===
// Export Categories to XLSX
app.get("/api/categories/export", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const categories = await readData("categories.json");
    const exportData = categories.map((cat) => ({
      "Category Name": cat.name || "",
      "Description": cat.description || "",
      "ID": cat.id || "",
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Categories");
    ws["!cols"] = [{ wch: 25 }, { wch: 50 }, { wch: 15 }];
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=categories_export.xlsx");
    res.send(buf);
  } catch (error) {
    console.error("Export categories error:", error);
    res.status(500).json({ success: false, message: "Failed to export categories: " + error.message });
  }
});

// Download Category Import Template
app.get("/api/categories/template", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const templateData = [
      { "Category Name": "Example Category 1", "Description": "Description for category 1" },
      { "Category Name": "Example Category 2", "Description": "Description for category 2" },
    ];

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    ws["!cols"] = [{ wch: 25 }, { wch: 50 }];
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=category_import_template.xlsx");
    res.send(buf);
  } catch (error) {
    console.error("Category template error:", error);
    res.status(500).json({ success: false, message: "Failed to generate template: " + error.message });
  }
});

// Import Categories from XLSX
app.post("/api/categories/import", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { categories: importData } = req.body;
    if (!Array.isArray(importData) || importData.length === 0) {
      return res.status(400).json({ success: false, message: "No valid data to import" });
    }

    const categories = await readData("categories.json");
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (let i = 0; i < importData.length; i++) {
      try {
        const row = importData[i];
        if (!row["Category Name"] || row["Category Name"].toString().trim() === "") {
          errors.push(`Baris ${i + 1}: Category Name wajib diisi`);
          errorCount++;
          continue;
        }

        const categoryName = row["Category Name"].toString().trim();
        const existingCategory = categories.find(c => c.name && c.name.toLowerCase() === categoryName.toLowerCase());
        if (existingCategory) {
          errors.push(`Baris ${i + 1}: Kategori "${categoryName}" sudah ada`);
          errorCount++;
          continue;
        }

        const newCategory = {
          id: Date.now() + i,
          name: categoryName,
          description: (row["Description"] || "").toString().trim(),
        };

        categories.push(newCategory);
        successCount++;
      } catch (error) {
        errors.push(`Baris ${i + 1}: ${error.message}`);
        errorCount++;
      }
    }

    await writeData("categories.json", categories);
    let message = `Import selesai. Sukses: ${successCount}, Error: ${errorCount}`;
    if (errors.length > 0) {
      message += `\n\nBeberapa error pertama:\n${errors.slice(0, 3).join("\n")}`;
      if (errors.length > 5) message += ` ... dan ${errors.length - 5} more errors`;
    }

    res.json({ success: true, message, successCount, errorCount, errors: errors.slice(0, 10) });
  } catch (error) {
    console.error("Import categories error:", error);
    res.status(500).json({ success: false, message: "Failed to import categories: " + error.message });
  }
});

// === TRANSACTIONS EXPORT ===
// Export Transactions to XLSX
app.get("/api/transactions/export", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const transactions = await readData("transactions.json");
    const users = await readData("users.json");
    const exportData = transactions.map((t) => {
      const user = users.find((u) => u.id === t.cashierId);
      return {
        "Transaction ID": t.id || "",
        "Date": t.date || "",
        "Time": t.time || "",
        "Cashier": user ? user.name || user.username : "",
        "Items Count": t.items ? t.items.length : 0,
        "Subtotal": t.subtotal || 0,
        "Tax": t.tax || 0,
        "Discount": t.discount || 0,
        "Total": t.total || 0,
        "Payment Method": t.paymentMethod || "",
        "Status": t.status || "",
      };
    });

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Transactions");
    ws["!cols"] = [{ wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 12 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 12 }];
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=transactions_export.xlsx");
    res.send(buf);
  } catch (error) {
    console.error("Export transactions error:", error);
    res.status(500).json({ success: false, message: "Failed to export transactions: " + error.message });
  }
});

// === USERS EXPORT/IMPORT ===
// Export Users to XLSX
app.get("/api/users/export", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const users = await readData("users.json");
    const exportData = users.map((u) => ({
      "Username": u.username || "",
      "Name": u.name || "",
      "Role": u.role || "",
      "Status": u.status || "active",
      "ID": u.id || "",
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Users");
    ws["!cols"] = [{ wch: 20 }, { wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=users_export.xlsx");
    res.send(buf);
  } catch (error) {
    console.error("Export users error:", error);
    res.status(500).json({ success: false, message: "Failed to export users: " + error.message });
  }
});

// Download User Import Template
app.get("/api/users/template", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const templateData = [
      { "Username": "user1", "Password": "password123", "Name": "User 1", "Role": "cashier", "Status": "active" },
      { "Username": "user2", "Password": "password123", "Name": "User 2", "Role": "admin", "Status": "active" },
    ];

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    ws["!cols"] = [{ wch: 20 }, { wch: 20 }, { wch: 30 }, { wch: 15 }, { wch: 15 }];
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=user_import_template.xlsx");
    res.send(buf);
  } catch (error) {
    console.error("User template error:", error);
    res.status(500).json({ success: false, message: "Failed to generate template: " + error.message });
  }
});

// Import Users from XLSX
app.post("/api/users/import", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { users: importData } = req.body;
    if (!Array.isArray(importData) || importData.length === 0) {
      return res.status(400).json({ success: false, message: "No valid data to import" });
    }

    const users = await readData("users.json");
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (let i = 0; i < importData.length; i++) {
      try {
        const row = importData[i];
        if (!row["Username"] || !row["Password"]) {
          errors.push(`Baris ${i + 1}: Username dan Password wajib diisi`);
          errorCount++;
          continue;
        }

        const username = row["Username"].toString().trim();
        const existingUser = users.find(u => u.username && u.username.toLowerCase() === username.toLowerCase());
        if (existingUser) {
          errors.push(`Baris ${i + 1}: Username "${username}" sudah ada`);
          errorCount++;
          continue;
        }

        const hashedPassword = await bcrypt.hash(row["Password"].toString(), 10);
        const newUser = {
          id: Date.now() + i,
          username: username,
          password: hashedPassword,
          name: (row["Name"] || "").toString().trim(),
          role: (row["Role"] || "cashier").toString().trim(),
          status: (row["Status"] || "active").toString().trim(),
        };

        users.push(newUser);
        successCount++;
      } catch (error) {
        errors.push(`Baris ${i + 1}: ${error.message}`);
        errorCount++;
      }
    }

    await writeData("users.json", users);
    let message = `Import selesai. Sukses: ${successCount}, Error: ${errorCount}`;
    if (errors.length > 0) {
      message += `\n\nBeberapa error pertama:\n${errors.slice(0, 3).join("\n")}`;
      if (errors.length > 5) message += ` ... dan ${errors.length - 5} more errors`;
    }

    res.json({ success: true, message, successCount, errorCount, errors: errors.slice(0, 10) });
  } catch (error) {
    console.error("Import users error:", error);
    res.status(500).json({ success: false, message: "Failed to import users: " + error.message });
  }
});

// === CUSTOMERS EXPORT/IMPORT ===
// Export Customers to XLSX
app.get("/api/customers/export", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const customers = await readData("customers.json");
    const exportData = customers.map((c) => ({
      "Customer Name": c.name || "",
      "Phone": c.phone || "",
      "Email": c.email || "",
      "Address": c.address || "",
      "ID": c.id || "",
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Customers");
    ws["!cols"] = [{ wch: 30 }, { wch: 20 }, { wch: 30 }, { wch: 50 }, { wch: 15 }];
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=customers_export.xlsx");
    res.send(buf);
  } catch (error) {
    console.error("Export customers error:", error);
    res.status(500).json({ success: false, message: "Failed to export customers: " + error.message });
  }
});

// Download Customer Import Template
app.get("/api/customers/template", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const templateData = [
      { "Customer Name": "John Doe", "Phone": "081234567890", "Email": "john@example.com", "Address": "Jl. Example No. 123" },
      { "Customer Name": "Jane Smith", "Phone": "081987654321", "Email": "jane@example.com", "Address": "Jl. Test No. 456" },
    ];

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    ws["!cols"] = [{ wch: 30 }, { wch: 20 }, { wch: 30 }, { wch: 50 }];
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=customer_import_template.xlsx");
    res.send(buf);
  } catch (error) {
    console.error("Customer template error:", error);
    res.status(500).json({ success: false, message: "Failed to generate template: " + error.message });
  }
});

// Import Customers from XLSX
app.post("/api/customers/import", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { customers: importData } = req.body;
    if (!Array.isArray(importData) || importData.length === 0) {
      return res.status(400).json({ success: false, message: "No valid data to import" });
    }

    const customers = await readData("customers.json");
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (let i = 0; i < importData.length; i++) {
      try {
        const row = importData[i];
        if (!row["Customer Name"] || row["Customer Name"].toString().trim() === "") {
          errors.push(`Baris ${i + 1}: Customer Name wajib diisi`);
          errorCount++;
          continue;
        }

        const newCustomer = {
          id: Date.now() + i,
          name: row["Customer Name"].toString().trim(),
          phone: (row["Phone"] || "").toString().trim(),
          email: (row["Email"] || "").toString().trim(),
          address: (row["Address"] || "").toString().trim(),
          createdAt: new Date().toISOString(),
        };

        customers.push(newCustomer);
        successCount++;
      } catch (error) {
        errors.push(`Baris ${i + 1}: ${error.message}`);
        errorCount++;
      }
    }

    await writeData("customers.json", customers);
    let message = `Import selesai. Sukses: ${successCount}, Error: ${errorCount}`;
    if (errors.length > 0) {
      message += `\n\nBeberapa error pertama:\n${errors.slice(0, 3).join("\n")}`;
      if (errors.length > 5) message += ` ... dan ${errors.length - 5} more errors`;
    }

    res.json({ success: true, message, successCount, errorCount, errors: errors.slice(0, 10) });
  } catch (error) {
    console.error("Import customers error:", error);
    res.status(500).json({ success: false, message: "Failed to import customers: " + error.message });
  }
});

// Check username availability
app.post("/api/users/check-username/:id?", async (req, res) => {
  try {
    const { username } = req.body;
    const userId = req.params.id;

    const existingUser = await validateUsername(username.trim(), userId);
    res.json({ exists: !!existingUser });
  } catch (error) {
    console.error("Error checking username:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Check product name availability
app.post("/api/products/check-name/:id?", async (req, res) => {
  try {
    const { name } = req.body;
    const productId = req.params.id;

    const existingProduct = await validateProductName(name.trim(), productId);
    res.json({ exists: !!existingProduct });
  } catch (error) {
    console.error("Error checking product name:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Check category name availability
app.post("/api/categories/check-name/:id?", async (req, res) => {
  try {
    const { name } = req.body;
    const categoryId = req.params.id;

    const existingCategory = await validateCategoryName(
      name.trim(),
      categoryId
    );
    res.json({ exists: !!existingCategory });
  } catch (error) {
    console.error("Error checking category name:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Reset user password
app.post(
  "/api/users/:id/reset-password",
  isAuthenticated,
  isAdmin,
  async (req, res) => {
    try {
      const { newPassword } = req.body;
      const userId = req.params.id;

      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: "Password minimal 6 karakter",
        });
      }

      const users = await readData("users.json");
      const index = users.findIndex((u) => u.id == userId);

      if (index !== -1) {
        users[index].password = await bcrypt.hash(newPassword, 10);
        users[index].updatedAt = new Date().toISOString();

        await writeData("users.json", users);
        res.json({
          success: true,
          message: "Password berhasil direset",
        });
      } else {
        res.status(404).json({
          success: false,
          message: "User tidak ditemukan",
        });
      }
    } catch (error) {
      console.error("Error resetting password:", error);
      res.status(500).json({
        success: false,
        message: "Failed to reset password",
      });
    }
  }
);

// --- Product Drafts API ---
// Helper untuk draf POS
const readPosDrafts = async () => readData("pos-drafts.json");
const writePosDrafts = async (drafts) => writeData("pos-drafts.json", drafts);

// GET /api/drafts - Ambil semua draf
app.get("/api/drafts", isAuthenticated, async (req, res) => {
  try {
    const drafts = await readPosDrafts();
    res.json(drafts);
  } catch (error) {
    console.error("Error loading drafts:", error);
    res.status(500).json({ success: false, message: "Failed to load drafts" });
  }
});

// POST /api/drafts - Simpan draf baru
app.post("/api/drafts", isAuthenticated, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Cannot save an empty draft." });
    }

    const drafts = await readPosDrafts();
    const newDraft = {
      id: Date.now().toString(),
      items: items,
      timestamp: new Date().toISOString(),
    };
    drafts.push(newDraft);
    await writePosDrafts(drafts);
    res.json({
      success: true,
      message: "Draft saved successfully!",
      draft: newDraft,
    });
  } catch (error) {
    console.error("Error saving draft:", error);
    res.status(500).json({ success: false, message: "Failed to save draft" });
  }
});

// PUT /api/drafts/:id/load - Muat draf ke keranjang dan hapus
app.put("/api/drafts/:id/load", isAuthenticated, async (req, res) => {
  try {
    const drafts = await readPosDrafts();
    const draftIndex = drafts.findIndex((d) => d.id === req.params.id);

    if (draftIndex === -1) {
      return res
        .status(404)
        .json({ success: false, message: "Draft not found." });
    }

    const draftToLoad = drafts[draftIndex];

    // Hapus draf setelah dimuat
    drafts.splice(draftIndex, 1);
    await writePosDrafts(drafts);

    res.json({
      success: true,
      message: "Draft loaded successfully.",
      items: draftToLoad.items,
    });
  } catch (error) {
    console.error("Error loading draft:", error);
    res.status(500).json({ success: false, message: "Failed to load draft" });
  }
});

// DELETE /api/drafts/:id - Hapus draf
app.delete("/api/drafts/:id", isAuthenticated, async (req, res) => {
  try {
    const drafts = await readPosDrafts();
    const filteredDrafts = drafts.filter((d) => d.id !== req.params.id);

    if (drafts.length === filteredDrafts.length) {
      return res
        .status(404)
        .json({ success: false, message: "Draft not found." });
    }

    await writePosDrafts(filteredDrafts);
    res.json({ success: true, message: "Draft deleted successfully." });
  } catch (error) {
    console.error("Error deleting draft:", error);
    res.status(500).json({ success: false, message: "Failed to delete draft" });
  }
});

app.post('/api/admin/encrypt-migrate', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const pass = process.env.POS_PASSPHRASE || '';
    if (!pass) return res.status(400).json({ success: false, message: 'POS_PASSPHRASE is required' });
    const files = await fs.readdir(DATA_DIR).catch(() => []);
    let processed = 0;
    const skipped = [];
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const full = path.join(DATA_DIR, f);
      const raw = await fs.readFile(full, 'utf-8').catch(() => null);
      if (!raw) continue;
      if (typeof raw === 'string' && raw.startsWith('ENC1:')) { skipped.push(f); continue; }
      let obj;
      try { obj = JSON.parse(raw); } catch { continue; }
      try { await writeData(f, obj); processed++; } catch {}
    }
    res.json({ success: true, processed, skipped });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Migration failed' });
  }
});

// --- Global 404 handler (must be after all routes) ---
app.use((req, res, next) => {
  const code = 404;
  const message = 'Not Found';
  // If client expects JSON (API/fetch), return JSON
  const acceptsHtml = req.accepts(['html', 'json']) === 'html';
  if (!acceptsHtml || req.originalUrl.startsWith('/api/')) {
    return res.status(code).json({ success: false, code, message, path: req.originalUrl });
  }
  const q = new URLSearchParams({ code: String(code), msg: message, path: req.originalUrl });
  return res.status(code).redirect(`/error.html?${q.toString()}`);
});

// --- Global error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  try { console.error('Unhandled error:', err); } catch {}
  const code = err?.status || err?.statusCode || 500;
  const message = err?.message || 'Internal Server Error';
  const acceptsHtml = req.accepts(['html', 'json']) === 'html';
  if (!acceptsHtml || req.originalUrl.startsWith('/api/')) {
    return res.status(code).json({ success: false, code, message, path: req.originalUrl });
  }
  const q = new URLSearchParams({ code: String(code), msg: message, path: req.originalUrl });
  return res.status(code).redirect(`/error.html?${q.toString()}`);
});

// --- PERUBAHAN 3: Inisialisasi Server yang Lebih Aman ---
// Gunakan async IIFE untuk memastikan direktori data ada sebelum server berjalan
(async () => {
  try {
    await ensureDataDir();
    await loadPassphraseFromFile();
    // Initialize encryption settings after passphrase is loaded
    try {
      const s = await readData('settings.json').catch(() => ({}));
      if (s && typeof s === 'object' && s.encryption && typeof s.encryption.enabled === 'boolean') {
        encryptionEnabled = !!s.encryption.enabled;
      }
    } catch {}
    // Run auto-backup if configured
    await autoBackupIfNeededOnStart();
    let hasValidLicense = false;
    try {
      const off = await verifyOfflineLicense();
      hasValidLicense = !!(off && off.valid);
      if (hasValidLicense) {
        try { console.log('[LICENSE-OFFLINE] Valid offline license', { reason: off.reason, exp: off.payload && off.payload.exp ? new Date(off.payload.exp).toISOString() : null }); } catch {}
      }
    } catch {}
    if (!hasValidLicense) {
      try {
        const lic = await checkLicenseOnline();
        hasValidLicense = !!(lic && lic.ok);
      } catch {}
    }
    if (!hasValidLicense) {
      await ensureTrialNotExpired();
    } else {
      try { console.log('[TRIAL] Skipping trial check because valid license is present'); } catch {}
    }
    const server = app.listen(PORT, HOST, () => {
      const url = `http://${HOST}:${PORT}/`;
      console.log(`Server berjalan di ${url}`);
      if (SHOULD_OPEN) {
        // Slight delay to ensure server is ready
        setTimeout(() => openBrowser(url), 300);
      }
    });
    server.on("error", (err) => {
      console.error("Server error saat start:", err);
      process.exit(1);
    });
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();
