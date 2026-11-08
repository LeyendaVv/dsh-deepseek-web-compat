// 打印指定 turn 的每个 step：模型请求、assistant 正文/思考长度与工具调用
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const turn = Number(process.argv[3]);
const buf = readFileSync(file);
const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const st = [];
let i = 0;
while (true) { const k = buf.indexOf(M, i); if (k < 0) break; st.push(k); i = k + 4; }
let text = '';
for (let k = 0; k < st.length; k++) {
  const a = st[k], b = k + 1 < st.length ? st[k + 1] : buf.length;
  try { text += zstdDecompressSync(buf.subarray(a, b)).toString('utf8'); } catch {}
}
for (const line of text.split('\n')) {
  if (!line) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.data?.turn !== turn) continue;
  const step = e.data?.step;
  if (e.type === 'request/header') console.log(`  step ${step} → 模型请求`);
  else if (e.type === 'assistant/message') {
    const c = e.data?.message?.content ?? [];
    const tx = c.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('');
    const rs = c.filter((x) => x.type === 'reasoning').map((x) => x.text ?? '').join('');
    const calls = c.filter((x) => x.type === 'tool-call').map((x) => x.name);
    console.log(`  step ${step} assent 正文=${tx.length} 思考=${rs.length} 调用=${calls.join(',') || '-'} 正文样本=${JSON.stringify(tx.slice(0, 40))}`);
  } else if (e.type === 'tool/call') console.log(`  step ${step} tool/call ${e.data?.name}`);
  else if (e.type === 'step/end') console.log(`  step ${step} step/end`);
}
