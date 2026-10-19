// `bun test`. The adapter against a fake claude CLI that speaks stream-json,
// so no test uses a login or any quota.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeCli, PREFIX } from "../src/ClaudeCli.ts";
import { Shim } from "../src/Shim.ts";
import { Sse } from "../src/Sse.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-shim-test-"));
const FAKE = path.join(DIR, "claude");
const LOG = path.join(DIR, "log.jsonl");

process.env.CLAUDE_SHIM_BIN = FAKE;
process.env.CLAUDE_SHIM_DIR = path.join(DIR, "work");
process.env.FAKE_LOG = LOG;
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.ANTHROPIC_API_KEY = "not-a-real-key";

// the fake CLI: logs its arguments, environment and input frames; answers
// each unqueried frame with a zero-turn result; then streams one turn, and
// a second one 1.5 s later that must never be seen
fs.writeFileSync(FAKE, `#!${process.execPath}
import * as fs from "node:fs";
import * as readline from "node:readline";
const log = (row) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(row) + "\\n");
const out = (row) => process.stdout.write(JSON.stringify(row) + "\\n");
log({ args: process.argv.slice(2), cwd: process.cwd(), base: process.env.ANTHROPIC_BASE_URL ?? null, key: process.env.ANTHROPIC_API_KEY ?? null, token: process.env.CLAUDE_SHIM_TOKEN ?? null, retries: process.env.CLAUDE_CODE_MAX_RETRIES });
const mode = process.env.FAKE_MODE ?? "text";
const ev = (event) => out({ type: "stream_event", event });
const turn = (n) => {
  ev({ type: "message_start", message: { id: "msg_" + n, type: "message", role: "assistant", model: "m", usage: { input_tokens: 10, output_tokens: 1 } } });
  if (mode === "tool") {
    ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_" + n, name: "${PREFIX}zoom", input: {} } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"id":' } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"7"}' } });
  } else {
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: String(n) } });
  }
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_delta", delta: { stop_reason: mode === "tool" ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
  ev({ type: "message_stop" });
};
out({ type: "system", subtype: "init" });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  log({ frame });
  if (frame.shouldQuery === false) {
    out({ type: "result", subtype: "success", num_turns: mode === "noreplay" ? 1 : 0, is_error: false });
  }
}
if (mode === "error") {
  out({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your limit" }] } });
  out({ type: "result", is_error: true, result: "You've hit your limit" });
  process.exit(1);
}
turn(1);
await new Promise((ok) => setTimeout(ok, 1500));
log({ second: true });
turn(2);
`);
fs.chmodSync(FAKE, 0o755);

const rows = () => fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const events = async (res: Response) => {
  const out: any[] = [];
  for await (const ev of Sse.events(res.body!)) {
    out.push(ev);
  }
  return out;
};

const fresh = (mode: string) => {
  fs.rmSync(LOG, { force: true });
  process.env.FAKE_MODE = mode;
};

test("a turn streams its reply; the CLI gets the expected flags and none of the API overrides", async () => {
  fresh("text");
  const res = await ClaudeCli.post({ model: "claude-haiku-4-5", system: [{ type: "text", text: "be brief" }], output_config: { effort: "low" }, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, new AbortController().signal);
  expect(res.status).toBe(200);
  const evs = await events(res);
  expect(evs.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("")).toBe("hello 1");
  const [start, ...frames] = rows();
  expect(start.base).toBe(null);
  expect(start.key).toBe(null);
  expect(start.retries).toBe("0");
  expect(fs.realpathSync(start.cwd)).toBe(fs.realpathSync(process.env.CLAUDE_SHIM_DIR!));
  const args: string[] = start.args;
  expect(args.slice(0, 3)).toEqual(["-p", "--model", "claude-haiku-4-5"]);
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
  expect(args[args.indexOf("--effort") + 1]).toBe("low");
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--no-session-persistence");
  expect(frames).toEqual([{ frame: { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } } }]);
});

test("a history replays unqueried, tool names prefixed out and stripped back, killed at message_stop", async () => {
  fresh("tool");
  const body = {
    model         : "claude-haiku-4-5",
    system        : [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    tools         : [{ name: "zoom", description: "read a node", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }],
    messages      : [
      { role: "user", content: [{ type: "text", text: "find 7", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_0", name: "zoom", input: { id: "6" } }, { type: "server_tool_use", id: "s", name: "web_search", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_0", content: [{ type: "text", text: "six" }] }] },
    ],
  };
  expect(ClaudeCli.plan(body).tools).toEqual([{ name: "zoom", description: "read a node", inputSchema: { type: "object" } }]);
  const res = await ClaudeCli.post(body, new AbortController().signal);
  expect(res.status).toBe(200);
  const evs = await events(res);
  expect(evs.map((e) => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  expect(evs[1].content_block.name).toBe("zoom");
  expect(rows().filter((r) => r.frame).map((r) => r.frame)).toEqual([
    { type: "user", message: { role: "user", content: [{ type: "text", text: "find 7" }] }, shouldQuery: false },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_0", name: PREFIX + "zoom", input: { id: "6" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_0", content: [{ type: "text", text: "six" }] }] } },
  ]);
  await new Promise((ok) => setTimeout(ok, 2500));
  expect(rows().some((r) => r.second)).toBe(false);
});

test("a CLI error refuses the request once, with no retry", async () => {
  fresh("error");
  const res = await ClaudeCli.post({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, new AbortController().signal);
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toContain("You've hit your limit");
  expect(rows().filter((r) => r.args).length).toBe(1);
});

test("a CLI that does not acknowledge a replay is refused", async () => {
  fresh("noreplay");
  const body = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "a" }] }, { role: "assistant", content: [{ type: "text", text: "b" }] }, { role: "user", content: [{ type: "text", text: "c" }] }] };
  const res = await ClaudeCli.post(body, new AbortController().signal);
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toContain("history replay not supported");
});

test("a missing claude binary is refused, not hung", async () => {
  process.env.CLAUDE_SHIM_BIN = path.join(DIR, "no-such-claude");
  try {
    const res = await ClaudeCli.post({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, new AbortController().signal);
    expect(res.status).toBe(400);
  } finally {
    process.env.CLAUDE_SHIM_BIN = FAKE;
  }
});

test("a history that does not end in a user message is rejected before the CLI starts", () => {
  expect(() => ClaudeCli.plan({ model: "m", messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }] })).toThrow("must end in a user message");
});

test("the inert MCP server lists the tools and runs none", () => {
  const file = path.join(DIR, "tools.json");
  fs.writeFileSync(file, JSON.stringify([{ name: "zoom", description: "d", inputSchema: { type: "object" } }]));
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "zoom", arguments: {} } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n";
  const run = spawnSync(process.execPath, [path.join(import.meta.dir, "../src/InertMcp.ts"), file], { input, encoding: "utf8" });
  const out = run.stdout.trim().split("\n").map((l) => JSON.parse(l));
  expect(out.map((r) => r.id)).toEqual([1, 2, 3]);
  expect(out[1].result.tools[0].name).toBe("zoom");
  expect(out[2].result.isError).toBe(true);
});

test("the shim answers the Messages API on loopback, streamed and whole, behind its token", async () => {
  process.env.CLAUDE_SHIM_TOKEN = "t0";
  const server = Shim.serve(0);
  const url = "http://127.0.0.1:" + server.port + "/v1/messages";
  expect(server.hostname).toBe("127.0.0.1");
  const ask = (body: object, key = "t0") => fetch(url, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect((await ask({ model: "m", messages: [{ role: "user", content: "hi" }] }, "bad")).status).toBe(401);
    expect((await fetch(url.replace("messages", "complete"), { method: "POST", headers: { "x-api-key": "t0" } })).status).toBe(404);
    expect((await ask({ model: "m", messages: [] })).status).toBe(400);
    fresh("tool");
    const tools = [{ name: "zoom", description: "d", input_schema: { type: "object" } }];
    const whole = await (await ask({ model: "claude-haiku-4-5", system: "sys", tools, messages: [{ role: "user", content: "find 7" }] })).json();
    expect(whole.content).toEqual([{ type: "tool_use", id: "tu_1", name: "zoom", input: { id: "7" } }]);
    expect(whole.stop_reason).toBe("tool_use");
    expect(whole.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(rows()[0].token).toBe(null);
    fresh("text");
    const text = await (await ask({ model: "claude-haiku-4-5", stream: true, messages: [{ role: "user", content: "hi" }] })).text();
    expect(text.split("\n").filter((l) => l.startsWith("event: "))).toEqual(["event: message_start", "event: content_block_start", "event: content_block_delta", "event: content_block_delta", "event: content_block_stop", "event: message_delta", "event: message_stop"]);
    fresh("error");
    const refused = await ask({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(refused.status).toBe(502);
    expect((await refused.json()).error.type).toBe("api_error");
  } finally {
    server.stop(true);
    delete process.env.CLAUDE_SHIM_TOKEN;
  }
});
