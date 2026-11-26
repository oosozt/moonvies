// Accounts for Moonvies: people sign in, and inside an account pick a profile ("Who's watching?")
// that has its own watch progress and favorites. Accounts are made only from an invite link the
// admin creates; nobody can sign up on their own. Everything lives in one SQLite file (moonvies.db).
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const now = () => Date.now();
const DAY = 24 * 3600e3;
const SESSION_DAYS = 365;
export const COLORS = ['#ff2e88', '#3df2ff', '#ffb020', '#7cff6b', '#b18cff', '#ff7a45', '#4d8bff', '#ff5ce1'];

let db;
export function openDb(file) {
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, hash TEXT NOT NULL,
      admin INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, media TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
      kind TEXT NOT NULL, agent TEXT, created INTEGER NOT NULL, seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (
      hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      note TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER);
    -- progress and favorites have no foreign key: profile 0 is the computer itself, without --lan
    CREATE TABLE IF NOT EXISTS progress (
      profile_id INTEGER NOT NULL, key TEXT NOT NULL,
      t REAL NOT NULL DEFAULT 0, d REAL NOT NULL DEFAULT 0, w INTEGER NOT NULL DEFAULT 0, at INTEGER,
      PRIMARY KEY (profile_id, key));
    CREATE TABLE IF NOT EXISTS favorites (
      profile_id INTEGER NOT NULL, key TEXT NOT NULL,
      item TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (profile_id, key));
  `);
  return db;
}
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

/* ---------- passwords ---------- */
async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [, salt, hex] = String(stored).split('$');
  if (!salt || !hex) return false;
  const key = await scrypt(String(pw), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hex, 'hex');
  return want.length === key.length && timingSafeEqual(want, key);
}
const DUMMY = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(64);

/* ---------- people and profiles ---------- */
export const userCount = () => one('SELECT COUNT(*) n FROM users').n;
const cleanName = (s, max = 32) => String(s || '').normalize('NFC').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
function validUser(name, pw) {
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(name)) return 'A username is 2 to 32 letters, digits, dots, dashes or underscores.';
  if (String(pw || '').length < 6) return 'The password needs at least 6 characters.';
  if (String(pw).length > 200) return 'That password is too long.';
  return null;
}
export function profilesOf(userId) { return all('SELECT id, name, color FROM profiles WHERE user_id = ? ORDER BY id', userId); }
function addProfile(userId, name) {
  const used = new Set(profilesOf(userId).map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
  return Number(run('INSERT INTO profiles (user_id, name, color, created) VALUES (?, ?, ?, ?)', userId, name, color, now()).lastInsertRowid);
}

/* ---------- sessions (the "catalog" cookie holds a random token; only its hash is stored) ---------- */
function newSession(userId, kind, agent, profileId = null) {
  const token = randomBytes(32).toString('hex');
  run('INSERT INTO sessions (hash, media, user_id, profile_id, kind, agent, created, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha(token), mediaToken(token), userId, profileId, kind, String(agent || '').slice(0, 200), now(), now());
  return token;
}
// A sign-in for a device that can't show the sign-in page (the Glass Home TV launcher), made on the server.
export function deviceToken(userName, profileName, label) {
  const u = one('SELECT id FROM users WHERE name = ?', userName);
  if (!u) throw new Error(`No account called "${userName}"`);
  const p = profileName ? profilesOf(u.id).find((x) => x.name.toLowerCase() === String(profileName).toLowerCase()) : profilesOf(u.id)[0];
  if (!p) throw new Error(`No profile called "${profileName}" in ${userName}'s account`);
  return newSession(u.id, 'device', label, p.id);
}
export const mediaToken = (token) => sha('media:' + token).slice(0, 40);
const cookieOut = (token) => `catalog=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Strict`;
const cookieGone = 'catalog=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict';
export const tokenOf = (req) => /(?:^|;\s*)catalog=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1] || null;

function ctxFrom(s) {
  if (!s) return null;
  const user = one('SELECT id, name, admin FROM users WHERE id = ?', s.user_id);
  if (!user) return null;
  const profiles = profilesOf(user.id);
  const chosen = profiles.find((p) => p.id === s.profile_id) || null;
  if (now() - s.seen > 3600e3) run('UPDATE sessions SET seen = ? WHERE hash = ?', now(), s.hash);
  return { user: { id: user.id, name: user.name, admin: !!user.admin }, profiles, chosen, profile: chosen || profiles[0] || { id: 0, name: user.name, color: COLORS[0] }, sessionHash: s.hash, kind: s.kind };
}
// Who is asking: from the cookie, or (only for the video and subtitle files themselves) from ?t=, which
// players like VLC or a Chromecast use since they have no cookie.
export function contextOf(req, mediaOk) {
  const token = tokenOf(req);
  if (token) {
    const s = one('SELECT * FROM sessions WHERE hash = ?', sha(token));
    if (s && now() - s.seen < SESSION_DAYS * DAY) { const c = ctxFrom(s); if (c) { c.token = token; return c; } }
  }
  if (mediaOk) {
    const t = new URL(req.url, 'http://x').searchParams.get('t');
    if (t && /^[a-f0-9]{40}$/.test(t)) {
      const s = one('SELECT * FROM sessions WHERE media = ?', t);
      if (s && now() - s.seen < SESSION_DAYS * DAY) return ctxFrom(s);
    }
  }
  return null;
}

/* ---------- invites ---------- */
function newInvite(kind, userId, note, days = 7) {
  const code = randomBytes(18).toString('base64url');
  run('INSERT INTO invites (hash, kind, user_id, note, created, expires) VALUES (?, ?, ?, ?, ?, ?)', sha(code), kind, userId, cleanName(note, 60) || null, now(), now() + days * DAY);
  return code;
}
const inviteOf = (code) => {
  const i = code && one('SELECT * FROM invites WHERE hash = ?', sha(code));
  return i && !i.used && i.expires > now() ? i : null;
};
// The very first start: a link that makes the admin account.
export function setupLink() {
  if (userCount()) return null;
  run("DELETE FROM invites WHERE kind = 'admin'");
  return newInvite('admin', null, 'admin', 30);
}

/* ---------- rate limits for guessing ---------- */
const fails = new Map(); // ip -> [times]
function tooMany(ip) { const l = (fails.get(ip) || []).filter((t) => now() - t < 15 * 60e3); fails.set(ip, l); return l.length >= 10; }
const failed = (ip) => fails.set(ip, [...(fails.get(ip) || []), now()]);

/* ---------- TV pairing: a code made on a signed-in device signs the TV into that same account ---------- */
const pairCodes = new Map(); // code -> { userId, exp }
export function pairCode(ctx) {
  for (const [c, v] of pairCodes) if (v.userId === ctx.user.id || v.exp < now()) pairCodes.delete(c);
  let code;
  do code = String(100000 + (randomBytes(4).readUInt32BE() % 900000)); while (pairCodes.has(code));
  pairCodes.set(code, { userId: ctx.user.id, exp: now() + 10 * 60e3 });
  return code;
}

/* ---------- what the pages ask ---------- */
const meOut = (c) => ({ user: c.user, profile: c.chosen, profiles: c.profiles, colors: COLORS });

// Routes anyone may call (signing in). Returns true when it answered.
export async function publicRoutes(req, res, path, { send, readJson, onFirstProfile, log }) {
  const ip = req.socket.remoteAddress || '';
  if (path === '/api/auth/login' && req.method === 'POST') {
    if (tooMany(ip)) return send(res, 429, { error: 'Too many wrong tries. Wait 15 minutes.' }), true;
    const b = await readJson(req).catch(() => ({}));
    const u = one('SELECT * FROM users WHERE name = ?', cleanName(b.name));
    const ok = await checkPassword(b.password, u?.hash || DUMMY);
    if (!u || !ok) { failed(ip); return send(res, 403, { error: 'Wrong username or password.' }), true; }
    res.setHeader('Set-Cookie', cookieOut(newSession(u.id, 'login', req.headers['user-agent'])));
    log(`Signed in: ${u.name} from ${ip}`);
    return send(res, 200, { ok: true }), true;
  }
  if (path === '/api/auth/invite' && req.method === 'GET') {
    const i = inviteOf(new URL(req.url, 'http://x').searchParams.get('c'));
    if (!i) return send(res, 404, { error: 'This link has expired or was already used. Ask for a new one.' }), true;
    const u = i.user_id ? one('SELECT name FROM users WHERE id = ?', i.user_id) : null;
    return send(res, 200, { kind: i.kind, name: u?.name || '', note: i.kind === 'new' ? i.note || '' : '' }), true;
  }
  if (path === '/api/auth/invite' && req.method === 'POST') {
    if (tooMany(ip)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' }), true;
    const b = await readJson(req).catch(() => ({}));
    const i = inviteOf(b.c);
    if (!i) { failed(ip); return send(res, 404, { error: 'This link has expired or was already used. Ask for a new one.' }), true; }
    let userId, firstProfile = null;
    if (i.kind === 'reset') {
      if (String(b.password || '').length < 6) return send(res, 400, { error: 'The password needs at least 6 characters.' }), true;
      const h = await hashPassword(b.password);
      userId = i.user_id;
      tx(() => {
        run('UPDATE users SET hash = ? WHERE id = ?', h, userId);
        run('DELETE FROM sessions WHERE user_id = ?', userId); // a new password signs out everywhere else
        run('UPDATE invites SET used = ? WHERE hash = ?', now(), i.hash);
      });
    } else {
      const name = cleanName(b.name), prof = cleanName(b.profile, 24) || name;
      const bad = validUser(name, b.password);
      if (bad) return send(res, 400, { error: bad }), true;
      if (one('SELECT 1 x FROM users WHERE name = ?', name)) return send(res, 409, { error: 'That username is taken. Pick another.' }), true;
      const h = await hashPassword(b.password);
      tx(() => {
        userId = Number(run('INSERT INTO users (name, hash, admin, created) VALUES (?, ?, ?, ?)', name, h, i.kind === 'admin' ? 1 : 0, now()).lastInsertRowid);
        firstProfile = addProfile(userId, prof);
        run('UPDATE invites SET used = ? WHERE hash = ?', now(), i.hash);
      });
      log(`New account: ${name}${i.kind === 'admin' ? ' (admin)' : ''}`);
      if (i.kind === 'admin') onFirstProfile?.(firstProfile);
    }
    res.setHeader('Set-Cookie', cookieOut(newSession(userId, 'login', req.headers['user-agent'], firstProfile)));
    return send(res, 200, { ok: true }), true;
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    const t = tokenOf(req);
    if (t) run('DELETE FROM sessions WHERE hash = ?', sha(t));
    res.setHeader('Set-Cookie', cookieGone);
    return send(res, 200, { ok: true }), true;
  }
  if (path === '/api/tv/pair' && req.method === 'POST') {
    if (tooMany(ip)) return send(res, 429, { error: 'Too many wrong codes. Wait 15 minutes.' }), true;
    const { code } = await readJson(req).catch(() => ({}));
    const p = pairCodes.get(String(code || '').trim());
    if (!p || p.exp < now()) { failed(ip); return send(res, 403, { error: 'That code is wrong or has expired.' }), true; }
    pairCodes.delete(String(code).trim());
    res.setHeader('Set-Cookie', cookieOut(newSession(p.userId, 'tv', req.headers['user-agent'])));
    log(`TV paired from ${ip}`);
    return send(res, 200, { ok: true }), true;
  }
  return false;
}

// Routes for someone signed in (ctx). Returns true when it answered.
export async function accountRoutes(req, res, path, ctx, { send, readJson, log }) {
  const m = req.method;
  if (path === '/api/me' && m === 'GET') return send(res, 200, meOut(ctx)), true;
  if (path === '/api/me/profile' && m === 'POST') {
    const b = await readJson(req);
    if (!ctx.profiles.some((p) => p.id === b.id)) return send(res, 404, { error: 'No such profile' }), true;
    run('UPDATE sessions SET profile_id = ? WHERE hash = ?', b.id, ctx.sessionHash);
    return send(res, 200, { ok: true }), true;
  }
  if (path === '/api/me/password' && m === 'POST') {
    const b = await readJson(req);
    const u = one('SELECT hash FROM users WHERE id = ?', ctx.user.id);
    if (!(await checkPassword(b.old, u.hash))) return send(res, 403, { error: 'The current password is wrong.' }), true;
    if (String(b.password || '').length < 6) return send(res, 400, { error: 'The new password needs at least 6 characters.' }), true;
    const h = await hashPassword(b.password);
    tx(() => { run('UPDATE users SET hash = ? WHERE id = ?', h, ctx.user.id); run('DELETE FROM sessions WHERE user_id = ? AND hash <> ?', ctx.user.id, ctx.sessionHash); });
    return send(res, 200, { ok: true }), true;
  }
  if (path === '/api/me/signout-others' && m === 'POST') {
    run('DELETE FROM sessions WHERE user_id = ? AND hash <> ?', ctx.user.id, ctx.sessionHash);
    return send(res, 200, { ok: true }), true;
  }
  // profiles: POST /api/profiles {name} adds one; POST /api/profiles/<id> {name, color} or {delete: true}
  if (path === '/api/profiles' && m === 'POST') {
    const name = cleanName((await readJson(req)).name, 24);
    if (!name) return send(res, 400, { error: 'Give the profile a name.' }), true;
    if (ctx.profiles.length >= 6) return send(res, 400, { error: 'An account can have up to 6 profiles.' }), true;
    return send(res, 200, { ok: true, id: addProfile(ctx.user.id, name) }), true;
  }
  const pm = /^\/api\/profiles\/(\d+)$/.exec(path);
  if (pm && m === 'POST') {
    const id = Number(pm[1]), b = await readJson(req);
    if (!ctx.profiles.some((p) => p.id === id)) return send(res, 404, { error: 'No such profile' }), true;
    if (b.delete) {
      if (ctx.profiles.length < 2) return send(res, 400, { error: 'An account needs at least one profile.' }), true;
      tx(() => { dropProfileData([id]); run('DELETE FROM profiles WHERE id = ?', id); });
      return send(res, 200, { ok: true }), true;
    }
    const name = b.name != null ? cleanName(b.name, 24) : null, color = COLORS.includes(b.color) ? b.color : null;
    if (b.name != null && !name) return send(res, 400, { error: 'Give the profile a name.' }), true;
    if (name) run('UPDATE profiles SET name = ? WHERE id = ?', name, id);
    if (color) run('UPDATE profiles SET color = ? WHERE id = ?', color, id);
    return send(res, 200, { ok: true }), true;
  }

  /* admin: accounts and invites */
  if (!path.startsWith('/api/admin/')) return false;
  if (!ctx.user.admin) return send(res, 403, { error: 'Only the admin can do this.' }), true;
  const base = `http://${req.headers.host}`;
  if (path === '/api/admin/users' && m === 'GET') {
    const users = all('SELECT id, name, admin, created FROM users ORDER BY created').map((u) => ({
      ...u, admin: !!u.admin, profiles: profilesOf(u.id).map((p) => p.name),
      devices: one('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', u.id).n,
      seen: one('SELECT MAX(seen) s FROM sessions WHERE user_id = ?', u.id).s || null,
    }));
    const invites = all("SELECT hash, kind, note, user_id, created, expires FROM invites WHERE used IS NULL AND expires > ? AND kind <> 'admin' ORDER BY created DESC", now())
      .map((i) => ({ id: i.hash.slice(0, 16), kind: i.kind, note: i.note, user: i.user_id ? one('SELECT name FROM users WHERE id = ?', i.user_id)?.name : null, expires: i.expires }));
    return send(res, 200, { users, invites }), true;
  }
  if (path === '/api/admin/invite' && m === 'POST') {
    const b = await readJson(req);
    const code = newInvite('new', null, b.note);
    log(`Invite made by ${ctx.user.name}${b.note ? ' for ' + cleanName(b.note, 60) : ''}`);
    return send(res, 200, { link: `${base}/login?invite=${code}`, days: 7 }), true;
  }
  const im = /^\/api\/admin\/invites\/([a-f0-9]{16})$/.exec(path);
  if (im && m === 'POST') { // cancel an invite
    run('DELETE FROM invites WHERE substr(hash, 1, 16) = ? AND used IS NULL', im[1]);
    return send(res, 200, { ok: true }), true;
  }
  const um = /^\/api\/admin\/users\/(\d+)\/(reset|signout|delete)$/.exec(path);
  if (um && m === 'POST') {
    const id = Number(um[1]), u = one('SELECT * FROM users WHERE id = ?', id);
    if (!u) return send(res, 404, { error: 'No such account' }), true;
    if (um[2] === 'reset') {
      run("DELETE FROM invites WHERE kind = 'reset' AND user_id = ? AND used IS NULL", id);
      return send(res, 200, { link: `${base}/login?invite=${newInvite('reset', id, null, 2)}`, days: 2 }), true;
    }
    if (um[2] === 'signout') { run('DELETE FROM sessions WHERE user_id = ? AND hash <> ?', id, ctx.sessionHash); return send(res, 200, { ok: true }), true; }
    if (id === ctx.user.id) return send(res, 400, { error: "You can't delete your own account." }), true;
    tx(() => { dropProfileData(profilesOf(id).map((p) => p.id)); run('DELETE FROM users WHERE id = ?', id); });
    log(`Account deleted: ${u.name}`);
    return send(res, 200, { ok: true }), true;
  }
  return send(res, 404, { error: 'not found' }), true;
}

/* ---------- per-profile watch progress and favorites ---------- */
function dropProfileData(ids) {
  for (const id of ids) { run('DELETE FROM progress WHERE profile_id = ?', id); run('DELETE FROM favorites WHERE profile_id = ?', id); }
}
const progOut = (r) => ({ t: r.t, d: r.d, w: !!r.w, at: r.at });
export function progressGet(pid, key) { const r = one('SELECT * FROM progress WHERE profile_id = ? AND key = ?', pid, key); return r ? progOut(r) : null; }
export function progressSet(pid, key, p) {
  run(`INSERT INTO progress (profile_id, key, t, d, w, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (profile_id, key) DO UPDATE SET t = excluded.t, d = excluded.d, w = excluded.w, at = excluded.at`, pid, key, p.t || 0, p.d || 0, p.w ? 1 : 0, p.at || now());
}
// { "<video n>": {t, d, w, at} } for one download
export function watchOf(pid, id) {
  const out = {};
  for (const r of all('SELECT * FROM progress WHERE profile_id = ? AND key LIKE ?', pid, id + ':%')) out[r.key.slice(id.length + 1)] = progOut(r);
  return out;
}
export function dropProgress(id) { run('DELETE FROM progress WHERE key LIKE ?', id + ':%'); }
// someone (another profile) is part-way through this download
export function othersWatching(pid, id) { return !!one('SELECT 1 x FROM progress WHERE profile_id <> ? AND key LIKE ? AND w = 0 AND t > 60', pid, id + ':%'); }
export function favoritesOf(pid) { return all('SELECT item, added FROM favorites WHERE profile_id = ? ORDER BY added DESC', pid).map((r) => ({ ...JSON.parse(r.item), addedAt: r.added })); }
export function favoriteSet(pid, key, item) {
  if (item) run('INSERT INTO favorites (profile_id, key, item, added) VALUES (?, ?, ?, ?) ON CONFLICT (profile_id, key) DO UPDATE SET item = excluded.item', pid, key, JSON.stringify(item), now());
  else run('DELETE FROM favorites WHERE profile_id = ? AND key = ?', pid, key);
}
// The old single-user files become the admin's first profile.
export function importOld(pid, progress, favorites) {
  tx(() => {
    for (const [k, p] of Object.entries(progress || {})) progressSet(pid, k, p);
    for (const [k, f] of Object.entries(favorites || {})) { const { addedAt, ...item } = f; run('INSERT OR IGNORE INTO favorites (profile_id, key, item, added) VALUES (?, ?, ?, ?)', pid, k, JSON.stringify(item), addedAt || now()); }
  });
}
