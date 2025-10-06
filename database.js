// database.js
import sqlite3 from 'sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'database.db');

export const db = new sqlite3.Database(DB_PATH);

export function initSchema() {
  db.serialize(() => {
    // Ajustes básicos recomendados
    db.run(`PRAGMA journal_mode=WAL`);
    db.run(`PRAGMA synchronous=NORMAL`);
    db.run(`PRAGMA foreign_keys=ON`);

    // Servidores registrados
    db.run(`CREATE TABLE IF NOT EXISTS servers (
      ID TEXT PRIMARY KEY,            -- guildId
      Owner TEXT,                     -- Coin OwnerID (quem recebe)
      Panel TEXT,                     -- canal do painel (id)
      channel TEXT,                   -- canal onde anúncios aparecem (id)
      cooldown INTEGER DEFAULT 1800,  -- segundos (min 1800=30m, max 86400=24h)
      latest INTEGER DEFAULT 0        -- timestamp do último anúncio
    )`);

    // Fila de anúncios (volátil: consumida pelo worker)
    db.run(`CREATE TABLE IF NOT EXISTS adsqueue (
      queue INTEGER PRIMARY KEY AUTOINCREMENT,
      AD_ID TEXT NOT NULL,
      User TEXT NOT NULL,
      ad TEXT NOT NULL,
      link TEXT,
      msg TEXT,
      Server TEXT NOT NULL
    )`);

    // Fila de pagamentos (volátil: consumida pelo worker)
    db.run(`CREATE TABLE IF NOT EXISTS paymentqueue (
      queue INTEGER PRIMARY KEY AUTOINCREMENT,
      AD_ID TEXT NOT NULL,
      PayID TEXT,
      ID TEXT NOT NULL,
      card TEXT NOT NULL,
      server_owner_id TEXT NOT NULL
    )`);

    // Anúncios de cada usuário (estado do anúncio)
    db.run(`CREATE TABLE IF NOT EXISTS users (
      ID TEXT NOT NULL,       -- userId do anunciante
      ADS_ID TEXT NOT NULL,   -- identificador único do anúncio do usuário
      times INTEGER,          -- null => infinito; >0 => restante
      card TEXT NOT NULL,     -- cardCode para pagar
      PRIMARY KEY (ID, ADS_ID)
    )`);

    // 🔐 Conteúdo persistente dos anúncios (fonte da verdade para rounds)
    db.run(`CREATE TABLE IF NOT EXISTS adsmeta (
      AD_ID TEXT PRIMARY KEY,
      User TEXT NOT NULL,
      ad TEXT NOT NULL,
      link TEXT,
      msg TEXT
    )`);

    // Índices úteis
    db.run(`CREATE INDEX IF NOT EXISTS idx_adsqueue_server ON adsqueue(Server)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_adsqueue_adid ON adsqueue(AD_ID)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_paymentqueue_keys ON paymentqueue(AD_ID, ID)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_by_ad ON users(ADS_ID)`);
  });
}

// =============== Helpers de servidores ===============
export function getServer(guildId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM servers WHERE ID = ?`, [guildId], (e, row) => e ? reject(e) : resolve(row));
  });
}

export function upsertServer({ ID, Owner, Panel, channel, cooldown }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO servers (ID, Owner, Panel, channel, cooldown, latest)
       VALUES (@ID, @Owner, @Panel, @channel, @cooldown, COALESCE((SELECT latest FROM servers WHERE ID=@ID),0))
       ON CONFLICT(ID) DO UPDATE SET
         Owner=COALESCE(excluded.Owner, servers.Owner),
         Panel=COALESCE(excluded.Panel, servers.Panel),
         channel=COALESCE(excluded.channel, servers.channel),
         cooldown=COALESCE(excluded.cooldown, servers.cooldown)`,
      { '@ID': ID, '@Owner': Owner, '@Panel': Panel, '@channel': channel, '@cooldown': cooldown },
      (e) => e ? reject(e) : resolve()
    );
  });
}

export function setLatest(guildId, ts) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE servers SET latest = ? WHERE ID = ?`, [ts, guildId], (e) => e ? reject(e) : resolve());
  });
}

// =============== Helpers de anúncios (estado/times) ===============
export function insertUserAd({ userId, adsId, times, card }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO users (ID, ADS_ID, times, card) VALUES (?,?,?,?)`,
      [userId, adsId, times ?? null, card],
      (e) => e ? reject(e) : resolve()
    );
  });
}

export function decrementTimes(userId, adsId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT times FROM users WHERE ID=? AND ADS_ID=?`, [userId, adsId], (e, row) => {
      if (e) return reject(e);
      if (!row) return resolve();             // anúncio removido / inexistente
      if (row.times == null) return resolve(); // infinito: não altera
      const next = row.times - 1;
      if (next <= 0) {
        db.run(`DELETE FROM users WHERE ID=? AND ADS_ID=?`, [userId, adsId], (e2) => e2 ? reject(e2) : resolve());
      } else {
        db.run(`UPDATE users SET times=? WHERE ID=? AND ADS_ID=?`, [next, userId, adsId], (e2) => e2 ? reject(e2) : resolve());
      }
    });
  });
}

// ====== Conteúdo persistente do anúncio (fonte para rounds) ======
export function upsertAdMeta({ AD_ID, User, ad, link, msg }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO adsmeta (AD_ID, User, ad, link, msg)
       VALUES (?,?,?,?,?)
       ON CONFLICT(AD_ID) DO UPDATE SET
         User=excluded.User,
         ad=excluded.ad,
         link=excluded.link,
         msg=excluded.msg`,
      [AD_ID, User, ad, link, msg],
      (e) => e ? reject(e) : resolve()
    );
  });
}

export function getAdMeta(AD_ID) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT ad, link, msg FROM adsmeta WHERE AD_ID = ?`,
      [AD_ID],
      (e, row) => e ? reject(e) : resolve(row)
    );
  });
}

// =============== Fila de anúncios (adsqueue) ===============
export function addToAdsQueue(rows) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`INSERT INTO adsqueue (AD_ID, User, ad, link, msg, Server) VALUES (?,?,?,?,?,?)`);
      for (const r of rows) stmt.run([r.AD_ID, r.User, r.ad, r.link, r.msg, r.Server]);
      stmt.finalize((e) => e ? reject(e) : resolve());
    });
  });
}

/**
 * Busca a próxima entrada da fila de anúncios.
 * - Se serverId for fornecido: busca por AD_ID + Server.
 * - Se serverId for null/undefined: busca apenas por AD_ID (primeira na fila).
 */
export function getAdQueueByAdIdAndServer(adId, serverId) {
  return new Promise((resolve, reject) => {
    const params = [adId];
    let sql = `SELECT * FROM adsqueue WHERE AD_ID = ?`;
    if (serverId != null) {
      sql += ` AND Server = ?`;
      params.push(serverId);
    }
    sql += ` ORDER BY queue ASC LIMIT 1`;
    db.get(sql, params, (e, row) => e ? reject(e) : resolve(row));
  });
}

export function deleteAdsQueue(queueId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM adsqueue WHERE queue = ?`, [queueId], (e) => e ? reject(e) : resolve());
  });
}

// =============== Fila de pagamentos (paymentqueue) ===============
export function addToPaymentQueue(rows) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`INSERT INTO paymentqueue (AD_ID, ID, card, server_owner_id) VALUES (?,?,?,?)`);
      for (const r of rows) stmt.run([r.AD_ID, r.ID, r.card, r.server_owner_id]);
      stmt.finalize((e) => e ? reject(e) : resolve());
    });
  });
}

export function popNextPayment() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM paymentqueue ORDER BY queue ASC LIMIT 1`, [], (e, row) => {
      if (e) return reject(e);
      resolve(row);
    });
  });
}

export function deletePayment(queueId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM paymentqueue WHERE queue = ?`, [queueId], (e) => e ? reject(e) : resolve());
  });
}

// =============== Limpeza e manutenção ===============
export function cleanupSequencesIfEmpty() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT
         (SELECT COUNT(1) FROM adsqueue) AS a,
         (SELECT COUNT(1) FROM paymentqueue) AS p`,
      [],
      (e, row) => {
        if (e) return reject(e);
        if (row.a === 0 && row.p === 0) {
          db.serialize(() => {
            db.run(`DELETE FROM sqlite_sequence WHERE name IN ('adsqueue','paymentqueue')`);
          });
        }
        resolve();
      }
    );
  });
}
