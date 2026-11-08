# 完整技术复盘：把 DeepSeek 网页版接成 DSH 模型车道的全过程

> 记录我们实际走过的每一步、每个知识点、每次踩坑和判断依据。
> **写在前面**：这套路线已被验证会触发账号风控（实测禁言 3 天）。技术可行 ≠ 建议使用。
> 保留此文档是为了留下"怎么做的"和"为什么这么做"，不是鼓励复现。

---

# 第 0 章 动手前必须知道的五件事

1. **网页 API 是私有的**：路径、字段、鉴权随时会变，且没有任何兼容承诺。
2. **网页登录分两层**：长期 session cookie + 短期 token（约 1 小时）。硬件客户端只有 token，浏览器有 cookie。
3. **网页没有原生 function calling**：工具调用只能靠"文本协议约定"，模型会退化。
4. **PoW 是准入闸门**：每次请求都要现算一个工作量证明，这是官方在区分"人"和"程序"。
5. **风控是行为级的**：不是"你调通了"就没事，而是"你调得太多、太规律、太像程序"就出事。

---

# 第 1 章 接入：先让 DSH 认识一个"新模型"

## 1.1 DSH 的模型是怎么注册的

```
~/.dsh/profiles/<profile>/
├── package.json      ← dsh.profile.bundles 决定加载哪些插件
├── cordis.patch.yml  ← 对插件配置的覆盖（用户层）
└── node_modules/     ← 插件实际代码
```

- 插件通过 `dsh.profile.bundles` 数组决定是否加载
- 模型车道由 LLM 插件注册：`import { LlmAdapter } from "@deepseek-ai/dsh-llm"`
- 默认模型由 `agent-default-model` 插件的 `provider / model` 字段决定

## 1.2 选择插件

当时对比了三条路：

| 插件 | 协议 | 结论 |
|---|---|---|
| `dsh-deepseek-web@1.0.3` | 旧版网页 | peer 要求 `^0.1.0-rc.7`，与 0.2.1-rc.5 不兼容，装不上 |
| `dsh-web-bridge`（DSH-webtokens） | 浏览器桥接 | 装得上但启动失败：`llm/discoverModels parameter codec has no create() factory` |
| `dsh-deepseek-web-free@1.0.33` | 网页私有 API | ✅ peer `>=0.2.0-rc.1 <0.3.0-0`，可用 |

**知识点**：装插件前先看 `peerDependencies`，DSH 版本跳得快，跨版本几乎必坏。

## 1.3 关键踩坑：patch 文件的写法

`cordis.patch.yml` 里想**新增**一个插件条目，必须用 `- insert:` 形式：

```yaml
- insert:
    - id: my-plugin
      name: my-plugin-package
      config: {...}
```

直接写 `- id: x / name: y` 会被当成"覆盖已有条目"，找不到就静默忽略，日志里只有一句 `patch: entry "x" not found`。

## 1.4 依赖改成 file: 防止补丁被覆盖

DSH 启动时可能重装依赖，`node_modules` 里的补丁会被 npm 版本覆盖。解法：

```bash
dsh plugin --profile <profile> add file:<插件源码目录>
```

之后 `package.json` 里是 `file:C:/.../dsh-deepseek-web-free`，重启不再被洗回原版。

---

# 第 2 章 协议：一次模型调用到底发了什么

## 2.1 五步时序

```
① GET  /api/v0/users/current                校验 token，返回账号 + 轮换后的新 token
② POST /api/v0/chat_session/create           建网页会话 → chatSessionId
③ POST /api/v0/chat/create_pow_challenge     领 PoW 挑战（target_path=/api/v0/chat/completion）
④ 本地求解 PoW → x-ds-pow-response 请求头
⑤ POST /api/v0/chat/completion               带 PoW + prompt → SSE 流
```

## 2.2 必需请求头（伪造官方 Web 客户端）

| 头 | 值 |
|---|---|
| `authorization` | `Bearer <token>` |
| `x-client-version` | `2.2.0` |
| `x-client-bundle-id` | `com.deepseek.chat` |
| `x-client-platform` | `web` |
| `x-client-locale` | `zh_CN` |
| `origin` / `referer` | `https://chat.deepseek.com` |
| `user-agent` | **必须是浏览器 UA** |

**实测**：默认 `curl/x.y` 的 UA 会被 WAF 直接挡成 429 + HTML 页（`Server: CW`、`Block-Event-Id`、`HWWAFSESID`）。换成浏览器 UA 就正常。

## 2.3 PoW 挑战的字段

```json
{"code":0,"msg":"","data":{"biz_data":{"challenge":{
  "algorithm":"DeepSeekHashV1",
  "challenge":"<64 hex>",
  "salt":"<hex>",
  "signature":"<64 hex>",
  "difficulty":144000,
  "expire_at":1794121038063,
  "expire_after":300000,
  "target_path":"/api/v0/chat/completion"
}}}}
```

- 求解：枚举 nonce，做带 salt 的哈希，直到满足 difficulty
- 实测：**60–90 ms**，nonce 落在 11–14 万区间
- 结果编码成 JSON 放在 `x-ds-pow-response`（约 368 字符）
- `expire_at` 到期作废，必须重新领

**知识点**：这个计算量和"人点一下按钮"是等价的，官方用它防机器刷。我们程序化求解，本质就是在绕过这层准入。

## 2.4 SSE 流的两条通道

网页会把内容分成：

- `reasoning`（思考通道 / DeepThink）
- `text`（回答通道）

插件必须分别解析、分别缓存。**很多"空白回答"的问题就出在这两条通道的处理上**（见第 6 章）。

## 2.5 错误码：HTTP 200 里的业务错误

| code | 含义 | 正确处理 |
|---|---|---|
| 40002 | Missing Token | 未登录 |
| 40003 | Authorization Failed (invalid token) | token 失效，需重新登录 |
| 42901 | too many requests | 限频，等冷却 |
| 非 JSON | HTML 拦截页 | WAF/反爬 |

**原插件的 bug**：把这些一律当成 `PROTOCOL` 错误，于是触发"重建会话 + 重试"，在启动期直接变成致命崩溃。

---

# 第 3 章 认证：token 的生命周期（问题的核心）

## 3.1 两种凭证

| 凭证 | 存放 | 寿命 | 用途 |
|---|---|---|---|
| session cookie | 浏览器 profile | 长（数小时到数天） | 换取 token |
| token | 网页 localStorage `userToken` | 短（约 1 小时） | 调 API |

网页 `localStorage.userToken` 是 JSON 信封：

```json
{"value":"<64 字符 token>","__version":"0"}
```

**拆包才能用**——直接拿字符串会拿到 JSON 原文。

## 3.2 DSH 凭据库的格式

`~/.dsh/.credentials.yaml`：

```yaml
version: 1
records:
  deepseek-account-platform/default:
    kind: ...
    payload: { version, token, issuer }
refs:
  DEEPSEEK_API_KEY: sk-...
  DEEPSEEK_WEB_TOKEN: <64 字符>
```

- 网页 token 存在 `refs.DEEPSEEK_WEB_TOKEN`
- token 失效后，DSH 会把这一项**移除**（不是标记过期），所以你看到的是"登录没了"

## 3.3 实测寿命

| 来源 | 实测 |
|---|---|
| 面板登录拿的 token | 约 66 分钟（15:25 → 16:31 失效） |
| 浏览器 localStorage token | 明显更长（16:47 抓的用了 3+ 小时） |

失效时间线（`pow-error.log`，本地时间）：16:31 / 16:32 / 16:34 / 17:14 / 19:53。

## 3.4 轮换写回

`GET /users/current` 的响应里会带一个新 token。原插件只取 `id`，把新 token 丢了。补丁：

```js
// 把轮换后的 token 写回凭据库
if (typeof account.token === "string" && account.token !== credential) {
  try { await this.deps.storeCredential?.(account.token); } catch {}
}
```

效果：能多续一两次，但**只要中间断一次轮换就失效**——因为它仍然没有 cookie。

## 3.5 抓 token（我们最后走的路）

用 CDP 连浏览器，从已登录页面读 `localStorage.userToken`：

```
浏览器 CDP: ws://127.0.0.1:9222/devtools/browser
→ Target.getTargets        找 chat.deepseek.com 页面
→ Target.attachToTarget    附着
→ Runtime.evaluate         localStorage.getItem("userToken")
→ Target.detachFromTarget
```

坑点：

1. `/json/list` 在新版 Edge 上返回 404（授权机制变化），**只能用 browser 级 WebSocket**
2. 每次新建连接都会弹「是否允许远程调试」→ 想自动化必须**保持一条长连接**
3. 写入前必须**先调接口校验 token**，否则会把废票写进凭据库
4. 读 token 时页面必须先加载完 JS，抓早了拿到的是旧值

---

# 第 4 章 工具调用：没有 function calling 的世界

## 4.1 契约是怎么塞进去的

插件把工具定义写成文本契约，放在 prompt 末尾：

```xml
<DSH_LOCAL_TOOL_CONTRACT>
DeepSeek Web does not expose native function calling.
Answer-channel schema:
<dsh_tool_calls>{"version":1,"calls":[{"name":"TOOL_NAME","arguments":{}}]}</dsh_tool_calls>
Rules:
- thinking / DeepThink: 只做规划，不要输出工具标签
- answer: 需要本地操作时，输出且只输出一个未围栏的块，然后停止
Available tools: [ ...每个工具的 name/description/parameters... ]
</DSH_LOCAL_TOOL_CONTRACT>
```

## 4.2 模型会怎么退化

真实抓到的三种：

**① 吐自家 DSML 格式**（最常见）

```
<｜｜DSML｜｜ invoke name="pwsh">
<｜｜DSML｜｜ parameter name="command" string="true">netstat -ano</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
```

注意是**全角竖线 + 双竖线**，不是文档里的 `||DSML||`。

**② 只思考不回答**：正文只剩 `\n\n`，内容全在 reasoning。

**③ 直接输出被截断**：单次约 1 万字符封顶。

## 4.3 归一化（解析层）

```js
function normalizeDsmlVariant(content) {
  if (!/DSML/i.test(content)) return content;
  if (content.includes("<dsh_tool_calls>")) return content;
  // 全角/双竖线统一成 ||DSML||
  const s = content
    .replace(/<[\uFF5C|]+DSML[\uFF5C|]+/g, "<||DSML||")
    .replace(/<\/[\uFF5C|]+DSML[\uFF5C|]+/g, "</||DSML||");
  // 解析 invoke / parameter，忽略多余的 name 参数
  // → 生成标准 <dsh_tool_calls> JSON
}
```

要点：

- 参数里如果套了 `name="arguments"` 的 JSON，要**拆一层**，否则参数变成 `{arguments:{path:...}}`
- 重复的 `name` 参数要跳过（模型会同时写 name 和 arguments）
- 归一化必须发生在 `parseToolProtocol` **最前面**

## 4.4 展示剥离（展示层）

解析层的归一化不能用于展示（否则模型原文被改），而原插件的 `stripDsml` 只认单竖线，漏了 `｜｜` 变体，导致"工具执行了，屏幕上还挂着 829 字符的草稿"。

解法：单独一个展示函数，**由内向外**删块：

```js
function stripToolMarkupForDisplay(content) {
  let s = content.replace(/[\uFF5C]+/g, "|");
  s = s.replace(/<\|+DSML\|+\s*parameter\b[^>]*>[\s\S]*?<\/\|+DSML\|+\s*parameter>/gi, "");
  s = s.replace(/<\|+DSML\|+\s*invoke\b[^>]*>[\s\S]*?<\/\|+DSML\|+\s*invoke>/gi, "");
  s = s.replace(/<\|+DSML\|+[^>]*>[\s\S]*?<\/\|+DSML\|+[^>]*>/gi, "");
  s = s.replace(/<\/?\|+DSML\|+[^>]*>/gi, "");
  s = s.replace(/<dsh_tool_calls>[\s\S]*?<\/dsh_tool_calls>/gi, "");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
```

实测：829 字符纯 DSML → 0；混排正文保留。

**核心原则：解析时不能删（删了没法执行），展示时必须删（不删就刺眼）。**

---

# 第 5 章 崩溃：为什么"应用起不来"

## 5.1 根因不是协议，是 Node 24

Node 24 默认把**未处理的 Promise 拒绝**当致命错误，直接结束进程。

插件里有几处 fire-and-forget：

```js
this.pow.warmup();                       // 没有 catch
loadProtocolCore();                      // 没有 catch
const powHeaderPromise = client.solveCompletionPow(...);  // 提前发起，没人 await
```

任何一个先失败 → 未处理拒绝 → 整个 host 退出。

## 5.2 修法

```js
this.pow.warmup()?.catch?.(() => {});
loadProtocolCore().catch(() => {});
powHeaderPromise?.catch?.(() => {});
```

## 5.3 错误分类

把"业务码"翻译成 DSH 能理解的错误类型：

| 业务 | 错误类型 | DSH 行为 |
|---|---|---|
| 40002/40003 | `REAUTH_REQUIRED` | 提示重新登录，不清空一切 |
| 429 | `AUTH`/可重试 | 等待重试 |
| HTML 页 | `WAF` | 归类为反爬，不重试 |
| 其它 JSON | `PROTOCOL` | 才当作协议变更 |

同时把原始响应写进 `~/.dsh/deepseek-web/pow-error.log`（截断 + 脱敏），否则永远不知道服务端回了什么。

---

# 第 6 章 空白回答：诊断实录

## 6.1 症状

界面："已完成，用时 22 秒"，消息区一片空白。

## 6.2 抓日志

会话日志（`~/.dsh/sessions/<id>/session.v4.jsonl.zstd`，zstd 分片）里逐条解析：

```
step 1  正文 2 字（"\n\n"）  思考 148    工具 pwsh
step 2  正文 2 字（"\n\n"）  思考 935    工具 pwsh
step 3  正文 2 字（"\n\n"）  思考 541    工具 pwsh
step 4  正文 2 字（"\n\n"）  思考 2085   无工具   ← 最终回复
```

**结论：不是"没回复"，是正文只有两个换行**，内容全进了思考通道。

## 6.3 两个修法

```js
// ① 判定放宽：不能要求"严格为空"，1–3 个字符也要算空白
String(turn?.text ?? "").replace(/\s/g, "").length < 8
// ② 触发重试：关掉 thinking 再问一次（同会话、接 responseMessageId）
return this.completeWithRepair({ ...input, thinkingEnabled: false, __noThinkRetry: true });
```

**调试技巧**：在 `parsed.kind === "none"` 分支里写一行 JSON 日志（kind / text / reasoning / thinking / streamed / attempt），能立刻看出卡在哪个条件。

---

# 第 7 章 上下文：把结构化对话压成一段文本

## 7.1 三块拼装

```xml
<DSH_AGENT_INSTRUCTIONS> 系统提示 </DSH_AGENT_INSTRUCTIONS>
<DSH_CONVERSATION> user / assistant / dsh_context 消息 </DSH_CONVERSATION>
<DSH_LOCAL_TOOL_CONTRACT> 工具定义 </DSH_LOCAL_TOOL_CONTRACT>
```

## 7.2 增量判断

算三个哈希：system、tools、历史前缀。
- 全一致 → 发增量（`<DEEPSEEK_WEB_INCREMENTAL_CONTEXT>`）
- 任一变化 → 发全量

**知识点**：这是性能关键。全量 prompt 几千 token，网页端要重算；增量能省一半时间。

---

# 第 8 章 性能与上限（实测数据）

## 8.1 一次多轮任务（10 轮，239 秒）

| 轮次 | 耗时 | 正文 | 思考 | 工具 |
|---|---|---|---|---|
| 1 | 2.1s | 53 | 0 | — |
| 2 | 35.0s | 0 | 11,797 | — |
| 3 | 3.9s | 0 | 1,423 | — |
| 6 | 8.9s | 5,897 | 0 | — |
| 7–9 | 17–25s | 300–600 | 600–2,100 | pwsh/write/read |
| 10 | 130.3s | 529 | 35,667 | write |

## 8.2 三个硬上限

| 限制 | 数值 | 表现 |
|---|---|---|
| 单次回复长度 | 约 1 万字符 | 长 HTML 缺 `</html>` |
| DeepThink 思考长度 | 不可控（实测 3.5–5.8 万字） | 单轮 130 秒 |
| 频率 | 触发 429 / WAF | 连续调用后全部失败 |

## 8.3 "更聪明的提示词"实验（反例）

同一需求三版：

| 版本 | 思考量 | 结果 |
|---|---|---|
| 原版 | 3.5 万字 | ✅ 完整 |
| 加长提示词 v2 | 5.8 万字 | ❌ 主体消失（实际是被截断） |
| 加长提示词 v3 | 5.3 万字 | ❌ 同上 |

**结论：提示词堆得越多，输出越长、越容易撞上限。质量前言应该约束"如何输出"，不是"想更久"。**

---

# 第 9 章 风控：我们是怎么被识别出来的

## 9.1 观察到的防护层

| 层 | 表现 |
|---|---|
| WAF | 非浏览器 UA → 429 + HTML（`Server: CW`） |
| PoW | 每次请求需算 6–9 万次哈希 |
| 频率 | 42901 too many requests |
| 行为 | 短时间大量请求 → 账号处罚 |

## 9.2 为什么会被判违规

按行为特征看，我们同时踩了多条：

1. **固定 UA + 固定指纹**：请求头完全一致，没有真实浏览器的随机性
2. **请求节奏过于规律**：定时任务、每 30 分钟一次的抓取
3. **同一 token 多端使用**：面板登录 + 浏览器 + keeper 写回
4. **PoW 求解耗时太一致**：60–90ms，机器特征明显
5. **没有配套的浏览行为**：只调 API 不看页面

## 9.3 结论

> 技术跑通了不代表能长期用。风控是行为对抗，程序化访问本身就是要被识别的对象。

这也是为什么这套方案**只适合学习协议**，不适合当生产力车道。

---

# 第 10 章 复现清单（如果将来还想学）

```
准备
□ 确认 DSH 版本与插件 peerDependencies 兼容
□ 插件用 file: 依赖，避免补丁被覆盖
□ cordis.patch.yml 用 - insert: 新增条目

协议
□ 浏览器 DevTools 抓一次完整请求，确认五个步骤
□ 单独实现 PoW 求解，验证 x-ds-pow-response 能过
□ 确认错误码分类（40002/40003/42901/HTML）

稳定性
□ 给所有 fire-and-forget 加 catch
□ 错误按业务码分类并写日志
□ 空白回答加阈值 + 重试
□ 工具调用先归一化再解析，展示层单独剥离

验证
□ diag live 返回 valid
□ 一次工具任务真实落盘
□ check-artifact 通过
```

---

# 第 11 章 复盘：哪些判断是对的

| 判断 | 结果 |
|---|---|
| 补丁放 file: 依赖，防覆盖 | ✅ 对，省了反复重打 |
| 错误按业务码分类 | ✅ 对，崩溃消失 |
| 先做诊断脚本再改代码 | ✅ 对，几次误判都被纠正 |
| 展示层与解析层分离 | ✅ 对，两个问题互不干扰 |
| 加质量前言 | ⚠️ 部分有效（防截断），但作用有限 |
| 靠轮换 token 续命 | ❌ 不可靠，缺 cookie |
| 浏览器抓 token 自动化 | ⚠️ 技术可行，但正是风控重点 |
| 高频自动化 | ❌ 直接导致封禁 |

**最重要的一条**：技术上的"跑通"和"能长期使用"是两件事。前者靠 debug，后者靠不触碰对方的风控边界。
