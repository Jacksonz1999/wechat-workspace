'use strict';
/**
 * 数据层：多用户工作台数据 + 身份绑定 + 审计日志
 * 零依赖，落盘为 JSON 文件（便于备份/迁移），接口与前端同构。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'audit.log');

const MODULES = ['work', 'study', 'family', 'money', 'life', 'meta'];
const BIND_TTL_MS = 5 * 60 * 1000;      // 绑定码有效期
const SESSION_TTL_MS = 30 * 60 * 1000;  // 会话保留时长

/* ---------------- 与前端同构的空数据结构 ---------------- */
function emptyUser() {
  return {
    work:   { tasks: [], events: [], projects: [] },
    study:  { tasks: [], courses: [], logs: [] },
    family: { events: [], chores: [], anniv: [] },
    money:  { incomes: [], expenses: [], budgets: [], bills: [], rules: [] },
    life:   { health: [], habits: [], memos: [] },
    meta:   { seeded: false, ts: {} }
  };
}

/* ---------------- 读写 ---------------- */
let STATE = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (STATE) return STATE;
  ensureDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      STATE = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      // 损坏时备份原文件再重建，避免静默丢数据
      const bak = STATE_FILE + '.broken.' + Date.now();
      try { fs.copyFileSync(STATE_FILE, bak); } catch (_) {}
      console.error('[store] state.json 解析失败，已备份到 ' + bak);
      STATE = null;
    }
  }
  if (!STATE || typeof STATE !== 'object') STATE = { users: {}, data: {}, binds: {} };
  STATE.users = STATE.users || {};
  STATE.data = STATE.data || {};
  STATE.binds = STATE.binds || {};   // code -> {uid, exp}
  return STATE;
}

let saveTimer = null;
function save() {
  // 合并写盘，避免高频操作把文件打爆
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      ensureDir();
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(STATE));
      fs.renameSync(tmp, STATE_FILE);   // 原子替换
    } catch (e) {
      console.error('[store] 写盘失败: ' + e.message);
    }
  }, 120);
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    ensureDir();
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(STATE));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('[store] 写盘失败: ' + e.message); }
}

/* ---------------- 用户 ---------------- */
function uid() {
  return 'u_' + crypto.randomBytes(6).toString('hex');
}
/**
 * 取（必要时建）用户。
 *  - 传了 id：一定返回这个 id（不存在就按该 id 建），保证调用方持有的 id 始终有效
 *  - 没传 id：新建一个随机 id
 * 早期实现在「传了 id 但该用户不存在」时会另起随机 id，导致微信端绑到陌生账号。
 */
function ensureUser(id) {
  const s = load();
  if (!id) {
    const nid = uid();
    s.users[nid] = { id: nid, createdAt: new Date().toISOString(), name: '', openids: [] };
    s.data[nid] = s.data[nid] || emptyUser();
    save();
    return nid;
  }
  if (!s.users[id]) {
    s.users[id] = { id: id, createdAt: new Date().toISOString(), name: '', openids: [] };
    save();
  }
  s.data[id] = s.data[id] || emptyUser();
  return id;
}

function userData(id) {
  const s = load();
  const k = ensureUser(id);
  s.data[k] = s.data[k] || emptyUser();
  // 兼容老数据：补齐缺失的模块
  const base = emptyUser();
  Object.keys(base).forEach(m => { if (!s.data[k][m]) s.data[k][m] = base[m]; });
  return s.data[k];
}
function listUsers() { return Object.keys(load().users); }

/* ---------------- 微信身份绑定 ---------------- */
function genBindCode(uid_) {
  const s = load();
  const u = ensureUser(uid_);
  // 6 位数字，冲突重试
  let code, guard = 0;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); guard++; }
  while (s.binds[code] && s.binds[code].exp > Date.now() && guard < 20);
  s.binds[code] = { uid: u, exp: Date.now() + BIND_TTL_MS };
  save();
  return { code, exp: s.binds[code].exp };
}
function consumeBindCode(code) {
  const s = load();
  const rec = s.binds[String(code || '').trim()];
  if (!rec) return { ok: false, reason: 'not_found' };
  if (rec.exp < Date.now()) { delete s.binds[code]; save(); return { ok: false, reason: 'expired' }; }
  delete s.binds[code];
  save();
  return { ok: true, uid: rec.uid };
}
function bindOpenid(uid_, openid) {
  const s = load();
  const u = ensureUser(uid_);
  // 一个 openid 只能绑一个用户：先解绑旧的
  Object.keys(s.users).forEach(k => {
    const arr = s.users[k].openids || [];
    const i = arr.indexOf(openid);
    if (i >= 0) arr.splice(i, 1);
  });
  s.users[u].openids = s.users[u].openids || [];
  if (s.users[u].openids.indexOf(openid) < 0) s.users[u].openids.push(openid);
  save();
  return u;
}
function findByOpenid(openid) {
  const s = load();
  const ks = Object.keys(s.users);
  for (const k of ks) {
    if ((s.users[k].openids || []).indexOf(openid) >= 0) return k;
  }
  return null;
}
function unbind(openid) {
  const s = load();
  let hit = null;
  Object.keys(s.users).forEach(k => {
    const arr = s.users[k].openids || [];
    const i = arr.indexOf(openid);
    if (i >= 0) { arr.splice(i, 1); hit = k; }
  });
  save();
  return hit;
}

/* ---------------- 审计日志（JSONL，便于检索与审计） ---------------- */
function audit(entry) {
  try {
    ensureDir();
    const line = JSON.stringify(Object.assign({
      at: new Date().toISOString(),
      id: crypto.randomBytes(4).toString('hex')
    }, entry)) + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    console.error('[store] 写日志失败: ' + e.message);
  }
}
function readAudit(limit) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const arr = lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    return limit ? arr.slice(-limit) : arr;
  } catch (e) { return []; }
}

/* ---------------- 与前端同步：按模块时间戳 last-write-wins ---------------- */
function pullModules(uid_) {
  const d = userData(uid_);
  const out = {};
  MODULES.forEach(m => { out[m] = d[m]; });
  return out;
}
function pushModules(uid_, payload) {
  const d = userData(uid_);
  const changed = [];
  (payload && payload.ts ? Object.keys(payload.ts) : []).forEach(m => {
    if (MODULES.indexOf(m) < 0) return;
    const incoming = Number(payload.ts[m]) || 0;
    const local = Number((d.meta && d.meta.ts && d.meta.ts[m]) || 0);
    if (incoming > local) {
      d[m] = payload[m];
      d.meta.ts[m] = incoming;
      changed.push(m);
    }
  });
  if (changed.length) save();
  return changed;
}

module.exports = {
  MODULES, SESSION_TTL_MS, emptyUser,
  load, save, flush, uid, ensureUser, userData, listUsers,
  genBindCode, consumeBindCode, bindOpenid, findByOpenid, unbind,
  audit, readAudit, pullModules, pushModules
};
