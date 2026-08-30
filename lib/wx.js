'use strict';
/**
 * 微信公众平台协议封装（零依赖）
 * 支持：服务器验签、消息解析、被动回复、客服消息、access_token 自动续期
 * 说明：本实现面向「明文模式 / 兼容模式」。安全模式（AES 加密）需在公众平台
 *       切换为兼容模式，或在 decrypt() 处接入官方加解密库。
 */
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

/* ---------------- 服务器验证 ---------------- */
function checkSignature(token, signature, timestamp, nonce) {
  if (!token || !signature) return false;
  const str = [token, timestamp, nonce].sort().join('');
  const sha = crypto.createHash('sha1').update(str, 'utf8').digest('hex');
  return sha === signature;
}

/* ---------------- XML（只处理微信消息用到的结构） ---------------- */
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function parseXml(xml) {
  const out = {};
  // 先剥掉最外层 <xml> 根标签：否则字段正则会先把整个文档匹配成一个 "xml" 键，字段全部丢失
  const body = String(xml).replace(/^\uFEFF?\s*<xml[^>]*>/i, '').replace(/<\/xml>\s*$/i, '');
  const re = /<([A-Za-z_][\w:-]*)\s*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let v = m[2];
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(v);
    out[m[1]] = cdata ? cdata[1] : v.trim();
  }
  return out;
}
function buildTextXml(toUser, fromUser, content) {
  return '<xml>' +
    '<ToUserName><![CDATA[' + toUser + ']]></ToUserName>' +
    '<FromUserName><![CDATA[' + fromUser + ']]></FromUserName>' +
    '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[' + xmlEscape(content) + ']]></Content>' +
    '</xml>';
}

/* ---------------- HTTPS 请求 ---------------- */
function httpsJson(urlStr, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad url')); }
    const payload = options.body ? Buffer.from(JSON.stringify(options.body), 'utf8') : null;
    const req = https.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: options.method || (payload ? 'POST' : 'GET'),
      headers: Object.assign(
        { 'Content-Type': 'application/json; charset=utf-8' },
        payload ? { 'Content-Length': payload.length } : {},
        options.headers || {}
      ),
      timeout: options.timeout || 10000
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { json = null; }
        if (!json) return reject(new Error('响应不是合法 JSON: ' + buf.slice(0, 200)));
        if (json.errcode) return reject(Object.assign(new Error(json.errmsg || ('errcode ' + json.errcode)), { errcode: json.errcode }));
        resolve(json);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------------- access_token ---------------- */
let TOKEN_CACHE = { token: '', exp: 0, fetching: null };

function getAccessToken(cfg) {
  if (TOKEN_CACHE.token && TOKEN_CACHE.exp > Date.now() + 5000) {
    return Promise.resolve(TOKEN_CACHE.token);
  }
  if (TOKEN_CACHE.fetching) return TOKEN_CACHE.fetching;
  const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' +
    encodeURIComponent(cfg.appId) + '&secret=' + encodeURIComponent(cfg.appSecret);
  TOKEN_CACHE.fetching = httpsJson(url)
    .then(j => {
      TOKEN_CACHE.token = j.access_token;
      TOKEN_CACHE.exp = Date.now() + (Number(j.expires_in) || 7200) * 1000;
      TOKEN_CACHE.fetching = null;
      return TOKEN_CACHE.token;
    })
    .catch(e => { TOKEN_CACHE.fetching = null; throw e; });
  return TOKEN_CACHE.fetching;
}
function resetTokenCache() { TOKEN_CACHE = { token: '', exp: 0, fetching: null }; }

/* ---------------- 客服消息（异步下发，避免 5 秒超时） ---------------- */
function sendCustomText(cfg, openid, text) {
  return getAccessToken(cfg)
    .then(token => httpsJson('https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + encodeURIComponent(token), {
      body: { touser: openid, msgtype: 'text', text: { content: text } }
    }))
    .then(() => true)
    .catch(e => {
      // 40001/42001：token 失效，清缓存后重试一次
      const code = e && e.errcode;
      if (code === 40001 || code === 42001) {
        resetTokenCache();
        return getAccessToken(cfg).then(token =>
          httpsJson('https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + encodeURIComponent(token), {
            body: { touser: openid, msgtype: 'text', text: { content: text } }
          })).then(() => true);
      }
      throw e;
    });
}

module.exports = {
  checkSignature, parseXml, buildTextXml, xmlEscape,
  httpsJson, getAccessToken, resetTokenCache, sendCustomText
};
