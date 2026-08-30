'use strict';
/** 日期/数字工具（与前端同构，保证微信端和网页端口径一致） */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return fmt(new Date()); }
function shift(n, base) {
  const d = base ? new Date(base + 'T00:00:00') : new Date();
  d.setDate(d.getDate() + n);
  return fmt(d);
}
function dayDiff(a, b) {
  const pa = String(a).split('-'), pb = String(b).split('-');
  return Math.round((new Date(+pa[0], +pa[1] - 1, +pa[2]) - new Date(+pb[0], +pb[1] - 1, +pb[2])) / 86400000);
}
function md(s) { const p = String(s || '').split('-'); return p.length < 3 ? String(s || '') : (+p[1]) + '月' + (+p[2]) + '日'; }
function weekday(s) { return WEEK[new Date(String(s).split('-')[0], String(s).split('-')[1] - 1, String(s).split('-')[2]).getDay()]; }
function ym(s) { return String(s || '').slice(0, 7); }
function curYM() { return today().slice(0, 7); }
function dlName(d) {
  const n = dayDiff(d, today());
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === 2) return '后天';
  if (n === -1) return '昨天';
  return md(d) + ' ' + weekday(d);
}
function money0(n) {
  n = Number(n) || 0;
  return '¥' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function money2(n) {
  n = Number(n) || 0;
  const neg = n < 0;
  return (neg ? '-¥' : '¥') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** 解析自然语言日期 */
function parseDate(text) {
  if (!text) return null;
  const t = String(text);
  const now = new Date();
  let m;
  if (/今天|今日|当天/.test(t)) return today();
  if (/昨天|昨日/.test(t)) return shift(-1);
  if (/明天|明日/.test(t)) return shift(1);
  if (/后天/.test(t)) return /大后天/.test(t) ? shift(3) : shift(2);
  if ((m = /(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(t))) {
    return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
  }
  if ((m = /(\d{1,2})[月/-](\d{1,2})[日号]?/.exec(t))) {
    let mo = +m[1], da = +m[2];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    let y = now.getFullYear();
    const cand = y + '-' + pad(mo) + '-' + pad(da);
    // 若该日期已过去超过 6 个月，认为是明年
    if (dayDiff(cand, today()) < -180) y += 1;
    return y + '-' + pad(mo) + '-' + pad(da);
  }
  const wm = /(下{0,1})\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/.exec(t);
  if (wm) {
    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 };
    const target = map[wm[2]];
    if (target != null) {
      const cur = now.getDay();
      let delta = (target - cur + 7) % 7;
      if (wm[1] === '下') delta += 7;
      if (delta === 0 && wm[1] !== '下') delta = 7;
      return shift(delta);
    }
  }
  return null;
}
/* ---- 中文数字：语音识别常输出「六十八」「一百二十八」，必须能解析 ---- */
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
                   五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
const CN_UNIT  = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
const CN_RUN   = '零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十百千万亿';

function parseChineseNumber(s) {
  if (!s) return null;
  let total = 0, section = 0, number = 0, hit = false;
  for (const ch of String(s)) {
    if (ch in CN_DIGIT) { number = CN_DIGIT[ch]; hit = true; continue; }
    if (ch in CN_UNIT) {
      const u = CN_UNIT[ch];
      if (u >= 10000) { section = (section + number) * u; total += section; section = 0; }
      else { section += (number === 0 ? 1 : number) * u; hit = true; }
      number = 0;
      continue;
    }
    break;                       // 遇到无关字符即停止，避免把「三天的三」算进来
  }
  return hit ? (total + section + number) : null;
}
/**
 * 阿拉伯数字金额。
 * 不能简单取「第一个数字」——小票上「科技园路1号」「2026-08-28」里都有数字。
 * 打分：挨着金额语境(合计/¥/元/块…)最高，带两位小数次之，其余最低；同分取靠后的。
 */
function parseAmountArabic(text) {
  if (!text) return null;
  const t = String(text).replace(/，/g, ',');
  const re = /\d+(?:\.\d{1,2})?/g;
  const all = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const v = parseFloat(m[0]);
    if (isNaN(v) || v <= 0) continue;
    const before = t.slice(Math.max(0, m.index - 7), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 2);
    // 日期/时间里的数字（2026-08-28 14:32）不该被当成金额
    const prevCh = m.index > 0 ? t.charAt(m.index - 1) : '';
    const nextCh = t.charAt(m.index + m[0].length) || '';
    const looksDate = /[-/年.]/.test(prevCh) || /[-:：月日]/.test(nextCh);
    const keyed = !looksDate &&
      (AMT_CTX.test(before) || /^[元块]/.test(after) || /[￥¥]/.test(before.slice(-3)));
    const twoDec = /\.\d{2}$/.test(m[0]);
    all.push({ v: v, score: (keyed ? 100 : (twoDec ? 50 : 10)), dec: twoDec ? 1 : 0, idx: m.index });
  }
  if (!all.length) return null;
  // 同分时优先「更像钱」的（带两位小数），再取靠后的
  let best = all[0];
  for (const x of all) {
    if (x.score > best.score ||
        (x.score === best.score &&
         (x.dec > best.dec || (x.dec === best.dec && x.idx >= best.idx)))) best = x;
  }
  return Math.round(best.v * 100) / 100;
}
/**
 * 中文数字金额：「六十八」「二十五块五」「一百二十八元」。
 * 关键：必须挨着金额语境才认定，否则「记三天后交周报」里的“三”会被当成 3 元。
 */
/**
 * 金额语境词。注意不要用会误命中的宽泛词：
 * 早期写的是 `付了?`，结果「微信支付」里的“付”把后面的日期数字也带成了高置信金额。
 */
const AMT_CTX = /(?:花了?|消费|付款|付了|实付|应付|已付|金额|合计|总计|小计|总共|一共|元|块钱?|人民币|记账|记一笔|记一下|房租|水费|电费|气费|话费|物业|工资|奖金|报销|收入|到账|买|充值)/;
function parseAmountChinese(text) {
  const t = String(text || '');
  // 允许「二十五块五」这种带小数分隔符的连续串
  const runs = t.match(new RegExp('[' + CN_RUN + ']{1,14}(?:[块元点][零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖]{1,2})?', 'g'));
  if (!runs || !runs.length) return null;

  // 后面紧跟日期/量词 → 明确不是金额（「二十五号」「三点」「三十天」）
  const NOT_AMT = /^[号日点分月年天个次条遍杯份斤公里层页章节课]/;
  let pick = null;
  for (const r of runs) {
    const idx = t.indexOf(r);
    const before = idx > 0 ? t.slice(Math.max(0, idx - 7), idx) : '';
    const after = t.slice(idx + r.length, idx + r.length + 2);
    if (NOT_AMT.test(after)) continue;
    // 判定为金额的三种情形：自带「块/元」、处于金额语境、或较长的裸数字串
    if (/[块元]/.test(r) || AMT_CTX.test(before) || AMT_CTX.test(after)
        || /^[块元]/.test(after) || r.length >= 3) { pick = r; }
  }
  if (pick == null) return null;

  let intPart = pick, decPart = '';
  const dm = /^(.*?)(?:块|元|点)([零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖]{1,2})$/.exec(pick);
  if (dm) { intPart = dm[1]; decPart = dm[2]; }
  const iv = intPart ? parseChineseNumber(intPart) : null;
  if (iv == null && !decPart) return null;
  let v = iv || 0;
  if (decPart) {
    let ds = '';
    for (const ch of decPart) { if (ch in CN_DIGIT) ds += CN_DIGIT[ch]; else break; }
    if (ds) v += Number('0.' + ds);
  }
  return v > 0 ? Math.round(v * 100) / 100 : null;
}
/** 金额解析：阿拉伯优先，回退中文数字 */
function parseAmount(text) {
  const a = parseAmountArabic(text);
  if (a != null) return a;
  return parseAmountChinese(text);
}
/** 解析时长（分钟） */
function parseMinutes(text) {
  if (!text) return null;
  const t = String(text);
  let m = /(\d+(?:\.\d)?)\s*(?:个)?小时/.exec(t);
  const h = m ? parseFloat(m[1]) : 0;
  m = /(\d+)\s*分钟/.exec(t);
  const mi = m ? parseInt(m[1], 10) : 0;
  if (!h && !mi) return null;
  return Math.round(h * 60 + mi);
}

module.exports = {
  pad, fmt, today, shift, dayDiff, md, weekday, ym, curYM, dlName,
  money0, money2, parseDate, parseAmount, parseAmountArabic, parseAmountChinese,
  parseChineseNumber, parseMinutes
};
