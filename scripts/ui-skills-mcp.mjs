#!/usr/bin/env node
// MCP stdio bridge for the ui-skills remote server (stdlib only).
// Lets stdio-only MCP clients (e.g. Pi) use https://www.ui-skills.com/mcp.
// Protocol: newline-delimited JSON-RPC on stdin/stdout.
const ENDPOINT = process.env.UI_SKILLS_MCP_URL ?? "https://www.ui-skills.com/mcp";

async function forward(message) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let message = null;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) message = parsed;
    } catch {
      message = null;
    }
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") continue;
    const isNotification = !("id" in message) || message.id === undefined || message.id === null;
    if (message.method === "initialize") {
      if (!isNotification) {
        reply(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ui-skills", version: "0.2.4" },
        });
      }
      continue;
    }
    if (message.method === "ping") {
      if (!isNotification) reply(message.id, {});
      continue;
    }
    if (message.method.startsWith("notifications/")) continue;
    if (isNotification) continue;
    forward(message).then(
      (result) => {
        if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
        else replyError(message.id, -32603, "Empty response from ui-skills MCP server");
      },
      (err) => replyError(message.id, -32603, err instanceof Error ? err.message : String(err)),
    );
  }
});
