// ClaudeCli
// =========
// One Messages API request run through the official claude CLI, under the
// login the CLI already has. The adapter never reads, copies or forwards
// that login: it only starts the CLI and reads what the CLI prints.
//
// A request runs `claude -p` once, in stream-json mode. The request body
// becomes a system prompt file, an inert MCP server that only lists the
// client's tools (InertMcp.ts), and input frames. Every user frame but the
// last is replayed without a query, and the CLI acknowledges each with a
// zero-turn result. The CLI's stream events are the API's own SSE events,
// so they pass through unchanged, except that tool names lose the MCP
// prefix. At the first message_stop the process group is killed, so a
// request is one generation at most.
//
// The CLI owns caching, retries and its own context: cache_control marks
// are dropped, server tools are not offered, nothing is counted ahead. The
// ANTHROPIC_* overrides are removed from the CLI's environment so it can
// only use its own login.

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

// Types
// =====

// a request as the CLI takes it
export type Plan = {
  system : string;
  tools  : Array<{ name: string; description: string; inputSchema: unknown }>;
  frames : Array<{ type: "user" | "assistant"; message: { role: string; content: any[] } }>;
  model  : string;
  effort : string;
};

// Constants
// =========

// the MCP server is called "client", so the CLI names its tools mcp__client__<name>
export const PREFIX = "mcp__client__";

const SERVER_BLOCKS = ["server_tool_use", "web_search_tool_result"];

const DROP_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_EFFORT_LEVEL",
];

const SET_ENV = {
  ENABLE_TOOL_SEARCH                : "false",
  CLAUDE_CODE_MAX_RETRIES           : "0",
  DISABLE_AUTO_COMPACT              : "1",
  DISABLE_COMPACT                   : "1",
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER : "off",
};

const INERT = path.join(import.meta.dir, "InertMcp.ts");

// the claude binary, and the directory the CLI runs in (kept stable so its
// per-directory context stays the same from request to request)
export function bin(): string {
  return process.env.CLAUDE_SHIM_BIN ?? "claude";
}

export function workdir(): string {
  return process.env.CLAUDE_SHIM_DIR ?? path.join(os.homedir(), ".claude-cli-shim");
}

// ClaudeCli
// =========

export namespace ClaudeCli {

  export function plan(body: any): Plan {
    const system = (body.system ?? []).map((b: any) => b.text).join("\n\n");
    const tools = (body.tools ?? [])
      .filter((t: any) => t.input_schema !== undefined)
      .map((t: any) => ({ name: t.name, description: t.description ?? "", inputSchema: t.input_schema }));
    const frames: Plan["frames"] = [];
    for (const msg of body.messages ?? []) {
      const content = msg.content.filter((b: any) => !SERVER_BLOCKS.includes(b.type)).map(ClaudeCli.block);
      if (content.length > 0) {
        frames.push({ type: msg.role, message: { role: msg.role, content } });
      }
    }
    if (frames.length === 0 || frames[frames.length - 1].type !== "user") {
      throw new Error("the history must end in a user message");
    }
    return { system, tools, frames, model: body.model, effort: body.output_config?.effort ?? "" };
  }

  export function block(b: any): any {
    const { cache_control, ...rest } = b;
    return rest.type === "tool_use" ? { ...rest, name: PREFIX + rest.name } : rest;
  }

  // one CLI session id per conversation (system prompt and first message),
  // so the CLI's per-session context stays the same from request to request
  export function session(plan: Plan): string {
    const digest = crypto.createHash("sha256").update(JSON.stringify([plan.system, plan.frames[0].message])).digest();
    digest[6] = (digest[6] & 0x0f) | 0x40;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString("hex");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  export function args(plan: Plan, dir: string): string[] {
    const mcp = { mcpServers: { client: { command: process.execPath, args: [INERT, path.join(dir, "tools.json")] } } };
    const out = [
      "-p", "--model", plan.model,
      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--tools", "", "--system-prompt-file", path.join(dir, "system.md"),
      "--setting-sources", "", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
      "--disable-slash-commands", "--max-turns", "1", "--permission-mode", "dontAsk", "--no-session-persistence",
      "--session-id", ClaudeCli.session(plan),
    ];
    return plan.effort ? [...out, "--effort", plan.effort] : out;
  }

  export function env(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !DROP_ENV.includes(k) && !k.startsWith("CLAUDE_SHIM_")) {
        out[k] = v;
      }
    }
    out.USER ??= os.userInfo().username;
    return { ...out, ...SET_ENV };
  }

  // a stream event as the client reads it: tool names as the client gave them
  export function event(ev: any): any {
    const b = ev.content_block;
    if (ev.type === "content_block_start" && b?.type === "tool_use" && String(b.name).startsWith(PREFIX)) {
      return { ...ev, content_block: { ...b, name: b.name.slice(PREFIX.length) } };
    }
    return ev;
  }

  // the text of an error the CLI reported (an assistant message's or a result's)
  export function told(ev: any): string | null {
    if (ev.type === "assistant" && (ev.error || ev.message?.error)) {
      const text = (ev.message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      return text || String(ev.error ?? ev.message.error);
    }
    if (ev.type === "result" && ev.is_error) {
      return String(ev.result ?? ev.subtype ?? "error");
    }
    return null;
  }

  export function refusal(why: string): Response {
    const status = /overloaded/i.test(why) ? 529 : 400;
    return new Response(JSON.stringify({ error: { message: "claude-cli: " + why } }), { status });
  }

  // the request, run; a 200 Response streams the API's events as `data:` lines
  export async function post(body: any, signal: AbortSignal): Promise<Response> {
    const plan = ClaudeCli.plan(body);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-shim-"));
    fs.writeFileSync(path.join(dir, "system.md"), plan.system);
    fs.writeFileSync(path.join(dir, "tools.json"), JSON.stringify(plan.tools));
    const cwd = workdir();
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn(bin(), ClaudeCli.args(plan, dir), { cwd, env: ClaudeCli.env(), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const errs: string[] = [];
    child.stderr.on("data", (d) => errs.push(String(d)) > 20 && errs.shift());
    child.stdin.on("error", () => {});
    let dead = false;
    const kill = () => {
      if (dead) {
        return;
      }
      dead = true;
      try {
        process.kill(-child.pid!, "SIGTERM");
        setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 2000).unref();
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    };
    signal.addEventListener("abort", kill, { once: true });
    const spawned = new Promise<string | null>((done) => child.once("error", (err) => done(err.message)));
    const exited = new Promise<null>((done) => child.once("close", () => done(null)));
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const next = async (): Promise<any> => {
      for (;;) {
        const got = await Promise.race([lines.next(), exited]);
        if (got === null || got.done) {
          return null;
        }
        const line = got.value.trim();
        if (line !== "") {
          try {
            return JSON.parse(line);
          } catch {
            throw new Error("not stream-json: " + line.slice(0, 200));
          }
        }
      }
    };
    const why = async (text: string) => {
      const failed = await Promise.race([spawned, Promise.resolve(null)]);
      return text + (failed ? " (" + failed + ")" : errs.length ? " (" + errs.join("").trim().slice(-300) + ")" : "");
    };
    let first: any;
    try {
      for (const [i, frame] of plan.frames.entries()) {
        const quiet = frame.type === "user" && i < plan.frames.length - 1;
        child.stdin.write(JSON.stringify(quiet ? { ...frame, shouldQuery: false } : frame) + "\n");
        for (let ev = quiet ? await next() : { type: "result", num_turns: 0 }; ; ev = await next()) {
          if (ev === null) {
            throw new Error(await why("the CLI exited before the history was replayed"));
          }
          if (ev.type === "result") {
            if (ev.num_turns !== 0 || ev.is_error) {
              throw new Error("history replay not supported: no zero-turn acknowledgment");
            }
            break;
          }
        }
      }
      child.stdin.end();
      for (;;) {
        const ev = await next();
        if (ev === null) {
          throw new Error(await why("the CLI exited before it streamed"));
        }
        const error = ClaudeCli.told(ev);
        if (error !== null) {
          throw new Error(error);
        }
        if (ev.type === "stream_event") {
          first = ev.event;
          break;
        }
      }
    } catch (err: any) {
      kill();
      return ClaudeCli.refusal(err.message);
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(ctl) {
        const put = (ev: any) => ctl.enqueue(new TextEncoder().encode("data: " + JSON.stringify(ClaudeCli.event(ev)) + "\n\n"));
        try {
          for (let ev = first; ev !== null; ) {
            put(ev);
            if (ev.type === "message_stop") {
              break;
            }
            for (ev = null; ev === null; ) {
              const raw = await next();
              if (raw === null) {
                break;
              }
              const error = ClaudeCli.told(raw);
              ev = error !== null ? { type: "error", error: { type: "api_error", message: error } } : raw.type === "stream_event" ? raw.event : null;
            }
            if (ev === null) {
              break;
            }
          }
        } catch (err: any) {
          put({ type: "error", error: { type: "api_error", message: err.message } });
        }
        kill();
        ctl.close();
      },
      cancel: kill,
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

}
