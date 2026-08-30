'use strict';
/**
 * 微信智能工作台 —— 服务端入口
 * 零依赖（只用 node 内置模块），单进程即可跑。
 *
 *   GET  /wechat           微信服务器验证（验签回显 echostr）
 *   POST /wechat           接收微信消息 / 菜单点击事件
 *   GET  /healthz          健康检查
 *   POST /api/bind-code    工作台申领绑定码        （需 X-Api-Key）
 *   GET  /api/state        工作台拉取数据          （需 X-Api-Key）
 *   PUT  /api/state        工作台推送数据          （需 X-Api-Key）
 *   POST /api/menu/create  创建微信底部快捷菜单     （需 X-Api-Key）
 *   POST /api/sim          本地模拟一条消息（仅当 allowSim=true）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const wx = require('./lib/wx');
const store = require('./lib/store');
const session = require('./lib/session');
const nlu = require('./lib/nlu');
const tools = require('./lib/tools');
const ocr = require('./lib/ocr');
const D = require('./lib/dates');

/* ---------------- 配置 ---------------- */
const ROOT = path.join(__dirname, '..');
function loadConfig() {
  // 云部署支持：环境变量 WB_CONFIG_JSON 直接注入完整配置（密钥不进镜像）
  if (process.env.WB_CONFIG_JSON) {
    try { return JSON.parse(process.env.WB_CONFIG_JSON); }
    catch (e) { console.error('[config] WB_CONFIG_JSON 解析失败: ' + e.message); return null; }
  }
  const p = process.env.WB_CONFIG || path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) {
    console.error('[config] 找不到 ' + p + '，请先复制 config.example.json 并填写。');
    return null;
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error('[config] 解析失败: ' + e.message); return null; }
}
const CFG = loadConfig();
if (!CFG) process.exit(1);

nlu.setLlm(CFG.llm || null);

// 云平台（Claw Cloud 等）通过 PORT 环境变量指定端口，优先级最高
const PORT = Number(process.env.PORT) || Number(CFG.port) || 3000;
const API_KEY = CFG.apiKey || '';
if (!API_KEY) console.warn('[warn] 未配置 apiKey，/api/* 接口将全部拒绝（这是安全的默认行为）');

/* ---------------- 底部快捷菜单 ---------------- */
const MENU_DEF = {
  button: [
    { type: 'click', name: '今天', key: 'CMD:today' },
    { type: 'click', name: '记一笔', key: 'CMD:expense' },
    {
      name: '更多',
      sub_button: [
        { type: 'click', name: '待办任务', key: 'CMD:task.list' },
        { type: 'click', name: '本月收支', key: 'CMD:money.summary' },
        { type: 'click', name: '习惯打卡', key: 'CMD:habit.list' },
        { type: 'click', name: '全部指令', key: 'CMD:menu' },
        { type: 'click', name: '帮助', key: 'CMD:help' }
      ]
    }
  ]
};
function createMenu() {
  return wx.getAccessToken(CFG.wechat).then(token =>
    wx.httpsJson('https://api.weixin.qq.com/cgi-bin/menu/create?access_token=' + encodeURIComponent(token), { body: MENU_DEF })
  );
}

/* ---------------- 消息去重 ---------------- */
const SEEN = new Map();
function seenBefore(id) {
  if (!id) return false;
  const now = Date.now();
  if (now - (SEEN.get(id) || 0) < 10 * 60 * 1000) return true;
  SEEN.set(id, now);
  // 简单清理，避免无限增长
  if (SEEN.size > 5000) SEEN.forEach((t, k) => { if (now - t > 10 * 60 * 1000) SEEN.delete(k); });
  return false;
}

/* ---------------- 回复渲染 ---------------- */
function render(res, menu) {
  let text = String(res.text || '已处理。');
  if (menu && menu.length) {
    text += '\n\n快捷指令：\n' + menu.slice(0, 3).map(m => '· ' + m).join('\n');
  }
  // 微信单条文本建议控制在 600 字内
  if (text.length > 600) text = text.slice(0, 590) + '\n…（内容较长，可到工作台查看完整列表）';
  return text;
}
function renderClarify(c) {
  if (c.reason === 'empty') return c.msg;
  let t = c.msg || '请选择一个：';
  (c.options || []).forEach(o => { t += '\n' + o.n + '. ' + o.text; });
  return t + '\n\n回复序号即可，或回复「取消」。';
}

/* ---------------- 核心：处理一条用户消息 ---------------- */
let LAST_VIA = 'wechat', LAST_TEXT = '';
async function handleMessage(msg) {
  const out = await handleMessageRaw(msg);
  // 语音场景回显识别结果：识别错了用户能立刻发现并纠正，这是信任的关键
  if (LAST_VIA === 'voice' && out && !/^(收到|欢迎|还没有绑定)/.test(out)) {
    return '【语音】' + LAST_TEXT + '\n\n' + out;
  }
  return out;
}

async function handleMessageRaw(msg) {
  const openid = msg.FromUserName;
  const key = openid;
  const t0 = Date.now();
  session.pushHistory(key, 'user', msg.Content || ('[' + msg.MsgType + ']' + (msg.Event || '') + (msg.EventKey || '')));

  // 菜单点击事件 → 转成指令文本
  let text = String(msg.Content == null ? '' : msg.Content).trim();
  let viaVoice = false;
  if (msg.MsgType === 'event' && msg.Event === 'CLICK' && /^CMD:/.test(String(msg.EventKey || ''))) {
    text = String(msg.EventKey).slice(4);
    if (text === 'expense') text = '记一笔';
  } else if (msg.MsgType === 'event' && msg.Event === 'subscribe') {
    return '欢迎使用智能工作台 👋\n' +
      '先在工作台（网页）→ 设置 → 微信绑定 里拿一个 6 位绑定码，\n' +
      '直接发给我，例如：绑定 123456\n\n' +
      '绑定后就能这样用：\n· 记一笔 68 餐饮\n· 今天要处理什么\n· 完成季度复盘';
  } else if (msg.MsgType === 'voice') {
    // 微信自带语音识别：开通后结果就在 Recognition 字段里，不需要自建 ASR
    const rec = String(msg.Recognition || '').trim();
    if (!rec) {
      return '收到语音了，但没读到文字。\n\n' +
        '需要先在公众号后台开通「语音识别」：\n' +
        '公众号后台 → 添加功能插件 → 语音识别 → 开启\n\n' +
        '开通后直接说「记一笔六十八餐饮」就行。在那之前可以先发文字，或回复「菜单」。';
    }
    text = rec;
    viaVoice = true;
  } else if (msg.MsgType === 'image') {
    return '收到图片了。\n\n' +
      '票据、发票、付款截图的识别，请到工作台网页 → 工资 → 拍照记账 上传，' +
      '那里会自动做模糊 / 反光检测并预填字段，照片只存在你自己的设备上。\n\n' +
      '识别完之后，在这里用文字查询和修改都可以，比如「本月收支」。';
  } else if (msg.MsgType !== 'text') {
    return '目前支持文字和语音消息。可以试试发「菜单」看看能做什么。';
  }
  if (!text) return '没听清，可以说「菜单」看看能做什么。';

  LAST_VIA = viaVoice ? 'voice' : 'wechat';
  LAST_TEXT = text;
  const VIA = LAST_VIA;

  const s = session.ensure(key);

  /* --- 1. 未绑定：只响应绑定码 --- */
  if (!s.uid) {
    const bound = store.findByOpenid(openid);
    if (bound) s.uid = bound;
  }
  if (!s.uid) {
    // 只有「绑定 123456」或纯 6 位码才当作绑定请求，否则给引导，不要回「绑定码不对」
    const m = /(?:绑定)?\s*(\d{6})\s*$/.exec(text);
    const isBindAttempt = /绑定/.test(text) || /^\d{6}$/.test(text.trim());
    if (!isBindAttempt) {
      store.audit({ uid: '-', action: 'msg.unbound', target: text, via: VIA, openid });
      return '还没有绑定工作台账号。\n\n' +
        '1. 打开工作台网页 → 设置 → 微信绑定 → 点「生成绑定码」\n' +
        '2. 把 6 位数字发给我，例如：绑定 123456\n\n' +
        '绑定码 5 分钟内有效。';
    }
    const tool = tools.TOOLS.filter(t => t.name === 'bind')[0];
    const r = tool.run({ uid: null, data: store.emptyUser(), openid, via: VIA }, { code: m ? m[1] : '' });
    if (r.bound) { s.uid = store.findByOpenid(openid); session.clearFlow(key); }
    store.audit({ uid: s.uid || '-', action: 'msg', target: text, via: VIA, openid, bound: !!s.uid });
    return render(r, r.menu);
  }

  const data = store.userData(s.uid);
  const ctx = { uid: s.uid, data, openid, via: VIA };

  /* --- 2. 二次确认中 --- */
  if (s.confirm) {
    if (/^(是|y|yes|确认|确定|好的|嗯|ok|没错|执行)$/i.test(text)) {
      const c = s.confirm;
      session.clearFlow(key);
      const tool = tools.TOOLS.filter(t => t.name === c.tool)[0];
      const r = tool.run(ctx, c.slots);
      store.audit({ uid: s.uid, action: 'confirm.run', target: c.tool, via: VIA });
      return post(r, key, s, ctx, c.tool, c.slots);
    }
    if (/^(取消|算了|不|no|别了)$/i.test(text)) {
      session.clearFlow(key);
      return '已取消，什么都没改。';
    }
  }

  /* --- 3. 模糊澄清中（回复序号） --- */
  if (s.clarify && /^[1-9]$/.test(text)) {
    const n = parseInt(text, 10) - 1;
    const opt = (s.clarify.options || [])[n];
    if (opt) {
      const c = s.clarify;
      session.clearFlow(key);
      const tool = tools.TOOLS.filter(t => t.name === c.tool)[0];
      const slots = Object.assign({}, c.slots, { [c.resolveKey]: opt.text, title: opt.text });
      const r = tool.run(ctx, slots);
      return post(r, key, s, ctx, c.tool, c.slots);
    }
  }

  /* --- 4. 槽位补全中：用这条消息补缺失参数 --- */
  if (s.pending) {
    const p = s.pending;
    const tool = tools.TOOLS.filter(t => t.name === p.tool)[0];
    const merged = Object.assign({}, p.slots, extractByMissing(text, p.missing));
    const still = session.missingSlots(tool, merged);
    if (still.length) {
      s.pending = { tool: p.tool, slots: merged, missing: still.map(x => x.key), at: Date.now() };
      return '还差一步：' + still[0].ask;
    }
    session.clearFlow(key);
    const r = tool.run(ctx, merged);
    return post(r, key, s, ctx, p.tool, merged);
  }

  /* --- 5. 正常意图识别 --- */
  let rec;
  try {
    rec = await nlu.recognize(text, s, tools.TOOLS, CFG.nlu || {});
  } catch (e) {
    rec = nlu.ruleRecognize(text);
    rec.tool = nlu.pickTool(rec);
  }
  const tool = tools.TOOLS.filter(t => t.name === rec.tool)[0];
  if (!tool) {
    store.audit({ uid: s.uid, action: 'unrecognized', target: text, via: VIA });
    return '没太理解这句。可以这样说：\n· 记一笔 68 餐饮\n· 今天要处理什么\n· 完成季度复盘\n\n回复「菜单」看全部能力。';
  }

  const slots = Object.assign({}, rec.slots);
  (tool.slots || []).forEach(sd => { if (sd.default != null && slots[sd.key] == null) slots[sd.key] = sd.default; });

  // 必填槽位缺失 → 追问
  const miss = session.missingSlots(tool, slots);
  if (miss.length) {
    s.pending = { tool: tool.name, slots, missing: miss.map(x => x.key), at: Date.now() };
    store.audit({ uid: s.uid, action: 'clarify', target: tool.name + ':' + miss.map(x => x.key).join(','), via: VIA });
    return '好的，' + miss[0].ask;
  }

  // 敏感操作 → 二次确认
  if (tool.sensitive) {
    s.confirm = { tool: tool.name, slots, at: Date.now() };
    store.audit({ uid: s.uid, action: 'confirm.ask', target: tool.name, via: VIA });
    const preview = describeTarget(tool.name, slots);
    return '确认要' + tool.desc + '吗？\n' + preview + '\n\n回复「确认」执行，回复「取消」放弃。';
  }

  let r;
  try {
    r = tool.run(ctx, slots);
  } catch (e) {
    store.audit({ uid: s.uid, action: 'error', target: tool.name, via: VIA, err: e.message });
    return '执行时出错了：' + e.message + '\n数据没有改动，可以再试一次，或回复「菜单」。';
  }
  const out = post(r, key, s, ctx, tool.name, slots);
  store.audit({ uid: s.uid, action: 'run', target: tool.name, via: VIA, ms: Date.now() - t0, ok: !!(r && r.ok) });
  return out;
}

/** 执行后的统一后处理：处理模糊澄清 / 失败提示 */
function post(r, key, s, ctx, toolName, slots) {
  if (!r) return '处理完成。';
  if (r.ok) {
    session.clearFlow(key);
    session.pushHistory(key, 'assistant', r.text);
    return render(r, r.menu);
  }
  if (r.needClarify) {
    const c = r.needClarify;
    if (c.reason === 'ambiguous' && c.options && c.options.length) {
      // 记住当前工具与已填槽位，用户回序号后能接着执行
      s.clarify = { tool: toolName, options: c.options, slots: slots || {}, resolveKey: 'title', at: Date.now() };
    } else {
      session.clearFlow(key);
    }
    return renderClarify(c);
  }
  if (r.needSlots) {
    s.pending = { tool: r.needSlots.tool || toolName, slots: r.needSlots.slots || slots || {}, missing: r.needSlots.missing || [], at: Date.now() };
    return r.needSlots.ask || '还差一点信息。';
  }
  session.clearFlow(key);
  return '没做成：' + (r.msg || '未知原因') + '\n可以换个说法再试，或回复「菜单」。';
}
/** 追问时，按缺失字段类型从用户回复里抽取 */
function extractByMissing(text, missingKeys) {
  const out = {};
  const keys = missingKeys || [];
  if (keys.indexOf('amount') >= 0) { const v = D.parseAmount(text); if (v != null) out.amount = v; }
  if (keys.indexOf('date') >= 0) { const v = D.parseDate(text); if (v) out.date = v; }
  if (keys.indexOf('minutes') >= 0) { const v = D.parseMinutes(text); if (v != null) out.minutes = v; }
  if (keys.indexOf('progress') >= 0) { const m = /(\d+)/.exec(text); if (m) out.progress = +m[1]; }
  if (keys.indexOf('category') >= 0) {
    const cats = ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '人情', '其他'];
    cats.forEach(c => { if (text.indexOf(c) >= 0) out.category = c; });
  }
  if (keys.indexOf('title') >= 0) {
    let t = text.replace(/^(是|确认|好的|嗯)+\s*/i, '').trim();
    if (t) out.title = t;
  }
  return out;
}
function describeTarget(toolName, slots) {
  const t = String(slots.title || slots.category || slots.name || '').slice(0, 30);
  return t ? '　对象：' + t : '';
}

/* ---------------- HTTP ---------------- */
function readBody(req, limit) {
  limit = limit || 4 * 1024 * 1024;   // 够放下压缩后的票据图（≤2.2MB base64）
  return new Promise((resolve, reject) => {
    let buf = '';
    let over = false;
    req.on('data', c => {
      if (over) return;               // 超限后继续读完，避免直接断连导致对端收到 ECONNRESET
      buf += c;
      if (Buffer.byteLength(buf) > limit) {
        over = true;
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
      }
    });
    req.on('end', () => { if (!over) resolve(buf); });
    req.on('error', e => { if (!over) reject(e); });
  });
}
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function checkApi(req) {
  if (!API_KEY) return false;
  return req.headers['x-api-key'] === API_KEY;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  try {
    /* ---- 微信服务器验证 ---- */
    if (p === '/wechat' && req.method === 'GET') {
      const { signature, timestamp, nonce, echostr } = Object.fromEntries(u.searchParams);
      if (wx.checkSignature(CFG.wechat.token, signature, timestamp, nonce)) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(echostr || '');
      }
      res.writeHead(403); return res.end('forbidden');
    }

    /* ---- 接收微信消息 ---- */
    if (p === '/wechat' && req.method === 'POST') {
      const raw = await readBody(req);
      // 验签（微信 POST 也会带 signature）
      if (CFG.wechat.strictVerify !== false) {
        const { signature, timestamp, nonce } = Object.fromEntries(u.searchParams);
        if (!wx.checkSignature(CFG.wechat.token, signature, timestamp, nonce)) {
          res.writeHead(403); return res.end('forbidden');
        }
      }
      const msg = wx.parseXml(raw);
      if (seenBefore(msg.MsgId || (msg.FromUserName + msg.CreateTime))) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('success');
      }

      // 微信的 5 秒窗口从它「发出」起算：入隧道耗时 + 处理耗时 + 回隧道耗时都要算进去。
      // CreateTime 是秒级时间戳，有 ±1s 误差，故预算收紧到 1.5s。
      const ageMs = Date.now() - (Number(msg.CreateTime) * 1000 || Date.now());
      console.log('[msg] ' + (msg.MsgType || '?') + ' from=' + (msg.FromUserName || '?') +
        ' age=' + (ageMs / 1000).toFixed(1) + 's' +
        (msg.Content ? ' text="' + String(msg.Content).slice(0, 30) + '"' : '') +
        (msg.Recognition ? ' voice="' + String(msg.Recognition).slice(0, 30) + '"' : '') +
        (msg.EventKey ? ' event=' + msg.EventKey : ''));

      let reply = '';
      try {
        reply = await handleMessage(msg);
      } catch (e) {
        console.error('[handle] ' + e.stack);
        reply = '服务开小差了，请稍后再试。如果一直不行，回复「菜单」看看还能用哪些功能。';
        store.audit({ uid: '-', action: 'fatal', target: String(e.message), via: VIA });
      }

      // 链路快才走被动回复；否则立刻回 success，改走客服消息（服务端直连微信 API，不经过隧道）
      const passiveOk = ageMs < 1500 && (Date.now() - (Number(msg.CreateTime) * 1000 || Date.now())) < 1500;
      if (reply && passiveOk) {
        console.log('[reply] passive');
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(wx.buildTextXml(msg.FromUserName, msg.ToUserName, reply));
      }
      console.log('[reply] customer-service (age ' + (ageMs / 1000).toFixed(1) + 's)');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('success');
      if (reply) {
        wx.sendCustomText(CFG.wechat, msg.FromUserName, reply).catch(e => {
          console.error('[custom] 客服消息发送失败: ' + e.message);
        });
      }
      return;
    }

    /* ---- 健康检查 ---- */
    if (p === '/healthz') {
      return json(res, 200, {
        ok: true, users: store.listUsers().length,
        sessions: session.SESSIONS.size,
        llm: !!(CFG.llm && CFG.llm.endpoint),
        time: new Date().toISOString()
      });
    }

    /* ---- 工作台：申领绑定码 ---- */
    if (p === '/api/bind-code' && req.method === 'POST') {
      if (!checkApi(req)) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const uid = store.ensureUser(body.uid);
      const r = store.genBindCode(uid);
      store.audit({ uid, action: 'bindcode.issue', via: 'api' });
      return json(res, 200, { uid, code: r.code, exp: r.exp, ttlSec: Math.round((r.exp - Date.now()) / 1000) });
    }

    /* ---- 工作台：拉取数据 ---- */
    if (p === '/api/state' && req.method === 'GET') {
      if (!checkApi(req)) return json(res, 401, { error: 'unauthorized' });
      const uid = store.ensureUser(u.searchParams.get('uid'));
      const d = store.userData(uid);
      return json(res, 200, { uid, modules: store.pullModules(uid), ts: (d.meta && d.meta.ts) || {} });
    }

    /* ---- 工作台：推送数据 ---- */
    if (p === '/api/state' && req.method === 'PUT') {
      if (!checkApi(req)) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const uid = store.ensureUser(body.uid);
      const changed = store.pushModules(uid, { ts: body.ts || {}, ...(body.modules || {}) });
      store.audit({ uid, action: 'state.push', target: changed.join(','), via: 'api' });
      const d = store.userData(uid);
      return json(res, 200, { uid, changed, ts: (d.meta && d.meta.ts) || {} });
    }

    /* ---- 创建微信底部菜单 ---- */
    if (p === '/api/menu/create' && req.method === 'POST') {
      if (!checkApi(req)) return json(res, 401, { error: 'unauthorized' });
      await createMenu();
      return json(res, 200, { ok: true, menu: MENU_DEF });
    }

    /* ---- 本地模拟器（默认关闭） ---- */
    if (p === '/api/sim' && req.method === 'POST') {
      if (CFG.allowSim !== true) return json(res, 404, { error: 'not found' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const reply = await handleMessage({
        FromUserName: body.openid || 'sim_user',
        ToUserName: 'gh_sim', MsgType: 'text', Content: String(body.text || ''),
        CreateTime: Math.floor(Date.now() / 1000), MsgId: 'sim_' + Date.now() + Math.random()
      });
      return json(res, 200, { reply });
    }

    /* ---- 票据识别（工作台拍照记账调用） ---- */
    if (p === '/api/ocr' && req.method === 'POST') {
      if (!checkApi(req)) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const uid = store.ensureUser(body.uid);
      const img = String(body.image || '');
      const b64 = img.indexOf(',') >= 0 ? img.slice(img.indexOf(',') + 1) : img;
      // 图片体积护栏：约 2.2MB base64 ≈ 1.6MB 原图，超过说明前端没压缩
      if (!b64 || b64.length > 2200000) return json(res, 413, { error: 'image_too_large', limit: 2200000 });
      const d = store.userData(uid);
      const out = await ocr.recognize(CFG.ocr || { provider: 'none' }, b64,
        (d.money && d.money.rules) || []);
      store.audit({ uid, action: 'ocr', target: out.status, via: 'api',
        provider: out.provider, ms: out.latencyMs, err: out.errCode });
      return json(res, 200, out);
    }

    /* ---- 审计日志（需鉴权） ---- */
    if (p === '/api/audit' && req.method === 'GET') {
      if (!checkApi(req)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { logs: store.readAudit(Number(u.searchParams.get('limit')) || 100) });
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (e && e.statusCode === 413) {
      try { return json(res, 413, { error: 'body_too_large' }); } catch (_) { return; }
    }
    console.error('[http] ' + e.stack);
    try { json(res, 500, { error: 'internal', message: String(e.message) }); } catch (_) {}
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('[server] 监听 http://0.0.0.0:' + PORT);
    console.log('[server] 微信回调地址  http://<你的域名>/wechat');
    console.log('[server] 健康检查      http://127.0.0.1:' + PORT + '/healthz');
    if (!CFG.wechat || !CFG.wechat.token) console.warn('[warn] 未配置 wechat.token');
  });
  const bye = () => { console.log('\n[server] 正在退出，写盘…'); store.flush(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { server, handleMessage, createMenu, MENU_DEF, CFG };
