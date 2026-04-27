# openai-fc-proxy

[中文](./README.md)

Transparent HTTP proxy that adds OpenAI-compatible function calling (tool use) to any LLM backend that doesn't natively support the `tools` parameter. Incorporates best practices from [AnyToolCall](https://github.com/AliyahZombie/AnyToolCall) and [Toolify](https://github.com/funnycups/Toolify).

## How it works

```
Client (with tools) ──► fc-proxy ──► LLM backend (without tools)
                         │
                    1. Converts tools → system prompt (rare-char delimiters)
                    2. Strips tools / tool_choice from request
                    3. Parses tool calls from response text
                    4. Returns standard OpenAI tool_calls format
```

When a request includes `tools`, the proxy:

1. Converts tool definitions into a system prompt using **random rare-character delimiters**
2. Removes `tools` and `tool_choice` from the upstream request
3. Parses the model's text output for tool calls (6 formats supported)
4. Returns a standard OpenAI `tool_calls` response

When no `tools` are present, requests pass through with zero overhead.

## v2.0 Features

- **Random rare-character delimiters** — Each startup picks random Tibetan/Javanese/Yi Unicode characters, eliminating upstream LLM misrecognition (no more `##TOOL_CALL##` garbled output)
- **Streaming prefix-match protection** — Buffers partial delimiter matches across SSE chunks instead of emitting broken text
- **`<think>` block awareness** — Strips reasoning model (DeepSeek, Qwen) think blocks before parsing, preventing false tool call detection
- **Message merging** — Auto-merges consecutive same-role messages (fixes Gemini 400 errors)
- **Tool history cleanup** — Converts tool_calls/tool role messages even when current request has no tools
- **Parse retry with classification** — Truncated → request continuation; syntax error → request rewrite (configurable, off by default)
- **Parameter schema validation** — Validates parsed tool call arguments against JSON Schema (type/required/enum)
- **Token usage estimation** — Fills in missing or zero usage fields with character-based estimates
- **`tool_choice` support** — Handles `auto`/`required`/`none`/specific tool via prompt injection
- **Multi-upstream routing + model aliases** — Optional JSON config for multiple upstream services with alias-based random load balancing
- **`developer` → `system` role conversion** — Automatic role mapping
- **Upstream connection retry** — Exponential backoff retry strategy
- **Header whitelist** — Only forwards necessary headers to reduce upstream compatibility issues
- **Client authentication** — Optional API key whitelist
- **Modular architecture** — 14 independent modules for easy maintenance

## Supported tool call formats

Parser matches in priority order (preferred → fallback):

| Priority | Format | Description |
|----------|--------|-------------|
| 1 | Rare-char delimiters | Primary format, randomized per startup |
| 2 | `##TOOL_CALL##...##END_CALL##` | Legacy compatibility |
| 3 | `<tool_call>...</tool_call>` | XML format |
| 4 | `<function_call>...</function_call>` | XML format |
| 5 | `` ```json ... ``` `` | Code block |
| 6 | Raw JSON | Last resort |

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
| `FC_RETRY_ENABLED` | `false` | Enable parse failure auto-retry |
| `FC_RETRY_MAX` | `3` | Maximum retry attempts |
| `UPSTREAM_RETRY` | `1` | Upstream connection retry count |
| `UPSTREAM_RETRY_DELAY` | `0.5` | Retry base delay in seconds (exponential backoff) |
| `CLIENT_KEYS` | *(empty)* | Client API key whitelist, comma-separated |
| `ROUTES_FILE` | *(empty)* | Multi-upstream routing JSON config file path |

## Multi-upstream routing

Create a JSON config file and set `ROUTES_FILE`:

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

- **Model aliases**: `gemini-2.5:gemini-2.5-pro` means alias `gemini-2.5` maps to `gemini-2.5-pro`
- **Load balancing**: Random selection when multiple models share the same alias
- **Backward compatible**: Falls back to single `UPSTREAM_URL` when no config file is set

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

Fully supported via the `ToolSieve` approach:

- Normal text chunks pass through immediately (no buffering delay)
- **Prefix-match protection**: Partial delimiter matches are buffered until the next chunk confirms
- **`<think>` awareness**: Reasoning model think blocks don't interfere with streaming tool call detection
- Tool calls are emitted as standard SSE `tool_calls` delta events
- 2000-character safety threshold prevents infinite buffering from JSON false positives

## Project structure

```
index.js              # Entry point, starts HTTP server
src/
  config.js           # Environment variables & configuration
  delimiter.js        # Random rare-character delimiter generation
  prompt.js           # tools → system prompt conversion
  parser.js           # Multi-format tool call parser
  think.js            # <think> tag handling
  schema.js           # JSON Schema parameter validation
  messages.js         # Message transformation, merging, history cleanup
  sieve.js            # Streaming tool call detection (ToolSieve)
  retry.js            # Parse retry + upstream connection retry
  router.js           # Multi-upstream routing + model aliases
  auth.js             # Client authentication
  tokens.js           # Token usage estimation
  headers.js          # Header whitelist filtering
  proxy.js            # HTTP proxy core logic
```

## Testing

```bash
node test.js
```

Runs 13 tests covering: passthrough, legacy format parsing, rare-char delimiters, XML fallback, error stripping, multi-tool calls, streaming, think block handling, message merging, tool history cleanup, usage field estimation, developer role conversion, and models endpoint passthrough.

## Use cases

- **Qwen2API** / chat.qwen.ai reverse proxies
- **Ollama** models without native tool support
- **Gemini** via OpenAI-compatible interface
- **DeepSeek / Qwen reasoning models** — automatic `<think>` block handling
- Any OpenAI-compatible API that ignores the `tools` parameter

## Zero dependencies

Pure Node.js (>=18), no npm packages required.

## License

MIT
