'use strict';
/**
 * OCR Provider 适配层
 *
 * 设计目标：工作台前端不用关心用的是哪家识别服务，统一走一个契约。
 *  - none    默认。不识别，明确返回 skipped，让前端降级为「手动核对」
 *  - tencent 腾讯云 OCR（通用印刷体高精度版）
 *  - baidu   百度 OCR（通用文字识别·高精度含位置版）
 *  - custom  你自己的 HTTP 服务（返回本文件定义的契约即可）
 *
 * 统一输出（与前端 applyOCR 的入参契约一致）：
 * { ok, status, amount, currency, merchant, txnAt, category, note,
 *   conf:{}, rawText, candidates:{amount:[]}, errCode, errMsg, latencyMs, provider }
 */
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const D = require('./dates');

/* ---------------- HTTP 工具 ---------------- */
function request(urlStr, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('地址不合法')); }
    const isForm = options.form != null;
    const body = isForm ? Buffer.from(options.form, 'utf8')
                        : (options.body ? Buffer.from(JSON.stringify(options.body), 'utf8') : null);
    const headers = Object.assign(
      { 'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
      body ? { 'Content-Length': body.length } : {},
      options.headers || {}
    );
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: options.method || (body ? 'POST' : 'GET'),
      headers, timeout: options.timeout || 15000
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (e) { return reject(new Error('响应不是合法 JSON：' + buf.slice(0, 160))); }
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('识别服务超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------------- 腾讯云：TC3-HMAC-SHA256 签名 ---------------- */
function tc3Sign(secretKey, date, service, payload) {
  const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();

  const host = 'ocr.tencentcloudapi.com';
  const canonicalRequest = [
    'POST', '/', '',
    'content-type:application/json; charset=utf-8',
    'host:' + host, '',
    'content-type;host',
    sha256(payload)
  ].join('\n');
  const credentialScope = date + '/' + service + '/tc3_request';
  const stringToSign = ['TC3-HMAC-SHA256', String(Math.floor(Date.now() / 1000)), credentialScope, sha256(canonicalRequest)].join('\n');

  const sDate = hmac(Buffer.from('TC3' + secretKey, 'utf8'), date);
  const sSvc = hmac(sDate, service);
  const sKey = hmac(sSvc, 'tc3_request');
  return crypto.createHmac('sha256', sKey).update(stringToSign, 'utf8').digest('hex');
}

/* ---------------- 各家 Provider ---------------- */
const PROVIDERS = {
  none: {
    label: '未启用（手动核对）',
    isConfigured: () => false,
    async run() {
      return {
        ok: false, status: 'skipped', errCode: 'E007',
        errMsg: '尚未配置识别服务，当前为手动核对模式：金额与时间需要你手动填写'
      };
    }
  },

  tencent: {
    label: '腾讯云 OCR',
    isConfigured: c => !!(c.tencent && c.tencent.secretId && c.tencent.secretKey),
    async run(cfg, imageBase64) {
      const t = cfg.tencent;
      const action = cfg.tencent.action || 'GeneralAccurateOCR';   // 也可换成 VatInvoiceOCR 等票据专项
      const payload = JSON.stringify({ ImageBase64: imageBase64 });
      const date = new Date().toISOString().slice(0, 10);
      const ts = Math.floor(Date.now() / 1000);
      const sig = tc3Sign(t.secretKey, date, 'ocr', payload);
      const auth = 'TC3-HMAC-SHA256 Credential=' + t.secretId + '/' + date + '/ocr/tc3_request'
                 + ', SignedHeaders=content-type;host, Signature=' + sig;
      const j = await request('https://ocr.tencentcloudapi.com/', {
        body: JSON.parse(payload),
        headers: {
          'Authorization': auth,
          'Content-Type': 'application/json; charset=utf-8',
          'Host': 'ocr.tencentcloudapi.com',
          'X-TC-Action': action,
          'X-TC-Version': '2018-11-19',
          'X-TC-Timestamp': String(ts),
          'X-TC-Region': t.region || 'ap-guangzhou'
        },
        timeout: cfg.timeoutMs || 15000
      });
      const r = j.Response || {};
      if (r.Error) throw new Error('腾讯云返回错误：' + (r.Error.Code || '') + ' ' + (r.Error.Message || ''));
      const lines = (r.TextDetections || []).map(x => String(x.DetectedText || '').trim()).filter(Boolean);
      return { ok: true, rawText: lines.join('\n') };
    }
  },

  baidu: {
    label: '百度 OCR',
    isConfigured: c => !!(c.baidu && c.baidu.appKey && c.baidu.secretKey),
    async run(cfg, imageBase64) {
      const b = cfg.baidu;
      if (!b._token || !b._exp || b._exp < Date.now()) {
        const tj = await request('https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials'
          + '&client_id=' + encodeURIComponent(b.appKey)
          + '&client_secret=' + encodeURIComponent(b.secretKey), { method: 'POST', timeout: 10000 });
        if (!tj.access_token) throw new Error('百度 access_token 获取失败：' + JSON.stringify(tj).slice(0, 160));
        b._token = tj.access_token;
        b._exp = Date.now() + (Number(tj.expires_in) || 2592000) * 1000 - 60000;
      }
      const j = await request('https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=' + encodeURIComponent(b._token), {
        form: 'image=' + encodeURIComponent(imageBase64),
        timeout: cfg.timeoutMs || 15000
      });
      if (j.error_code) throw new Error('百度返回错误：' + j.error_code + ' ' + (j.error_msg || ''));
      const lines = ((j.words_result || []).map(x => String(x.words || '').trim())).filter(Boolean);
      return { ok: true, rawText: lines.join('\n') };
    }
  },

  custom: {
    label: '自建 / 第三方 HTTP 服务',
    isConfigured: c => !!c.customEndpoint,
    async run(cfg, imageBase64) {
      const j = await request(cfg.customEndpoint, {
        body: { image: 'data:image/jpeg;base64,' + imageBase64, ts: new Date().toISOString() },
        headers: cfg.customHeaders || {},
        timeout: cfg.timeoutMs || 15000
      });
      // 自建服务可以直接返回结构化结果，也可以只返回 rawText 交给本地解析
      return { ok: true, rawText: j.rawText || '', structured: j };
    }
  }
};

/* ---------------- 从识别原文里结构化出字段 ---------------- */
function guessMerchant(raw) {
  const lines = String(raw || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  for (const l of lines) {
    if (/(有限公司|有限责任公司|分公司|商店|超市|商场|酒店|餐厅|饭店|银行|医院|药房|药店|便利店|门店|咖啡|茶饮)/.test(l)) {
      return l.slice(0, 40);
    }
  }
  // 兜底取首行，但要排除「合计 12.00」这类明显是小计标签的行
  const f = lines[0];
  if (f.length > 30 || /^\d/.test(f)) return '';
  if (/(合计|总计|小计|金额|应付|实付|收款|找零|余额|支付|时间|日期|电话|单号|订单)/.test(f)) return '';
  return f;
}
function guessCategory(raw, rules) {
  const pool = String(raw || '').toLowerCase();
  let best = null;
  (rules || []).slice()
    .sort((a, b) => String(b.kw || '').length - String(a.kw || '').length)
    .forEach(r => {
      if (!r.kw) return;
      if (pool.indexOf(String(r.kw).toLowerCase()) >= 0 && !best) best = r.cat;
    });
  return best || '';
}
function extract(raw, rules) {
  const amt = D.parseAmount(raw);
  const pa = amt != null ? { v: amt, c: 0.9 } : { v: null, c: 0 };
  const dt = D.parseDate(raw);
  const merchant = guessMerchant(raw);
  const cat = guessCategory(raw, rules);
  // 候选金额：把原文里所有像金额的数字都列出来，供用户一键替换
  const nums = (String(raw || '').match(/\d+(?:\.\d{1,2})?/g) || [])
    .map(Number).filter(n => n > 0 && n < 1000000);
  const cand = [];
  nums.forEach(n => { if (cand.indexOf(n) < 0) cand.push(n); });
  cand.sort((a, b) => b - a);

  return {
    amount: pa.v,
    currency: 'CNY',
    merchant: merchant,
    txnAt: dt || '',
    category: cat,
    note: '',
    conf: {
      amount: pa.v != null ? pa.c : 0,
      currency: 0.6,
      merchant: merchant ? 0.7 : 0,
      txnAt: dt ? 0.85 : 0,
      category: cat ? 0.8 : 0
    },
    rawText: String(raw || ''),
    candidates: { amount: cand.slice(0, 4) }
  };
}

/* ---------------- 统一入口 ---------------- */
async function recognize(cfg, imageBase64, rules) {
  const name = (cfg && cfg.provider) || 'none';
  const p = PROVIDERS[name] || PROVIDERS.none;

  if (!p.isConfigured(cfg)) {
    return Object.assign({
      ok: false, status: 'skipped', errCode: 'E007',
      errMsg: '尚未配置识别服务（当前 provider=' + name + '），已转为手动核对模式',
      latencyMs: 0, provider: name
    }, extract('', rules));
  }

  const t0 = Date.now();
  try {
    if (!imageBase64 || imageBase64.length < 64) throw new Error('图片数据为空');
    const out = await p.run(cfg, imageBase64);
    const fields = extract(out.rawText, rules);
    const miss = [];
    if (fields.amount == null) miss.push('金额');
    if (!fields.txnAt) miss.push('交易时间');
    if (!fields.merchant) miss.push('商家');
    return Object.assign({
      ok: true,
      status: miss.length ? 'partial' : 'ok',
      errCode: miss.length ? 'E011' : '',
      errMsg: miss.length ? ('部分字段未能识别：' + miss.join('、') + '，请手动补全') : '',
      latencyMs: Date.now() - t0,
      provider: p.label,
      rawText: out.rawText || ''
    }, fields);
  } catch (e) {
    const msg = String(e.message || e);
    const isTimeout = /超时|timeout|ETIMEDOUT/i.test(msg);
    return Object.assign({
      ok: false,
      status: 'failed',
      errCode: isTimeout ? 'E008' : 'E009',
      errMsg: isTimeout
        ? '识别服务超时，请检查网络后点「重新识别」'
        : ('识别服务调用失败（' + msg.slice(0, 80) + '），已转为手动核对模式'),
      latencyMs: Date.now() - t0,
      provider: p.label
    }, extract('', rules));
  }
}

module.exports = { recognize, extract, guessMerchant, guessCategory, PROVIDERS, request, tc3Sign };
