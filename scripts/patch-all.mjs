#!/usr/bin/env node
// 给 dsh-deepseek-web-free 打上"稳定性 + 工具调用 + 输出质量"补丁（幂等，可重复执行）
//
// 用法：
//   node scripts/patch-all.mjs                 # 默认改 ~/.dsh/profiles/desktop/node_modules/dsh-deepseek-web-free/lib
//   DSWEB_LIB=<目录>/lib node scripts/patch-all.mjs
//
// 改前每个文件都会备份成 *.bak-compat，可用 scripts/revert.mjs 还原。
// 说明：这些补丁作用于已安装包，插件升级后会被覆盖，重跑一次即可。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const LIB = process.env.DSWEB_LIB
  || path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-deepseek-web-free', 'lib');
const CFG = path.join(LIB, 'config-DACadRbL.js');
const IDX = path.join(LIB, 'index.js');

for (const f of [CFG, IDX]) {
  if (!existsSync(f)) {
    console.error('找不到插件文件：' + f);
    console.error('请确认 dsh-deepseek-web-free 已安装，或用 DSWEB_LIB 指定 lib 目录。');
    process.exit(1);
  }
}

let applied = 0;
let skipped = 0;
let failed = 0;

function edit(file, marker, oldText, newText, label) {
  let src = readFileSync(file, 'utf8');
  if (src.includes(marker)) { skipped++; console.log(`  = ${label}（已存在）`); return; }
  if (!src.includes(oldText)) { failed++; console.log(`  ! ${label}：锚点未找到（插件版本可能变了）`); return; }
  const bak = file + '.bak-compat';
  if (!existsSync(bak)) copyFileSync(file, bak);
  writeFileSync(file, src.replace(oldText, newText), 'utf8');
  applied++;
  console.log(`  + ${label}`);
}

// ─────────────────────────── A. 协议层（config-DACadRbL.js）───────────────────────────

// A1. create_pow_challenge 失败时按业务码分类写日志，而不是一律 PROTOCOL
edit(CFG, 'REAUTH_REQUIRED', `\tthrowIfProtocolError(parsed);
\tif (parsed.response.type !== "pow_challenge") throw new DeepSeekWebError("invalid PoW challenge", ERROR_CODES.POW);`,
`\tif (!parsed.ok) {
\t\tconst bodyText = String(raw?.text ?? "").trim();
\t\tlet serverCode;
\t\tlet serverMsg = "";
\t\ttry {
\t\t\tconst parsedBody = JSON.parse(bodyText);
\t\t\tif (typeof parsedBody?.code === "number") serverCode = parsedBody.code;
\t\t\tif (typeof parsedBody?.msg === "string") serverMsg = parsedBody.msg;
\t\t} catch {}
\t\tconst looksJson = bodyText.startsWith("{") || bodyText.startsWith("[");
\t\ttry {
\t\t\tconst dir = join(homedir(), ".dsh", "deepseek-web");
\t\t\tawait mkdir(dir, { recursive: true });
\t\t\tconst redacted = bodyText.slice(0, 1500).replace(/Bearer\\s+\\S+/gi, "Bearer [redacted]");
\t\t\tawait writeFile(join(dir, "pow-error.log"), JSON.stringify({
\t\t\t\tat: (new Date()).toISOString(),
\t\t\t\tstatus: raw?.status,
\t\t\t\tserverCode: serverCode ?? null,
\t\t\t\tserverMsg,
\t\t\t\tbody: redacted
\t\t\t}) + "\\n", { flag: "a" });
\t\t} catch {}
\t\tif (serverCode === 40002 || serverCode === 40003) {
\t\t\tthrow new DeepSeekWebError("DeepSeek Web 登录态失效（code " + serverCode + " " + serverMsg + "），请重新登录", ERROR_CODES.REAUTH_REQUIRED, { status: raw?.status });
\t\t}
\t\tif (typeof serverCode === "number" && serverCode !== 0) {
\t\t\tthrow new DeepSeekWebError("DeepSeek Web 拒绝了请求（code " + serverCode + " " + serverMsg + "）", ERROR_CODES.AUTH, { status: raw?.status });
\t\t}
\t\tthrow new DeepSeekWebError(
\t\t\tlooksJson ? "challenge 返回了无法识别的 JSON（协议可能改了）" : "challenge 端点返回了非 JSON 页面（反爬/WAF）",
\t\t\tlooksJson ? ERROR_CODES.PROTOCOL : ERROR_CODES.WAF,
\t\t\t{ status: raw?.status }
\t\t);
\t}
\tif (parsed.response?.type !== "pow_challenge") throw new DeepSeekWebError("invalid PoW challenge", ERROR_CODES.POW);`,
  'A1 错误按业务码分类 + 写 pow-error.log');

// A2. currentUser 把服务端轮换的新 token 带出来
edit(CFG, 'rotatedToken', `\tif (parsed.response.type !== "account") throw new DeepSeekWebError("DeepSeek Web account id missing", ERROR_CODES.PROTOCOL);
\treturn {
\t\tid: parsed.response.id,
\t\taccountHash: accountHash(parsed.response.id)
\t};`,
`\tif (parsed.response.type !== "account") throw new DeepSeekWebError("DeepSeek Web account id missing", ERROR_CODES.PROTOCOL);
\tlet rotatedToken;
\ttry {
\t\tconst parsedBody = JSON.parse(raw.text);
\t\tconst t = parsedBody?.data?.biz_data?.token;
\t\tif (typeof t === "string" && t.length > 0) rotatedToken = t;
\t} catch {}
\treturn {
\t\tid: parsed.response.id,
\t\taccountHash: accountHash(parsed.response.id),
\t\ttoken: rotatedToken
\t};`,
  'A2 currentUser 返回轮换 token');

// A3. 构造器里的 fire-and-forget promises 加 catch（否则未处理拒绝会杀掉进程）
edit(CFG, 'warmup()?.catch', `\t\tthis.pow.warmup();
\t\tloadProtocolCore();`,
`\t\t// fire-and-forget：不 catch 就是未处理拒绝，Node 24 会直接结束进程
\t\tthis.pow.warmup()?.catch?.(() => {});
\t\tloadProtocolCore().catch(() => {});`,
  'A3 构造器两处 promise 兜底');

// ─────────────────────────── B. 适配器层（index.js）───────────────────────────

// B1. powHeaderPromise 提前发起，没人 await 时会变成未处理拒绝
edit(IDX, 'powHeaderPromise?.catch',
  `\t\tconst powHeaderPromise = options.purpose === "session-title" ? Promise.resolve(void 0) : this.client.solveCompletionPow?.(credential, options.signal);`,
`\t\tconst powHeaderPromise = options.purpose === "session-title" ? Promise.resolve(void 0) : this.client.solveCompletionPow?.(credential, options.signal);
\t\t// 这条 promise 提前发起；若先失败而没人 await，就是未处理拒绝，Node 24 会结束进程
\t\tpowHeaderPromise?.catch?.(() => {});`,
  'B1 powHeaderPromise 兜底');

// B2 + B3. 把轮换 token 写回凭据库
edit(IDX, 'storeCredential\n\t});', `\tconst adapter = new DeepSeekWebAdapter({
\t\toptions,
\t\tresolveCredential,
\t\tclient
\t});`,
`\tconst adapter = new DeepSeekWebAdapter({
\t\toptions,
\t\tresolveCredential,
\t\tclient,
\t\tstoreCredential
\t});`,
  'B2 适配器注入 storeCredential');

edit(IDX, 'storeCredential?.(account.token)', `\t\t\tconst account = await this.client.currentUser(credential, signal);
\t\t\tthis.accountCache.set(credential, {
\t\t\t\thash: account.accountHash,
\t\t\t\tat: Date.now()
\t\t\t});`,
`\t\t\tconst account = await this.client.currentUser(credential, signal);
\t\t\tif (typeof account.token === "string" && account.token.length > 0 && account.token !== credential) {
\t\t\t\ttry { await this.deps.storeCredential?.(account.token); } catch {}
\t\t\t}
\t\t\tthis.accountCache.set(credential, {
\t\t\t\thash: account.accountHash,
\t\t\t\tat: Date.now()
\t\t\t});`,
  'B3 轮换 token 写回凭据库');

// B4. DSML 变体归一化（模型会用全角竖线/双竖线/多余 name 参数，插件解析器认不出）
const DSML_HELPER = `/** 把模型实际吐出来的各种 DSML 变体（全角竖线、双竖线、多余 name 参数、多余空格）归一化成 dsh_tool_calls JSON。 */
function normalizeDsmlVariant(content) {
\tif (!/DSML/i.test(content)) return content;
\tif (content.includes("<dsh_tool_calls>")) return content;
\tconst s = content
\t\t.replace(/<[\\uFF5C|]+DSML[\\uFF5C|]+/g, "<||DSML||")
\t\t.replace(/<\\/[\\uFF5C|]+DSML[\\uFF5C|]+/g, "</||DSML||");
\tconst calls = [];
\tconst invRe = /<\\|+DSML\\|+\\s*invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/\\|+DSML\\|+\\s*invoke>/g;
\tlet m;
\twhile ((m = invRe.exec(s)) !== null) {
\t\tconst name = m[1];
\t\tconst body = m[2];
\t\tconst args = {};
\t\tconst pRe = /<\\|+DSML\\|+\\s*parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/\\|+DSML\\|+\\s*parameter>/g;
\t\tlet p;
\t\twhile ((p = pRe.exec(body)) !== null) {
\t\t\tconst key = p[1];
\t\t\tif (key === "name") continue;
\t\t\tlet value = p[2].trim();
\t\t\ttry { value = JSON.parse(value); } catch {}
\t\t\targs[key] = value;
\t\t}
\t\tlet finalArgs = args;
\t\tif (args && typeof args.arguments === "object" && args.arguments !== null) finalArgs = args.arguments;
\t\tcalls.push({ name, arguments: finalArgs });
\t}
\tif (calls.length === 0) return s;
\treturn "<dsh_tool_calls>" + JSON.stringify({ version: 1, calls }) + "</dsh_tool_calls>";
}

`;

edit(IDX, 'normalizeDsmlVariant', `function parseToolProtocol(content, allowedTools, options) {
\tconst allowed = new Set(allowedTools);`,
DSML_HELPER + `function parseToolProtocol(rawContent, allowedTools, options) {
\tconst content = normalizeDsmlVariant(rawContent);
\tconst allowed = new Set(allowedTools);`,
  'B4 DSML 变体归一化');

// B5. 输出质量前言（长产物分块、不省略、标续写点）
const QUALITY = `const QUALITY_PREAMBLE = \`
<DSH_OUTPUT_QUALITY>
输出质量硬性要求（生成长文本、代码或文件时适用）：
1. 完整输出：不得用 "…"、"// 省略"、"其余同上" 之类的占位跳过任何部分；一个文件必须从头写到尾。
2. 单次容量有限：如果预计产物超过约 8000 字符，先输出完整骨架（所有标签闭合、可运行），再分块补全内容。
3. 续写标记：未能一次写完时，在结尾单独一行输出 <DSH_CONTINUE/>，然后停下；下一轮从断点继续，不重复已写内容。
4. 对照约束：用户列出的每一条硬性要求，输出前逐条核对，缺哪条补哪条。
5. 细节不确定时按最常见做法直接实现，不因为不确定而省略整块。
6. 只输出要求的产物本身，不要额外的解释、寒暄或"我已完成"之类的声明。
</DSH_OUTPUT_QUALITY>
\`;

function outputQualityPreamble() {
\tif (process.env.DSHWEB_QUALITY === "off") return "";
\treturn QUALITY_PREAMBLE;
}

`;

edit(IDX, 'outputQualityPreamble', 'function buildToolContract(tools, maxCalls) {',
  QUALITY + 'function buildToolContract(tools, maxCalls) {',
  'B5 注入输出质量前言');

edit(IDX, '${outputQualityPreamble()}', `<DSH_AGENT_INSTRUCTIONS>
\${input.system ?? ""}
</DSH_AGENT_INSTRUCTIONS>`,
`<DSH_AGENT_INSTRUCTIONS>
\${input.system ?? ""}
</DSH_AGENT_INSTRUCTIONS>
\${outputQualityPreamble()}`,
  'B5b 前言接入 prompt');

// B6. 只思考不出正文时，自动关 thinking 续问一次
edit(IDX, '__noThinkRetry', `\t\t\t\treturn {
\t\t\t\t\tturn,
\t\t\t\t\tcalls: []
\t\t\t\t};`,
`\t\t\t\tif (input.__noThinkRetry !== true && input.thinkingEnabled !== false && String(turn?.text ?? "").trim() === "" && String(turn?.reasoning ?? "").trim() !== "") {
\t\t\t\t\treturn this.completeWithRepair({
\t\t\t\t\t\t...input,
\t\t\t\t\t\tthinkingEnabled: false,
\t\t\t\t\t\t__noThinkRetry: true,
\t\t\t\t\t\tparentMessageId: turn.responseMessageId ?? parent,
\t\t\t\t\t\tpowHeader: void 0
\t\t\t\t\t});
\t\t\t\t}
\t\t\t\treturn {
\t\t\t\t\tturn,
\t\t\t\t\tcalls: []
\t\t\t\t};`,
  'B6 空白回答自动重试');

console.log(`\n完成：新增 ${applied}，已存在 ${skipped}，失败 ${failed}`);
if (failed > 0) {
  console.log('有补丁锚点未命中 —— 插件可能已升级，请对照 docs/protocol.md 手动确认。');
  process.exit(2);
}
