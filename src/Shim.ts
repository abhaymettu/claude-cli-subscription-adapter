// Shim
// ====
// `bun src/Shim.ts [port]`. The Messages API (POST /v1/messages) and the
// OpenAI Chat Completions API (POST /v1/chat/completions: OpenAI.ts, and
// GET /v1/models), streamed or not, on 127.0.0.1, answered by the official
// claude CLI (ClaudeCli.ts), so a client of either runs on the CLI's own
// login by setting its base URL. It binds loopback only. With CLAUDE_SHIM_TOKEN set, a
// request must carry it as its x-api-key or bearer token. Custom tools come
// back to the client; server tools, fast mode and token counting are not
// offered. At most CLAUDE_SHIM_LIMIT requests run at once, each one CLI
// process; the rest wait.

import { ClaudeCli } from "./ClaudeCli.ts";
import { OpenAI } from "./OpenAI.ts";
import { Sse } from "./Sse.ts";

const LIMIT = Number(process.env.CLAUDE_SHIM_LIMIT ?? "4");

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

const queue: Array<() => void> = [];
let running = 0;

export namespace Shim {

  // a client's body as ClaudeCli.plan takes it: text given as a string
  // becomes a block
  export function body(x: any): any {
    const blocks = (c: any) => (typeof c === "string" ? [{ type: "text", text: c }] : c);
    return {
      ...x,
      system        : x.system === undefined ? [] : blocks(x.system),
      output_config : x.output_config ?? {},
      messages      : (x.messages ?? []).map((m: any) => ({ ...m, content: blocks(m.content) })),
    };
  }

  export function error(status: number, type: string, message: string): Response {
    return Response.json({ type: "error", error: { type, message } }, { status });
  }

  export async function slot(): Promise<() => void> {
    if (running >= LIMIT) {
      await new Promise<void>((ok) => queue.push(ok));
    }
    running += 1;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        running -= 1;
        queue.shift()?.();
      }
    };
  }

  // the CLI's events as the API streams them, each named
  export function sse(res: Response, free: () => void): Response {
    const body = new ReadableStream<Uint8Array>({
      async start(ctl) {
        const enc = new TextEncoder();
        try {
          for await (const ev of Sse.events(res.body!)) {
            ctl.enqueue(enc.encode("event: " + ev.type + "\ndata: " + JSON.stringify(ev) + "\n\n"));
          }
        } finally {
          free();
          ctl.close();
        }
      },
      cancel: () => {
        res.body?.cancel();
        free();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  export async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const token = process.env.CLAUDE_SHIM_TOKEN;
    const given = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (token && given !== token) {
      return Shim.error(401, "authentication_error", "wrong shim token");
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "anthropic" })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return Shim.openai(req);
    }
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      return Shim.error(404, "not_found_error", "only POST /v1/messages, POST /v1/chat/completions and GET /v1/models are offered");
    }
    let x: any;
    try {
      x = Shim.body(await req.json());
      ClaudeCli.plan(x);
    } catch (err: any) {
      return Shim.error(400, "invalid_request_error", err.message);
    }
    const free = await Shim.slot();
    try {
      const res = await ClaudeCli.post(x, req.signal);
      if (!res.ok) {
        free();
        const why = (await res.json()).error.message;
        return Shim.error(res.status === 529 ? 529 : 502, res.status === 529 ? "overloaded_error" : "api_error", why);
      }
      if (x.stream) {
        return Shim.sse(res, free);
      }
      const out = await Sse.whole(res.body!);
      free();
      return "error" in out ? Shim.error(502, out.error?.type ?? "api_error", out.error?.message ?? "stream error") : Response.json(out.message);
    } catch (err: any) {
      free();
      return Shim.error(500, "api_error", err.message);
    }
  }

  export function oerror(status: number, type: string, message: string): Response {
    return Response.json({ error: { message, type, param: null, code: null } }, { status });
  }

  export async function openai(req: Request): Promise<Response> {
    let raw: any;
    let x: any;
    try {
      raw = await req.json();
      x = OpenAI.body(raw);
      ClaudeCli.plan(x);
    } catch (err: any) {
      return Shim.oerror(400, "invalid_request_error", err.message);
    }
    const free = await Shim.slot();
    try {
      const res = await ClaudeCli.post(x, req.signal);
      if (!res.ok) {
        free();
        return Shim.oerror(res.status === 529 ? 503 : 502, "api_error", (await res.json()).error.message);
      }
      if (!raw.stream) {
        const out = await OpenAI.whole(res, raw.model);
        free();
        return Response.json(out);
      }
      const lines = OpenAI.chunks(res, raw.model, raw.stream_options?.include_usage === true);
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(ctl) {
          try {
            for await (const line of lines) {
              ctl.enqueue(enc.encode(line));
            }
          } finally {
            free();
            ctl.close();
          }
        },
        cancel: () => {
          res.body?.cancel();
          free();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    } catch (err: any) {
      free();
      return Shim.oerror(500, "api_error", err.message);
    }
  }

  export function serve(port: number) {
    return Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, fetch: Shim.handle });
  }

}

if (import.meta.main) {
  const server = Shim.serve(Number(process.argv[2] ?? "8789"));
  console.error("claude-cli shim: http://127.0.0.1:" + server.port + " (/v1/messages, /v1/chat/completions, /v1/models)");
}
