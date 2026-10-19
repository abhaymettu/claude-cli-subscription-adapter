# claude-cli-subscription-adapter

A small local server that answers the Anthropic Messages API (`POST /v1/messages`) by running the official `claude` CLI. Point any Anthropic API client at it with `ANTHROPIC_BASE_URL`, and its requests run on the Claude subscription your CLI is logged in with (Pro or Max) instead of a metered API key.

It is about 500 lines of TypeScript for [Bun](https://bun.sh), with no dependencies.

> The adapter never reads, copies or forwards your Claude login. It only starts the `claude` CLI, which uses its own login as it always does, and reads what the CLI prints.

## Quickstart

You need Bun 1.1 or later and the `claude` CLI, logged in (run `claude` once and sign in).

```sh
git clone https://github.com/abhaymettu/claude-cli-subscription-adapter
cd claude-cli-subscription-adapter
bun src/Shim.ts 8789
```

Then, in the program you want to run on your subscription:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8789
export ANTHROPIC_API_KEY=unused   # most SDKs want some value; the adapter ignores it unless CLAUDE_SHIM_TOKEN is set
```

A quick check with the Python SDK:

```python
import anthropic
client = anthropic.Anthropic(base_url="http://127.0.0.1:8789", api_key="unused")
msg = client.messages.create(model="claude-haiku-5-5", max_tokens=200,
                             messages=[{"role": "user", "content": "Say pong."}])
print(msg.content[0].text)
```

### Settings

All settings are environment variables read by the adapter.

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_SHIM_BIN` | `claude` | Path to the `claude` binary, if it is not on `PATH`. |
| `CLAUDE_SHIM_TOKEN` | unset | A local password. When set, each request must send it as `x-api-key` or `Authorization: Bearer`. |
| `CLAUDE_SHIM_LIMIT` | `4` | How many CLI processes may run at once. Further requests wait. |
| `CLAUDE_SHIM_DIR` | `~/.claude-cli-shim` | The directory the CLI runs in. Kept stable so the CLI's per-directory context does not change between requests. |

The port is the first argument (`bun src/Shim.ts 8789`). The server binds `127.0.0.1` only.

## How it works

Each request starts one `claude -p` process in stream-json mode and stops it as soon as the reply is complete.

1. The request body is turned into what the CLI accepts:
   - the system prompt goes into a temporary file passed with `--system-prompt-file`;
   - your tools are listed by a tiny MCP server (`src/InertMcp.ts`) that only lists them and never runs them;
   - each message becomes a stream-json input frame.
2. Earlier user turns are replayed with `shouldQuery: false`, so the CLI records the history without answering it. The CLI acknowledges each one with a zero-turn result, and the adapter checks every acknowledgment. The last user turn is sent normally.
3. The CLI prints the API's own streaming events (`message_start`, `content_block_delta` and so on) as `stream_event` lines. The adapter passes them through unchanged, except that the MCP prefix is removed from tool names, so your client sees the names it sent.
4. At the first `message_stop`, the adapter kills the CLI's process group. A request is therefore one model turn at most. `--max-turns 1` and `--permission-mode dontAsk` back this up.
5. A tool call comes back to your client as a normal `tool_use` block. Your client runs the tool and sends the result in its next request, exactly as with the API's custom tools.

The CLI runs with:
- its built-in tools off (`--tools ""`);
- no user or project settings (`--setting-sources ""`);
- only the adapter's MCP server (`--strict-mcp-config`);
- no session saved to disk (`--no-session-persistence`);
- retries off (`CLAUDE_CODE_MAX_RETRIES=0`).

The adapter removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock, Vertex and Foundry switches from the CLI's environment. As a result, the CLI can only use its own subscription login and can never loop back into the adapter.

## What is supported

| Request feature | Status |
|---|---|
| `POST /v1/messages`, streamed (`stream: true`) or whole | Supported |
| Text, images and other content blocks the CLI accepts in a user message | Passed through as given |
| Custom tools (`tools` with `input_schema`), `tool_use` and `tool_result` | Supported |
| Multi-turn history | Supported, by replay (see Limits) |
| `system` as a string or as blocks | Supported |
| `output_config.effort` | Passed to the CLI as `--effort` |
| `cache_control` marks | Dropped. The CLI places its own cache breakpoints. |
| Server tools (web search, code execution), `tool_choice` | Not offered. Server tool blocks in the history are dropped. |
| `max_tokens`, `temperature`, `top_p`, `stop_sequences`, `metadata` | Ignored. The CLI chooses its own output cap. |
| `/v1/messages/count_tokens`, batches, files, models | Not offered (404) |

## Limits

- **Extra tokens and time per request.** The CLI adds its own context in front of your system prompt, and this cannot be removed. In the author's tests, a one-tool request used about 1,000 input tokens in total. Each request also pays for starting a CLI process: about 2.5 seconds for a tiny Haiku request, measured end to end through the adapter.
- **Usage comes from your plan's limits.** Every request counts against your subscription's session and weekly limits, at `claude -p` rates. Several agents running in parallel use them up quickly, and there is no batching.
- **No retry-after.** When you hit a limit, the CLI's error comes back as HTTP 502 (`api_error`), not as a 429 with `retry-after`. "Overloaded" errors come back as 529. The adapter itself never retries.
- **Depends on the CLI version.** The history replay acknowledgment and the `stream_event` lines belong to the CLI, not to a published API. They were checked on Claude Code 2.1.303. If a later CLI changes them, the adapter refuses the request with "history replay not supported" rather than quietly sending a different prompt. Re-test after upgrading the CLI.
- **Tool schemas go through MCP.** JSON Schema features that the CLI's MCP layer rejects will fail. In particular, the adapter does not yet strip top-level `oneOf`/`anyOf`/`allOf`.
- **The CLI puts your account email in the model's context.** The `claude` CLI (checked on 2.1.303) adds the logged-in account's email address to every request as a system note. There is no switch to turn it off: the only code path that skips it is `ANTHROPIC_UNIX_SOCKET`, which changes how the CLI reaches the API and is not used here. The model can see the address and may repeat it in a reply, and anything your client stores (transcripts, summaries, logs) can end up containing it. Treat those as personal data and do not share them.
- **One process per request.** Requests above `CLAUDE_SHIM_LIMIT` wait in a queue.
- **Usage numbers are the CLI's.** The `usage` object reports the CLI's real token counts, including the cache writes it chose.

## Terms of use

Check Anthropic's current terms for your plan before you use this. Whether running API clients through `claude -p` on a subscription is allowed is decided by Anthropic, not by this project.

The page the author read when writing this is [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Its October 7, 2026 update says: "You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits." That is a reading of one page on one date. It is not a guarantee, and it is not legal advice. The page and the terms can change.

The adapter is built to stay on the CLI side of the line:
- it never touches the login token;
- it listens on loopback only;
- it can require a local password.

Do not expose it to a network, and do not let other people's agents use your subscription through it.

## Tests

```sh
bun test
```

The tests use a fake `claude` that speaks stream-json, so they need no login and use no quota. They cover:
- the flags and environment the CLI gets, including that the API overrides and the adapter's own token never reach it;
- the replay of history, with the tool name prefix added and removed;
- the kill at `message_stop`, checked by a second reply that must never arrive;
- CLI errors and a missing binary are refused, not retried or hung;
- the inert MCP server lists tools and runs none;
- the HTTP server: loopback binding, token, 404s, and streamed and whole responses.

By hand, on Claude Code 2.1.303 with a Max login: the official Anthropic Python SDK, whole and streamed, a custom tool call, and a replayed multi-turn history all worked through the adapter, and no CLI process was left running afterwards.

## Roadmap

- An OpenAI-compatible endpoint (`/v1/chat/completions`) over the same CLI driver.
- Stripping or rewriting top-level `oneOf`/`anyOf` in tool schemas.

## Origin and license

The adapter was first written as the `claude-cli` vendor of [UniiChat-claude-cli](https://github.com/abhaymettu/UniiChat-claude-cli), a fork of [UniiChat](https://github.com/VictorTaelin/UniiChat) by Victor Taelin. It is extracted here so that any Anthropic API client can use it. See [NOTICE](NOTICE).

Licensed under the [Apache License 2.0](LICENSE). This project is not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic.
