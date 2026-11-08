// 扫描会话日志：找出模型输出了 DSML 但没被解析成工具调用的轮次
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import path from 'node:path';

const root = process.argv[2];
const sinceMs = Date.now() - Number(process.argv[3] || 120) * 60000;

function decompress(file) {
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
  return text;
}

for (const dir of readdirSync(root)) {
  const full = path.join(root, dir);
  if (!statSync(full).isDirectory()) continue;
  const files = readdirSync(full).filter((f) => f.endsWith('.zstd'));
  for (const f of files) {
    const p = path.join(full, f);
    if (statSync(p).mtimeMs < sinceMs) continue;
    let text;
    try { text = decompress(p); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('assistant/message')) continue;
      if (!/DSML|dsh_tool_calls|<\|.*invoke/i.test(line)) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const content = e.data?.message?.content ?? [];
      const tx = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      const rs = content.filter((c) => c.type === 'reasoning').map((c) => c.text ?? '').join('');
      const calls = content.filter((c) => c.type === 'tool-call');
      const dsmlInText = /DSML/i.test(tx);
      const dsmlInReasoning = /DSML/i.test(rs);
      if (!dsmlInText && !dsmlInReasoning) continue;
      console.log(`${dir.slice(-12)} turn=${e.data?.turn} step=${e.data?.step} calls=${calls.length} text=${tx.length} reasoning=${rs.length} dsmlInText=${dsmlInText} dsmlInReasoning=${dsmlInReasoning}`);
      const sample = (dsmlInText ? tx : rs).replace(/\s+/g, ' ').slice(0, 220);
      console.log('   样本: ' + sample);
    }
  }
}
