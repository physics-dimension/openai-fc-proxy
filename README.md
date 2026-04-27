# openai-fc-proxy

[English](./README_EN.md)

透明 HTTP 代理，为不原生支持 `tools` 参数的 LLM 后端添加 OpenAI 兼容的函数调用（tool use）能力。整合了 [AnyToolCall](https://github.com/AliyahZombie/AnyToolCall) 和 [Toolify](https://github.com/funnycups/Toolify) 的最佳实践。

## 工作原理

```
客户端 (带 tools) ──► fc-proxy ──► LLM 后端 (不支持 tools)
                        │
                   1. tools 定义 → 系统提示词（生僻字定界符）
                   2. 从上游请求中移除 tools / tool_choice
                   3. 从模型回复文本中解析工具调用
                   4. 返回标准 OpenAI tool_calls 格式
```

当请求包含 `tools` 时，代理会：

1. 将工具定义转换为系统提示词，使用**随机生僻字定界符**指示模型输出工具调用
2. 从转发给上游的请求中移除 `tools` 和 `tool_choice`
3. 解析模型回复中的工具调用（支持 6 种格式）
4. 返回标准 OpenAI `tool_calls` 响应

当请求不包含 `tools` 时，请求直接透传，零开销。

## v2.0 特性

- **随机生僻字定界符** — 每次启动随机选取藏文/爪哇文/彝文等 Unicode 字符组合，彻底避免上游 LLM 误识别（告别 `##TOOL_CALL##` 乱码问题）
- **流式前缀匹配保护** — 定界符跨 SSE chunk 截断时暂存不输出，等下一个 chunk 确认后再释放
- **`<think>` 标签感知** — 自动剥离推理模型（DeepSeek、Qwen 等）的思考块，不误触发工具调用解析
- **消息合并** — 连续相同 role 的消息自动合并，解决 Gemini 系列对连续同 role 报 400 的问题
- **工具历史清洗** — 即使当前请求无 tools，历史中有 tool_calls/tool role 时也自动转换，防止上游报错
- **解析失败自动重试** — 截断 → 要求续写；语法错误 → 要求重写（可配置，默认关闭）
- **参数 Schema 校验** — 解析出的工具调用参数按 JSON Schema 校验（type/required/enum），不通过时触发重试
- **Token 用量估算** — 上游不返回或返回 0 时自动补全 usage 字段
- **`tool_choice` 支持** — 处理 `auto`/`required`/`none`/指定工具，转换为提示词约束
- **多上游路由 + 模型别名** — 可选 JSON 配置多个上游服务，支持模型别名和随机负载均衡
- **`developer` → `system` 转换** — 自动将 `developer` role 转为 `system`
- **上游连接重试** — 指数退避重试策略
- **Header 白名单** — 仅转发必要 header，减少上游兼容问题
- **客户端认证** — 可选 API key 白名单认证
- **模块化架构** — 14 个独立模块，易于维护和迭代

## 支持的工具调用格式

解析器按优先级依次匹配（首选 → 兜底）：

| 优先级 | 格式 | 说明 |
|--------|------|------|
| 1 | 生僻字定界符 | 主格式，每次启动随机生成 |
| 2 | `##TOOL_CALL##...##END_CALL##` | 旧版兼容 |
| 3 | `<tool_call>...</tool_call>` | XML 格式 |
| 4 | `<function_call>...</function_call>` | XML 格式 |
| 5 | `` ```json ... ``` `` | 代码块 |
| 6 | 裸 JSON | 最后兜底 |

## 快速开始

```bash
# 指向任意 OpenAI 兼容后端
UPSTREAM_URL=http://localhost:11434 PORT=3003 node index.js

# 或使用 Docker
docker run -e UPSTREAM_URL=http://host.docker.internal:11434 -p 3003:3003 ghcr.io/physics-dimension/openai-fc-proxy
```

然后将 `http://localhost:3003` 作为 API Base URL，客户端照常发送 `tools` 即可。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `UPSTREAM_URL` | `http://localhost:11434` | 上游 API 地址 |
| `PORT` | `3003` | 代理监听端口 |
| `BIND` | `0.0.0.0` | 绑定地址 |
| `FC_RETRY_ENABLED` | `false` | 启用解析失败自动重试 |
| `FC_RETRY_MAX` | `3` | 最大重试次数 |
| `UPSTREAM_RETRY` | `1` | 上游连接重试次数 |
| `UPSTREAM_RETRY_DELAY` | `0.5` | 重试基础延迟（秒，指数退避） |
| `CLIENT_KEYS` | *(空)* | 客户端 API key 白名单，逗号分隔 |
| `ROUTES_FILE` | *(空)* | 多上游路由 JSON 配置文件路径 |

## 多上游路由配置

创建 JSON 配置文件，通过 `ROUTES_FILE` 环境变量指定：

```json
{
  "services": [
    {
      "name": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-xxx",
      "models": ["gpt-4o", "gpt-4o-mini"],
      "is_default": true
    },
    {
      "name": "google",
      "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
      "api_key": "xxx",
      "models": ["gemini-2.5:gemini-2.5-pro", "gemini-2.5:gemini-2.5-flash"]
    }
  ]
}
```

- **模型别名**：`gemini-2.5:gemini-2.5-pro` 表示别名 `gemini-2.5` 映射到 `gemini-2.5-pro`
- **负载均衡**：同一别名配置多个模型时随机选择
- **向后兼容**：无配置文件时退回单一 `UPSTREAM_URL` 模式

## Docker Compose

```yaml
services:
  fc-proxy:
    build: .
    ports:
      - "3003:3003"
    environment:
      - UPSTREAM_URL=http://host.docker.internal:11434
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## 流式响应

通过 `ToolSieve` 机制完整支持流式响应：

- 普通文本 chunk 即时透传（零缓冲延迟）
- **前缀匹配保护**：定界符跨 chunk 截断时暂存，等下一个 chunk 确认
- **`<think>` 感知**：推理模型思考块不干扰流式工具调用检测
- 工具调用以标准 SSE `tool_calls` delta 事件输出
- 2000 字符安全阈值：防止 JSON 误识别导致无限缓冲

## 项目结构

```
index.js              # 入口，启动 HTTP 服务
src/
  config.js           # 环境变量与配置
  delimiter.js        # 随机生僻字定界符生成
  prompt.js           # tools → 系统提示词转换
  parser.js           # 多格式工具调用解析器
  think.js            # <think> 标签处理
  schema.js           # JSON Schema 参数校验
  messages.js         # 消息转换、合并、历史清洗
  sieve.js            # 流式工具调用检测 (ToolSieve)
  retry.js            # 解析重试 + 上游连接重试
  router.js           # 多上游路由 + 模型别名
  auth.js             # 客户端认证
  tokens.js           # Token 用量估算
  headers.js          # Header 白名单过滤
  proxy.js            # HTTP 代理核心逻辑
```

## 测试

```bash
node test.js
```

运行 13 项测试，覆盖：透传、旧版格式解析、生僻字定界符、XML 兜底、错误过滤、多工具调用、流式传输、think 块忽略、消息合并、工具历史清洗、usage 字段补全、developer role 转换、models 接口透传。

## 适用场景

- **Qwen2API** / chat.qwen.ai 逆向代理
- **Ollama** 不支持原生工具调用的模型
- **Gemini** 通过 OpenAI 兼容接口使用
- **DeepSeek / Qwen 推理模型** — 自动处理 `<think>` 块
- 任何忽略 `tools` 参数的 OpenAI 兼容 API

## 零依赖

纯 Node.js (>=18)，无需安装任何 npm 包。

## License

MIT
