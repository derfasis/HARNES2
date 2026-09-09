"""MCP 2.x stdio adapter over the same restricted business tool surface.

This is an internal planning integration. The local service creates its own
proposal-only token; it is never the operator's browser token.
"""
import asyncio
import json
from pathlib import Path
import urllib.error
import urllib.request
import uuid

import mcp_types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

ROOT = Path(__file__).resolve().parents[2]


def call_api(route, payload=None):
    connection = json.loads((ROOT / "data/runtime/mcp-connection.json").read_text(encoding="utf-8"))
    headers = {"Authorization": "Bearer " + connection["token"], "Content-Type": "application/json"}
    request = urllib.request.Request(connection["url"] + route, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


async def list_tools(ctx, params):
    definitions = await asyncio.to_thread(call_api, "/internal/tools")
    return types.ListToolsResult(tools=[types.Tool(**definition) for definition in definitions["tools"]])


async def call_tool(ctx, params):
    try:
        result = await asyncio.to_thread(call_api, "/internal/tools/call", {"name": params.name, "arguments": params.arguments or {}, "request_id": str(uuid.uuid4())})
        return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False))])
    except urllib.error.HTTPError as error:
        return types.CallToolResult(isError=True, content=[types.TextContent(type="text", text=error.read(8192).decode(errors="replace"))])
    except (OSError, ValueError):
        return types.CallToolResult(isError=True, content=[types.TextContent(type="text", text="Local business service is unavailable. Start the project first.")])


server = Server("digital-ai-partner", version="0.1.0", on_list_tools=list_tools, on_call_tool=call_tool)


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
