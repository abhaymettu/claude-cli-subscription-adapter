// Sse
// ===
// Reading the Messages API's server-sent events: one by one, or folded
// into the whole message the API returns when a request is not streamed.

export namespace Sse {

  // each `data:` line of a stream, parsed
  export async function* events(stream: ReadableStream<Uint8Array>): AsyncGenerator<any> {
    const dec = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      rest += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, nl).replace(/\r$/, "");
        rest = rest.slice(nl + 1);
        if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
          yield JSON.parse(line.slice(5));
        }
      }
    }
  }

  // the events folded into one message; an error event is returned as such
  export async function whole(stream: ReadableStream<Uint8Array>): Promise<{ message: any } | { error: any }> {
    let message: any = { content: [] };
    const json: string[] = [];
    const usage: any = {};
    for await (const ev of Sse.events(stream)) {
      switch (ev.type) {
        case "message_start": {
          message = { ...ev.message, content: [] };
          Object.assign(usage, ev.message.usage ?? {});
          break;
        }
        case "content_block_start": {
          message.content[ev.index] = { ...ev.content_block };
          break;
        }
        case "content_block_delta": {
          const block = message.content[ev.index];
          const d = ev.delta;
          if (d.type === "text_delta") {
            block.text += d.text;
          } else if (d.type === "thinking_delta") {
            block.thinking += d.thinking;
          } else if (d.type === "signature_delta") {
            block.signature = d.signature;
          } else if (d.type === "input_json_delta") {
            json[ev.index] = (json[ev.index] ?? "") + d.partial_json;
          } else if (d.type === "citations_delta") {
            block.citations = [...(block.citations ?? []), d.citation];
          }
          break;
        }
        case "message_delta": {
          message.stop_reason = ev.delta.stop_reason ?? message.stop_reason;
          message.stop_sequence = ev.delta.stop_sequence ?? message.stop_sequence ?? null;
          Object.assign(usage, ev.usage ?? {});
          break;
        }
        case "error": {
          return { error: ev.error };
        }
      }
    }
    message.content = message.content.map((b: any, k: number) => (json[k] !== undefined ? { ...b, input: parse(json[k]) } : b));
    return { message: { ...message, stop_reason: message.stop_reason ?? null, stop_sequence: message.stop_sequence ?? null, usage } };
  }

}

function parse(json: string): unknown {
  try {
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
}
