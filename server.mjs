// Local server for the catalog page.
// - Serves the page (YouTube trailer embeds refuse to play from a file:// page).
// - Bridges to torlink: runs `torlnk search`, drives a `torlnk serve` instance for
//   downloads, reports progress, and opens finished downloads in the default player.
import { createServer } from 'node:http';
import { readFile, writeFile, stat, readdir, mkdir, rename, rm, statfs, open as openFile } from 'node:fs/promises';
import { existsSync, createReadStream, openSync, closeSync, readdirSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { extname, join, normalize, resolve, sep, basename, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, spawn, execFile } from 'node:child_process';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import * as auth from './auth.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 5178;
const TOR_PORT = Number(process.env.TORLINK_API_PORT) || 9161;
const TOR = `http://127.0.0.1:${TOR_PORT}`;
const DATA_DIR = process.env.TORLINK_STATE_DIR
  ? join(process.env.TORLINK_STATE_DIR, 'data')
  : join(process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local'), 'torlink', 'Data');
const HISTORY = join(DATA_DIR, 'history.json');
const META_FILE = join(root, 'downloads.json'); // what the page knows about each download (poster, auto-open)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const VIDEO = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.webm', '.wmv', '.ts', '.mpg', '.mpeg']);
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);

/* ---------- torlink CLI ---------- */
function torlinkCli() {
  const candidates = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'torlnk', 'dist', 'cli.cjs'),
    join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'torlnk', 'dist', 'cli.cjs'),
    // Linux/macOS (nvm or a system node): the global folder beside this node
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'torlnk', 'dist', 'cli.cjs'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}
const CLI = torlinkCli();
function runTorlink(args) {
  // Run the installed CLI with this same node, so no .ps1/.cmd launcher is involved.
  return CLI ? spawn(process.execPath, [CLI, ...args], { windowsHide: true })
             : spawn('torlnk.cmd', args, { windowsHide: true, shell: true });
}

/* ---------- torlink serve (download engine) ---------- */
let serveProc = null, serveStarting = null;
async function torHealthy() {
  try { const r = await fetch(TOR + '/health', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
// torlink has no single-instance lock: the TUI and a serve engine would both
// resume and rewrite the same queue/history files. Check for an open TUI first.
const WIN = process.platform === 'win32';
function torlinkTuiOpen() {
  if (!WIN) return Promise.resolve(false);
  return new Promise((ok) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"],
      { windowsHide: true, timeout: 8000 }, (err, out) => {
        if (err) return ok(false);
        ok(out.split(/\r?\n/).some((l) => /torlnk[\\/]dist[\\/]cli\.cjs/i.test(l) &&
          !/\b(serve|search|seed|watch|files|update|--help|--version)\b/.test(l.split(/cli\.cjs"?/i)[1] || '')));
      });
  });
}
let lastStartError = null; // { err, at }: don't re-run the TUI check on every poll
async function ensureServe() {
  if (await torHealthy()) return;
  if (serveStarting) return serveStarting;
  if (lastStartError && Date.now() - lastStartError.at < 10000) throw lastStartError.err;
  serveStarting = (async () => {
    if (!process.env.TORLINK_STATE_DIR && await torlinkTuiOpen()) {
      throw Object.assign(new Error('The torlink window is open. Close it so the catalog can run downloads; both would otherwise manage the same files.'), { status: 409 });
    }
    // The engine writes straight to its log file (no pipe back to this process), so
    // restarting this server doesn't break it; the next start reuses it. It still
    // shares this console, so closing the catalog window or Ctrl+C stops it too.
    const logFd = openSync(join(root, 'torlink-serve.log'), 'a');
    const to = process.env.CATALOG_DOWNLOAD_DIR ? ['--to', process.env.CATALOG_DOWNLOAD_DIR] : [];
    const args = ['serve', '--port', String(TOR_PORT), ...to];
    const opts = { windowsHide: true, stdio: ['ignore', logFd, logFd] };
    serveProc = CLI ? spawn(process.execPath, [CLI, ...args], opts) : spawn('torlnk.cmd', args, { ...opts, shell: true });
    closeSync(logFd);
    serveProc.on('exit', (code) => { console.log(`torlink serve exited (${code})`); serveProc = null; });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await torHealthy()) { console.log(`torlink serve running on ${TOR}`); return; }
      if (!serveProc) break;
    }
    throw new Error('torlink serve did not start; see torlink-serve.log');
  })().then(() => { lastStartError = null; }, (err) => { lastStartError = { err, at: Date.now() }; throw err; })
    .finally(() => { serveStarting = null; });
  return serveStarting;
}
async function tor(path, body) {
  await ensureServe();
  const r = await fetch(TOR + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `torlink ${r.status}`), { status: r.status });
  return j;
}

/* ---------- state ---------- */
let meta = {};
try { meta = JSON.parse(await readFile(META_FILE, 'utf8')); } catch {}
// Downloads whose title link got lost (an old page bug sent TV shows with a bad type):
// let the page match them to their title again.
for (const m of Object.values(meta)) if (!m.item && m.linkTried && m.title) m.linkTried = false;
const saveMeta = () => writeFile(META_FILE, JSON.stringify(meta, null, 2)).catch(() => {});
// Accounts, profiles, and each profile's watch progress and favorites: moonvies.db (see auth.mjs).
auth.openDb(join(root, 'moonvies.db'));
// Before accounts there was one shared progress.json and favorites.json: they become the admin's first profile.
async function importOldFiles(pid) {
  const old = async (f) => { try { return JSON.parse(await readFile(join(root, f), 'utf8')); } catch { return null; } };
  const p = await old('progress.json'), f = await old('favorites.json');
  if (!p && !f) return;
  auth.importOld(pid, p, f);
  for (const x of ['progress.json', 'favorites.json']) await rename(join(root, x), join(root, x + '.imported')).catch(() => {});
  console.log('Moved the old watch progress and favorites into the admin\'s profile');
}
// A small snapshot of a TMDB title, enough to draw its card.
function itemOf(x) {
  if (!x || !Number.isInteger(Number(x.id)) || !['movie', 'tv'].includes(x.type)) return null;
  return {
    id: Number(x.id), type: x.type, title: String(x.title || '').slice(0, 300),
    poster_path: typeof x.poster_path === 'string' ? x.poster_path : null,
    date: typeof x.date === 'string' ? x.date.slice(0, 10) : '', vote_average: Number(x.vote_average) || 0,
    genre_ids: Array.isArray(x.genre_ids) ? x.genre_ids.map(Number).filter(Number.isInteger).slice(0, 12) : [],
  };
}
const epOf = (b) => ({
  season: Number.isInteger(b.season) ? b.season : null,
  episode: Number.isInteger(b.episode) ? b.episode : null,
});
const linkOf = (m) => m ? { item: m.item || null, season: m.season ?? null, episode: m.episode ?? null, linkTried: !!m.linkTried } : { item: null, season: null, episode: null, linkTried: false };
async function history() {
  try { return JSON.parse(await readFile(HISTORY, 'utf8')); } catch { return []; }
}

function infoHashOf(magnet) {
  const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet || '');
  if (!m) return null;
  const v = m[1];
  if (/^[0-9a-f]{40}$/i.test(v)) return v.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(v)) { // base32 → hex
    let bits = '';
    for (const c of v.toUpperCase()) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
    return bits.match(/.{4}/g).map((b) => parseInt(b, 2).toString(16)).join('');
  }
  return null;
}

/* ---------- opening finished downloads ---------- */
async function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, depth + 1);
    else if (e.isFile()) out.push({ p, size: (await stat(p).catch(() => ({ size: 0 }))).size });
  }
  return out;
}
// What to open for a finished download: the main video for a movie, the
// playlist for a season or course, otherwise the folder itself.
async function target(h) {
  const base = resolve(h.dir), p = resolve(h.dir, h.name);
  if (p !== base && !p.startsWith(base + sep)) return null;
  const s = await stat(p).catch(() => null);
  if (!s) return null;
  if (s.isFile()) return { open: p, folder: p };
  const vids = (await walk(p)).filter((f) => VIDEO.has(extname(f.p).toLowerCase())).sort((a, b) => b.size - a.size);
  const total = vids.reduce((n, f) => n + f.size, 0);
  if (vids.length && vids[0].size >= total * 0.6) return { open: vids[0].p, folder: p };
  if (existsSync(join(p, 'playlist.m3u'))) return { open: join(p, 'playlist.m3u'), folder: p };
  return { open: p, folder: p };
}
// Everything playable in a finished download, in episode order, plus subtitles.
async function mediaOf(h) {
  const base = resolve(h.dir), p = resolve(h.dir, h.name);
  if (p !== base && !p.startsWith(base + sep)) return null;
  const s = await stat(p).catch(() => null);
  if (!s) return null;
  let files = s.isFile() ? [{ p, size: s.size }] : await walk(p);
  // A single-file download's subtitles sit beside it: "<name>.tr.srt" etc.
  if (s.isFile()) {
    const stem = basename(p, extname(p)).toLowerCase();
    for (const f of await readdir(base).catch(() => []))
      if (f.toLowerCase().startsWith(stem + '.') && SUB_EXT.has(extname(f).toLowerCase())) files.push({ p: join(base, f), size: 0 });
  }
  const byName = (a, b) => a.p.localeCompare(b.p, undefined, { numeric: true, sensitivity: 'base' });
  const vids = files.filter((f) => VIDEO.has(extname(f.p).toLowerCase())).sort(byName);
  const subs = files.filter((f) => SUB_EXT.has(extname(f.p).toLowerCase())).sort(byName);
  const rel = (f) => f.p.slice((s.isFile() ? resolve(h.dir) : p).length + 1);
  // A movie's sample clip would sort first; start on the biggest file unless it's a series.
  const total = vids.reduce((n, f) => n + f.size, 0);
  const biggest = vids.reduce((bi, f, i) => (f.size > vids[bi].size ? i : bi), 0);
  return {
    vids: vids.map((f) => ({ path: f.p, name: rel(f), size: f.size })),
    subs: subs.map((f) => ({ path: f.p, name: rel(f) })),
    start: vids.length && vids[biggest].size >= total * 0.6 ? biggest : 0,
  };
}
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg' };
async function streamFile(req, res, file) {
  const { size } = await stat(file);
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    else { start = Math.max(0, size - Number(m[2])); }
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    status = 206;
  }
  res.writeHead(status, {
    'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') { res.end(); return; }
  const rs = createReadStream(file, { start, end });
  rs.pipe(res); res.on('close', () => rs.destroy());
}
/* ASS/SSA → WebVTT, keeping where each line goes. Anime subtitles put signs, notes and a second
   speaker at the top or at an exact spot; ffmpeg's own conversion drops all of that and stacks
   everything at the bottom. Drawings (vector shapes) are skipped; styling beyond italics is dropped. */
function assToVtt(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let resX = 384, resY = 288, section = '', fmt = null, sfmt = null;
  const styles = {};
  const cues = [];
  const ts = (t) => { const m = /(\d+):(\d+):(\d+)[.:](\d+)/.exec(t); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]) : 0; };
  const vt = (s) => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(3).padStart(6, '0'); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x}`; };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { section = line.toLowerCase(); continue; }
    const kv = /^([^:]+):\s*(.*)$/.exec(line); if (!kv) continue;
    const key = kv[1].trim().toLowerCase(), val = kv[2];
    if (key === 'playresx') resX = +val || resX;
    else if (key === 'playresy') resY = +val || resY;
    else if (key === 'format' && section.includes('styles')) sfmt = val.split(',').map((x) => x.trim().toLowerCase());
    else if (key === 'format' && section.includes('events')) fmt = val.split(',').map((x) => x.trim().toLowerCase());
    else if (key === 'style' && sfmt) {
      const f = val.split(','), g = (n) => f[sfmt.indexOf(n)]?.trim();
      let an = +g('alignment') || 2;
      if (section.includes('v4 styles') && !section.includes('+')) an = { 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 }[an] || 2; // SSA numbering
      styles[g('name')] = { an, italic: g('italic') === '-1' || g('italic') === '1', marginV: +g('marginv') || 0, fs: +g('fontsize') || 0 };
    } else if (key === 'dialogue' && fmt) {
      const parts = val.split(','), textAt = fmt.indexOf('text');
      const f = (n) => parts[fmt.indexOf(n)]?.trim();
      const body = parts.slice(textAt).join(',');
      const st = styles[f('style')] || styles[Object.keys(styles)[0]] || { an: 2, italic: false, marginV: 0 };
      const tags = (body.match(/\{[^}]*\}/g) || []).join('');
      if (/\\p[1-9]/.test(tags)) continue; // a drawing, not text
      let an = st.an;
      const anM = /\\an([1-9])/.exec(tags) || null, aM = !anM && /\\a(\d+)/.exec(tags);
      if (anM) an = +anM[1]; else if (aM) an = { 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 }[+aM[1]] || an;
      const pos = /\\(?:pos|move)\(\s*([-\d.]+)\s*,\s*([-\d.]+)/.exec(tags);
      let italic = st.italic;
      // the text: tags out, \N new lines, \h hard spaces; italics where the line turns them on
      let out = '', it = italic;
      for (const seg of body.split(/(\{[^}]*\})/)) {
        if (seg.startsWith('{')) { const m = /\\i([01])(?![\d])/.exec(seg); if (m) { const on = m[1] === '1'; if (on !== it) { out += on ? '<i>' : '</i>'; it = on; } } continue; }
        out += seg.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      if (it) out += '</i>';
      if (italic) out = '<i>' + out;
      // no empty lines inside: in WebVTT an empty line ends the subtitle
      out = out.replace(/<i><\/i>/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.replace(/<\/?i>/g, '').trim()).join('\n').trim();
      if (!out.replace(/<\/?i>/g, '').trim()) continue;
      // where it goes
      // small print in the original (a quest window, a sign) stays smaller than the dialogue
      const fsM = /\\fs([\d.]+)/.exec(tags), small = !!(fsM && st.fs && +fsM[1] < st.fs * 0.7);
      if (small) out = `<c.sm>${out}</c>`;
      const nLines = out.split('\n').length, lineH = small ? 3.4 : 5.6; // one line ≈ 5.6% of the picture height
      const horiz = an % 3 === 1 ? 'start' : an % 3 === 0 ? 'end' : 'center';
      let set = '';
      if (pos) {
        const x = Math.min(100, Math.max(0, +pos[1] / resX * 100)), y = Math.min(100, Math.max(0, +pos[2] / resY * 100));
        const top = an >= 7 ? y : an >= 4 ? y - nLines * lineH / 2 : y - nLines * lineH;
        // keep the box inside the picture: as wide as there's room for on its side of the spot
        const room = horiz === 'start' ? 100 - x : horiz === 'end' ? x : 2 * Math.min(x, 100 - x);
        set = `line:${Math.min(92, Math.max(2, top)).toFixed(1)}% position:${x.toFixed(1)}% align:${horiz} size:${Math.max(20, Math.min(100, room)).toFixed(0)}%`;
      } else if (an >= 7) set = `line:4% align:${horiz}`;
      else if (an >= 4) set = `line:${(50 - nLines * lineH / 2).toFixed(1)}% align:${horiz}`;
      else {
        const mv = +f('marginv') || st.marginV;
        if (mv > resY * 0.1) set = `line:${Math.max(2, 100 - mv / resY * 100 - nLines * lineH).toFixed(1)}%`; // a style meant to sit higher
        if (horiz !== 'center') set += (set ? ' ' : '') + `align:${horiz}`;
      }
      cues.push({ s: ts(f('start')), e: ts(f('end')), set, out });
    }
  }
  cues.sort((a, b) => a.s - b.s);
  return 'WEBVTT\n\n' + cues.map((c) => `${vt(c.s)} --> ${vt(c.e)}${c.set ? ' ' + c.set : ''}\n${c.out}`).join('\n\n') + '\n';
}
function srtToVtt(text) {
  return 'WEBVTT\n\n' + text.replace(/^\uFEFF/, '').replace(/\r/g, '')
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
}

/* ---------- ffmpeg: phone-ready copies ---------- */
// Phones can't play MKV (and browsers never show subtitles built into a file), so
// a video gets repackaged once into an MP4 (video copied as is, audio as AAC) with
// its text subtitles extracted to .vtt files. Kept in ./phone, keyed by download+file.
function findTool(name) {
  const exe = WIN ? name + '.exe' : name, local = process.env.LOCALAPPDATA || '';
  if (process.env.FFMPEG_DIR && existsSync(join(process.env.FFMPEG_DIR, exe))) return join(process.env.FFMPEG_DIR, exe);
  for (const dir of (process.env.PATH || '').split(delimiter)) if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  if (!WIN) return null;
  const pk = join(local, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of readdirSync(pk).filter((d) => /^Gyan\.FFmpeg/i.test(d)))
      for (const sub of readdirSync(join(pk, d))) { const p = join(pk, d, sub, 'bin', exe); if (existsSync(p)) return p; }
  } catch {}
  return null;
}
const FFMPEG = findTool('ffmpeg'), FFPROBE = findTool('ffprobe');
const PHONE_DIR = join(root, 'phone');
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const PLAYABLE = new Set(['.mp4', '.m4v', '.webm', '.mov']);
const jobs = new Map(); // "<id>-<n>" -> { pct, started, error }
// a > 0: only audio track a; h: video turned into 720p H.264 (for players without HEVC, like an old TV web engine)
const phoneKey = (id, n, a = 0, h = 0) => `${id}-${n}` + (a > 0 ? `.a${a}` : '') + (h ? '.h264' : '');
async function phoneInfo(id, n) {
  try { return JSON.parse(await readFile(join(PHONE_DIR, phoneKey(id, n) + '.json'), 'utf8')); } catch { return null; }
}
async function phoneState(id, n, file, a = 0, h = 0) {
  if (a > 0 || h) { if (existsSync(join(PHONE_DIR, phoneKey(id, n, a, h) + '.mp4'))) return { state: 'ready' }; }
  else if (PLAYABLE.has(extname(file).toLowerCase())) return { state: 'direct' };
  else if (await phoneInfo(id, n)) return { state: 'ready' };
  if (!FFMPEG) return { state: 'unavailable' };
  const j = jobs.get(phoneKey(id, n, a, h));
  if (!j) return { state: 'none' };
  if (j.error) return { state: 'error', error: j.error };
  return { state: j.started ? 'working' : 'queued', pct: j.pct };
}
function probe(file) {
  return new Promise((ok, fail) => execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { windowsHide: true, maxBuffer: 20e6 }, (err, out) => (err ? fail(err) : ok(JSON.parse(out)))));
}
/* One conversion at a time (an old laptop shouldn't run several), in order of priority: what someone
   pressed play on (pri 1) goes before copies made in the background after a download (pri 0), and
   even stops a background one that's running; that one starts again afterwards. */
const waiting = []; // { k, file, job, a, h, pri, at }
let current = null;
function startPhone(id, n, file, a = 0, h = 0, pri = 1) {
  const k = phoneKey(id, n, a, h);
  const old = jobs.get(k);
  if (old && !old.error) {
    const w = waiting.find((x) => x.k === k);
    if (w && pri > w.pri) w.pri = pri;
    if (current?.k === k && pri > current.pri) current.pri = pri; // asked for while making it: no longer stoppable
    else if (w && pri > (current?.pri ?? 1)) bumpCurrent();
    return;
  }
  const job = { pct: 0, started: false };
  jobs.set(k, job);
  waiting.push({ k, file, job, a, h, pri, at: Date.now() });
  if (current && pri > current.pri) bumpCurrent();
  nextConvert();
}
function bumpCurrent() { // a background copy steps aside for one someone is waiting for
  if (!current || current.pri > 0 || !current.job.proc) return;
  current.job.requeue = true;
  try { current.job.proc.kill(); } catch {}
}
async function nextConvert() {
  if (current || !waiting.length) return;
  waiting.sort((x, y) => (y.pri - x.pri) || (x.at - y.at));
  const w = current = waiting.shift();
  try { await convert(w.file, w.k, w.job, w.a, w.h); jobs.delete(w.k); }
  catch (e) {
    if (w.job.requeue) { Object.assign(w.job, { pct: 0, started: false, requeue: false, proc: null }); waiting.push(w); console.log(`Paused a background copy for one someone is waiting for`); }
    else { w.job.error = e.message; console.log(`Phone version failed: ${e.message}`); }
  } finally { current = null; nextConvert(); }
}
// a > 0: a copy with only that audio track (browsers other than Safari can't switch tracks inside a file)
async function convert(file, k, job, a = 0, h = 0) {
  job.started = true;
  await mkdir(PHONE_DIR, { recursive: true });
  const info = await probe(file);
  const dur = Number(info.format?.duration) || 0;
  const v = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new Error('no video in this file');
  const allAuds = info.streams.filter((s) => s.codec_type === 'audio');
  if (a > 0 && !allAuds[a]) throw new Error('no such audio track');
  const auds = a > 0 || h ? [allAuds[a] || allAuds[0]].filter(Boolean) : allAuds;
  const subs = a > 0 || h ? [] : info.streams.filter((s) => s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name));
  const tmp = join(PHONE_DIR, k + '.part.mp4');
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-i', file, '-map', `0:${v.index}`];
  if (h && v.codec_name !== 'h264') args.push('-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'superfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1');
  else if (v.codec_name === 'h264') args.push('-c:v', 'copy');
  else if (v.codec_name === 'hevc') args.push('-c:v', 'copy', '-tag:v', 'hvc1'); // hvc1: what iPhones expect
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p');
  auds.forEach((a, i) => {
    args.push('-map', `0:${a.index}`);
    if (a.codec_name === 'aac') args.push(`-c:a:${i}`, 'copy');
    else args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, '192k', `-ac:a:${i}`, '2');
    args.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0');
  });
  args.push('-map_chapters', '-1', '-movflags', '+faststart', '-sn', '-dn', tmp);
  subs.forEach((s, i) => args.push('-map', `0:${s.index}`, '-c:s', 'webvtt', join(PHONE_DIR, `${k}.s${i}.vtt`)));
  await new Promise((ok, fail) => {
    const p = job.proc = spawn(FFMPEG, args, { windowsHide: true });
    let errTail = '';
    p.stdout.on('data', (c) => {
      const m = /out_time_us=(\d+)/.exec(String(c));
      if (m && dur) job.pct = Math.min(99, Math.round(Number(m[1]) / 1e6 / dur * 100));
    });
    p.stderr.on('data', (c) => { errTail = (errTail + c).slice(-600); });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(errTail.trim().split('\n').pop() || `ffmpeg exited ${code}`))));
  });
  await rename(tmp, join(PHONE_DIR, k + '.mp4'));
  if (a > 0 || h) { console.log(`${h ? 'H.264 copy' : 'Audio track ' + (a + 1)} ready: ${basename(file)}`); return; }
  const tag = (s) => s.tags || {};
  await writeFile(join(PHONE_DIR, k + '.json'), JSON.stringify({
    audio: auds.map((a) => ({ lang: tag(a).language || '', title: tag(a).title || '' })),
    subs: subs.map((s, i) => ({ file: `${k}.s${i}.vtt`, lang: tag(s).language || '', title: tag(s).title || '' })),
  }));
  console.log(`Phone version ready: ${basename(file)}`);
}
/* Preview frames for seeking with the remote: one frame every 10 s, 10x10 to a sheet, made once in
   the background (keyframes only, so even a long movie takes well under a minute). */
const THUMB_DIR = join(root, 'thumbs');
const THUMB_EVERY = 10;
const thumbJobs = new Map(); // key -> 'working' | error message
let thumbQueue = Promise.resolve();
async function thumbInfo(k) {
  try { return JSON.parse(await readFile(join(THUMB_DIR, k + '.json'), 'utf8')); } catch { return null; }
}
function startThumbs(k, file) {
  if (thumbJobs.has(k) || !FFMPEG) return;
  thumbJobs.set(k, 'working');
  thumbQueue = thumbQueue.then(() => makeThumbs(k, file)).then(() => thumbJobs.delete(k),
    (e) => { thumbJobs.set(k, e.message); console.log(`Seek previews failed: ${e.message}`); });
}
async function makeThumbs(k, file) {
  await mkdir(THUMB_DIR, { recursive: true });
  await new Promise((ok, fail) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-skip_frame', 'nokey', '-i', file, '-an', '-sn', '-dn',
      '-vf', `fps=1/${THUMB_EVERY},scale=240:-2,tile=10x10`, '-fps_mode', 'vfr', '-q:v', '7', join(THUMB_DIR, `${k}-%03d.jpg`)], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (c) => { err = (err + c).slice(-400); });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`))));
  });
  const sheets = (await readdir(THUMB_DIR)).filter((f) => f.startsWith(k + '-') && f.endsWith('.jpg')).length;
  await writeFile(join(THUMB_DIR, k + '.json'), JSON.stringify({ every: THUMB_EVERY, cols: 10, rows: 10, sheets }));
}

// The video codec of a file ("h264", "hevc"...), asked once per file.
const vcodecCache = new Map();
function vcodecOf(path) {
  if (!FFPROBE) return Promise.resolve('');
  if (!vcodecCache.has(path)) vcodecCache.set(path, new Promise((ok) => execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path],
    { windowsHide: true, timeout: 15000 }, (err, out) => ok(err ? '' : String(out).trim().split(/\s/)[0]))));
  return vcodecCache.get(path);
}
// The audio tracks of a video (language, title), asked once per file.
const audioCache = new Map();
async function audioOf(path) {
  if (!FFPROBE) return [];
  const key = path + ':' + ((await stat(path).catch(() => null))?.mtimeMs || 0);
  if (!audioCache.has(key)) audioCache.set(key, new Promise((ok) => execFile(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-print_format', 'json', '-show_streams', path],
    { windowsHide: true, timeout: 15000, maxBuffer: 5e6 }, (err, out) => {
      try { ok(JSON.parse(out).streams.map((x) => ({ lang: x.tags?.language || '', title: x.tags?.title || '', ch: x.channels || 0 }))); } catch { ok([]); }
    })));
  return audioCache.get(key);
}
// Chapters (start/end/title) of a video: many TV and anime files mark the opening and the credits.
const chapterCache = new Map();
async function chaptersOf(path) {
  if (!FFPROBE) return [];
  const key = path + ":" + ((await stat(path).catch(() => null))?.mtimeMs || 0);
  if (!chapterCache.has(key)) chapterCache.set(key, new Promise((ok) => execFile(FFPROBE, ["-v", "error", "-print_format", "json", "-show_chapters", path],
    { windowsHide: true, timeout: 15000 }, (err, out) => {
      try { ok(JSON.parse(out).chapters.map((c) => ({ start: Number(c.start_time), end: Number(c.end_time), title: String(c.tags?.title || "") }))); } catch { ok([]); }
    })));
  return chapterCache.get(key);
}
async function removePhoneFiles(id) {
  for (const f of await readdir(PHONE_DIR).catch(() => [])) if (f.startsWith(id + '-')) await rm(join(PHONE_DIR, f), { force: true }).catch(() => {});
}

/* ---------- subtitle files: decoding, conversion, zip ---------- */
// Old subtitle files often aren't UTF-8 (Turkish ones are usually Windows-1254).
const CODEPAGE = { tr: 'windows-1254', ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', ar: 'windows-1256', fa: 'windows-1256',
  el: 'windows-1253', he: 'windows-1255', pl: 'windows-1250', cs: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250' };
function decodeText(buf, lang = '') {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, ''); } catch {}
  try { return new TextDecoder(CODEPAGE[lang.toLowerCase()] || 'windows-1252').decode(buf); } catch { return buf.toString('latin1'); }
}
function langOfFile(path) {
  const code = /\.([a-z]{2,3})\d*\.(srt|vtt|ass|ssa)$/i.exec(path)?.[1];
  if (code) return code.toLowerCase();
  // "Subs/English.srt", "2_Turkish.srt": a language name instead of a code.
  const word = basename(path, extname(path)).toLowerCase().split(/[^a-z]+/).filter(Boolean).pop() || '';
  return Object.entries(LANG_NAMES).find(([c, n]) => c.length === 2 && n.toLowerCase() === word)?.[0] || '';
}
const LANG_NAMES = { en: 'English', eng: 'English', tr: 'Turkish', tur: 'Turkish', ja: 'Japanese', jpn: 'Japanese', fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', es: 'Spanish', spa: 'Spanish', pt: 'Portuguese', por: 'Portuguese',
  ru: 'Russian', rus: 'Russian', ar: 'Arabic', ara: 'Arabic', ko: 'Korean', kor: 'Korean', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese',
  nl: 'Dutch', dut: 'Dutch', pl: 'Polish', pol: 'Polish', sv: 'Swedish', swe: 'Swedish', el: 'Greek', gre: 'Greek', he: 'Hebrew', heb: 'Hebrew' };
// Every subtitle a download has: files beside or inside it (from the torrent or from
// SubDL), plus the ones built into each video once its phone version exists.
async function subsOf(id, media) {
  const out = [];
  for (const s of media.subs) {
    const lang = langOfFile(s.path);
    const vi = media.vids.findIndex((v) => basename(s.path).toLowerCase().startsWith(basename(v.path, extname(v.path)).toLowerCase() + '.'));
    out.push({ path: s.path, lang, label: LANG_NAMES[lang] ? `${LANG_NAMES[lang]} (file)` : basename(s.path), video: vi >= 0 ? vi : null, builtin: false });
  }
  for (let i = 0; i < media.vids.length; i++) {
    for (const [si, s] of ((await phoneInfo(id, i))?.subs || []).entries()) {
      out.push({ path: join(PHONE_DIR, s.file), lang: s.lang, label: `${s.title || LANG_NAMES[s.lang] || s.lang || 'Subtitle'} (built in)`, video: i, si, builtin: true });
    }
  }
  return out;
}
async function subtitleAsVtt(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.ass' || ext === '.ssa') return assToVtt(decodeText(await readFile(path), langOfFile(path)));
  const text = decodeText(await readFile(path), langOfFile(path));
  return ext === '.vtt' ? text : srtToVtt(text);
}
// A built-in subtitle: from its original ASS form when it has one (positions kept), else the .vtt
// made with the phone version.
async function subtitleFor(id, media, sub) {
  if (sub.builtin) {
    const ass = await builtinAss(id, sub.video, media.vids[sub.video]?.path).catch((e) => { console.log(`Subtitle extract failed: ${e.message}`); return null; });
    const f = ass?.[sub.si];
    if (f) return assToVtt(await readFile(f, 'utf8'));
  }
  return subtitleAsVtt(sub.path);
}
// The ASS subtitles built into video n, copied out once, all in one pass over the file.
const assJobs = new Map();
function builtinAss(id, n, file) {
  const k = phoneKey(id, n), list = join(PHONE_DIR, `${k}.ass.json`);
  if (!assJobs.has(k)) assJobs.set(k, (async () => {
    if (existsSync(list)) return JSON.parse(await readFile(list, 'utf8'));
    if (!FFMPEG || !file) return [];
    const info = await probe(file);
    const subs = info.streams.filter((x) => x.codec_type === 'subtitle' && TEXT_SUBS.has(x.codec_name)); // the same list as the phone version's
    const out = subs.map((x, i) => (['ass', 'ssa'].includes(x.codec_name) ? join(PHONE_DIR, `${k}.s${i}.ass`) : null));
    const args = ['-v', 'error', '-y', '-i', file];
    subs.forEach((x, i) => { if (out[i]) args.push('-map', `0:${x.index}`, '-c:s', 'copy', out[i]); });
    if (out.some(Boolean)) await new Promise((ok, fail) => execFile(FFMPEG, args, { windowsHide: true }, (e) => (e ? fail(e) : ok())));
    await mkdir(PHONE_DIR, { recursive: true });
    await writeFile(list, JSON.stringify(out));
    return out;
  })().finally(() => setTimeout(() => assJobs.delete(k), 60000)));
  return assJobs.get(k);
}
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('the subtitle download is not a valid zip');
  const out = [];
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
    const raw = buf.subarray(start, start + csize);
    if (!name.endsWith('/') && (method === 0 || method === 8)) out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
function parseSE(name) {
  let m = /\bS(\d{1,2})[ ._-]?E(\d{1,3})\b/i.exec(name) || /\b(\d{1,2})x(\d{2})\b/.exec(name);
  if (m) return { season: +m[1], episode: +m[2] };
  const abs = /\s-\s(\d{1,3})(?:v\d)?(?=\s|\[|\(|\.|$)/.exec(name);
  m = /\bS(\d{1,2})(?!\d|[ ._-]?E\d)/i.exec(name);
  if (m) return { season: +m[1], episode: abs ? +abs[1] : null };
  return abs ? { season: 1, episode: +abs[1] } : null;
}

/* ---------- settings (SubDL key) ---------- */
const SETTINGS_FILE = join(root, 'settings.json');
let settings = {};
try { settings = JSON.parse(await readFile(SETTINGS_FILE, 'utf8')); } catch {}
const saveSettings = () => writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2)).catch(() => {});
const autoSubLangs = () => (Array.isArray(settings.autoSubLangs) ? settings.autoSubLangs : ['TR', 'EN']);
const settingsOut = () => ({ tmdbKey: settings.tmdbKey || '', subdl: !!settings.subdlKey, ffmpeg: !!FFMPEG, autoSubs: settings.autoSubs !== false, autoSubLangs: autoSubLangs(), autoNextOff: settings.autoNextOff || [], desktop: WIN });

/* ---------- watch progress: per profile, "<download id>:<video n>" -> { t: seconds in, d: duration, w: watched, at } (auth.mjs) ---------- */
const { watchOf, dropProgress } = auth;
// How many videos each finished download has (walking the folder once).
const vidCount = new Map();
async function countVids(h) {
  if (!vidCount.has(h.id)) { const m = await mediaOf(h); if (!m) return 0; vidCount.set(h.id, m.vids.length); }
  return vidCount.get(h.id);
}

/* ---------- SubDL ---------- */
const L2 = { eng: 'en', tur: 'tr', jpn: 'ja', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', spa: 'es', por: 'pt', rus: 'ru', ara: 'ar',
  kor: 'ko', chi: 'zh', zho: 'zh', dut: 'nl', nld: 'nl', pol: 'pl', swe: 'sv', gre: 'el', ell: 'el', heb: 'he' };
const lang2 = (c) => { c = String(c || '').toLowerCase(); return L2[c] || c.slice(0, 2); };
async function subdlSearch(h, media, n, langs) {
  const v = media.vids[n];
  const m = meta[h.id] || {}, item = m.item;
  const se = (item?.type === 'tv' && m.season != null && m.episode != null) ? { season: m.season, episode: m.episode } : parseSE(v.name);
  const q = new URLSearchParams({ api_key: settings.subdlKey, subs_per_page: '30', unpack: '1', client: 'custom_integration',
    languages: String(langs || 'EN').toUpperCase().replace(/[^A-Z_,]/g, '') });
  if (item) { q.set('tmdb_id', String(item.id)); q.set('type', item.type); }
  else q.set('film_name', basename(v.name, extname(v.name)).replace(/[._]/g, ' ').replace(/\[[^\]]*\]/g, ' ').split(/\b(19|20)\d\d\b|\bS\d\d/i)[0].trim());
  if ((item?.type === 'tv' || (!item && se)) && se) { q.set('type', 'tv'); q.set('season_number', String(se.season)); if (se.episode != null) q.set('episode_number', String(se.episode)); }
  const r = await fetch('https://api.subdl.com/api/v1/subtitles?' + q, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!j.status) return { results: [], note: j.error || `SubDL error ${r.status}` };
  const results = [], bare = (x) => String(x || '').split('?')[0]; // links carry ?api_key=: keep the key on this PC
  for (const s of j.subtitles || []) {
    const lang = String(s.language || s.lang || '').toUpperCase();
    const files = (s.unpack_files || []).filter((f) => se?.episode == null || f.episode == null || f.episode === se.episode);
    if (files.length) for (const f of files) results.push({ url: bare(f.url), name: f.name, release: f.release_name || s.release_name || '', lang: String(f.language || lang).toUpperCase(), hi: !!(f.hi ?? s.hi), pack: !!s.full_season });
    else results.push({ url: bare(s.url), name: s.name || '', release: s.release_name || '', lang, hi: !!s.hi, pack: !!s.full_season });
  }
  return { results, title: j.results?.[0]?.name || '', season: se?.season ?? null, episode: se?.episode ?? null };
}
// Fetch one SubDL subtitle and save it beside the video as "<video>.<lang>.srt", where VLC finds it too.
async function subdlSave(h, v, b) {
  const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
  if (!/^\/subtitle\/[A-Za-z0-9_\-./]+$/.test(String(b.url)) || String(b.url).includes('..')) fail(400, 'bad subtitle link');
  const r = await fetch('https://dl.subdl.com' + b.url + '?api_key=' + encodeURIComponent(settings.subdlKey || ''), { signal: AbortSignal.timeout(30000) });
  if (!r.ok) fail(502, `SubDL download failed (${r.status})`);
  let buf = Buffer.from(await r.arrayBuffer()), ext = extname(String(b.name || b.url)).toLowerCase();
  if (buf.subarray(0, 2).toString() === 'PK') {
    const entries = unzip(buf).filter((e) => SUB_EXT.has(extname(e.name).toLowerCase()));
    if (!entries.length) fail(422, 'no subtitle file inside the download');
    const se = parseSE(v.name), tag = se?.episode != null ? `E${String(se.episode).padStart(2, '0')}` : '';
    const pick = (tag && entries.find((e) => e.name.toUpperCase().includes(tag))) || entries.sort((a, c) => c.data.length - a.data.length)[0];
    buf = pick.data; ext = extname(pick.name).toLowerCase();
  }
  if (!SUB_EXT.has(ext)) ext = '.srt';
  const lang = String(b.lang || 'xx').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3) || 'xx';
  const text = decodeText(buf, lang);
  const stem = v.path.slice(0, -extname(v.path).length);
  let dest = `${stem}.${lang}${ext}`; // a second one in the same language becomes .tr2.srt
  for (let k = 2; existsSync(dest); k++) dest = `${stem}.${lang}${k}${ext}`;
  if (!resolve(dest).startsWith(resolve(h.dir) + sep)) fail(400, 'unsafe path');
  await writeFile(dest, '﻿' + text, 'utf8');
  console.log(`Subtitle saved: ${basename(dest)}`);
  return basename(dest);
}
// The subtitle whose release name shares the most with the video's file name
// (same group, source and quality usually means the timing matches).
function bestSub(list, videoName) {
  const words = new Set(videoName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
  const score = (x) => (x.release + ' ' + x.name).toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length - (x.hi ? 1.5 : 0) - (x.pack ? 0.5 : 0);
  return list.reduce((best, x) => (!best || score(x) > score(best) ? x : best), null);
}
// Subtitles languages a video already has, built in or as files beside it.
async function subLangsOf(h, media, n) {
  const have = new Set();
  for (const s of media.subs) {
    const own = basename(s.path).toLowerCase().startsWith(basename(media.vids[n].path, extname(media.vids[n].path)).toLowerCase() + '.');
    if (own || media.vids.length === 1) have.add(lang2(langOfFile(s.path)));
  }
  if (FFPROBE) {
    const info = await probe(media.vids[n].path).catch(() => null);
    for (const s of info?.streams || [])
      if (s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name) && !/sign|song/i.test(s.tags?.title || '')) have.add(lang2(s.tags?.language));
  }
  return have;
}
// Fetch the best subtitle in each wanted language the videos don't have yet.
async function autoSubs(h) {
  if (!settings.subdlKey) return { got: 0, note: 'no SubDL key' };
  const want = autoSubLangs();
  const media = await mediaOf(h);
  if (!media || !want.length) return { got: 0 };
  let got = 0;
  for (const [n, v] of media.vids.slice(0, 40).entries()) {
    if (media.vids.length > 1 && v.size < 40e6) continue; // samples and extras
    const have = await subLangsOf(h, media, n);
    const missing = want.filter((l) => !have.has(l.toLowerCase()));
    if (!missing.length) continue;
    const r = await subdlSearch(h, media, n, missing.join(','));
    if (r.note) return { got, note: r.note };
    for (const L of missing) {
      const best = bestSub(r.results.filter((x) => x.lang === L), v.name);
      if (!best) continue;
      try { await subdlSave(h, v, { url: best.url, lang: L, name: best.name }); got++; } catch (e) { console.log(`Auto subtitle failed: ${e.message}`); }
      await new Promise((ok) => setTimeout(ok, 700)); // go easy on SubDL
    }
  }
  if (got) console.log(`Auto subtitles: ${got} added for ${h.name}`);
  return { got };
}
let subsChain = Promise.resolve();
const queueAutoSubs = (h) => (subsChain = subsChain.then(() => autoSubs(h)).catch((e) => ({ got: 0, note: e.message })));

const DL_DIR = process.env.CATALOG_DOWNLOAD_DIR || join(os.homedir(), 'Downloads', 'torlink');
const BIN_DIR = process.env.CATALOG_BIN_DIR || join(DL_DIR, '.catalog-bin');
const BIN_DAYS = 7;
async function emptyOldBin() {
  if (WIN) return;
  for (const d of await readdir(BIN_DIR).catch(() => [])) {
    if (Date.now() - Number(d) > BIN_DAYS * 864e5) await rm(join(BIN_DIR, d), { recursive: true, force: true }).catch(() => {});
  }
}
setTimeout(emptyOldBin, 60e3); setInterval(emptyOldBin, 6 * 3600e3);
// Move a finished download's files to the Recycle Bin (recoverable), not a hard delete.
function recycle(p) {
  // Elsewhere (the Linux server): the catalog's own bin on the same drive, emptied after 7 days
  if (!WIN) return (async () => {
    if (!existsSync(p)) return;
    const into = join(BIN_DIR, String(Date.now()));
    await mkdir(into, { recursive: true });
    await rename(p, join(into, basename(p)));
  })();
  return new Promise((ok, fail) => {
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:CATALOG_RECYCLE; " +
      "if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } " +
      "elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 60000, env: { ...process.env, CATALOG_RECYCLE: p } },
      (err, _out, errOut) => (err ? fail(new Error((errOut || err.message).trim().split('\n')[0])) : ok()));
  });
}

// Opening on the server's own screen: only meaningful when it runs on the PC you sit at.
function openPath(p) { if (WIN) execFile('explorer.exe', [p]); }
function showInFolder(p) { if (WIN) spawn('explorer.exe', [`/select,"${p}"`], { windowsVerbatimArguments: true }); }

// Watch for downloads that should open by themselves when they finish.
// Downloads that finished before auto subtitles existed don't get them retroactively.
for (const x of await history()) if (meta[x.id] && meta[x.id].subsTried === undefined) meta[x.id].subsTried = true;
setInterval(async () => {
  const pending = Object.entries(meta).filter(([, m]) => m.autoOpen && !m.opened);
  const needSubs = Object.entries(meta).filter(([, m]) => !m.subsTried);
  if (!pending.length && !needSubs.length) return;
  const h = await history();
  for (const [id, m] of pending) {
    const done = h.find((x) => x.id === id);
    if (!done) continue;
    const t = await target(done);
    m.opened = true; saveMeta();
    if (t) { console.log(`Finished: ${done.name}, opening ${t.open}`); openPath(t.open); }
  }
  // When a download finishes, fetch subtitles for it (if that's switched on).
  for (const [id, m] of needSubs) {
    const done = h.find((x) => x.id === id);
    if (!done) continue;
    m.subsTried = true; saveMeta();
    if (settings.autoSubs !== false && settings.subdlKey) queueAutoSubs(done);
  }
}, 3000);

/* ---------- download guard: films, episodes and their subtitles only ---------- */
// A torrent can carry a program next to (or instead of) the video. torlink saves a torrent's
// .torrent file as soon as it has the file list, before the data comes: if that list holds
// anything that can run, or no video at all, the torrent is stopped and its files deleted.
// When a download finishes, every file that isn't video, subtitles or a harmless extra goes.
const KEEP_EXT = new Set([...VIDEO, ...SUB_EXT, '.sub', '.idx', '.sup', '.jpg', '.jpeg', '.png', '.webp', '.nfo', '.txt']);
const RUNNABLE_EXT = new Set(['.exe', '.msi', '.msp', '.msix', '.appx', '.bat', '.cmd', '.com', '.scr', '.pif', '.cpl', '.lnk', '.url', '.vbs', '.vbe',
  '.js', '.jse', '.mjs', '.wsf', '.wsh', '.ps1', '.psm1', '.hta', '.jar', '.apk', '.xapk', '.appimage', '.sh', '.run', '.dll', '.sys', '.reg',
  '.desktop', '.app', '.dmg', '.pkg', '.deb', '.rpm', '.py', '.pl', '.elf', '.out', '.inf', '.gadget', '.application', '.scf', '.ocx', '.drv']);
const TORRENT_DIR = join(DATA_DIR, 'torrents');
const blockedLog = []; // { title, reason, at } shown in the downloads drawer

// The smallest bencode reader that gets a torrent's file names out (strings stay bytes).
function bdecode(buf) {
  let i = 0;
  const next = () => {
    const c = buf[i];
    if (c === 0x69) { const e = buf.indexOf(0x65, i); const n = Number(buf.toString('latin1', i + 1, e)); i = e + 1; return n; } // i...e
    if (c === 0x6c) { i++; const l = []; while (buf[i] !== 0x65) l.push(next()); i++; return l; } // l...e
    if (c === 0x64) { i++; const d = {}; while (buf[i] !== 0x65) { const k = next().toString('latin1'); d[k] = next(); } i++; return d; } // d...e
    const colon = buf.indexOf(0x3a, i); const len = Number(buf.toString('latin1', i, colon)); // <len>:<bytes>
    if (!Number.isFinite(len) || colon < 0) throw new Error('bad torrent');
    const s = buf.subarray(colon + 1, colon + 1 + len); i = colon + 1 + len; return s;
  };
  return next();
}
function torrentFiles(file) {
  const t = bdecode(readFileSync(file)), info = t.info || {};
  const str = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? ''));
  const name = str(info['name.utf-8'] || info.name);
  const files = Array.isArray(info.files)
    ? info.files.map((f) => [name, ...(f['path.utf-8'] || f.path || []).map(str)].join('/'))
    : [name];
  return { name, files };
}
const extOf = (f) => extname(f.replace(/[\s.]+$/, '')).toLowerCase(); // "film.exe " and "film.exe." count as .exe
function verdict(files) {
  const runnable = files.filter((f) => RUNNABLE_EXT.has(extOf(f)));
  if (runnable.length) return `it contains a program or script (${basename(runnable[0])})`;
  if (!files.some((f) => VIDEO.has(extOf(f)))) return 'it has no video in it';
  return null;
}
const guarded = new Set(), cleaned = new Set(); // checked this run
let guardBusy = false;
setInterval(async () => {
  if (guardBusy || !(await torHealthy())) return;
  guardBusy = true;
  try {
    let live = [];
    try { live = (await tor('/downloads')).downloads || []; } catch { return; }
    for (const d of live) {
      if (guarded.has(d.id)) continue;
      const file = join(TORRENT_DIR, d.id + '.torrent');
      if (!existsSync(file)) continue; // no file list yet
      guarded.add(d.id);
      let list;
      try { list = torrentFiles(file); } catch (e) { console.log(`Guard: can't read ${d.id}: ${e.message}`); continue; }
      const why = verdict(list.files);
      if (!why) continue;
      const title = meta[d.id]?.title || list.name || d.name;
      console.log(`Guard: refused "${title}": ${why}`);
      await tor('/control', { id: d.id, action: 'delete' }).catch(() => tor('/control', { id: d.id, action: 'remove' }).catch(() => {}));
      // and the files themselves, in case anything arrived already
      const base = resolve(DL_DIR), p = resolve(DL_DIR, basename(list.name || ''));
      if (list.name && p.startsWith(base + sep)) await rm(p, { recursive: true, force: true }).catch(() => {});
      blockedLog.unshift({ title, reason: why, at: Date.now() }); blockedLog.length = Math.min(blockedLog.length, 20);
      delete meta[d.id]; saveMeta();
    }
    // finished downloads: drop whatever isn't video, subtitles or a harmless extra
    for (const h of await history()) {
      if (cleaned.has(h.id)) continue;
      cleaned.add(h.id);
      const base = resolve(h.dir), root = resolve(h.dir, basename(String(h.name).trim()));
      if (!root.startsWith(base + sep) || !existsSync(root)) continue;
      const st = await stat(root).catch(() => null);
      const extra = st?.isDirectory() ? (await walk(root)).map((f) => f.p).filter((f) => !KEEP_EXT.has(extOf(f))) : [];
      prepare(h).catch((e) => console.log(`Prepare failed: ${e.message}`));
      if (extra.length) {
        await tor('/control', { id: h.id, action: 'stop-seed' }).catch(() => {}); // don't share (or fetch back) what's removed
        for (const f of extra) await rm(f, { force: true }).catch(() => {});
        console.log(`Guard: removed ${extra.length} extra file(s) from ${h.name}: ${extra.slice(0, 5).map((f) => basename(f)).join(', ')}`);
      }
    }
  } finally { guardBusy = false; }
}, 3000);

// Make a finished download ready to play anywhere before anyone asks: the MP4 copy phones need and the
// seek previews, quietly, one at a time behind whatever someone is actually waiting for.
async function prepare(h) {
  if (!FFMPEG) return;
  const media = await mediaOf(h);
  if (!media) return;
  for (const [i, v] of media.vids.entries()) {
    if (media.vids.length > 1 && v.size < 40e6) continue; // samples and extras
    if ((await phoneState(h.id, i, v.path)).state === 'none') startPhone(h.id, i, v.path, 0, 0, 0);
    const tk = phoneKey(h.id, i);
    if (!(await thumbInfo(tk))) startThumbs(tk, v.path);
  }
}

/* ---------- play while downloading ---------- */
// A download that is still coming can be watched. Moonvies reads the video piece by piece and uses
// a piece only once its checksum matches the torrent's, so half-written data never reaches the
// player; ffmpeg turns that into an HLS stream that grows with the download. WebTorrent (torlink's
// engine) fetches pieces in order, so the start of a video is there early.
const LIVE_DIR = join(PHONE_DIR, 'live');
function torrentLayout(id) {
  const file = join(TORRENT_DIR, id + '.torrent');
  if (!existsSync(file)) return null;
  const info = bdecode(readFileSync(file)).info || {};
  const str = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? ''));
  const name = str(info['name.utf-8'] || info.name), base = resolve(DL_DIR);
  const files = []; let off = 0;
  const list = Array.isArray(info.files) ? info.files.map((f) => ({ parts: [name, ...(f['path.utf-8'] || f.path || []).map(str)], length: f.length }))
    : [{ parts: [name], length: info.length }];
  for (const f of list) {
    const path = resolve(base, ...f.parts);
    if (!path.startsWith(base + sep) || f.parts.some((x) => x === '..')) return null; // a name trying to leave the folder
    files.push({ rel: f.parts.slice(Array.isArray(info.files) ? 1 : 0).join('/'), path, start: off, length: f.length });
    off += f.length;
  }
  return { name, pieceLen: info['piece length'], hashes: info.pieces, files, total: off, folder: Array.isArray(info.files) ? resolve(base, name) : null };
}
// every piece of a (small) file checked: a subtitle file in the torrent is usable
async function fileComplete(L, f) {
  if (!f.length) return true;
  for (let p = Math.floor(f.start / L.pieceLen); p <= Math.floor((f.start + f.length - 1) / L.pieceLen); p++) {
    const ps = p * L.pieceLen, pe = Math.min(ps + L.pieceLen, L.total);
    if (!pieceOk(L, p, await readGlobal(L, ps, pe - ps))) return false;
  }
  return true;
}
// A download that's still coming, in the shape mediaOf gives a finished one: its videos, and the
// subtitle files that are usable (complete ones from the torrent, and ones added beside it).
async function liveMediaOf(id) {
  const L = torrentLayout(id);
  if (!L) return null;
  const vids = liveVids(L);
  if (!vids.length) return null;
  const subs = [], inTorrent = new Set(L.files.map((f) => f.path));
  for (const f of L.files) if (SUB_EXT.has(extOf(f.rel)) && await fileComplete(L, f)) subs.push({ path: f.path, name: f.rel });
  if (L.folder) { for (const f of await walk(L.folder)) if (SUB_EXT.has(extOf(f.p)) && !inTorrent.has(f.p)) subs.push({ path: f.p, name: f.p.slice(L.folder.length + 1) }); }
  else {
    const stem = basename(L.files[0].path, extname(L.files[0].path)).toLowerCase();
    for (const f of await readdir(DL_DIR).catch(() => []))
      if (f.toLowerCase().startsWith(stem + '.') && SUB_EXT.has(extOf(f))) subs.push({ path: join(DL_DIR, f), name: f });
  }
  const total = vids.reduce((n, f) => n + f.length, 0);
  const biggest = vids.reduce((bi, f, i) => (f.length > vids[bi].length ? i : bi), 0);
  return { L, vids: vids.map((f) => ({ path: f.path, name: f.rel, size: f.length })), subs, start: vids[biggest].length >= total * 0.6 ? biggest : 0 };
}
const headCache = new Map(); // path -> { at, info }: the start of a growing file, asked at most every 30 s
async function headOf(path) {
  const c = headCache.get(path);
  if (c && Date.now() - c.at < 30e3) return c.info;
  const info = existsSync(path) ? await probeHead(path) : null;
  headCache.set(path, { at: Date.now(), info });
  return info;
}
// Subtitles of a download that's still coming: files, plus the ones built into each video
// (the stream copies those out as it goes).
async function liveSubs(id, media) {
  const out = [];
  for (const sb of media.subs) {
    const lang = langOfFile(sb.path);
    const vi = media.vids.findIndex((v) => basename(sb.path).toLowerCase().startsWith(basename(v.path, extname(v.path)).toLowerCase() + '.'));
    out.push({ path: sb.path, lang, label: LANG_NAMES[lang] ? `${LANG_NAMES[lang]} (file)` : basename(sb.path), video: vi >= 0 ? vi : null, builtin: false });
  }
  for (const [i, v] of media.vids.entries()) {
    const text = ((await headOf(v.path))?.streams || []).filter((x) => x.codec_type === 'subtitle' && TEXT_SUBS.has(x.codec_name));
    text.forEach((x, si) => out.push({ lang: x.tags?.language || '', label: `${x.tags?.title || LANG_NAMES[x.tags?.language] || x.tags?.language || 'Subtitle'} (built in)`,
      video: i, si, builtin: true, ass: ['ass', 'ssa'].includes(x.codec_name) }));
  }
  return out;
}
// the videos of a torrent, in the order a finished download lists them (so progress keys match)
const liveVids = (L) => L.files.filter((f) => VIDEO.has(extOf(f.rel)))
  .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
// bytes [g, g+len) of the torrent, across its files; null when any part isn't on the disk yet
async function readGlobal(L, g, len) {
  const out = Buffer.alloc(len);
  for (const f of L.files) {
    const a = Math.max(g, f.start), b = Math.min(g + len, f.start + f.length);
    if (a >= b) continue;
    const fh = await openFile(f.path, 'r').catch(() => null);
    if (!fh) return null;
    try { const { bytesRead } = await fh.read(out, a - g, b - a, a - f.start); if (bytesRead < b - a) return null; }
    finally { await fh.close(); }
  }
  return out;
}
const pieceOk = (L, p, buf) => buf && createHash('sha1').update(buf).digest().equals(L.hashes.subarray(p * 20, p * 20 + 20));
// how much of a video is there, counted in whole checked pieces from its start (stops at `enough`)
async function readyBytes(L, f, enough = Infinity) {
  let g = f.start; const end = Math.min(f.start + f.length, f.start + enough);
  while (g < end) {
    const p = Math.floor(g / L.pieceLen), ps = p * L.pieceLen, pe = Math.min(ps + L.pieceLen, L.total);
    if (!pieceOk(L, p, await readGlobal(L, ps, pe - ps))) break;
    g = pe;
  }
  return Math.min(g, end) - f.start;
}

const liveSessions = new Map(); // key -> { id, dir, proc, stopped, lastHit, error, fed, length }
async function feedLive(L, f, s) {
  let g = f.start; const end = f.start + f.length;
  try {
    while (g < end && !s.stopped) {
      const p = Math.floor(g / L.pieceLen), ps = p * L.pieceLen, pe = Math.min(ps + L.pieceLen, L.total);
      const buf = await readGlobal(L, ps, pe - ps);
      if (!pieceOk(L, p, buf)) { await sleep(1500); continue; } // not downloaded yet
      const chunk = buf.subarray(g - ps, Math.min(end, pe) - ps);
      if (!s.proc.stdin.write(chunk)) await new Promise((r) => {
        const done = () => { s.proc.stdin.off('drain', done); s.proc.off('close', done); r(); };
        s.proc.stdin.on('drain', done); s.proc.on('close', done);
      });
      g = ps + (Math.min(end, pe) - ps); s.fed = g - f.start;
    }
  } catch (e) { if (!s.stopped) s.error = e.message; }
  try { s.proc.stdin.end(); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function probeHead(path) {
  return new Promise((ok) => execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], { windowsHide: true, timeout: 15000, maxBuffer: 5e6 },
    (err, out) => { try { ok(err ? null : JSON.parse(out)); } catch { ok(null); } }));
}
const liveStarting = new Map(); // key -> promise of a session being set up
function startLive(id, n, a, h) {
  const k = phoneKey(id, n, a, h);
  const s = liveSessions.get(k);
  if (s && !s.error) { s.lastHit = Date.now(); return s; }
  if (!liveStarting.has(k)) liveStarting.set(k, startLiveNow(id, n, a, h, k).finally(() => liveStarting.delete(k)));
  return liveStarting.get(k);
}
async function startLiveNow(id, n, a, h, k) {
  let s;
  const L = torrentLayout(id);
  if (!L) return { state: 'waiting' };
  const f = liveVids(L)[n];
  if (!f) throw Object.assign(new Error('no such video'), { status: 404 });
  // the file's header has to be here (and checked) before ffmpeg can make sense of it
  const need = Math.min(f.length, 4 * L.pieceLen, 16 << 20);
  if ((await readyBytes(L, f, need)) < need) return { state: 'waiting' };
  const info = await probeHead(f.path);
  const v = info?.streams?.find((x) => x.codec_type === 'video');
  if (!v) return { state: 'waiting' };
  const dir = join(LIVE_DIR, k);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
  const video = h && v.codec_name !== 'h264'
    ? ['-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'superfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-g', '96', '-keyint_min', '96', '-sc_threshold', '0']
    : ['-c:v', 'copy', ...(v.codec_name === 'hevc' ? ['-tag:v', 'hvc1'] : [])];
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-fflags', '+genpts', '-i', 'pipe:0', '-map', '0:v:0', '-map', `0:a:${a}?`, ...video,
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-sn', '-dn', '-map_chapters', '-1',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 's%05d.m4s'), join(dir, 'index.m3u8')];
  // and the text subtitles built into it, as they come (ASS kept as ASS for its positions)
  info.streams.filter((x) => x.codec_type === 'subtitle' && TEXT_SUBS.has(x.codec_name)).forEach((x, si) => {
    const ass = ['ass', 'ssa'].includes(x.codec_name);
    args.push('-map', `0:${x.index}`, '-c:s', ass ? 'copy' : 'webvtt', '-f', ass ? 'ass' : 'webvtt', '-flush_packets', '1', join(dir, `sub${si}.${ass ? 'ass' : 'vtt'}`));
  });
  s = { id, dir, stopped: false, lastHit: Date.now(), error: null, fed: 0, length: f.length, dur: Number(info.format?.duration) || 0, errTail: '' };
  s.proc = spawn(FFMPEG, args, { windowsHide: true, cwd: dir }); // ffmpeg writes init.mp4 into its working folder
  s.proc.stdin.on('error', () => {});
  s.proc.stderr.on('data', (c) => { s.errTail = (s.errTail + c).slice(-600); });
  s.proc.on('close', (code) => { s.done = true; if (code && !s.stopped && !s.error) s.error = s.errTail.trim().split('\n').pop() || `ffmpeg exited ${code}`; });
  liveSessions.set(k, s);
  feedLive(L, f, s);
  console.log(`Streaming while downloading: ${f.rel}`);
  return s;
}
async function liveState(s) {
  if (!s.dir) return s; // { state: 'waiting' }
  if (s.error) return { state: 'error', error: `Can't stream this file before it finishes (${s.error}).` };
  const pl = await readFile(join(s.dir, 'index.m3u8'), 'utf8').catch(() => '');
  const segs = (pl.match(/#EXTINF/g) || []).length;
  const secs = [...pl.matchAll(/#EXTINF:([\d.]+)/g)].reduce((t, x) => t + Number(x[1]), 0);
  return { state: segs >= 2 || /#EXT-X-ENDLIST/.test(pl) ? 'ready' : 'starting', pct: s.length ? Math.round(s.fed / s.length * 100) : 0, secs, ended: /#EXT-X-ENDLIST/.test(pl),
    url: `/api/live/${s.id}/${basename(s.dir)}/index.m3u8`, dur: s.dur };
}
// streams nobody watched for 20 minutes stop; their files go
setInterval(async () => {
  for (const [k, s] of liveSessions) {
    if (Date.now() - s.lastHit < 20 * 60e3) continue;
    s.stopped = true; try { s.proc.kill(); } catch {}
    liveSessions.delete(k);
    await rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
}, 60e3);
rm(LIVE_DIR, { recursive: true, force: true }).catch(() => {}); // leftovers from the last run

// What /api/media answers for a download that's still coming.
async function liveMedia(id, media, pid) {
  const videos = [];
  for (const [i, f] of media.vids.entries()) {
    const head = await headOf(f.path), tag = (x) => x.tags || {};
    videos.push({ index: i, name: f.name, size: f.size, ext: extOf(f.name).slice(1), phone: { state: 'live' },
      audio: (head?.streams || []).filter((x) => x.codec_type === 'audio').map((x) => ({ lang: tag(x).language || '', title: tag(x).title || '', ch: x.channels || 0 })),
      vcodec: head?.streams?.find((x) => x.codec_type === 'video')?.codec_name || '', dur: Number(head?.format?.duration) || 0,
      watch: auth.progressGet(pid, `${id}:${i}`), chapters: [], external: '' });
  }
  const subs = await liveSubs(id, media);
  return { name: media.L.name, live: true, start: media.start, videos,
    tv: meta[id]?.item?.type === 'tv' || !!parseSE(media.L.name) || media.vids.length > 1,
    subs: subs.map((x, i) => ({ index: i, label: x.label, lang: x.lang, video: x.video, builtin: x.builtin })),
    subdl: !!settings.subdlKey, ffmpeg: !!FFMPEG, cast: null };
}

/* ---------- API ---------- */
function readJson(req) {
  if (req.body) return Promise.resolve(req.body); // read once already (a check before the route)
  return new Promise((ok) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
  });
}
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)); }

function search(q, category) {
  return new Promise((ok, fail) => {
    const p = runTorlink(['search', q, '--category', category, '--timeout', '30s']);
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
    p.on('error', fail);
    p.on('close', () => {
      try { ok(JSON.parse(out.slice(out.indexOf('{')))); }
      catch { fail(new Error((err.split('\n').find((l) => l.trim() && !/WebRTC/.test(l)) || 'torlink search failed').trim())); }
    });
  });
}

/* ---------- episodes: download one by itself, and the next one while you watch ---------- */
async function tmdb(path, params = {}) {
  const key = settings.tmdbKey;
  if (!key) throw new Error('The PC has no TMDB key yet: open the catalog once on the PC.');
  const u = new URL('https://api.themoviedb.org/3' + path);
  const headers = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; else u.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers });
  if (!r.ok) throw new Error('TMDB error ' + r.status);
  return r.json();
}
const tmdbCache = new Map(); // path -> { at, data }, kept 6 hours
async function tmdbCached(path, params) {
  const k = path + JSON.stringify(params || {}), c = tmdbCache.get(k);
  if (c && Date.now() - c.at < 6 * 3600e3) return c.data;
  const data = await tmdb(path, params);
  tmdbCache.set(k, { at: Date.now(), data });
  return data;
}
const showInfo = (tvId) => tmdbCached(`/tv/${tvId}`, { append_to_response: 'alternative_titles' });
const seasonInfo = (tvId, s) => tmdbCached(`/tv/${tvId}/season/${s}`);
const todayStr = () => new Date().toISOString().slice(0, 10);
// The episode after S/E: the next one this season, else the first of the next season.
async function episodeAfter(tvId, s, e) {
  const show = await showInfo(tvId);
  let ep = (await seasonInfo(tvId, s).catch(() => null))?.episodes?.find((x) => x.episode_number === e + 1), ns = s, ne = e + 1;
  if (!ep) {
    if (!(show.seasons || []).some((x) => x.season_number === s + 1)) return null;
    ep = (await seasonInfo(tvId, s + 1).catch(() => null))?.episodes?.find((x) => x.episode_number === 1);
    ns = s + 1; ne = 1;
    if (!ep) return null;
  }
  return { season: ns, episode: ne, name: ep.name || '', still: ep.still_path || null, airDate: ep.air_date || null,
    aired: !!ep.air_date && ep.air_date <= todayStr() };
}
// A download of this episode (or the season pack it's in), finished or still coming.
async function haveEpisode(tvId, s, e) {
  const done = new Set((await history()).filter((x) => existsSync(resolve(x.dir, x.name))).map((x) => x.id));
  let live = [];
  try { live = (await tor('/downloads')).downloads || []; } catch {}
  const running = new Map(live.map((d) => [d.id, d]));
  for (const [id, m] of Object.entries(meta)) {
    if (m.item?.type !== 'tv' || m.item.id !== tvId || m.season !== s || (m.episode != null && m.episode !== e)) continue;
    if (running.has(id)) return { id, state: 'downloading', pct: running.get(id).progress || 0 };
    if (done.has(id)) return { id, state: 'done' };
  }
  return null;
}
const normName = (s) => ' ' + s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
// "[Judas] Overgeared - S01E02" is ours; "Killers of the Overgeared" isn't (as on the page).
function isOurs(name, names) {
  const lead = normName(name.replace(/^(\s*\[[^\]]*\])+/, ''));
  const inParens = (name.match(/[([]([^)\]]+)[)\]]/g) || []).map(normName);
  return names.some((n) => lead.startsWith(n) || inParens.some((p) => p.startsWith(n)));
}
const groupOf = (n) => /^\s*\[([^\]]+)\]/.exec(n)?.[1] || /-([A-Za-z0-9]+)$/.exec(n.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\s*[[(][^\])]*[\])]\s*$/, ''))?.[1] || '';
const resOf = (n) => /\b(2160|1080|720|480)p\b/i.exec(n)?.[1] || (/\b4k\b/i.test(n) ? '2160' : '');
// Search the sources for one episode and start the best match: the same release group and
// quality as the episode before it when there is one (so it looks and sounds the same), else
// 1080p with plenty of people sharing it. Season packs are left out: too big to fetch unasked.
async function getEpisode(o) {
  const have = await haveEpisode(o.tvId, o.season, o.episode);
  if (have) return { outcome: 'have', ...have };
  const show = await showInfo(o.tvId);
  const names = [...new Set([show.name, show.original_name, ...(show.alternative_titles?.results || []).map((a) => a.title)]
    .filter((n) => n && /^[\x20-\x7E]+$/.test(n) && n.length >= 3))].map(normName);
  const pad = (n) => String(n).padStart(2, '0');
  const animated = (show.genres || []).some((g) => g.id === 16);
  const eastAsian = ['ja', 'ko', 'zh'].includes(show.original_language) || (show.origin_country || []).some((c) => ['JP', 'KR', 'CN'].includes(c));
  const cats = ['tv', ...(animated && eastAsian ? ['anime'] : [])];
  const q = `${show.name.replace(/[:'’]/g, '')} S${pad(o.season)}E${pad(o.episode)}`;
  const docs = await Promise.all(cats.map((c) => search(q, c).catch(() => ({ results: [] }))));
  const seen = new Set();
  const found = docs.flatMap((d) => d.results || []).filter((r) => r.infoHash && !seen.has(r.infoHash) && seen.add(r.infoHash))
    .filter((r) => { const se = parseSE(r.name); return se && se.season === o.season && se.episode === o.episode && isOurs(r.name, names); })
    .filter((r) => r.seeders >= 2 && (!r.sizeBytes || (r.sizeBytes > 60e6 && r.sizeBytes < 8e9)));
  if (!found.length) return { outcome: 'notFound', query: q };
  const g = groupOf(o.like || '').toLowerCase(), res = resOf(o.like || '');
  const score = (r) => Math.log2(1 + r.seeders) * 10 + (g && groupOf(r.name).toLowerCase() === g ? 40 : 0)
    + (res && resOf(r.name) === res ? 25 : 0) + ({ 1080: 15, 720: 8, 2160: -10 }[resOf(r.name)] || 0);
  const best = found.sort((a, b) => score(b) - score(a))[0];
  const id = infoHashOf(best.magnet);
  const out = await tor('/add', { magnet: best.magnet });
  meta[id] = { title: show.name + (show.first_air_date ? ` (${show.first_air_date.slice(0, 4)})` : ''), poster: show.poster_path || null,
    size: best.sizeBytes || 0, autoOpen: false, opened: false, addedAt: Date.now(), linkTried: true, auto: !!o.auto,
    item: itemOf({ id: show.id, type: 'tv', title: show.name, poster_path: show.poster_path, date: show.first_air_date || '',
      vote_average: show.vote_average, genre_ids: (show.genres || []).map((x) => x.id) }),
    season: o.season, episode: o.episode };
  saveMeta();
  console.log(`${o.auto ? 'Next episode, by itself' : 'Episode'}: ${best.name}`);
  return { outcome: out.outcome === 'duplicate' ? 'have' : 'added', id, name: best.name, size: best.sizeBytes || 0 };
}
// While an episode plays, fetch the one after it (once; again later if nothing was found or it hadn't aired).
const nextTries = new Map(); // "<show>:<s>:<e>" -> last try
async function autoNext(id, n) {
  const m = meta[id];
  if (m?.item?.type !== 'tv' || m.season == null || (settings.autoNextOff || []).includes(m.item.id)) return;
  let s = m.season, e = m.episode;
  const h = (await history()).find((x) => x.id === id);
  if (e == null) { // a season pack: the episode number is in the video's name
    const media = h && await mediaOf(h);
    const se = media && parseSE(basename(media.vids[n]?.name || ''));
    if (!se?.episode) return;
    s = se.season ?? s; e = se.episode;
  }
  const k = `${m.item.id}:${s}:${e}`;
  if (m.nextDone === k || Date.now() - (nextTries.get(k) || 0) < 30 * 60e3) return;
  nextTries.set(k, Date.now());
  try {
    const nx = await episodeAfter(m.item.id, s, e);
    if (!nx) { m.nextDone = k; saveMeta(); return; } // the last episode there is
    if (!nx.aired) return;
    const r = await getEpisode({ tvId: m.item.id, season: nx.season, episode: nx.episode, like: h?.name || '', auto: true });
    if (r.outcome !== 'notFound') { m.nextDone = k; saveMeta(); }
    else console.log(`Next episode: nothing found for "${r.query}"`);
  } catch (err) { console.log(`Next episode: ${err.message}`); }
}

async function api(req, res, path) {
  // The page is only meant to be driven from itself: refuse other origins.
  const origin = req.headers.origin;
  if (origin && origin !== auth.originOf(req)) return send(res, 403, { error: 'forbidden' });

  // who is asking (set by the request handler): their account and the profile they watch as
  const ctx = req.ctx, pid = ctx.profile.id;
  if (await auth.accountRoutes(req, res, path, ctx, { send, readJson, log: console.log })) return;
  // settings that hold API keys: once set, only the admin changes them
  if (path === '/api/settings' && req.method === 'POST' && !ctx.user.admin) {
    const b = await readJson(req);
    if ((typeof b.tmdbKey === 'string' && settings.tmdbKey) || (typeof b.subdlKey === 'string' && settings.subdlKey)) return send(res, 403, { error: 'Only the admin can change the API keys.' });
    req.body = b;
  }

  /* Phone → TV remote, within one account. The TV app keeps a live line open (role=tv) and does what
     it's told; phones keep one too (role=phone) and get the TV's "now playing" to draw the remote. */
  const remote = remoteOf(ctx.user.id);
  if (path === '/api/remote/stream' && req.method === 'GET') {
    const role = new URL(req.url, 'http://x').searchParams.get('role') === 'tv' ? 'tv' : 'phone';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const set = role === 'tv' ? remote.tvs : remote.phones;
    set.add(res);
    if (role === 'tv') remoteTell(remote.phones, 'tvs', { tvs: remote.tvs.size });
    else { remoteTell([res], 'tvs', { tvs: remote.tvs.size }); if (remote.status) remoteTell([res], 'status', remote.status); }
    req.on('close', () => {
      set.delete(res);
      if (role === 'tv') {
        if (!remote.tvs.size) { remote.status = null; remoteTell(remote.phones, 'status', { open: false }); }
        remoteTell(remote.phones, 'tvs', { tvs: remote.tvs.size });
      }
    });
    return;
  }
  if (path === '/api/remote/cmd' && req.method === 'POST') {
    const b = await readJson(req);
    if (!['play', 'toggle', 'seek', 'seekTo', 'stop', 'next'].includes(b.cmd)) return send(res, 400, { error: 'unknown command' });
    if (!remote.tvs.size) return send(res, 409, { error: 'The TV app is not open.' });
    remoteTell(remote.tvs, 'cmd', b);
    return send(res, 200, { ok: true });
  }
  if (path === '/api/remote/status' && req.method === 'POST') {
    remote.status = { ...(await readJson(req)), at: Date.now() };
    remoteTell(remote.phones, 'status', remote.status);
    return send(res, 200, { ok: true });
  }
  if (path === '/api/version' && req.method === 'GET') {
    // the page's version, so an open page (the TV app, the home-screen app) can notice an update
    return send(res, 200, { v: (await stat(join(root, 'index.html'))).mtimeMs });
  }
  if (path === '/api/tv/code' && req.method === 'POST') {
    // A short code to pair the TV app, shown on a device that already has access.
    if (!LAN) return send(res, 400, { error: 'Start the catalog for phones (start-phone.cmd) to use the TV app.' });
    const code = auth.pairCode(ctx); // the TV signs into this same account
    const ip = lanAddresses().map((a) => a.address).find(isPrivate);
    return send(res, 200, { code, minutes: 10, apk: existsSync(APK) ? `http://${ip || req.headers.host.replace(/:\d+$/, '')}:${port}/tv.apk` : null });
  }
  if (path === '/api/search' && req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    const q = (u.searchParams.get('q') || '').trim();
    const cat = ['movies', 'tv', 'anime', 'games'].includes(u.searchParams.get('category')) ? u.searchParams.get('category') : 'movies';
    if (!q) return send(res, 400, { error: 'missing q' });
    return send(res, 200, await search(q, cat));
  }
  if (path === '/api/add' && req.method === 'POST') {
    const b = await readJson(req);
    const id = infoHashOf(b.magnet);
    if (!id) return send(res, 400, { error: 'not a magnet link' });
    const out = await tor('/add', { magnet: b.magnet });
    meta[id] = { title: String(b.title || ''), poster: b.poster || null, size: Number(b.size) || 0, autoOpen: b.autoOpen !== false, opened: false, addedAt: Date.now(),
      item: itemOf(b.item), ...epOf(b), linkTried: true };
    saveMeta();
    return send(res, 200, { ok: true, id, outcome: out.outcome });
  }
  if (path === '/api/downloads' && req.method === 'GET') {
    // Finished downloads come from torlink's own history, so they still show
    // (and play) when the engine can't run, e.g. while the torlink window is open.
    let live = null, engineError = null;
    try { live = await tor('/downloads'); } catch (e) { engineError = e.message; }
    const h = await history();
    const active = (live?.downloads || []).map((d) => ({ ...d, ...(meta[d.id] || {}), ...linkOf(meta[d.id]) }));
    const activeIds = new Set(active.map((d) => d.id));
    const seeding = new Map((live?.seeds || []).map((s) => [s.id, s]));
    const finished = [];
    for (const x of h.filter((x) => !activeIds.has(x.id)).slice(0, 200)) finished.push({
      id: x.id, name: x.name, size: x.sizeBytes, completedAt: x.completedAt,
      seeding: seeding.get(x.id)?.status || 'stopped', ...(meta[x.id] ? { title: meta[x.id].title, poster: meta[x.id].poster } : {}),
      ...linkOf(meta[x.id]), vids: await countVids(x), watch: watchOf(pid, x.id),
    });
    return send(res, 200, { active, finished, engineError, dir: h[0]?.dir || DL_DIR, blocked: blockedLog.filter((b) => Date.now() - b.at < 24 * 3600e3) });
  }
  if (path === '/api/link' && req.method === 'POST') {
    // Ties a download to its TMDB title (used for downloads started elsewhere, e.g. in torlink itself).
    const b = await readJson(req);
    if (!/^[a-f0-9]{40}$/.test(String(b.id))) return send(res, 400, { error: 'bad id' });
    const item = itemOf(b.item);
    meta[b.id] = { ...(meta[b.id] || { autoOpen: false, opened: true, subsTried: true }), linkTried: true,
      ...(item ? { item, title: meta[b.id]?.title || item.title + (item.date ? ` (${item.date.slice(0, 4)})` : ''), poster: meta[b.id]?.poster || item.poster_path, ...epOf(b) } : {}) };
    saveMeta();
    return send(res, 200, { ok: true });
  }
  if (path === '/api/favorites' && req.method === 'GET') {
    return send(res, 200, auth.favoritesOf(pid));
  }
  if (path === '/api/favorite' && req.method === 'POST') {
    const b = await readJson(req), item = itemOf(b.item);
    if (!item) return send(res, 400, { error: 'bad item' });
    const key = `${item.type}:${item.id}`;
    auth.favoriteSet(pid, key, b.on ? item : null);
    return send(res, 200, { ok: true });
  }
  if (path === '/api/control' && req.method === 'POST') {
    const b = await readJson(req);
    if (b.action === 'autoOpen') { if (meta[b.id]) { meta[b.id].autoOpen = !!b.value; saveMeta(); } return send(res, 200, { ok: true }); }
    if (!['pause', 'resume', 'remove', 'delete', 'stop-seed', 'start-seed'].includes(b.action)) return send(res, 400, { error: 'bad action' });
    const out = await tor('/control', { id: String(b.id), action: b.action });
    if (b.action === 'remove' || b.action === 'delete') { delete meta[b.id]; saveMeta(); }
    return send(res, 200, out);
  }
  if (path === '/api/remove' && req.method === 'POST') {
    // Delete a finished download: stop sharing, drop it from torlink, then recycle its files.
    const b = await readJson(req);
    const h = (await history()).find((x) => x.id === b.id);
    if (!h) return send(res, 404, { error: 'not found' });
    const base = resolve(h.dir), target = resolve(h.dir, basename(h.name.trim()));
    if (!target.startsWith(base + sep)) return send(res, 400, { error: 'unsafe path' });
    await tor('/control', { id: h.id, action: 'remove' }); // keeps the files; releases torlink's hold on them
    const existed = existsSync(target);
    const wasFile = existed && (await stat(target).catch(() => null))?.isFile();
    for (let i = 0; i < 5 && existsSync(target); i++) {
      try { await recycle(target); } catch (e) { if (i === 4) throw e; }
      if (existsSync(target)) await new Promise((r) => setTimeout(r, 600)); // the engine may still be closing the files
    }
    const recycled = existed && !existsSync(target);
    // A single file's subtitles sit beside it, outside what torlink owns: recycle them too.
    if (wasFile) {
      const stem = basename(target, extname(target)).toLowerCase();
      for (const f of await readdir(base).catch(() => []))
        if (f.toLowerCase().startsWith(stem + '.') && SUB_EXT.has(extname(f).toLowerCase())) await recycle(join(base, f)).catch(() => {});
    }
    await removePhoneFiles(h.id);
    delete meta[h.id]; saveMeta();
    dropProgress(h.id); vidCount.delete(h.id);
    console.log(`Deleted: ${h.name}${recycled ? ' (files moved to the Recycle Bin)' : ''}`);
    return send(res, 200, { ok: true, recycled });
  }
  if ((path === '/api/open' || path === '/api/reveal') && req.method === 'POST') {
    const b = await readJson(req);
    const h = (await history()).find((x) => x.id === b.id);
    const t = h && await target(h);
    if (!t) return send(res, 404, { error: 'files not found on disk' });
    if (path === '/api/open') openPath(t.open); else showInFolder(t.open);
    return send(res, 200, { ok: true });
  }
  // /api/media/<id>                  → what can be played
  // /api/media/<id>/video/<n>[/file] → the video, with seeking (Range)
  // /api/media/<id>/sub/<n>.vtt      → a subtitle file as WebVTT
  // GET  /api/media/<id>                  → what can be played (+ phone-version state, subtitles)
  // GET  /api/media/<id>/video/<n>[/file] → the video, with seeking; ?phone=1 for the phone version
  // GET  /api/media/<id>/sub/<k>.vtt      → subtitle k as WebVTT
  // POST /api/media/<id>/phone/<n>        → start making the phone version
  // GET  /api/media/<id>/thumbs/<n>[/<s>.jpg] → seek previews (started on first ask), or sheet s
  // POST /api/live/<id>/<n>?a=&h=   → start (or check) watching a download that's still coming
  // GET  /api/live/<id>/<key>/<file>  → its HLS playlist and pieces
  const lv = /^\/api\/live\/([a-f0-9]{40})\/(\d+)$/.exec(path);
  if (lv && req.method === 'POST') {
    if (!FFMPEG) return send(res, 501, { error: 'ffmpeg is not installed on the PC' });
    const q = new URL(req.url, 'http://x').searchParams;
    const s = await startLive(lv[1], Number(lv[2]), Math.max(0, Number(q.get('a')) || 0), q.get('h') === '1' ? 1 : 0);
    return send(res, 200, await liveState(s));
  }
  const lf = /^\/api\/live\/([a-f0-9]{40})\/([\w.-]+)\/(index\.m3u8|init\.mp4|s\d{5}\.m4s)$/.exec(path);
  if (lf) {
    const s = liveSessions.get(lf[2]);
    if (!s || s.id !== lf[1]) return send(res, 404, { error: 'not streaming' });
    s.lastHit = Date.now();
    let data = await readFile(join(s.dir, lf[3])).catch(() => null);
    if (!data) return send(res, 404, { error: 'not there yet' });
    // ?vod=1: what's there so far as a finished video, for players that would otherwise treat a growing
    // stream as live TV (no length, no seeking): the page asks again for more as it nears the end
    if (lf[3] === 'index.m3u8' && new URL(req.url, 'http://x').searchParams.get('vod') === '1') {
      let text = data.toString('utf8').replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
      if (!/#EXT-X-ENDLIST/.test(text)) text = text.replace(/\s*$/, '\n#EXT-X-ENDLIST\n');
      data = Buffer.from(text);
    }
    res.writeHead(200, { 'Content-Type': lf[3].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4', 'Cache-Control': lf[3].endsWith('.m3u8') ? 'no-cache' : 'private, max-age=3600' }).end(data);
    return;
  }
  const mm = /^\/api\/media\/([a-f0-9]{40})(?:\/(video|sub|phone|thumbs)\/(\d+)(?:\.vtt|\/.*)?)?$/.exec(path);
  if (mm && (!mm[2] || mm[2] === 'sub') && !(await history()).some((x) => x.id === mm[1])) {
    const media = await liveMediaOf(mm[1]); // still downloading: played as a stream
    if (media) {
      if (!mm[2]) return send(res, 200, await liveMedia(mm[1], media, pid));
      const sub = (await liveSubs(mm[1], media))[Number(mm[3])];
      if (!sub) return send(res, 404, { error: 'no such subtitle' });
      let vtt;
      if (sub.builtin) {
        const key = `${mm[1]}-${sub.video}`;
        const ss = [...liveSessions].find(([k, x]) => (k === key || k.startsWith(key + '.')) && !x.stopped)?.[1];
        const txt = ss ? await readFile(join(ss.dir, `sub${sub.si}.${sub.ass ? 'ass' : 'vtt'}`), 'utf8').catch(() => '') : '';
        vtt = !txt ? 'WEBVTT\n\n' : sub.ass ? assToVtt(txt) : txt;
      } else vtt = await subtitleAsVtt(sub.path);
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-cache' }).end(vtt);
      return;
    }
  }
  if (mm) {
    const h = (await history()).find((x) => x.id === mm[1]);
    const media = h && await mediaOf(h);
    if (!media) return send(res, 404, { error: 'files not found on disk' });
    const n = Number(mm[3]);
    if (mm[2] === 'phone' && req.method === 'POST') {
      const v = media.vids[n];
      if (!v) return send(res, 404, { error: 'no such video' });
      if (!FFMPEG) return send(res, 501, { error: 'ffmpeg is not installed on the PC' });
      const q = new URL(req.url, 'http://x').searchParams, a = Math.max(0, Number(q.get('a')) || 0);
      const hh = q.get('h') === '1' && (await vcodecOf(v.path)) !== 'h264' ? 1 : 0; // an H.264 file needs no H.264 copy
      if (!['ready', 'direct'].includes((await phoneState(h.id, n, v.path, a, hh)).state)) startPhone(h.id, n, v.path, a, hh);
      return send(res, 200, { ...(await phoneState(h.id, n, v.path, a, hh)), h: hh });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    const subs = await subsOf(h.id, media);
    if (!mm[2]) {
      const t = LAN && ctx.token ? `?t=${auth.mediaToken(ctx.token)}` : '';
      const hostUrl = auth.originOf(req);
      const videos = [];
      for (const [i, v] of media.vids.entries()) {
        const info = await phoneInfo(h.id, i);
        videos.push({
          index: i, name: v.name, size: v.size, ext: extname(v.name).slice(1).toLowerCase(),
          phone: await phoneState(h.id, i, v.path), audio: info?.audio?.length ? info.audio : await audioOf(v.path), vcodec: await vcodecOf(v.path), watch: auth.progressGet(pid, `${h.id}:${i}`), chapters: await chaptersOf(v.path),
          // A direct link for VLC and other players (they play the original); carries the phone token since they have no cookie.
          external: `${hostUrl}/api/media/${h.id}/video/${i}/${encodeURIComponent(v.name.split(/[\\/]/).pop())}${t}`,
        });
      }
      return send(res, 200, { name: h.name, start: media.start, videos, tv: meta[h.id]?.item?.type === 'tv' || !!parseSE(h.name) || media.vids.length > 1,
        subs: subs.map((s, i) => ({ index: i, label: s.label, lang: s.lang, video: s.video, builtin: s.builtin })),
        subdl: !!settings.subdlKey, ffmpeg: !!FFMPEG, cast: castOf(req, ctx) });
    }
    if (mm[2] === 'thumbs') {
      const v = media.vids[n];
      if (!v) return send(res, 404, { error: 'no such video' });
      const k = phoneKey(h.id, n), sheet = /\/(\d+)\.jpg$/.exec(path);
      if (sheet) {
        const f = join(THUMB_DIR, `${k}-${String(Number(sheet[1])).padStart(3, '0')}.jpg`);
        if (!existsSync(f)) return send(res, 404, { error: 'no such sheet' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }).end(await readFile(f));
        return;
      }
      const info = await thumbInfo(k);
      if (info) return send(res, 200, { state: 'ready', ...info });
      if (!FFMPEG) return send(res, 200, { state: 'unavailable' });
      startThumbs(k, v.path);
      const j = thumbJobs.get(k);
      return send(res, 200, j && j !== 'working' ? { state: 'error', error: j } : { state: 'working' });
    }
    if (mm[2] === 'video') {
      const v = media.vids[n];
      if (!v) return send(res, 404, { error: 'no such video' });
      const q = new URL(req.url, 'http://x').searchParams, phone = q.get('phone') === '1', a = Math.max(0, Number(q.get('a')) || 0), hh = q.get('h') === '1' ? 1 : 0;
      return streamFile(req, res, phone ? join(PHONE_DIR, phoneKey(h.id, n, a, hh) + '.mp4') : v.path);
    }
    const sub = subs[n];
    if (!sub) return send(res, 404, { error: 'no such subtitle' });
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' }).end(await subtitleFor(h.id, media, sub));
    return;
  }
  if (path === '/api/settings') {
    if (req.method === 'POST') {
      const b = await readJson(req);
      if (typeof b.subdlKey === 'string') settings.subdlKey = b.subdlKey.trim().slice(0, 200);
      if (typeof b.tmdbKey === 'string') settings.tmdbKey = b.tmdbKey.trim().slice(0, 400);
      if (typeof b.autoSubs === 'boolean') settings.autoSubs = b.autoSubs;
      if (Array.isArray(b.autoSubLangs)) settings.autoSubLangs = b.autoSubLangs.map((x) => String(x).toUpperCase().replace(/[^A-Z_]/g, '').slice(0, 6)).filter(Boolean).slice(0, 4);
      saveSettings();
    }
    return send(res, 200, settingsOut());
  }
  if ((path === '/api/subs/search' && req.method === 'GET') || (path === '/api/subs/download' && req.method === 'POST') || (path === '/api/subs/auto' && req.method === 'POST')) {
    const u = new URL(req.url, 'http://x');
    const b = req.method === 'POST' ? await readJson(req) : { id: u.searchParams.get('id'), n: u.searchParams.get('n') };
    if (!settings.subdlKey) return send(res, 400, { error: 'Add a SubDL API key first' });
    let h = (await history()).find((x) => x.id === b.id), media = h && await mediaOf(h);
    if (!h && /^[a-f0-9]{40}$/.test(String(b.id))) { // still downloading
      media = await liveMediaOf(b.id);
      if (media) h = { id: b.id, name: media.L.name, dir: DL_DIR };
    }
    if (path === '/api/subs/auto') return send(res, 200, h ? await queueAutoSubs(h) : { got: 0, note: 'not found' });
    const n = Number(b.n) || 0, v = media?.vids[n];
    if (!v) return send(res, 404, { error: 'video not found' });
    if (path === '/api/subs/search') return send(res, 200, await subdlSearch(h, media, n, u.searchParams.get('langs')));
    return send(res, 200, { ok: true, name: await subdlSave(h, v, b) });
  }
  if (path === '/api/progress' && req.method === 'POST') {
    // The player reports where it is; "watched" comes from the end of the video or by hand.
    const b = await readJson(req);
    if (!/^[a-f0-9]{40}$/.test(String(b.id)) || !Number.isInteger(b.n) || b.n < 0 || b.n > 5000) return send(res, 400, { error: 'bad id' });
    const k = `${b.id}:${b.n}`, p = auth.progressGet(pid, k) || { t: 0, d: 0, w: false };
    if (Number.isFinite(b.d) && b.d > 0) p.d = b.d;
    if (Number.isFinite(b.t) && b.t >= 0) p.t = b.t;
    if (typeof b.watched === 'boolean') { p.w = b.watched; if (!b.watched || b.t === undefined) p.t = 0; }
    else if (p.d && (p.t >= p.d * 0.92 || (p.d > 900 && p.d - p.t < 150))) p.w = true; // into the credits
    p.at = Date.now();
    auth.progressSet(pid, k, p);
    if (p.t > 60) autoNext(b.id, b.n); // a minute in: fetch the next episode in the background
    return send(res, 200, { ok: true, watch: p });
  }
  if (path === '/api/next' && req.method === 'GET') {
    // For the player's "Next episode" card: what comes next, and whether it's here or on its way.
    const u = new URL(req.url, 'http://x'), id = u.searchParams.get('id'), n = Number(u.searchParams.get('n')) || 0;
    const m = meta[id];
    if (m?.item?.type !== 'tv' || m.season == null) return send(res, 200, { next: null });
    let s = m.season, e = m.episode;
    if (e == null) {
      const h = (await history()).find((x) => x.id === id), media = h && await mediaOf(h);
      const se = media && parseSE(basename(media.vids[n]?.name || ''));
      if (!se?.episode) return send(res, 200, { next: null });
      s = se.season ?? s; e = se.episode;
    }
    const next = await episodeAfter(m.item.id, s, e).catch(() => null);
    const have = next ? await haveEpisode(m.item.id, next.season, next.episode) : null;
    return send(res, 200, { next, have, autoNext: !(settings.autoNextOff || []).includes(m.item.id), tvId: m.item.id });
  }
  if (path === '/api/episode' && req.method === 'POST') {
    // "Download" on an episode: the best match for it, started straight away.
    const b = await readJson(req);
    const tvId = Number(b.tvId), s = Number(b.season), e = Number(b.episode);
    if (!Number.isInteger(tvId) || !Number.isInteger(s) || !Number.isInteger(e)) return send(res, 400, { error: 'bad episode' });
    return send(res, 200, await getEpisode({ tvId, season: s, episode: e, like: String(b.like || '') }));
  }
  if (path === '/api/autonext' && req.method === 'POST') {
    // Per show: fetch the next episode by itself while watching (on unless turned off).
    const b = await readJson(req), tvId = Number(b.tvId);
    if (!Number.isInteger(tvId)) return send(res, 400, { error: 'bad show' });
    const off = new Set(settings.autoNextOff || []);
    if (b.on) off.delete(tvId); else off.add(tvId);
    settings.autoNextOff = [...off]; saveSettings();
    return send(res, 200, { ok: true, on: !off.has(tvId) });
  }
  if (path === '/api/disk' && req.method === 'GET') {
    // Free space on the download drive, what the library takes, and what's safe to clear.
    const h = await history();
    const dir = h[0]?.dir || DL_DIR;
    const fsInfo = await statfs(existsSync(dir) ? dir : root).catch(() => null);
    let library = 0, phone = 0;
    const watched = [];
    for (const x of h) {
      if (!existsSync(resolve(x.dir, x.name))) continue;
      library += x.sizeBytes || 0;
      // safe to clear: this profile watched it all, and nobody else is part-way through it
      const n = await countVids(x), w = watchOf(pid, x.id);
      if (n && Object.values(w).filter((p) => p.w).length >= n && !auth.othersWatching(pid, x.id))
        watched.push({ id: x.id, name: x.name, size: x.sizeBytes || 0, title: meta[x.id]?.title || '', ...linkOf(meta[x.id]), watchedAt: Math.max(...Object.values(w).map((p) => p.at || 0)) });
    }
    for (const f of await readdir(PHONE_DIR).catch(() => [])) phone += (await stat(join(PHONE_DIR, f)).catch(() => ({ size: 0 }))).size;
    return send(res, 200, { dir, drive: /^[A-Za-z]:/.exec(dir)?.[0] || '',
      free: fsInfo ? fsInfo.bavail * fsInfo.bsize : null, total: fsInfo ? fsInfo.blocks * fsInfo.bsize : null,
      library, phone, watched: watched.sort((a, b) => a.watchedAt - b.watchedAt) });
  }
  if (path === '/api/phone/clear' && req.method === 'POST') {
    // Phone versions are copies, remade in seconds when needed again.
    let freed = 0;
    for (const f of await readdir(PHONE_DIR).catch(() => [])) {
      if ([...jobs.keys()].some((k) => f.startsWith(k))) continue; // being made right now
      const p = join(PHONE_DIR, f);
      freed += (await stat(p).catch(() => ({ size: 0 }))).size;
      await rm(p, { force: true }).catch(() => {});
    }
    return send(res, 200, { ok: true, freed });
  }
  if (path === '/api/status') {
    return send(res, 200, { torlink: !!CLI || 'launcher', engine: await torHealthy() });
  }
  send(res, 404, { error: 'not found' });
}

/* ---------- who may use it ---------- */
// With --lan the server listens on the network and everyone signs in (auth.mjs). Without it, it only
// answers this computer, with no sign-in, as one local profile.
const LAN = process.argv.includes('--lan');
const LOCAL_CTX = { user: { id: 0, name: 'local', admin: true }, profiles: [], chosen: null, profile: { id: 0, name: 'local', color: auth.COLORS[0] }, sessionHash: '', token: null };
// files a player fetches without the cookie (VLC, a Chromecast): they carry ?t=<media token> instead
const MEDIA_PATH = /^\/api\/(media\/[a-f0-9]{40}\/(video|sub)\/|live\/[a-f0-9]{40}\/[\w.-]+\/)/;
function whoIs(req) {
  if (!LAN) return LOCAL_CTX;
  return auth.contextOf(req, (req.method === 'GET' || req.method === 'HEAD') && MEDIA_PATH.test(new URL(req.url, 'http://x').pathname));
}
function lanAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || [])
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => ({ name, address: a.address })));
}

// Casting: the TV fetches the video itself, with no cookie, and it can only reach the PC's
// home-network address (not Tailscale's). Give the page that address plus the token.
const isPrivate = (h) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
function castOf(req, ctx) {
  if (!LAN || !ctx.token) return null;
  const t = auth.mediaToken(ctx.token);
  const host = String(req.headers.host || ''), name = host.replace(/:\d+$/, '');
  if (isPrivate(name)) return { base: `http://${host}`, t };
  const ip = lanAddresses().map((a) => a.address).find(isPrivate);
  return ip ? { base: `http://${ip}:${port}`, t } : null;
}

// the phone → TV remote, one per account: a phone only reaches TVs signed into the same account
const remotes = new Map();
function remoteOf(userId) {
  if (!remotes.has(userId)) remotes.set(userId, { tvs: new Set(), phones: new Set(), status: null });
  return remotes.get(userId);
}
function remoteTell(list, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of list) { try { r.write(msg); } catch {} }
}
// a comment line now and then keeps the live lines from being dropped as idle
setInterval(() => { for (const remote of remotes.values()) for (const r of [...remote.tvs, ...remote.phones]) { try { r.write(': ping\n\n'); } catch {} } }, 25000);

/* TV app: it finds the server by asking every address on the home network for /api/tv/hello,
   then pairs once with a 6-digit code from a signed-in device, which signs the TV into that account. */
const APK = join(root, 'tv-app', 'movie-catalog-tv.apk');
async function tvRoutes(req, res, path) {
  if (path === '/api/tv/hello') {
    // alt: the PC's Tailscale addresses, which the TV app tries when it's away from the home Wi-Fi
    const alt = lanAddresses().map((a) => a.address).filter((ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)).map((ip) => `http://${ip}:${port}`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify({ app: 'movie-catalog', name: os.hostname(), alt }));
    return true;
  }
  if (path === '/tv.apk') {
    if (!existsSync(APK)) { res.writeHead(404).end('The TV app has not been built yet.'); return true; }
    res.setHeader('Content-Disposition', 'attachment; filename="movie-catalog-tv.apk"');
    MIME['.apk'] = 'application/vnd.android.package-archive';
    await streamFile(req, res, APK);
    return true;
  }
  if (path === '/tv' && req.method === 'GET') {
    if (whoIs(req)) {
      // the home screen's Resume: the episode to start comes along (play=<download id>&n=<video>&title=...)
      const q = new URL(req.url, 'http://x').searchParams, play = q.get('play');
      const extra = play && /^[a-f0-9]{40}$/.test(play) ? '&' + new URLSearchParams({ play, n: String(Number(q.get('n')) || 0), title: (q.get('title') || '').slice(0, 200) }) : '';
      res.writeHead(302, { Location: '/?tv=1' + extra }).end(); return true;
    }
    const data = await readFile(join(root, 'tv-pair.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(data);
    return true;
  }
  // signing in, invites, TV pairing: open to anyone (auth.mjs limits wrong guesses)
  if (LAN && await auth.publicRoutes(req, res, path, { send, readJson, log: console.log, onFirstProfile: (pid) => importOldFiles(pid).catch((e) => console.log(`Import failed: ${e.message}`)) })) return true;
  if (path === '/login' || path === '/login.html') {
    if (!LAN) { res.writeHead(302, { Location: '/' }).end(); return true; }
    const data = await readFile(join(root, 'login.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(data);
    return true;
  }
  return false;
}

createServer(async (req, res) => {
  // The icons and the service worker hold nothing private; phones fetch them without the cookie.
  const pre = new URL(req.url, 'http://x').pathname;
  // through the tunnel, only https: plain http would carry passwords and cookies in the clear
  if (LAN && auth.viaTunnel(req) && req.headers['cf-connecting-ip'] && !auth.isHttps(req)) {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` }).end(); return;
  }
  if (/^\/apple-touch-icon(-precomposed)?\.png$/.test(pre) || pre === '/favicon.ico') req.url = pre === '/favicon.ico' ? '/icons/favicon-32.png' : '/icons/apple-touch-icon.png';
  try { if (await tvRoutes(req, res, pre)) return; } catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); return; }
  // The icons, the service worker and the scripts hold nothing private; the sign-in page needs some of them.
  const open = pre.startsWith('/icons/') || pre === '/sw.js' || pre === '/hls.min.js' || pre === '/manifest.webmanifest';
  req.ctx = open ? null : whoIs(req);
  if (!open && !req.ctx) {
    if (pre.startsWith('/api/')) { send(res, 401, { error: 'Signed out. Reload the page to sign in again.' }); return; }
    // a page: sign in first (the TV app gets its pairing screen at /tv)
    const tv = new URL(req.url, 'http://x').searchParams.get('tv') === '1';
    res.writeHead(302, { Location: tv ? '/tv' : '/login' }).end(); return;
  }
  // what needs signing in is never kept by Cloudflare (or any cache between): it would hand it to anyone
  res.setHeader('Cache-Control', 'private');
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.startsWith('/api/')) {
    try { await api(req, res, path); } catch (e) { if (res.headersSent) res.destroy(); else send(res, e.status || 500, { error: e.message }); }
    return;
  }
  if (path === '/manifest.webmanifest') {
    // (an iPhone's home-screen app has its own cookies, so it asks to sign in once)
    const start = '/';
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' }).end(JSON.stringify({
      name: 'Moonvies', short_name: 'Moonvies', id: '/', start_url: start, scope: '/', display: 'standalone',
      background_color: '#0a0520', theme_color: '#0a0520', orientation: 'any',
      icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
    }));
    return;
  }
  if (path === '/') path = '/index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root) || !types[extname(file)]) { res.writeHead(404).end(); return; }
  // Read first, then answer: a missing file (iPhones ask for /apple-touch-icon-precomposed.png
  // by themselves) must get a 404, not crash the server after the 200 went out.
  let data;
  try { data = await readFile(file); } catch { res.writeHead(404).end('not found'); return; }
  // no-cache: browsers (phones especially) must pick up a changed page on reload
  res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-cache' }).end(data);
}).listen(port, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  const url = `http://localhost:${port}/`;
  console.log(`Moonvies running at ${url}  (Ctrl+C to stop)`);
  if (LAN) {
    for (const a of lanAddresses()) console.log(`  on the network (${a.name}): http://${a.address}:${port}/`);
    // No accounts yet: a one-time link that makes the admin account (also saved to setup-link.txt).
    const setup = auth.setupLink();
    if (setup) {
      const ip = lanAddresses().map((a) => a.address).find(isPrivate) || 'localhost';
      const link = `http://${ip}:${port}/login?invite=${setup}`;
      console.log(`  No accounts yet. Make the admin account here (works once, for 30 days): ${link}`);
      writeFile(join(root, 'setup-link.txt'), link + '\n').catch(() => {});
    } else rm(join(root, 'setup-link.txt'), { force: true }).catch(() => {});
  }
  if (!CLI) console.log('torlink CLI not found in the global npm folder; falling back to torlnk.cmd');
  ensureServe().catch((e) => console.log(e.message));
  if (!process.argv.includes('--no-open')) exec(`start "" "${url}"`);
});

process.on('SIGINT', () => { serveProc?.kill(); process.exit(0); });
// A server people rely on from their phone: log a surprise error and keep running.
process.on('uncaughtException', (e) => console.log(`Error (still running): ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => console.log(`Error (still running): ${e?.stack || e}`));
