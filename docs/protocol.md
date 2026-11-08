# 协议链路（chat.deepseek.com 网页版）

> 本文是从插件行为与实测抓包还原的，不是官方文档。字段名以实际抓包为准。

## 一、整体流程

```
① GET  /api/v0/users/current          拿账号信息（响应里带轮换后的 token）
② POST /api/v0/chat_session/create    建会话 → chatSessionId
③ POST /api/v0/chat/create_pow_challenge   target_path=/api/v0/chat/completion
④ 本地求解 PoW → 生成 x-ds-pow-response 头
⑤ POST /api/v0/chat/completion        带 PoW 头 + prompt → SSE 流式返回
```

## 二、必需请求头

| 头 | 值（实测） |
|---|---|
| `authorization` | `Bearer <token>` |
| `x-client-version` | `2.2.0` |
| `x-client-bundle-id` | `com.deepseek.chat` |
| `x-client-platform` | `web` |
| `x-client-locale` | `zh_CN` |
| `accept` | `application/json` |
| `origin` / `referer` | `https://chat.deepseek.com` |
| `user-agent` | **必须是浏览器 UA**（curl 默认 UA 会被 WAF 挡成 429 + HTML） |

## 三、PoW 挑战

请求体：

```json
{"target_path":"/api/v0/chat/completion"}
```

响应（HTTP 200）：

```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":{"challenge":{
  "algorithm":"DeepSeekHashV1","challenge":"<64 hex>","salt":"<hex>",
  "signature":"<64 hex>","difficulty":144000,
  "expire_at":1794121038063,"expire_after":300000,
  "target_path":"/api/v0/chat/completion"}}}}
```

- 求解：对 `challenge` 做带 `salt`/`nonce` 的哈希枚举，直到满足 `difficulty`（实测 60–90 ms，nonce 约 1.1–1.4e5）
- 结果编码成 JSON 放进 `x-ds-pow-response`（约 368 字符）
- `expire_at` 到期后挑战作废，必须重新申请

## 四、错误码（HTTP 200 + JSON）

| code | msg | 含义 | 处理 |
|---|---|---|---|
| 40002 | Missing Token | 没带 token | 登录 |
| 40003 | Authorization Failed (invalid token) | token 失效 | 重新登录 |
| 42901 | too many requests | 限频 | 等冷却 |

被 WAF 拦截时返回 **HTML**（`Server: CW`、`Block-Event-Id`、`HWWAFSESID` cookie），content-type 是 `text/html`。

**关键：插件把"正文不是 JSON"一律当协议错误（PROTOCOL），进而触发会话重建 + 重试；在启动期就是致命崩溃。** 正确的分类是：40002/40003 → 认证类，429 → 限流，HTML → WAF。

## 五、工具调用没有原生 function calling

网页模型不会发 `tool_calls`，只能靠文本协议约定：

```xml
<dsh_tool_calls>{"version":1,"calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}</dsh_tool_calls>
```

实测它会用 **DSML 变体**回应（全角竖线 `｜`、双竖线、参数里再套一个 `name`）：

```
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="arguments" string="false">{"path": "a.txt"}</｜｜DSML｜｜ parameter>
```

插件自带 DSML 兼容解析，但要求规范写法，所以需要归一化。

## 六、已知上限

- 单次回复约 **1 万字符**封顶，长文件会被截断（表现为缺 `</html>`、`<svg>` 未闭合）
- DeepThink 打开时思考长度不可控（实测出现过 3.5 万字思考 / 130 秒）
- token 会被服务端轮换，持久化旧 token 迟早失效
