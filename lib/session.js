'use strict';
/**
 * 会话状态：多轮对话、槽位补全、模糊澄清、敏感操作二次确认
 * 内存态 + TTL 自动回收；服务重启只丢「未完成的多轮」，不影响已落盘的数据。
 */
const store = require('./store');

const SESSIONS = new Map();
const TTL = store.SESSION_TTL_MS;      // 30 分钟

function get(key) {
  const s = SESSIONS.get(key);
  if (!s) return null;
  if (Date.now() - s.lastAt > TTL) { SESSIONS.delete(key); return null; }
  return s;
}
function ensure(key) {
  let s = SESSIONS.get(key);
  if (!s || Date.now() - s.lastAt > TTL) {
    s = { key, uid: null, pending: null, confirm: null, clarify: null, history: [], lastAt: Date.now(), createdAt: Date.now() };
    SESSIONS.set(key, s);
  }
  s.lastAt = Date.now();
  return s;
}
function set(key, patch) {
  const s = ensure(key);
  Object.assign(s, patch);
  s.lastAt = Date.now();
  return s;
}
function clearFlow(key) {
  const s = ensure(key);
  s.pending = null; s.confirm = null; s.clarify = null;
  s.lastAt = Date.now();
  return s;
}
function remove(key) { SESSIONS.delete(key); }

/** 记录一轮对话（供 LLM 上下文与审计） */
function pushHistory(key, role, content) {
  const s = ensure(key);
  s.history.push({ role, content, at: Date.now() });
  if (s.history.length > 20) s.history = s.history.slice(-20);
  s.lastAt = Date.now();
}

/** 定期回收过期会话 */
function sweep() {
  const now = Date.now();
  let n = 0;
  SESSIONS.forEach((s, k) => { if (now - s.lastAt > TTL) { SESSIONS.delete(k); n++; } });
  return n;
}
setInterval(sweep, 5 * 60 * 1000).unref();

/** 找出某个工具还缺哪些必填槽位 */
function missingSlots(tool, slots) {
  const out = [];
  (tool.slots || []).forEach(s => {
    if (!s.required) return;
    const v = slots[s.key];
    if (v == null || v === '') out.push(s);
  });
  return out;
}

module.exports = { get, ensure, set, clearFlow, remove, pushHistory, sweep, missingSlots, SESSIONS };
