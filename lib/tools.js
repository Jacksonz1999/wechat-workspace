'use strict';
/**
 * 能力层：把工作台现有功能封装成可被意图路由调度的工具。
 * 每个工具统一返回 { text, menu?, needSlots?, needConfirm?, needClarify?, ok }
 * —— 由 server.js 决定是执行、追问还是二次确认。
 */
const D = require('./dates');
const store = require('./store');

/* ---------------- 通用工具 ---------------- */
function touch(ctx, mod) {
  ctx.data.meta = ctx.data.meta || {};
  ctx.data.meta.ts = ctx.data.meta.ts || {};
  ctx.data.meta.ts[mod] = Date.now();
  store.save();
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/** 模糊匹配条目：返回按相关度排序的候选 */
function matchItems(list, keys, kw) {
  const q = String(kw || '').trim();
  if (!q) return [];
  const scored = [];
  list.forEach((it, i) => {
    let s = 0;
    keys.forEach(k => {
      const v = String(it[k] == null ? '' : it[k]);
      if (!v) return;
      if (v === q) s += 100;
      else if (v.toLowerCase().indexOf(q.toLowerCase()) >= 0) s += 45 + (q.length / v.length) * 20;
      else {
        let hit = 0, total = 0;
        for (const ch of q) { if (!ch.trim()) continue; total++; if (v.indexOf(ch) >= 0) hit++; }
        if (total) s += (hit / total) * 18;
      }
    });
    if (s > 10) scored.push({ it, i, s: Math.round(s) });
  });
  return scored.sort((a, b) => b.s - a.s);
}
/** 选出唯一结果；不唯一或没有则返回追问信息 */
function pickOne(list, keys, kw, label) {
  const cands = matchItems(list, keys, kw);
  if (!cands.length) {
    return { ok: false, reason: 'empty', msg: '没找到匹配的' + label + '：' + (kw || '(空)') };
  }
  // 分数接近 → 让用户选
  if (cands.length > 1 && cands[0].s - cands[1].s < 12) {
    return {
      ok: false, reason: 'ambiguous', msg: '“' + kw + '”匹配到多条' + label + '，回复序号选择：',
      options: cands.slice(0, 5).map((c, n) => ({ n: n + 1, text: String(c.it[keys[0]] || '(无标题)') }))
    };
  }
  return { ok: true, item: cands[0].it, index: cands[0].i };
}
function num(v, d) { const n = Number(v); return isFinite(n) ? n : (d == null ? 0 : d); }

/* ---------------- 卡片渲染（微信纯文本） ---------------- */
function line(a, b) { return '· ' + a + '：' + b; }
function bar(pct) {
  const n = Math.max(0, Math.min(100, Math.round(pct)));
  const full = Math.round(n / 10);
  return '[' + '█'.repeat(full) + '░'.repeat(10 - full) + '] ' + n + '%';
}
function joinMenu(items) { return '\n' + items.join('\n'); }

/* =========================================================
   工具定义
   ========================================================= */
const TOOLS = [];

function def(t) { TOOLS.push(t); return t; }

/* ---------------- 查询类 ---------------- */
def({
  name: 'today', desc: '查看今天要处理的事项（跨模块汇总，逾期优先）',
  group: '查询', slots: [],
  run(ctx) {
    const t = D.today(), out = [];
    ctx.data.work.tasks.forEach(x => { if (!x.done && x.due && x.due <= t) out.push({ tag: '工作', txt: x.title, due: x.due }); });
    ctx.data.work.events.forEach(x => { if (!x.done && x.date && x.date <= t) out.push({ tag: '日程', txt: x.title, due: x.date }); });
    ctx.data.study.tasks.forEach(x => { if (!x.done && x.due && x.due <= t) out.push({ tag: '学习', txt: x.title, due: x.due }); });
    ctx.data.family.events.forEach(x => { if (!x.done && x.date && x.date <= t) out.push({ tag: '家庭', txt: x.title, due: x.date }); });
    ctx.data.family.chores.forEach(x => { if (x.last !== t) out.push({ tag: '家务', txt: x.name + '（' + (x.owner || '未分配') + '）', due: t }); });
    ctx.data.life.habits.forEach(x => { if (!((x.hist || []).indexOf(t) >= 0)) out.push({ tag: '习惯', txt: x.name, due: t }); });
    ctx.data.family.anniv.forEach(x => {
      const p = String(x.date || '').split('-');
      if (p.length < 3) return;
      const y = new Date().getFullYear();
      let nd = new Date(y, +p[1] - 1, +p[2]);
      if (D.dayDiff(D.fmt(nd), t) < 0) nd = new Date(y + 1, +p[1] - 1, +p[2]);
      const ds = D.fmt(nd), days = D.dayDiff(ds, t);
      if (days <= Number(x.remind || 7)) out.push({ tag: '纪念', txt: x.name, due: ds });
    });
    out.sort((a, b) => (a.due < b.due ? -1 : 1));
    if (!out.length) return { ok: true, text: '今天没有待处理事项，安排得不错。', menu: ['记一笔 68 餐饮', '今天有什么任务', '菜单'] };
    const lines = out.slice(0, 12).map(o => {
      const n = D.dayDiff(o.due, t);
      const flag = n < 0 ? '【逾期' + (-n) + '天】' : (n === 0 ? '【今天】' : '');
      return '[' + o.tag + '] ' + flag + o.txt;
    });
    const head = '今天要处理（' + out.length + ' 项）' + (out.length > 12 ? '，先显示 12 项' : '') + '\n';
    return { ok: true, text: head + joinMenu(lines), menu: ['完成 ' + out[0].txt.slice(0, 8), '记一笔', '菜单'] };
  }
});

def({
  name: 'task.list', desc: '查询工作任务', group: '查询',
  slots: [{ key: 'scope', desc: '范围', values: ['today', 'overdue', 'all', 'done'], default: 'today' }],
  run(ctx, a) {
    const scope = a.scope || 'today', t = D.today();
    let list = ctx.data.work.tasks.slice();
    if (scope === 'today') list = list.filter(x => !x.done && x.due && x.due <= t);
    else if (scope === 'overdue') list = list.filter(x => !x.done && x.due && x.due < t);
    else if (scope === 'done') list = list.filter(x => x.done);
    else list = list.filter(x => !x.done);
    list.sort((x, y) => (x.due || '9999') < (y.due || '9999') ? -1 : 1);
    if (!list.length) return { ok: true, text: '这个范围下没有任务。', menu: ['新增任务 整理周报', '今天要处理'] };
    const label = { today: '今天到期', overdue: '已逾期', all: '未完成', done: '已完成' }[scope];
    const lines = list.slice(0, 15).map((x, i) => {
      const n = x.due ? D.dayDiff(x.due, t) : null;
      const flag = n == null ? '' : (n < 0 ? '【逾期' + (-n) + '天】' : (n === 0 ? '【今天】' : '【' + D.md(x.due) + '】'));
      return (i + 1) + '. ' + flag + x.title + (x.pri ? '（' + x.pri + '）' : '');
    });
    return { ok: true, text: label + '（' + list.length + '）\n' + joinMenu(lines), menu: ['完成 ' + list[0].title.slice(0, 8), '新增任务', '菜单'] };
  }
});

def({
  name: 'event.list', desc: '查询日程安排', group: '查询', slots: [],
  run(ctx) {
    const t = D.today();
    const list = ctx.data.work.events.slice()
      .filter(x => !x.done && x.date && x.date >= t)
      .sort((a, b) => a.date < b.date ? -1 : 1);
    if (!list.length) return { ok: true, text: '近期没有日程。', menu: ['新增日程 明天 部门周会', '今天要处理'] };
    const lines = list.slice(0, 10).map(x => '· ' + D.dlName(x.date) + ' ' + (x.time || '全天') + '　' + x.title + (x.place ? '　@' + x.place : ''));
    return { ok: true, text: '近期日程\n' + joinMenu(lines), menu: ['新增日程', '菜单'] };
  }
});

def({
  name: 'project.list', desc: '查询项目进度', group: '查询', slots: [],
  run(ctx) {
    const list = ctx.data.work.projects || [];
    if (!list.length) return { ok: true, text: '还没有项目。', menu: ['新增项目', '菜单'] };
    const lines = list.map(p => '· ' + p.name + '　' + (p.stage || '') + '\n　' + bar(num(p.prog)));
    return { ok: true, text: '项目进度\n' + joinMenu(lines), menu: ['把 X 项目进度改为 80', '菜单'] };
  }
});

def({
  name: 'study.list', desc: '查询学习任务', group: '查询', slots: [],
  run(ctx) {
    const t = D.today();
    const list = ctx.data.study.tasks.filter(x => !x.done).sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1);
    if (!list.length) return { ok: true, text: '没有未完成的学习任务。', menu: ['记录学习 45 分钟', '菜单'] };
    const lines = list.slice(0, 10).map(x => '· ' + x.title + (x.subj ? '（' + x.subj + '）' : '') + (x.due ? '　' + D.dlName(x.due) : ''));
    return { ok: true, text: '学习任务\n' + joinMenu(lines), menu: ['记录学习 45 分钟', '菜单'] };
  }
});

def({
  name: 'course.list', desc: '查询课程进度', group: '查询', slots: [],
  run(ctx) {
    const list = ctx.data.study.courses || [];
    if (!list.length) return { ok: true, text: '还没有课程。', menu: ['新增课程', '菜单'] };
    const lines = list.map(c => {
      const tot = Math.max(1, num(c.total, 1)), dn = num(c.doneN);
      return '· ' + c.name + '　' + dn + '/' + tot + '\n　' + bar(dn / tot * 100);
    });
    return { ok: true, text: '课程进度\n' + joinMenu(lines), menu: ['记录学习 45 分钟', '菜单'] };
  }
});

def({
  name: 'chore.list', desc: '查询家务分工', group: '查询', slots: [],
  run(ctx) {
    const t = D.today(), list = ctx.data.family.chores || [];
    if (!list.length) return { ok: true, text: '还没有家务安排。', menu: ['新增家务', '菜单'] };
    const undone = list.filter(x => x.last !== t);
    const lines = list.map(x => (x.last === t ? '· ✓ ' : '· ○ ') + x.name + '　' + (x.owner || '未分配') + '　' + (x.freq || '每日'));
    return { ok: true, text: '家务（今日 ' + (list.length - undone.length) + '/' + list.length + '）\n' + joinMenu(lines), menu: undone.length ? ['完成 ' + undone[0].name, '菜单'] : ['菜单'] };
  }
});

def({
  name: 'anniv.list', desc: '查询纪念日倒计时', group: '查询', slots: [],
  run(ctx) {
    const list = (ctx.data.family.anniv || []).map(x => {
      const p = String(x.date || '').split('-');
      if (p.length < 3) return null;
      const y = new Date().getFullYear();
      let nd = new Date(y, +p[1] - 1, +p[2]);
      if (D.dayDiff(D.fmt(nd), D.today()) < 0) nd = new Date(y + 1, +p[1] - 1, +p[2]);
      const ds = D.fmt(nd);
      return { name: x.name, type: x.type || '纪念日', days: D.dayDiff(ds, D.today()), date: ds };
    }).filter(Boolean).sort((a, b) => a.days - b.days);
    if (!list.length) return { ok: true, text: '还没有纪念日。', menu: ['新增纪念日', '菜单'] };
    const lines = list.map(x => '· ' + x.name + '　' + (x.days === 0 ? '就是今天！' : x.days + ' 天后') + '（' + D.md(x.date) + '）');
    return { ok: true, text: '纪念日\n' + joinMenu(lines), menu: ['新增纪念日', '菜单'] };
  }
});

def({
  name: 'money.summary', desc: '查询本月收支汇总', group: '查询', slots: [],
  run(ctx) {
    const m = D.curYM();
    const inc = ctx.data.money.incomes.filter(e => D.ym(e.date) === m).reduce((a, b) => a + num(b.amt), 0);
    const exp = ctx.data.money.expenses.filter(e => D.ym(e.date) === m).reduce((a, b) => a + num(b.amt), 0);
    const byCat = {};
    ctx.data.money.expenses.filter(e => D.ym(e.date) === m).forEach(e => { byCat[e.cat] = (byCat[e.cat] || 0) + num(e.amt); });
    const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).slice(0, 5);
    let text = m + ' 收支\n' +
      line('收入', D.money0(inc)) + '\n' +
      line('支出', D.money0(exp)) + '\n' +
      line('结余', D.money0(inc - exp));
    if (cats.length) text += '\n支出 TOP：\n' + cats.map(c => '· ' + c + '　' + D.money0(byCat[c])).join('\n');
    return { ok: true, text, menu: ['记一笔 68 餐饮', '预算', '菜单'] };
  }
});

def({
  name: 'expense.list', desc: '查询支出明细', group: '查询', slots: [],
  run(ctx) {
    const m = D.curYM();
    const list = ctx.data.money.expenses.filter(e => D.ym(e.date) === m).sort((a, b) => a.date < b.date ? 1 : -1);
    if (!list.length) return { ok: true, text: '本月还没有支出记录。', menu: ['记一笔 68 餐饮', '菜单'] };
    const lines = list.slice(0, 12).map(e => '· ' + D.md(e.date) + '　' + e.cat + '　' + D.money2(e.amt) + (e.note ? '　' + e.note : ''));
    return { ok: true, text: '本月支出（' + list.length + ' 笔）\n' + joinMenu(lines), menu: ['记一笔', '收支汇总', '菜单'] };
  }
});

def({
  name: 'budget.list', desc: '查询预算使用情况', group: '查询', slots: [],
  run(ctx) {
    const m = D.curYM(), bs = ctx.data.money.budgets || [];
    if (!bs.length) return { ok: true, text: '还没有设置预算。', menu: ['设置餐饮预算 1500', '菜单'] };
    const lines = bs.map(b => {
      const used = ctx.data.money.expenses.filter(e => e.cat === b.cat && D.ym(e.date) === m).reduce((a, c) => a + num(c.amt), 0);
      const pct = num(b.amt) > 0 ? used / num(b.amt) * 100 : 0;
      const flag = pct > 100 ? ' ⚠超支' : (pct > 80 ? ' 接近上限' : '');
      return '· ' + b.cat + '　' + D.money0(used) + '/' + D.money0(b.amt) + '\n　' + bar(pct) + flag;
    });
    return { ok: true, text: '本月预算\n' + joinMenu(lines), menu: ['设置餐饮预算 1500', '菜单'] };
  }
});

def({
  name: 'habit.list', desc: '查询习惯打卡情况', group: '查询', slots: [],
  run(ctx) {
    const t = D.today(), list = ctx.data.life.habits || [];
    if (!list.length) return { ok: true, text: '还没有习惯。', menu: ['新增习惯 早睡', '菜单'] };
    const lines = list.map(h => {
      const done = (h.hist || []).indexOf(t) >= 0;
      let streak = 0, i = done ? 0 : 1;
      for (; i < 400; i++) { if ((h.hist || []).indexOf(D.shift(-i)) >= 0) streak++; else break; }
      return '· ' + (done ? '✓' : '○') + ' ' + h.name + '　连续 ' + streak + ' 天';
    });
    return { ok: true, text: '今日习惯\n' + joinMenu(lines), menu: ['打卡 早睡', '菜单'] };
  }
});

def({
  name: 'memo.list', desc: '查询备忘录', group: '查询', slots: [],
  run(ctx) {
    const list = (ctx.data.life.memos || []).slice().sort((a, b) => (!!b.pin - !!a.pin) || (a.date < b.date ? 1 : -1));
    if (!list.length) return { ok: true, text: '还没有备忘录。', menu: ['记一下 宽带下个月续费', '菜单'] };
    const lines = list.slice(0, 10).map(m => '· ' + (m.pin ? '【置顶】' : '') + m.title + (m.body ? '　' + String(m.body).slice(0, 30) : ''));
    return { ok: true, text: '备忘录\n' + joinMenu(lines), menu: ['记一下', '菜单'] };
  }
});

def({
  name: 'overview', desc: '查看工作台总览', group: '查询', slots: [],
  run(ctx) {
    const t = D.today(), m = D.curYM();
    const work = ctx.data.work.tasks.filter(x => !x.done && x.due && x.due <= t).length;
    const study = ctx.data.study.tasks.filter(x => !x.done && x.due && x.due <= t).length;
    const chore = (ctx.data.family.chores || []).filter(x => x.last !== t).length;
    const habit = (ctx.data.life.habits || []).filter(x => (x.hist || []).indexOf(t) < 0).length;
    const exp = ctx.data.money.expenses.filter(e => D.ym(e.date) === m).reduce((a, b) => a + num(b.amt), 0);
    const inc = ctx.data.money.incomes.filter(e => D.ym(e.date) === m).reduce((a, b) => a + num(b.amt), 0);
    return {
      ok: true,
      text: '工作台总览（' + D.md(t) + '）\n' +
        line('待处理', work + ' 项工作 · ' + study + ' 项学习') + '\n' +
        line('待打卡', chore + ' 项家务 · ' + habit + ' 个习惯') + '\n' +
        line('本月支出', D.money0(exp)) + '\n' +
        line('本月收入', D.money0(inc)) + '\n' +
        line('结余', D.money0(inc - exp)),
      menu: ['今天要处理', '记一笔', '菜单']
    };
  }
});

/* ---------------- 创建类 ---------------- */
def({
  name: 'task.create', desc: '新增任务（自动识别模块）', group: '创建',
  slots: [
    { key: 'title', desc: '任务名称', required: true, ask: '这个任务叫什么？' },
    { key: 'date', desc: '截止日期', ask: '什么时候截止？（今天/明天/8月30日）' },
    { key: 'priority', desc: '优先级', values: ['P0 紧急', 'P1 重要', 'P2 一般'] },
    { key: 'module', desc: '所属模块', values: ['work', 'family', 'life'] }
  ],
  run(ctx, a) {
    const mod = String(a.module || '').toLowerCase();
    const it = {
      id: newId(), title: String(a.title).slice(0, 80), pri: a.priority || 'P1 重要',
      done: false
    };
    let modName = '工作', list;
    if (mod === 'family') {
      it.date = a.date || D.today();   // family 用 date 字段
      list = ctx.data.family.events;
      modName = '家庭';
    } else if (mod === 'life') {
      it.due = a.date || D.today();    // life 用 due 字段（如果有的话）
      // life 模块没有独立 tasks 数组，用 family.events 作为通用待办
      list = ctx.data.family.events;
      modName = '生活';
    } else {
      it.due = a.date || D.today();
      list = ctx.data.work.tasks;
      modName = '工作';
    }
    list.unshift(it);
    touch(ctx, mod === 'family' ? 'family' : (mod === 'life' ? 'family' : 'work'));
    store.audit({ uid: ctx.uid, action: 'task.create', target: '[' + modName + '] ' + it.title, via: ctx.via });
    return {
      ok: true,
      text: '✅ 已添加' + (mod === 'family' || mod === 'life' ? '【' + modName + '】' : '') + '任务：' + it.title +
        '\n⏰ 截止 ' + D.dlName(it.due || it.date) +
        '，优先级 ' + it.pri,
      menu: ['今天要处理', '还有什么任务']
    };
  }
});

def({
  name: 'event.create', desc: '新增日程', group: '创建',
  slots: [
    { key: 'title', desc: '日程内容', required: true, ask: '什么日程？' },
    { key: 'date', desc: '日期', required: true, ask: '哪一天？（今天/明天/9月2日）' },
    { key: 'time', desc: '时间' }
  ],
  run(ctx, a) {
    const it = { id: newId(), date: a.date, time: a.time || '', title: String(a.title).slice(0, 80), place: '', done: false };
    ctx.data.work.events.push(it); touch(ctx, 'work');
    store.audit({ uid: ctx.uid, action: 'event.create', target: it.title, via: ctx.via });
    return { ok: true, text: '已添加日程：' + it.title + '\n' + D.dlName(it.date) + (it.time ? ' ' + it.time : ''), menu: ['近期日程', '菜单'] };
  }
});

def({
  name: 'expense.create', desc: '记一笔支出', group: '创建',
  slots: [
    { key: 'amount', desc: '金额', required: true, ask: '花了多少钱？' },
    { key: 'category', desc: '分类', values: ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '人情', '其他'] },
    { key: 'merchant', desc: '商家' },
    { key: 'date', desc: '日期' }
  ],
  run(ctx, a) {
    let cat = a.category || guessCategory(ctx, a.merchant, a.title);
    // 既没指定分类、规则也没命中时，追问一次而不是默默归到「其他」
    if (!cat) {
      return {
        ok: false,
        needSlots: {
          tool: 'expense.create',
          slots: Object.assign({ amount: a.amount }, a),
          missing: ['category'],
          ask: '记在哪个分类？\n餐饮 / 交通 / 购物 / 居住 / 娱乐 / 医疗 / 教育 / 人情 / 其他'
        }
      };
    }
    // 标题若与分类同名（如“记一笔 35 交通”），就不要再塞进备注，避免信息重复
    let note = String(a.merchant || '').trim();
    if (!note) {
      const t = String(a.title || '').trim();
      note = (t && t !== cat) ? t : '';
    }
    const it = {
      id: newId(), date: a.date || D.today(), cat,
      amt: Math.round(num(a.amount) * 100) / 100,
      note: note
    };
    ctx.data.money.expenses.unshift(it); touch(ctx, 'money');
    store.audit({ uid: ctx.uid, action: 'expense.create', target: it.cat + ' ' + it.amt, via: ctx.via });
    const m = D.curYM();
    const monthTotal = ctx.data.money.expenses.filter(e => D.ym(e.date) === m).reduce((s, b) => s + num(b.amt), 0);
    let extra = '本月已支出 ' + D.money0(monthTotal);
    const b = (ctx.data.money.budgets || []).filter(x => x.cat === cat)[0];
    if (b && num(b.amt) > 0) {
      const used = ctx.data.money.expenses.filter(e => e.cat === cat && D.ym(e.date) === m).reduce((s, c) => s + num(c.amt), 0);
      const pct = Math.round(used / num(b.amt) * 100);
      extra += '\n' + cat + '预算已用 ' + pct + '%' + (pct > 100 ? '，已超支' : (pct > 80 ? '，接近上限' : ''));
    }
    return { ok: true, text: '已记一笔支出\n' + line('金额', D.money2(it.amt)) + '\n' + line('分类', cat) + (it.note ? '\n' + line('商家', it.note) : '') + '\n' + line('日期', D.md(it.date)) + '\n' + extra, menu: ['再记一笔', '本月收支', '菜单'] };
  }
});

def({
  name: 'income.create', desc: '记一笔收入', group: '创建',
  slots: [
    { key: 'amount', desc: '金额', required: true, ask: '收入多少钱？' },
    { key: 'source', desc: '来源', values: ['工资', '奖金', '兼职', '理财', '报销', '其他'] },
    { key: 'date', desc: '日期' }
  ],
  run(ctx, a) {
    const it = { id: newId(), date: a.date || D.today(), src: a.source || '其他', amt: Math.round(num(a.amount) * 100) / 100, note: a.title || '' };
    ctx.data.money.incomes.unshift(it); touch(ctx, 'money');
    store.audit({ uid: ctx.uid, action: 'income.create', target: it.src + ' ' + it.amt, via: ctx.via });
    return { ok: true, text: '已记一笔收入：' + D.money2(it.amt) + '（' + it.src + '）', menu: ['本月收支', '菜单'] };
  }
});

def({
  name: 'memo.create', desc: '新增备忘录', group: '创建',
  slots: [{ key: 'title', desc: '内容', required: true, ask: '要记什么？' }],
  run(ctx, a) {
    const it = { id: newId(), title: String(a.title).slice(0, 60), body: '', date: D.today(), pin: false };
    ctx.data.life.memos.unshift(it); touch(ctx, 'life');
    store.audit({ uid: ctx.uid, action: 'memo.create', target: it.title, via: ctx.via });
    return { ok: true, text: '已记下：' + it.title, menu: ['备忘录', '菜单'] };
  }
});

def({
  name: 'study.create', desc: '新增学习任务', group: '创建',
  slots: [
    { key: 'title', desc: '任务名称', required: true, ask: '什么学习任务？' },
    { key: 'date', desc: '截止日期' }
  ],
  run(ctx, a) {
    const it = { id: newId(), title: String(a.title).slice(0, 80), subj: a.subject || '', due: a.date || D.today(), done: false };
    ctx.data.study.tasks.unshift(it); touch(ctx, 'study');
    store.audit({ uid: ctx.uid, action: 'study.create', target: it.title, via: ctx.via });
    return { ok: true, text: '已添加学习任务：' + it.title, menu: ['学习任务', '菜单'] };
  }
});

def({
  name: 'study.log', desc: '记录学习时长', group: '创建',
  slots: [
    { key: 'minutes', desc: '时长（分钟）', required: true, ask: '学了多久？（如 45 分钟 / 1 小时）' },
    { key: 'subject', desc: '科目' }
  ],
  run(ctx, a) {
    const it = { id: newId(), date: D.today(), subj: a.subject || '未分类', min: Math.round(num(a.minutes)), note: '' };
    ctx.data.study.logs.unshift(it); touch(ctx, 'study');
    store.audit({ uid: ctx.uid, action: 'study.log', target: it.subj + ' ' + it.min + 'min', via: ctx.via });
    const todayMin = ctx.data.study.logs.filter(l => l.date === D.today()).reduce((s, l) => s + num(l.min), 0);
    return { ok: true, text: '已记录学习 ' + it.min + ' 分钟' + (it.subj ? '（' + it.subj + '）' : '') + '\n今天累计 ' + todayMin + ' 分钟', menu: ['学习任务', '菜单'] };
  }
});

def({
  name: 'habit.create', desc: '新增习惯', group: '创建',
  slots: [{ key: 'title', desc: '习惯名称', required: true, ask: '想养成什么习惯？' }],
  run(ctx, a) {
    const it = { id: newId(), name: String(a.title).slice(0, 40), hist: [] };
    ctx.data.life.habits.push(it); touch(ctx, 'life');
    store.audit({ uid: ctx.uid, action: 'habit.create', target: it.name, via: ctx.via });
    return { ok: true, text: '已添加习惯：' + it.name + '\n回复「打卡 ' + it.name + '」即可打第一次', menu: ['习惯', '菜单'] };
  }
});

def({
  name: 'chore.create', desc: '新增家务', group: '创建',
  slots: [
    { key: 'title', desc: '家务名称', required: true, ask: '什么家务？' },
    { key: 'owner', desc: '负责人' },
    { key: 'freq', desc: '频次', values: ['每日', '每周', '每月'] }
  ],
  run(ctx, a) {
    const it = { id: newId(), name: String(a.title).slice(0, 40), owner: a.owner || '', freq: a.freq || '每日', last: '' };
    ctx.data.family.chores.push(it); touch(ctx, 'family');
    store.audit({ uid: ctx.uid, action: 'chore.create', target: it.name, via: ctx.via });
    return { ok: true, text: '已添加家务：' + it.name + (it.owner ? '（' + it.owner + '）' : ''), menu: ['家务', '菜单'] };
  }
});

def({
  name: 'anniv.create', desc: '新增纪念日', group: '创建',
  slots: [
    { key: 'title', desc: '名称', required: true, ask: '什么纪念日？' },
    { key: 'date', desc: '日期', required: true, ask: '哪一天？（如 1988-11-03）' }
  ],
  run(ctx, a) {
    const it = { id: newId(), name: String(a.title).slice(0, 40), date: a.date, type: a.type || '纪念日', remind: 7 };
    ctx.data.family.anniv.push(it); touch(ctx, 'family');
    store.audit({ uid: ctx.uid, action: 'anniv.create', target: it.name, via: ctx.via });
    return { ok: true, text: '已添加纪念日：' + it.name + '（' + D.md(it.date) + '）', menu: ['纪念日', '菜单'] };
  }
});

def({
  name: 'budget.create', desc: '设置月度预算', group: '创建',
  slots: [
    { key: 'category', desc: '分类', required: true, values: ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '人情', '其他'], ask: '给哪个分类设预算？' },
    { key: 'amount', desc: '预算金额', required: true, ask: '预算多少？' }
  ],
  run(ctx, a) {
    const exist = (ctx.data.money.budgets || []).filter(b => b.cat === a.category)[0];
    if (exist) { exist.amt = Math.round(num(a.amount) * 100) / 100; }
    else ctx.data.money.budgets.push({ id: newId(), cat: a.category, amt: Math.round(num(a.amount) * 100) / 100 });
    touch(ctx, 'money');
    store.audit({ uid: ctx.uid, action: 'budget.set', target: a.category + ' ' + a.amount, via: ctx.via });
    return { ok: true, text: '已设置「' + a.category + '」月度预算 ' + D.money0(a.amount), menu: ['预算', '菜单'] };
  }
});

/* ---------------- 完成 / 修改 / 删除 ---------------- */
def({
  name: 'task.done', desc: '完成工作任务', group: '执行',
  slots: [{ key: 'title', desc: '任务关键词', required: true, ask: '要完成哪个任务？' }],
  run(ctx, a) {
    const r = pickOne(ctx.data.work.tasks.filter(x => !x.done), ['title', 'proj'], a.title, '任务');
    if (!r.ok) return { ok: false, needClarify: r };
    r.item.done = true; r.item.doneAt = D.today(); touch(ctx, 'work');
    store.audit({ uid: ctx.uid, action: 'task.done', target: r.item.title, via: ctx.via });
    return { ok: true, text: '已完成：' + r.item.title, menu: ['今天要处理', '还有什么任务'] };
  }
});

def({
  name: 'study.done', desc: '完成学习任务', group: '执行',
  slots: [{ key: 'title', desc: '任务关键词', required: true, ask: '要完成哪个学习任务？' }],
  run(ctx, a) {
    const r = pickOne(ctx.data.study.tasks.filter(x => !x.done), ['title', 'subj'], a.title, '学习任务');
    if (!r.ok) return { ok: false, needClarify: r };
    r.item.done = true; touch(ctx, 'study');
    store.audit({ uid: ctx.uid, action: 'study.done', target: r.item.title, via: ctx.via });
    return { ok: true, text: '已完成：' + r.item.title, menu: ['学习任务', '菜单'] };
  }
});

def({
  name: 'habit.check', desc: '习惯打卡', group: '执行',
  slots: [{ key: 'title', desc: '习惯名称', required: true, ask: '给哪个习惯打卡？' }],
  run(ctx, a) {
    const t = D.today();
    const r = pickOne(ctx.data.life.habits || [], ['name'], a.title, '习惯');
    if (!r.ok) return { ok: false, needClarify: r };
    r.item.hist = r.item.hist || [];
    const i = r.item.hist.indexOf(t);
    if (i >= 0) { r.item.hist.splice(i, 1); touch(ctx, 'life'); return { ok: true, text: '已取消打卡：' + r.item.name }; }
    r.item.hist.push(t); touch(ctx, 'life');
    let streak = 0, k = 0;
    for (; k < 400; k++) { if (r.item.hist.indexOf(D.shift(-k)) >= 0) streak++; else break; }
    store.audit({ uid: ctx.uid, action: 'habit.check', target: r.item.name, via: ctx.via });
    return { ok: true, text: '打卡成功：' + r.item.name + '\n已连续 ' + streak + ' 天', menu: ['习惯', '菜单'] };
  }
});

def({
  name: 'chore.done', desc: '完成家务', group: '执行',
  slots: [{ key: 'title', desc: '家务名称', required: true, ask: '哪个家务做完了？' }],
  run(ctx, a) {
    const t = D.today();
    const r = pickOne((ctx.data.family.chores || []).filter(x => x.last !== t), ['name', 'owner'], a.title, '家务');
    if (!r.ok) return { ok: false, needClarify: r };
    r.item.last = t; touch(ctx, 'family');
    store.audit({ uid: ctx.uid, action: 'chore.done', target: r.item.name, via: ctx.via });
    return { ok: true, text: '已完成：' + r.item.name + (r.item.owner ? '（' + r.item.owner + '）' : ''), menu: ['家务', '菜单'] };
  }
});

def({
  name: 'project.update', desc: '更新项目进度', group: '执行',
  slots: [
    { key: 'title', desc: '项目名', required: true, ask: '哪个项目？' },
    { key: 'progress', desc: '进度百分比', required: true, ask: '进度改成多少？（0-100）' }
  ],
  run(ctx, a) {
    const r = pickOne(ctx.data.work.projects || [], ['name'], a.title, '项目');
    if (!r.ok) return { ok: false, needClarify: r };
    r.item.prog = Math.max(0, Math.min(100, Math.round(num(a.progress))));
    touch(ctx, 'work');
    store.audit({ uid: ctx.uid, action: 'project.update', target: r.item.name + ' ' + r.item.prog + '%', via: ctx.via });
    return { ok: true, text: r.item.name + ' 进度已更新\n' + bar(r.item.prog), menu: ['项目进度', '菜单'] };
  }
});

def({
  name: 'course.update', desc: '更新课程已完成课时', group: '执行',
  slots: [
    { key: 'title', desc: '课程名', required: true, ask: '哪门课？' },
    { key: 'progress', desc: '已完成课时', required: true, ask: '已完成多少课时？' }
  ],
  run(ctx, a) {
    const r = pickOne(ctx.data.study.courses || [], ['name'], a.title, '课程');
    if (!r.ok) return { ok: false, needClarify: r };
    r.item.doneN = Math.max(0, Math.min(num(r.item.total, 9999), Math.round(num(a.progress))));
    touch(ctx, 'study');
    store.audit({ uid: ctx.uid, action: 'course.update', target: r.item.name + ' ' + r.item.doneN, via: ctx.via });
    const tot = Math.max(1, num(r.item.total, 1));
    return { ok: true, text: r.item.name + '　' + r.item.doneN + '/' + tot + '\n' + bar(r.item.doneN / tot * 100), menu: ['课程进度', '菜单'] };
  }
});

def({
  name: 'item.delete', desc: '删除条目（任务/日程/支出等）', group: '危险', sensitive: true,
  slots: [{ key: 'title', desc: '要删除的条目关键词', required: true, ask: '要删除哪一项？' }],
  run(ctx, a) {
    const pools = [
      { mod: 'work', col: 'tasks', keys: ['title'], label: '任务' },
      { mod: 'work', col: 'events', keys: ['title'], label: '日程' },
      { mod: 'study', col: 'tasks', keys: ['title'], label: '学习任务' },
      { mod: 'life', col: 'memos', keys: ['title'], label: '备忘' },
      { mod: 'life', col: 'habits', keys: ['name'], label: '习惯' },
      { mod: 'family', col: 'chores', keys: ['name'], label: '家务' },
      { mod: 'money', col: 'expenses', keys: ['note', 'cat'], label: '支出' }
    ];
    let best = null;
    pools.forEach(p => {
      const r = matchItems(ctx.data[p.mod][p.col] || [], p.keys, a.title);
      if (r.length && (!best || r[0].s > best.s)) best = { s: r[0].s, item: r[0].it, pool: p };
    });
    if (!best) return { ok: false, needClarify: { reason: 'empty', msg: '没找到要删除的条目：' + a.title } };
    const p = best.pool;
    ctx.data[p.mod][p.col] = ctx.data[p.mod][p.col].filter(x => x !== best.item);
    touch(ctx, p.mod);
    store.audit({ uid: ctx.uid, action: 'item.delete', target: p.label + ':' + (best.item.title || best.item.name || ''), via: ctx.via });
    return { ok: true, text: '已删除' + p.label + '：' + (best.item.title || best.item.name || ''), menu: ['菜单'] };
  }
});

def({
  name: 'budget.delete', desc: '删除预算', group: '危险', sensitive: true,
  slots: [{ key: 'category', desc: '分类', required: true, ask: '删除哪个分类的预算？' }],
  run(ctx, a) {
    const before = (ctx.data.money.budgets || []).length;
    ctx.data.money.budgets = (ctx.data.money.budgets || []).filter(b => b.cat !== a.category);
    if ((ctx.data.money.budgets || []).length === before) return { ok: false, needClarify: { reason: 'empty', msg: '没有「' + a.category + '」的预算' } };
    touch(ctx, 'money');
    store.audit({ uid: ctx.uid, action: 'budget.delete', target: a.category, via: ctx.via });
    return { ok: true, text: '已删除「' + a.category + '」预算', menu: ['预算', '菜单'] };
  }
});

/* ---------------- 系统类 ---------------- */
def({
  name: 'help', desc: '使用帮助', group: '系统', slots: [],
  run(ctx) {
    return {
      ok: true,
      text: '直接说话就行，不用记指令。举几个例子：\n' +
        '· 记一笔 68 餐饮\n· 今天要处理什么\n· 完成季度复盘\n· 打卡早睡\n· 本月收支\n· 新增任务 明天 交周报\n\n' +
        '回复「菜单」看全部能力。',
      menu: ['菜单', '今天要处理', '本月收支']
    };
  }
});

def({
  name: 'menu', desc: '常用指令列表', group: '系统', slots: [],
  run(ctx) {
    const groups = {};
    TOOLS.forEach(t => { if (t.group === '系统') return; (groups[t.group] = groups[t.group] || []).push(t); });
    const order = ['查询', '创建', '执行', '危险'];
    let text = '常用指令（点一下就能发）\n';
    order.forEach(g => {
      if (!groups[g]) return;
      text += '\n【' + g + '】\n' + groups[g].map(t => '· ' + exampleOf(t.name)).join('\n');
    });
    text += '\n\n【系统】\n· 菜单\n· 帮助\n· 解绑';
    return { ok: true, text, menu: ['今天要处理', '记一笔 68 餐饮', '帮助'] };
  }
});

def({
  name: 'bind', desc: '绑定工作台账号', group: '系统', slots: [{ key: 'code', desc: '6 位绑定码', required: true, ask: '请发送绑定码（工作台 → 设置 → 微信绑定）' }],
  run(ctx, a) {
    const r = store.consumeBindCode(a.code);
    if (!r.ok) {
      return { ok: true, text: r.reason === 'expired' ? '绑定码已过期，请在工作台重新生成一个（5 分钟内有效）。' : '绑定码不对，请在工作台「设置 → 微信绑定」重新获取。' };
    }
    store.bindOpenid(r.uid, ctx.openid);
    ctx.uid = r.uid;
    store.audit({ uid: r.uid, action: 'bind', target: ctx.openid, via: ctx.via });
    return { ok: true, bound: true, text: '绑定成功！现在可以直接跟我说话操作你的工作台了。\n回复「今天要处理」试试。', menu: ['今天要处理', '本月收支', '菜单'] };
  }
});

def({
  name: 'unbind', desc: '解绑当前微信', group: '系统', sensitive: true, slots: [],
  run(ctx) {
    store.unbind(ctx.openid);
    store.audit({ uid: ctx.uid, action: 'unbind', target: ctx.openid, via: ctx.via });
    return { ok: true, text: '已解绑，这个微信不再关联任何工作台账号。' };
  }
});

/* ---------------- 辅助 ---------------- */
function guessCategory(ctx, merchant, title) {
  const rules = ctx.data.money.rules || [];
  const pool = String((merchant || '') + ' ' + (title || '')).toLowerCase();
  let best = null;
  rules.slice().sort((a, b) => String(b.kw || '').length - String(a.kw || '').length).forEach(r => {
    if (!r.kw) return;
    if (pool.indexOf(String(r.kw).toLowerCase()) >= 0) { if (!best) best = r.cat; }
  });
  return best || '';   // 空串表示没命中，由调用方决定追问还是兜底
}
function exampleOf(name) {
  const map = {
    'today': '今天要处理', 'overview': '工作台总览', 'task.list': '有什么任务', 'event.list': '近期日程',
    'project.list': '项目进度', 'study.list': '学习任务', 'course.list': '课程进度',
    'chore.list': '家务', 'anniv.list': '纪念日', 'money.summary': '本月收支',
    'expense.list': '支出明细', 'budget.list': '预算', 'habit.list': '习惯', 'memo.list': '备忘录',
    'task.create': '新增任务 明天 交周报', 'event.create': '新增日程 后天 部门周会',
    'expense.create': '记一笔 68 餐饮', 'income.create': '记一笔收入 500 兼职',
    'memo.create': '新增备忘 宽带下月续费', 'study.create': '新增学习任务 背单词',
    'study.log': '记录学习 45 分钟', 'habit.create': '新增习惯 早睡',
    'chore.create': '新增家务 洗碗 妈妈', 'anniv.create': '新增纪念日 妈妈生日 1988-11-03',
    'budget.create': '设置餐饮预算 1500',
    'task.done': '完成 季度复盘', 'study.done': '完成 背单词', 'habit.check': '打卡 早睡',
    'chore.done': '完成 洗碗', 'project.update': '把客户交付项目进度改为 80',
    'course.update': '数据分析课已完成 20 课时',
    'item.delete': '删除 买咖啡', 'budget.delete': '删除餐饮预算'
  };
  return map[name] || name;
}

module.exports = { TOOLS, def, matchItems, pickOne, touch, newId, exampleOf };
