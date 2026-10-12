import type { CallToolResult } from "@modelcontextprotocol/server";
import { redactText } from "#lib/server/mcp-redact.js";

/** Calls Homerun's own REST API as the MCP client's user. */
export type ApiCall = (
	method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
	path: string,
	body?: unknown,
) => Promise<Response>;

/** The annotations of a tool that only reads. */
export const read = { openWorldHint: false, readOnlyHint: true };
/** The annotations of a tool that changes something without destroying it. */
export const change = { destructiveHint: false, openWorldHint: false };

/** The API's answer as a tool result: its body as text with secrets redacted, flagged as an error on a non-2xx status. */
export async function asResult(response: Response): Promise<CallToolResult> {
	const text = redactText(await response.text());
	return {
		content: [
			{
				text: response.ok ? text : `HTTP ${response.status}: ${text}`,
				type: "text",
			},
		],
		isError: !response.ok,
	};
}

/** A thrown error as a failed tool result, for a refusal the tool makes itself before calling the API. */
export function errorResult(err: unknown): CallToolResult {
	return {
		content: [
			{ text: err instanceof Error ? err.message : String(err), type: "text" },
		],
		isError: true,
	};
}
