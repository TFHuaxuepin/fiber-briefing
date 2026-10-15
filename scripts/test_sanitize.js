// 回归测试：LLM 可能返回空 table 对象（{}/headers=null/rows=undefined），
// 早期版本会在 renderSection 里直接 sec.table.headers.map(...) 抛异常导致整期渲染失败。
// 运行：node scripts/test_sanitize.js
const { sanitizeData, renderDaily } = require('./build_briefing.js');

const cases = [
  {
    name: '空 table 对象（线上崩溃现场）',
    input: {
      highpoints: [{ tag: 'up', text: '涤纶长丝上涨0.63%' }],
      sections: [
        { title: '价格动态', paragraphs: ['POY重心上移。'], table: {} },
        { title: '下游需求：加弹/织造/坯布', paragraphs: ['轻纺城化纤布成交走弱。'], table: { headers: null, rows: undefined } },
      ],
      notes: '数据来自CCF',
    },
  },
  {
    name: 'table 只有 headers 没有 rows',
    input: { highpoints: [], sections: [{ title: 'A', paragraphs: [], table: { headers: ['指标'], rows: [] } }] },
  },
  { name: '完全空结构', input: { highpoints: null, sections: null, notes: null } },
  {
    name: '段落里混入 null / 空串',
    input: { highpoints: [{ text: '  ' }, null, { tag: 'down', text: '乙二醇下跌' }], sections: [{ title: null, paragraphs: ['x', null, '  ', 'y'] }] },
  },
];

let fail = 0;
for (const c of cases) {
  const out = sanitizeData(JSON.parse(JSON.stringify(c.input)));
  let ok = true, err = '';
  try {
    renderDaily('2026-09-15', '区间', out, []);
  } catch (e) { ok = false; err = e.message; }
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : '  -> ' + err}`);
  console.log('      sections=' + out.sections.length + ' highpoints=' + out.highpoints.length
    + ' tables=' + out.sections.filter(s => s.table).length);
}

// 有效 table 必须被保留
const keep = sanitizeData({ highpoints: [{ tag: 'up', text: 'a' }], sections: [{ title: 'T', paragraphs: ['p'], table: { headers: ['指标', '数值'], rows: [['POY', '7000']] } }] });
if (keep.sections[0].table && keep.sections[0].table.rows.length === 1) console.log('PASS  有效 table 被保留');
else { console.log('FAIL  有效 table 被误删'); fail++; }

// ===== qualityCheck：拦截残缺 LLM 输出（2026-09-17 事故：只给 4 条要点、板块为空） =====
const { qualityCheck } = require('./build_briefing.js');
const good = JSON.stringify({
  highpoints: [{ tag: 'up', text: 'a' }, { tag: 'down', text: 'b' }, { tag: '原料', text: 'c' }],
  sections: [{ title: 'A', paragraphs: ['p1', 'p2'] }, { title: 'B', paragraphs: ['p3'] }],
});
if (qualityCheck(good).ok) console.log('PASS  qualityCheck 完整输出通过');
else { console.log('FAIL  qualityCheck 完整输出被误拒'); fail++; }

// 事故现场：截断到只剩 highpoints（closeAll 修复后可解析，但板块缺失）
const truncated = '{"highpoints":[{"tag":"up","text":"a"},{"tag":"down","text":"b"},{"tag":"x","text":"c"},{"tag":"y","text":"d"';
const qc1 = qualityCheck(truncated);
if (!qc1.ok && /板块/.test(qc1.reason)) console.log('PASS  qualityCheck 拦截"只有要点"的截断输出 → ' + qc1.reason);
else { console.log('FAIL  qualityCheck 未拦截截断输出: ' + JSON.stringify(qc1)); fail++; }

// 板块为空的偷懒输出
const lazy = JSON.stringify({ highpoints: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], sections: [] });
if (!qualityCheck(lazy).ok) console.log('PASS  qualityCheck 拦截空板块输出');
else { console.log('FAIL  qualityCheck 未拦截空板块'); fail++; }

// 非法文本
if (!qualityCheck('抱歉，我无法完成这个任务。').ok) console.log('PASS  qualityCheck 拦截非JSON文本');
else { console.log('FAIL  qualityCheck 未拦截非JSON'); fail++; }

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} CASE(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
