// 统计今天 deepseek-web 的请求频率（按小时），用于分析行为特征
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import path from 'node:path';

const root = process.argv[2];
const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompress(file) {
  const buf = readFileSync(file);
  const st = [];
  let i = 0;
  while (true) { const k = buf.indexOf(M, i); if (k < 0) break; st.push(k); i = k + 4; }
  let s = '';
  for (let k = 0; k < st.length; k++) {
    const a = st[k], b = k + 1 < st.length ? st[k + 1] : buf.length;
    try { s += zstdDecompressSync(buf.subarray(a, b)).toString('utf8'); } catch {}
  }
  return s;
}

const perHour = new Map();
let total = 0;

for (const dir of readdirSync(root)) {
  const full = path.join(root, dir);
  if (!statSync(full).isDirectory()) continue;
  for (const f of readdirSync(full)) {
    if (!f.endsWith('.zstd')) continue;
    const p = path.join(full, f);
    if (Date.now() - statSync(p).mtimeMs > 24 * 3600e3) continue;
    let text;
    try { text = decompress(p); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('request/header') || !line.includes('deepseek-web')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const t = e.time;
      if (!t) continue;
      const h = new Date(t).toISOString().slice(0, 13);
      perHour.set(h, (perHour.get(h) || 0) + 1);
      total++;
    }
  }
}

console.log('deepseek-web 请求总数（近 24h）:', total);
console.log('按 UTC 小时分布:');
for (const [h, n] of [...perHour.entries()].sort()) {
  console.log(`  ${h}:00Z   ${String(n).padStart(4)} 次   ${'█'.repeat(Math.min(60, n))}`);
}
