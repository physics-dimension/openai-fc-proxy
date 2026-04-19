# openai-fc-proxy

[English](./README_EN.md)

透明 HTTP 代理，为不原生支持 `tools` 参数的 LLM 后端添加 OpenAI 兼容的函数调用（tool use）能力。

## 工作原理

```
客户端 (带 tools) ──► fc-proxy ──► LLM 后端 (不支持 tools)
                        │
                   1. tools 定义 → 系统提示词
                   2. 从上游请求中移除 tools
                   3. 从模型回复文本中解析工具调用
                   4. 返回标准 OpenAI tool_calls 格式
```

当请求包含 `tools` 时，代理会：

1. 将工具定义转换为系统提示词，指示模型输出 `##TOOL_CALL##...##END_CALL##` 格式
2. 从转发给上游的请求中移除 `tools` 和 `tool_choice`
3. 解析模型回复中的工具调用模式
4. 返回标准 OpenAI `tool_calls` 响应

当请求不包含 `tools` 时，请求直接透传，零开销。

## 支持的工具调用格式

解析器能处理模型可能输出的多种格式：

| 格式 | 示例 |
|------|------|
| 分隔符 | `##TOOL_CALL##{"name":"fn","arguments":{...}}##END_CALL##` |
| XML tool_call | `<tool_call>{"name":"fn","arguments":{...}}</tool_call>` |
| XML function_call | `<function_call>{"name":"fn","arguments":{...}}</function_call>` |
| 裸 JSON | `{"name":"fn","arguments":{...}}` |
| 代码块 | `` ```json\n{"name":"fn","arguments":{...}}\n``` `` |

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
- 检测到工具调用标记时才开始缓冲，直到块完整
- 工具调用以标准 SSE `tool_calls` delta 事件输出

## 测试

```bash
node test.js
```

运行 8 项测试：透传、工具调用解析（多种格式）、流式传输、多工具调用、错误过滤。

## 适用场景

- **Qwen2API** / chat.qwen.ai 逆向代理
- **Ollama** 不支持原生工具调用的模型
- 任何忽略 `tools` 参数的 OpenAI 兼容 API

## 零依赖

纯 Node.js (>=18)，无需安装任何 npm 包。

## License

MIT
