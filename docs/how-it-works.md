# DeepSeek 网页版接入 DSH 是怎么跑起来的

> 面向想搞懂原理的人。看完你应该能回答：token 为什么老失效、工具调用为什么会被"翻译"、我们那十个补丁各自在修什么。

---

## 一、整体结构：一个"协议翻译器"

```
你发一句话
   │
   ▼
DSH 的 llm 服务（@deepseek-ai/dsh-llm）
   │  统一模型调用层：流式、工具、重试、用量统计都在这一层
   │  按 provider 名把请求交给对应的"适配器"
   ▼
dsh-deepseek-web-free（本插件 = 适配器）
   │  ① 把 DSH 的结构化对话 → 一段文本
   │  ② 替网页后端做认证 + PoW 计算
   │  ③ 把网页的 SSE 流 → DSH 的事件流
   ▼
chat.deepseek.com（网页私有 API）
```

插件本身**不产生智能**，它只是把"OpenAI 风格的一次模型调用"翻译成"网页后端能懂的一次 HTTP 往返"，再把结果翻译回来。

---

## 二、认证：三样东西缺一不可

| 东西 | 是什么 | 谁提供 |
|---|---|---|
| `Authorization: Bearer <token>` | 你的登录票据，64 字符不透明串 | 登录时从网页拿，存在 DSH 凭据库 |
| 请求头指纹 | `x-client-version: 2.2.0`、`x-client-bundle-id: com.deepseek.chat`、`x-client-platform: web`、浏览器 UA | 插件伪造，模拟官方 Web 客户端 |
| `x-ds-pow-response` | 每次请求现算的 PoW 头 | 插件本地计算 |

**为什么 token 会过期**：网页把"长期登录"放在 **session cookie** 里，token 只是用 cookie 现换的**短期票据**。浏览器每次打开页面就换一张，所以你觉得"永远在线"；插件只存了一张票，票过期就没了。

这就是「抓 token」和「自己续 token」的分水岭：**要么持有能换票的凭证，要么定期去换一张新票。**

---

## 三、一次调用的完整时序

```
① GET  /api/v0/users/current
   校验 token、取账号信息 —— 响应里还会返回一个"轮换后的新 token"

② POST /api/v0/chat_session/create
   建网页会话 → chatSessionId

③ POST /api/v0/chat/create_pow_challenge
   领取挑战：{ algorithm, challenge, salt, signature, difficulty, expire_at }

④ 本地求解 PoW
   枚举 nonce，使哈希满足 difficulty；结果编码成 JSON 放进请求头
   实测：difficulty 144000 时约 60–90ms，nonce 约 11–14 万

⑤ POST /api/v0/chat/completion
   带 PoW 头 + chatSessionId + prompt + model/thinking/search
   返回 SSE（服务器推送事件）流

⑥ 逐帧解析 SSE
   把每个事件拆成两个通道：reasoning（思考）与 text（正文）
```

**PoW 是防滥用闸门**：让你证明"愿意为这次请求花算力"，所以第三方客户端能用，但刷不快、批量贵。

---

## 四、工具调用：没有 function calling，只有"约定文本"

这是最容易误解的一层。

网页模型**不会**输出结构化的 `tool_calls` 字段，它只会写字。所以插件在 prompt 里塞一份契约：

```xml
<DSH_LOCAL_TOOL_CONTRACT>
DeepSeek Web does not expose native function calling.
Answer-channel schema:
<dsh_tool_calls>{"version":1,"calls":[{"name":"TOOL_NAME","arguments":{}}]}</dsh_tool_calls>
Available tools: [ ... 本次会话可用的 50 个工具定义 ... ]
</DSH_LOCAL_TOOL_CONTRACT>
```

模型按约定回一段文本 → 插件用正则解析 → 转成 DSH 原生工具事件 → DSH 执行 → 结果回灌下一轮。

### 4.1 这条路会怎么歪掉

真实遇到过的三种：

1. **回成 DSML**：模型不用我们约定的 `<dsh_tool_calls>`，而是吐自家内部的标记：
   ```
   <｜｜DSML｜｜ invoke name="pwsh">
   <｜｜DSML｜｜ parameter name="command" string="true">netstat -ano</｜｜DSML｜｜ parameter>
   </｜｜DSML｜｜ invoke>
   ```
   注意它是**全角竖线 + 双竖线**，不是文档里的 `||DSML||`。

2. **只思考不回答**：正文只有换行，内容全在 reasoning 通道 → 界面显示"已完成"但空白。

3. **输出被截断**：单次回复约 1 万字符封顶，长文件写到一半就断。

### 4.2 我们怎么处理

```
模型原始输出
   │
   ├─ 解析层：normalizeDsmlVariant()
   │     把 DSML 各种变体 → <dsh_tool_calls> JSON → 工具才能执行
   │
   └─ 展示层：stripToolMarkupForDisplay()
         把 DSML 草稿 / dsh_tool_calls 块从思考和正文里删掉
         → 屏幕上不再出现标记碎片
```

两层必须分开：**解析时不能删**（删了就没法执行），**展示时必须删**（不删就会看到草稿）。

---

## 五、上下文是怎么被"压平"的

DSH 里对话是结构化的（角色、工具结果、附件、多模态块）。网页 API 只吃一段文本。插件拼成三块：

```xml
<DSH_AGENT_INSTRUCTIONS>   系统提示（你的 AGENTS.md、技能说明等）   </DSH_AGENT_INSTRUCTIONS>
<DSH_CONVERSATION>         历史消息（user / assistant / dsh_context 标签）  </DSH_CONVERSATION>
<DSH_LOCAL_TOOL_CONTRACT>  本次可用的工具定义                        </DSH_LOCAL_TOOL_CONTRACT>
```

为了避免每轮都重发全文，插件会算三个哈希：system、tools、历史前缀。

- 三个都没变 → 只发**增量**（`<DEEPSEEK_WEB_INCREMENTAL_CONTEXT>`）
- 任一变了 → 发**全量**

这直接决定了速度：全量 prompt 动辄几千 token，网页端要重新消化一遍。

---

## 六、我们打的补丁，各自在哪一层

| 编号 | 层 | 改了什么 | 解决什么现象 |
|---|---|---|---|
| A1 | 协议 | `create_pow_challenge` 失败按业务码分类 + 写日志 | 不再把"没登录/被拦"当协议错误 |
| A2 | 认证 | `currentUser` 把轮换后的新 token 带出来 | 为写回凭据库做准备 |
| A3 | 稳定性 | 构造器里两处 fire-and-forget 加 `catch` | 启动即崩 |
| B1 | 稳定性 | `powHeaderPromise` 加 `catch` | **崩溃的直接原因**：未处理拒绝杀进程 |
| B3 | 认证 | 轮换 token 写回凭据库 | token 多续一会儿 |
| A4 | 认证 | `currentUser` 也按业务码分类 | 界面从 UNKNOWN 变成"请重新登录" |
| B4 | 协议 | DSML 变体归一化 | 工具能被执行 |
| B7 | 展示 | 剥离 DSML / 工具块 | 屏幕上不再出现草稿 |
| B5 | 质量 | 注入输出质量前言 | 长产物不省略、分块写 |
| B6 | 稳定性 | 正文过短时关思考重试一次 | "已完成但空白" |
| B8 | 诊断 | repair 决策日志 | 重试没触发时能查原因 |

对应脚本都在 `scripts/`，幂等、可回滚（`revert.mjs`）。

---

## 七、token 为什么会反复失效，怎么根治

### 现象

- 登录后约 1 小时开始 40003
- 插件内部的轮换写回能续一两次，但中间断一次就失效

### 根因

网页的"长期登录"是 **cookie**，token 是短期票据。插件没有 cookie，只有票。

### 两条根治路线

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 定期换票**（推荐） | `token-keeper.mjs`：一条 CDP 长连接，每 30 分钟从已登录页面读 `localStorage.userToken`，变了写回凭据库 | 需要一次远程调试授权；那个浏览器要保持登录 |
| B. 自造 token | 不可行。token 由服务端签发，客户端只能算 PoW | — |

### 验证方法

```bash
node scripts/diag.mjs live            # 看当前 token 是否有效
node scripts/grab-web-token.mjs       # 从浏览器读 token 并校验（只读）
node scripts/grab-web-token.mjs --write  # 写回凭据库
```

---

## 八、已知边界

1. **单次回复约 1 万字符封顶** —— 长文件必须分块写
2. **DeepThink 是空白高发区** —— 正文只剩换行、思考几千字；默认建议关闭
3. **不要设为唯一模型** —— 接口是私有的，改版迟早发生；保留一条正常车道
4. **高频调用会触发反爬** —— 表现为 HTML 拦截页（`Server: CW`）或 429
5. **非官方** —— 可能违反服务条款，账号风险自担

---

## 九、出问题时按这个顺序查

```
1. diag.mjs live                      凭据还在吗？
2. ~/.dsh/deepseek-web/pow-error.log  服务端到底回了什么（含业务码）
3. ~/.dsh/deepseek-web/repair.log     空白回答走到哪个分支了
4. crash-*.log                        有没有未处理拒绝
5. scan-dsml-leaks.mjs                有没有漏掉的工具草稿
6. check-artifact.mjs <产物>          长产物是不是被截断
```

前三个是"看服务端",后三个是"看本地处理"。
