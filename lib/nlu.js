'use strict';
/**
 * 意图识别：规则优先 + LLM 兜底（可插拔）
 * 规则层零成本、零延迟、可预期；规则拿不准时再交给 LLM。
 * 输出统一为 { intent, object, tool, slots, confidence, by }
 */
const D = require('./dates');

/* ---------------- 意图词 ---------------- */
const INTENT_RULES = [
  { intent: 'bind',   re: /^(绑定|绑定账号|绑定微信)\b|^\s*绑定\s*\d{4,8}\s*$|绑定\s+\d{4,8}/ },
  { intent: 'unbind', re: /解绑|取消绑定|解除绑定|退出登录|登出/ },
  { intent: 'help',   re: /^(帮助|help|怎么用|能做什么|会什么|指令|命令|功能)\s*[?？。.]*$|怎么玩|如何操作/ },
  { intent: 'menu',   re: /^(菜单|功能列表|指令列表|常用指令)\s*$/ },
  { intent: 'cancel', re: /^(取消|算了|不用了|退出|别了|停止)\s*[。.!！]?$/ },
  { intent: 'confirm',re: /^(是|yes|y|确认|确定|好的|对的|嗯|ok|OK|没错|就这[样个]|执行)\s*[。.!！]?$/i },
  { intent: 'create', re: /(记一下|记一笔|记个|记录|新增|添加|加个|加一条|创建|新建|买了个|买了|花了|付了|消费|支出|收入|收到|到账|加钱)/ },
  { intent: 'complete', re: /(完成|搞定|做完|做了|结束|打卡|勾掉|划掉|办完)/ },
  { intent: 'delete', re: /(删除|删掉|去掉|移除|干掉)/ },
  { intent: 'update', re: /(修改|改成|改为|更新|调整|换个时间|改一下)/ },
  { intent: 'query',  re: /(查|看看|有哪些|有什么|多少|汇总|统计|列一下|清单|今天要|待办|提醒|几号|什么时候)/ }
];

/* ---------------- 对象词（顺序即优先级） ---------------- */
const OBJECT_RULES = [
  { object: 'budget', re: /(预算)/ },
  { object: 'income', re: /(收入|工资|到账|报销|奖金|进账)/ },
  { object: 'expense',re: /(支出|花了|花销|消费|买了个|买了|付了|账单|花掉)/ },
  { object: 'habit',  re: /(习惯|打卡)/ },
  { object: 'chore',  re: /(家务|洗碗|倒垃圾|拖地|打扫)/ },
  { object: 'anniv',  re: /(纪念|生日|周年)/ },
  { object: 'course', re: /(课程|课时|学到第)/ },
  { object: 'study',  re: /(学习|作业|背书|单词|复习|预习)/ },
  { object: 'project',re: /(项目|进度)/ },
  { object: 'event',  re: /(日程|安排|会议|开会|约会|行程)/ },
  { object: 'memo',   re: /(备忘|备注|笔记)/ },
  { object: 'money',  re: /(记账|账本|财务|收支|结余)/ },
  { object: 'task',   re: /(任务|待办|todo|事项)/i }
];

/* ---------------- 槽位抽取 ---------------- */
function extractSlots(text) {
  const s = {};
  const raw = String(text || '');

  const date = D.parseDate(raw);
  if (date) s.date = date;

  const amt = D.parseAmount(raw);
  if (amt != null) s.amount = amt;

  const min = D.parseMinutes(raw);
  if (min != null) s.minutes = min;

  // 进度 / 课时：只认“进度、完成、课时、改为、改成、更新为”附近的数字，避免误吞金额
  const pm = /(?:进度|完成|已完成|课时|改为|改成|更新为|调整到)\D{0,4}(\d{1,3})\s*%?/.exec(raw)
          || /(\d{1,3})\s*%/.exec(raw);
  if (pm) s.progress = parseInt(pm[1], 10);

  // 分类
  const cats = ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '人情', '其他'];
  for (const c of cats) if (raw.indexOf(c) >= 0) { s.category = c; break; }

  // 收入来源
  const srcs = ['工资', '奖金', '兼职', '理财', '报销'];
  for (const c of srcs) if (raw.indexOf(c) >= 0) { s.source = c; break; }

  // 优先级
  if (/P0|紧急|急|马上|立刻/.test(raw)) s.priority = 'P0 紧急';
  else if (/P1|重要/.test(raw)) s.priority = 'P1 重要';
  else if (/P2|一般|不急/.test(raw)) s.priority = 'P2 一般';

  // 成员（家庭模块）
  const who = /(爸爸|妈妈|孩子|宝宝|全家|老婆|老公|我)\s*(?:负责|做|去)?/.exec(raw);
  if (who) s.owner = who[1];

  // 商家： “在XX花了” / “XX 花了” / 结尾的名词
  let merchant = null;
  let m = /在\s*([^\s，,。了]{1,12}?)\s*(?:花|买|消费|付)/.exec(raw);
  if (m) merchant = m[1];
  if (!merchant) { m = /(?:给|还)\s*([^\s，,。]{1,12}?)\s*\d/.exec(raw); if (m) merchant = m[1]; }
  if (merchant) s.merchant = merchant;

  // 标题：去掉日期/金额/意图词后的剩余文本
  let title = raw
    .replace(/(今天|明天|后天|大后天|昨天|下周|本周)/g, '')
    .replace(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})日?/g, '')
    .replace(/(\d{1,2})[月/-](\d{1,2})[日号]?/g, '')
    .replace(/(?:￥|¥)?\s*\d+(?:\.\d{1,2})?\s*(?:元|块钱|块)?/g, '')
    .replace(/(记一下|记一笔|记个|记录|新增|添加|加个|加一条|创建|新建|买了个|买了|花了|付了|消费|支出|收入|收到|到账|加钱)/g, '')
    .replace(/(完成|搞定|做完|做了|结束|打卡|勾掉|划掉|办完|删除|删掉|去掉|移除|修改|改成|改为|更新|调整|改一下)/g, '')
    .replace(/(查|看看|有哪些|有什么|列一下|清单|汇总|统计)/g, '')
    .replace(/(任务|待办|日程|安排|会议|项目|课程|学习|家务|纪念|生日|备忘|习惯|预算|支出|收入|账单)/g, '')
    .replace(/(一下|一个|一条|个|的|了|吧|呢|请|帮我|我要|我想|给我)/g, '')
    .replace(/[,，。.!！?？\s]+/g, ' ')
    .trim();
  if (title && title.length >= 1) s.title = title;
  return s;
}

/* ---------------- 规则识别 ---------------- */
function ruleRecognize(text) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'unknown', object: null, slots: {}, confidence: 0, by: 'rule' };

  let intent = null;
  for (const r of INTENT_RULES) { if (r.re.test(raw)) { intent = r.intent; break; } }
  let object = null;
  for (const r of OBJECT_RULES) { if (r.re.test(raw)) { object = r.object; break; } }

  const slots = extractSlots(raw);
  let confidence = 0;
  if (intent) confidence += 0.5;
  if (object) confidence += 0.3;
  if (slots.title) confidence += 0.1;
  if (slots.date || slots.amount) confidence += 0.1;
  if (!intent && !object) confidence = 0.15;

  // intent 保持可空：pickTool 需要区分「没识别出意图」和「识别出查询意图」
  return { intent: intent, object, slots, raw, hit: !!(intent || object), confidence: Math.min(confidence, 0.95), by: 'rule' };
}

/* ---------------- 意图 → 工具 ---------------- */
function pickTool(r) {
  const { intent, object, slots } = r;
  if (intent === 'bind')    return 'bind';
  if (intent === 'unbind')  return 'unbind';
  if (intent === 'help')    return 'help';
  if (intent === 'menu')    return 'menu';
  if (intent === 'cancel')  return 'cancel';
  if (intent === 'confirm') return 'confirm';

  if (intent === 'create') {
    if (object === 'expense') return 'expense.create';
    if (object === 'income')  return 'income.create';
    if (object === 'memo')    return 'memo.create';
    if (object === 'study') {
      // “记录学习 45 分钟” 记时长；“新增学习任务 背单词” 记任务
      return (slots.minutes || !slots.title) ? 'study.log' : 'study.create';
    }
    if (object === 'habit')   return 'habit.create';
    if (object === 'event')   return 'event.create';
    if (object === 'anniv')   return 'anniv.create';
    if (object === 'chore')   return 'chore.create';
    if (object === 'budget')  return 'budget.create';
    if (object === 'task')    return 'task.create';
    if (object === 'project') return 'task.create';
    if (slots.amount && (slots.category || slots.merchant)) return 'expense.create';
    // “记一笔”没带对象也没带内容时，默认是记账（最常见）；有对象时按对象走
    if (!object && !slots.title) return 'expense.create';
    return object ? 'expense.create' : 'task.create';
  }
  if (intent === 'complete') {
    if (object === 'habit')  return 'habit.check';
    if (object === 'chore')  return 'chore.done';
    if (object === 'study')  return 'study.done';
    return 'task.done';
  }
  if (intent === 'delete') {
    if (object === 'budget') return 'budget.delete';
    return 'item.delete';
  }
  if (intent === 'update') {
    if (object === 'project') return 'project.update';
    if (object === 'course')  return 'course.update';
    return 'item.update';
  }
  // query
  if (object === 'budget')  return 'budget.list';
  if (object === 'money')   return 'money.summary';
  if (object === 'income')  return 'money.summary';
  if (object === 'expense') return 'expense.list';
  if (object === 'habit')   return 'habit.list';
  if (object === 'chore')   return 'chore.list';
  if (object === 'anniv')   return 'anniv.list';
  if (object === 'course')  return 'course.list';
  if (object === 'study')   return 'study.list';
  if (object === 'project') return 'project.list';
  if (object === 'event')   return 'event.list';
  if (object === 'memo')    return 'memo.list';
  if (object === 'task')    return 'task.list';
  if (/今天要|待办|有什么事|今天做/.test(String(r.raw || ''))) return 'today';
  // 完全没识别出意图和对象：给帮助，而不是默认当成“查任务”
  if (!r.hit && !r.intent) return 'help';
  return 'task.list';
}

/* ---------------- LLM 兜底（可选） ---------------- */
let LLM = null;   // {endpoint, apiKey, model, timeoutMs}

function setLlm(cfg) { LLM = cfg && cfg.endpoint ? cfg : null; }

function llmClassify(text, ctx, tools) {
  if (!LLM) return Promise.resolve(null);
  const catalog = tools.map(t => ({
    name: t.name, desc: t.desc,
    slots: (t.slots || []).map(s => ({ key: s.key, desc: s.desc, required: !!s.required, values: s.values || null }))
  }));
  const body = {
    model: LLM.model || 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content:
        '你是工作台助手。把用户的话解析成结构化指令，只输出 JSON，不要解释。\n' +
        '可选工具：' + JSON.stringify(catalog) + '\n' +
        '输出格式：{"tool":"工具名","slots":{...},"confidence":0-1}。\n' +
        '无法确定工具时用 {"tool":"help","slots":{},"confidence":0}。\n' +
        '日期一律转 YYYY-MM-DD，今天基准是 ' + D.today() + '。' },
      { role: 'user', content: String(text) }
    ]
  };
  const https = require('https');
  const { URL } = require('url');
  return new Promise(resolve => {
    let u;
    try { u = new URL(LLM.endpoint); } catch (e) { return resolve(null); }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': payload.length,
        'Authorization': 'Bearer ' + (LLM.apiKey || '')
      },
      timeout: LLM.timeoutMs || 12000
    }, res => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          let content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!content && j.content) content = j.content[0] && j.content[0].text;   // 兼容 Anthropic 风格
          content = String(content || '').replace(/```json|```/g, '').trim();
          const o = JSON.parse(content);
          if (!o || !o.tool) return resolve(null);
          resolve({ tool: o.tool, slots: o.slots || {}, confidence: Number(o.confidence) || 0.7, by: 'llm' });
        } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(payload); req.end();
  });
}

/* ---------------- 对外入口 ---------------- */
function recognize(text, ctx, tools, cfg) {
  const r = ruleRecognize(text);
  r.raw = text;
  const toolName = pickTool(r);
  const tool = (tools || []).filter(t => t.name === toolName)[0] || null;
  const base = { intent: r.intent || 'query', object: r.object, tool: toolName, slots: r.slots, confidence: r.confidence, by: 'rule' };

  const needLlm = cfg && cfg.llmFallback !== false && LLM &&
                  (r.confidence < (cfg.ruleThreshold || 0.5) || !tool);
  if (!needLlm) return Promise.resolve(base);

  return llmClassify(text, ctx, tools).then(o => {
    if (!o) return base;
    const t2 = (tools || []).filter(t => t.name === o.tool)[0];
    if (!t2) return base;
    // LLM 结果只在置信度更高时覆盖规则结果
    if (o.confidence >= r.confidence) {
      return { intent: r.intent, object: r.object, tool: o.tool, slots: Object.assign({}, r.slots, o.slots), confidence: o.confidence, by: 'llm' };
    }
    return base;
  });
}

module.exports = { recognize, ruleRecognize, pickTool, extractSlots, setLlm, llmClassify };
