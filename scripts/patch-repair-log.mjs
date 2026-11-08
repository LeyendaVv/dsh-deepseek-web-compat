#!/usr/bin/env node
// 补丁 B8：给 completeWithRepair 加决策日志，定位"为什么没触发重试"
// 输出到 ~/.dsh/deepseek-web/repair.log，每轮一行：
//   kind= none/calls/invalid  text=  reasoning=  thinking=  streamed=  attempt=  → retry/skip/return
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      path.join(homedir(), '.dsh', 'plugin-sources', 'dsh-deepseek-web-free', 'lib', 'index.js'),
      path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-deepseek-web-free', 'lib', 'index.js'),
    ];

const OLD = `\t\t\tif (parsed.kind === "none") {
\t\t\t\tconst promisedSource = turn.text.trim().length > 0 ? turn.text : turn.reasoning;`;
const NEW = `\t\t\tif (parsed.kind === "none") {
\t\t\t\ttry {
\t\t\t\t\tconst dir = join(homedir(), ".dsh", "deepseek-web");
\t\t\t\t\tawait mkdir(dir, { recursive: true });
\t\t\t\t\tawait writeFile(join(dir, "repair.log"), JSON.stringify({
\t\t\t\t\t\tat: (new Date()).toISOString(),
\t\t\t\t\t\tkind: parsed.kind,
\t\t\t\t\t\ttext: String(turn?.text ?? "").replace(/\\s/g, "").length,
\t\t\t\t\t\treasoning: String(turn?.reasoning ?? "").trim().length,
\t\t\t\t\t\tthinking: input.thinkingEnabled,
\t\t\t\t\t\tstreamed: input.sink.streamedVisible,
\t\t\t\t\t\tattempt,
\t\t\t\t\t\tnoThinkRetried: input.__noThinkRetry === true
\t\t\t\t\t}) + "\\n", { flag: "a" });
\t\t\t\t} catch {}
\t\t\t\tconst promisedSource = turn.text.trim().length > 0 ? turn.text : turn.reasoning;`;

let n = 0;
for (const file of TARGETS) {
  if (!existsSync(file)) { console.log('缺文件: ' + file); continue; }
  const src = readFileSync(file, 'utf8');
  if (src.includes('"repair.log"')) { console.log('已打过: ' + file); continue; }
  if (!src.includes(OLD)) { console.log('锚点未找到: ' + file); continue; }
  const bak = file + '.bak-repair-log';
  if (!existsSync(bak)) copyFileSync(file, bak);
  writeFileSync(file, src.replace(OLD, NEW), 'utf8');
  n++;
  console.log('已加决策日志: ' + file);
}
if (!n) console.log('无改动');
