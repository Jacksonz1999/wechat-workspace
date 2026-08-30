'use strict';
const nlu = require('./lib/nlu.js');

const tests = [
  '今天帮我加一个家庭类的一个工作，就是下周一，我得跟保险公司说一下车的事情。挺紧急的',
  '帮我加一个任务，明天交周报',
  '我要记一笔 68 餐饮',
  '给我安排一个工作上的事，后天开会',
  '新建一个生活类的待办，每天跑步',
  '提醒我 下周一 跟保险公司说车的事',
];

for (const msg of tests) {
  const r = nlu.ruleRecognize(msg);
  const tool = nlu.pickTool(r);
  console.log('---');
  console.log('IN:  ' + msg.slice(0, 50));
  console.log('INT: ' + (r.intent || '(none)') + ' | OBJ: ' + (r.object || '(none)') +
    ' | HIT: ' + r.hit + ' | CONF: ' + r.confidence.toFixed(2));
  console.log('SLT: ' + JSON.stringify(r.slots));
  console.log('TOOL: ' + tool);
}
