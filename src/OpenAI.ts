// OpenAI
// ======
// The OpenAI Chat Completions shape on the shim (Shim.ts). A request
// becomes the Messages body ClaudeCli.ts runs, and the CLI's events become
// one chat.completion, or chat.completion.chunk lines ending in [DONE].
// System and developer messages join into the system prompt; function
// tools map to tools, tool_calls to tool_use blocks, tool messages to
// tool_result blocks. Thinking is not shown. n, logprobs, response_format,
// tool_choice and the sampling settings are not offered.

import { Sse } from "./Sse.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const FINISH: Record<string, string> = {
  end_turn      : "stop",
  stop_sequence : "stop",
  tool_use      : "tool_calls",
  max_tokens    : "length",
  refusal       : "content_filter",
};

export namespace OpenAI {

  export function parts(content: any): any[] {
    if (content === null || content === undefined) {
      return [];
    }
    if (typeof content === "string") {
      return content === "" ? [] : [{ type: "text", text: content }];
    }
    return content.map((p: any) => {
      if (p.type === "text") {
        return { type: "text", text: p.text };
      }
      if (p.type === "image_url") {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url?.url ?? "");
        if (m === null) {
          throw new Error("only base64 data: image_url parts are supported");
        }
        return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
      }
      throw new Error("unsupported content part: " + p.type);
    });
  }

  export function text(content: any): string {
    return OpenAI.parts(content).filter((p) => p.type === "text").map((p) => p.text).join("\n");
  }

  // a Chat Completions request as the Messages body ClaudeCli.plan takes
  export function body(x: any): any {
    const system: string[] = [];
    const messages: Array<{ role: string; content: any[] }> = [];
    const push = (role: string, content: any[]) => {
      const top = messages[messages.length - 1];
      if (top?.role === role) {
        top.content.push(...content);
      } else if (content.length > 0) {
        messages.push({ role, content });
      }
    };
    for (const m of x.messages ?? []) {
      switch (m.role) {
        case "system":
        case "developer": {
          system.push(OpenAI.text(m.content));
          break;
        }
        case "user": {
          push("user", OpenAI.parts(m.content));
          break;
        }
        case "assistant": {
          const calls = (m.tool_calls ?? []).map((c: any) => ({ type: "tool_use", id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || "{}") }));
          push("assistant", [...OpenAI.parts(m.content), ...calls]);
          break;
        }
        case "tool": {
          push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: OpenAI.text(m.content) }]);
          break;
        }
        default: {
          throw new Error("unsupported message role: " + m.role);
        }
      }
    }
    const tools = (x.tools ?? []).filter((t: any) => t.type === "function").map((t: any) => ({
      name         : t.function.name,
      description  : t.function.description ?? "",
      input_schema : t.function.parameters ?? { type: "object", properties: {} },
    }));
    const effort = EFFORTS.includes(x.reasoning_effort) ? x.reasoning_effort : undefined;
    return { model: x.model, system: [{ type: "text", text: system.join("\n\n") }], output_config: effort ? { effort } : {}, tools, messages };
  }

  export function usage(u: any): object {
    const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const completion = u.output_tokens ?? 0;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  }

  // the CLI's events read whole, as one chat.completion
  export async function whole(res: Response, model: string): Promise<object> {
    const out = await Sse.whole(res.body!);
    if ("error" in out) {
      throw new Error(out.error?.message ?? "stream error");
    }
    const msg = out.message;
    const content = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const calls = msg.content
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    const message = { role: "assistant", content: content || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
    return {
      id      : "chatcmpl-" + (msg.id ?? crypto.randomUUID()),
      object  : "chat.completion",
      created : Math.floor(Date.now() / 1000),
      model,
      choices : [{ index: 0, message, finish_reason: FINISH[msg.stop_reason] ?? "stop" }],
      usage   : OpenAI.usage(msg.usage),
    };
  }

  // the CLI's events as chat.completion.chunk lines; tool calls numbered in
  // the order they start
  export async function* chunks(res: Response, model: string, withUsage: boolean): AsyncGenerator<string> {
    const created = Math.floor(Date.now() / 1000);
    const calls = new Map<number, number>();
    const usage: any = {};
    let id = "chatcmpl-" + crypto.randomUUID();
    let stop = "";
    const chunk = (delta: object, finish: string | null = null) =>
      "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
    for await (const ev of Sse.events(res.body!)) {
      if (ev.type === "message_start") {
        id = ev.message?.id ? "chatcmpl-" + ev.message.id : id;
        Object.assign(usage, ev.message?.usage ?? {});
        yield chunk({ role: "assistant", content: "" });
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        calls.set(ev.index, calls.size);
        yield chunk({ tool_calls: [{ index: calls.get(ev.index), id: ev.content_block.id, type: "function", function: { name: ev.content_block.name, arguments: "" } }] });
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        yield chunk({ content: ev.delta.text });
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta" && calls.has(ev.index)) {
        yield chunk({ tool_calls: [{ index: calls.get(ev.index), function: { arguments: ev.delta.partial_json } }] });
      } else if (ev.type === "message_delta") {
        stop = ev.delta?.stop_reason ?? stop;
        Object.assign(usage, ev.usage ?? {});
      } else if (ev.type === "error") {
        yield "data: " + JSON.stringify({ error: { message: ev.error?.message ?? "stream error", type: "api_error" } }) + "\n\n";
        return;
      }
    }
    yield chunk({}, FINISH[stop] ?? "stop");
    if (withUsage) {
      yield "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: OpenAI.usage(usage) }) + "\n\n";
    }
    yield "data: [DONE]\n\n";
  }

}
