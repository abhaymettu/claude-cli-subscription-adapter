// InertMcp
// ========
// The MCP server the claude CLI sees the client's tools through
// (ClaudeCli.ts). It lists them from the JSON file it is given and runs
// none: a tool call goes back to the client, which runs it and sends the
// result in its next request, as with the API's own custom tools.

import * as fs from "node:fs";
import * as readline from "node:readline";

const tools = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (line.trim() === "") {
    continue;
  }
  const row = JSON.parse(line);
  const result =
    row.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "client-tools", version: "1" } }
    : row.method === "tools/list" ? { tools }
    : row.method === "tools/call" ? { isError: true, content: [{ type: "text", text: "Denied: the client runs its own tools." }] }
    : {};
  if (row.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: row.id, result }) + "\n");
  }
}
