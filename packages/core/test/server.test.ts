import { describe, expect, it } from "vitest";
import { FikenClient } from "../src/fiken/client.ts";
import { handleMcpRequest, type ToolCallEvent } from "../src/server.ts";
import { SERVER_DISPLAY_NAME } from "../src/server-info.ts";
import { TOOLS } from "../src/tools/index.ts";
import { connect, json, MockTransport } from "./helpers.ts";

describe("createFikenServer", () => {
  it("annotates every tool and gives it a Norwegian title", async () => {
    const client = await connect(new MockTransport(() => json([])), { access: "write" });
    const { tools } = await client.listTools();
    expect(tools.length).toBe(TOOLS.length);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint ?? tool.annotations?.destructiveHint, tool.name).toBeDefined();
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("registers write tools only for grants with write access", async () => {
    const readOnly = await connect(new MockTransport(() => json([])), { access: "read" });
    const { tools } = await readOnly.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      TOOLS.filter((tool) => tool.access === "read").map((tool) => tool.name).sort(),
    );
  });

  it("reports metadata for each tool call", async () => {
    const events: ToolCallEvent[] = [];
    const client = await connect(new MockTransport(() => json({}, { status: 500 })), {
      onToolCall: (event) => events.push(event),
    });
    await client.callTool({ name: "list_companies", arguments: {} });
    expect(events).toEqual([
      { tool: "list_companies", company: undefined, outcome: "fiken_error", fikenStatus: 500, durationMs: expect.any(Number) },
    ]);
  });
});

describe("handleMcpRequest", () => {
  it("serves a 2025-era initialize without sessions, with title and instructions", async () => {
    const request = new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    const response = await handleMcpRequest(request, { fiken: new FikenClient(new MockTransport(() => json([]))), access: "read" });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const text = await response.text();
    const body = JSON.parse(text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "")) as {
      result: { serverInfo: { title: string }; instructions: string };
    };
    expect(body.result.serverInfo.title).toBe(SERVER_DISPLAY_NAME);
    expect(body.result.instructions).toContain(SERVER_DISPLAY_NAME);
  });
});

describe("token budget", () => {
  // Under 26 tools, all definitions under about 7,200 tokens. HANDOFF section 11 set 25 and 7,000 before read_file.
  // Estimated at 3.5 characters per token for Norwegian JSON; measure in MCP Inspector for the real number.
  it("keeps all tool definitions under 26 tools and about 7,200 tokens", async () => {
    const client = await connect(new MockTransport(() => json([])), { access: "write" });
    const { tools } = await client.listTools();
    expect(tools.length).toBeLessThan(26);
    expect(JSON.stringify(tools).length / 3.5).toBeLessThanOrEqual(7_200);
  });
});
