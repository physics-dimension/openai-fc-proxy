# openai-fc-proxy

[中文](./README.md)

Transparent HTTP proxy that adds OpenAI-compatible function calling (tool use) to any LLM backend that doesn't natively support the `tools` parameter.

## How it works

```
Client (with tools) ──► fc-proxy ──► LLM backend (without tools)
                         │
                    1. Converts tools → system prompt
                    2. Strips tools from request
                    3. Parses tool calls from response text
                    4. Returns standard OpenAI tool_calls format
```

When a request includes `tools`, the proxy:

1. Converts tool definitions into a system prompt instructing the model to output `##TOOL_CALL##...##END_CALL##` blocks
2. Removes `tools` and `tool_choice` from the upstream request
3. Parses the model's text output for tool call patterns
4. Returns a standard OpenAI `tool_calls` response

When no `tools` are present, requests pass through with zero overhead.

## Supported tool call formats

The parser handles multiple formats models might produce:

| Format | Example |
|--------|---------|
| Delimited | `##TOOL_CALL##{"name":"fn","arguments":{...}}##END_CALL##` |
| XML tool_call | `<tool_call>{"name":"fn","arguments":{...}}</tool_call>` |
| XML function_call | `<function_call>{"name":"fn","arguments":{...}}</function_call>` |
| Raw JSON | `{"name":"fn","arguments":{...}}` |
| Code block | `` ```json\n{"name":"fn","arguments":{...}}\n``` `` |

## Quick start

```bash
# Point at any OpenAI-compatible backend
UPSTREAM_URL=http://localhost:11434 PORT=3003 node index.js

# Or with Docker
docker run -e UPSTREAM_URL=http://host.docker.internal:11434 -p 3003:3003 ghcr.io/physics-dimension/openai-fc-proxy
```

Then use `http://localhost:3003` as your API base URL. Clients can send `tools` as usual.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UPSTREAM_URL` | `http://localhost:11434` | Backend API URL |
| `PORT` | `3003` | Proxy listen port |
| `BIND` | `0.0.0.0` | Bind address |

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

## Streaming

Streaming is fully supported via the `ToolSieve` approach:

- Normal text chunks pass through immediately (no buffering delay)
- When a tool call marker is detected mid-stream, the proxy buffers until the block is complete
- Tool calls are emitted as standard SSE `tool_calls` delta events

## Testing

```bash
node test.js
```

Runs 8 tests against a local mock server covering passthrough, tool call parsing (multiple formats), streaming, multi-tool, and error stripping.

## Use cases

- **Qwen2API** / chat.qwen.ai reverse proxies
- **Ollama** models without native tool support
- Any OpenAI-compatible API that ignores the `tools` parameter

## Zero dependencies

Pure Node.js (>=18), no npm packages required.

## License

MIT
