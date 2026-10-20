import { describe, expect, test } from "bun:test";
import * as devalue from "devalue";
import { nativeFetch } from "./support/config";
import { integrationContext } from "./support/context";

const MCP_HEADERS = {
	accept: "application/json, text/event-stream",
	"content-type": "application/json",
};

interface RpcAnswer {
	error?: { message: string };
	result?: {
		content?: { text: string }[];
		isError?: boolean;
		tools?: { name: string }[];
	};
}

async function readRpc(res: Response): Promise<RpcAnswer> {
	const text = await res.text();
	if (res.headers.get("content-type")?.includes("text/event-stream")) {
		const data = text
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.at(-1);
		return JSON.parse(data ?? "{}") as RpcAnswer;
	}
	return JSON.parse(text) as RpcAnswer;
}

function rpc(
	credentials: Record<string, string>,
	method: string,
	params: Record<string, unknown> = {},
): Promise<Response> {
	return nativeFetch(`${integrationContext().origin}/api/v1/mcp`, {
		body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
		headers: {
			...MCP_HEADERS,
			...credentials,
			"mcp-protocol-version": "2025-06-18",
		},
		method: "POST",
	});
}

async function initialize(credentials: Record<string, string>): Promise<void> {
	const res = await rpc(credentials, "initialize", {
		capabilities: {},
		clientInfo: { name: "integration", version: "0" },
		protocolVersion: "2025-06-18",
	});
	expect(res.status).toBe(200);
}

async function pkcePair(): Promise<{ challenge: string; verifier: string }> {
	const verifier = crypto.randomUUID() + crypto.randomUUID();
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	const challenge = Buffer.from(digest).toString("base64url");
	return { challenge, verifier };
}

describe("MCP server", () => {
	test("an anonymous call is challenged with where to find the resource metadata", async () => {
		const { origin } = integrationContext();
		const res = await rpc({}, "tools/list");
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/v1/mcp"`,
		);
	});

	test("the protected resource and authorization server metadata are served at the root", async () => {
		const { origin } = integrationContext();
		const resource = await nativeFetch(
			`${origin}/.well-known/oauth-protected-resource/api/v1/mcp`,
		);
		expect(resource.status).toBe(200);
		const resourceBody = (await resource.json()) as {
			authorization_servers: string[];
			resource: string;
		};
		expect(resourceBody.resource).toBe(`${origin}/api/v1/mcp`);

		const server = await nativeFetch(
			`${origin}/.well-known/oauth-authorization-server/issuer`,
		);
		expect(server.status).toBe(200);
		const serverBody = (await server.json()) as {
			client_id_metadata_document_supported?: boolean;
			issuer: string;
			registration_endpoint?: string;
		};
		expect(resourceBody.authorization_servers).toEqual([serverBody.issuer]);
		expect(serverBody.registration_endpoint).toBe(
			`${origin}/api/v1/auth/oauth2/register`,
		);
		expect(serverBody.client_id_metadata_document_supported).toBe(true);
	});

	test("an API key lists the tools and runs one", async () => {
		const key = { "x-api-key": integrationContext().apiKey };
		await initialize(key);

		const listed = await readRpc(await rpc(key, "tools/list"));
		const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
		expect(names).toContain("get_service_config");
		expect(names).toContain("deploy_service");
		expect(names).toContain("list_deployments");
		expect(names).toContain("list_backups");
		expect(names).toContain("get_job");
		expect(names).not.toContain("delete_service");

		const called = await readRpc(
			await rpc(key, "tools/call", { arguments: {}, name: "list_services" }),
		);
		expect(called.result?.isError).toBeFalsy();
		expect(
			Array.isArray(JSON.parse(called.result?.content?.[0]?.text ?? "")),
		).toBe(true);

		const missing = await readRpc(
			await rpc(key, "tools/call", {
				arguments: { serviceId: "no-such-service" },
				name: "get_service_config",
			}),
		);
		expect(missing.result?.isError).toBe(true);
		expect(missing.result?.content?.[0]?.text).toStartWith("HTTP 404");
	});

	test("an API key manages a cron job and reads its runs and the notification feed", async () => {
		const key = { "x-api-key": integrationContext().apiKey };
		await initialize(key);
		const tool = async (name: string, args: Record<string, unknown> = {}) => {
			const answer = await readRpc(
				await rpc(key, "tools/call", { arguments: args, name }),
			);
			return {
				isError: answer.result?.isError,
				text: answer.result?.content?.[0]?.text ?? "",
			};
		};

		const created = await tool("create_cron_job", {
			command: "echo postgres://app:hunter2@db/app",
			envVars: { API_TOKEN: "t0k3n", TZ: "UTC" },
			image: "alpine",
			kind: "image",
			name: "MCP cron job",
			schedule: "0 3 * * *",
		});
		expect(created.isError).toBeFalsy();
		const job = JSON.parse(created.text) as {
			command: string;
			envVars: Record<string, string>;
			id: string;
		};
		expect(job.envVars.API_TOKEN).toBe("[redacted]");
		expect(job.command).not.toContain("hunter2");

		const updated = await tool("update_cron_job", {
			command: job.command,
			cronJobId: job.id,
			enabled: true,
			envVars: { API_TOKEN: "[redacted]", TZ: null },
		});
		expect(updated.isError).toBeFalsy();
		const after = await nativeFetch(
			`${integrationContext().origin}/api/v1/cron-jobs/${job.id}`,
			{ headers: key },
		);
		const stored = (await after.json()) as {
			command: string;
			enabled: boolean;
			envVars: Record<string, string>;
		};
		expect(stored.enabled).toBe(true);
		expect(stored.envVars).toEqual({ API_TOKEN: "t0k3n" });
		expect(stored.command).toBe("echo postgres://app:hunter2@db/app");

		const listed = await tool("list_cron_jobs", { search: "MCP cron" });
		expect(JSON.parse(listed.text)).toContainEqual(
			expect.objectContaining({ enabled: true, id: job.id }),
		);
		const runs = await tool("list_cron_job_runs", { cronJobId: job.id });
		expect(runs.isError).toBeFalsy();
		expect(JSON.parse(runs.text)).toEqual([]);
		const missingRun = await tool("get_cron_job_run", {
			cronJobId: job.id,
			runId: "no-such-run",
		});
		expect(missingRun.text).toStartWith("HTTP 404");

		const feed = await tool("list_notifications", { unread: true });
		expect(Array.isArray(JSON.parse(feed.text))).toBe(true);
		expect((await tool("mark_notifications_read")).isError).toBeFalsy();

		expect(
			(await tool("delete_cron_job", { cronJobId: job.id })).isError,
		).toBeFalsy();
		expect(
			(await tool("get_cron_job", { cronJobId: job.id })).text,
		).toStartWith("HTTP 404");
	});

	test("a client can't register itself", async () => {
		const { origin } = integrationContext();
		const registered = await nativeFetch(
			`${origin}/api/v1/auth/oauth2/register`,
			{
				body: JSON.stringify({
					client_name: "Uninvited",
					redirect_uris: ["https://evil.example/callback"],
					token_endpoint_auth_method: "none",
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			},
		);
		expect(registered.status).toBeGreaterThanOrEqual(400);
	});

	test("a Gemini custom app registers itself as a public client", async () => {
		const { origin } = integrationContext();
		const callback =
			"https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1234567890-homerun_test";
		const registered = await nativeFetch(
			`${origin}/api/v1/auth/oauth2/register`,
			{
				body: JSON.stringify({
					client_name: "Not Gemini",
					grant_types: ["authorization_code", "refresh_token"],
					redirect_uris: [callback],
					response_types: ["code"],
					token_endpoint_auth_method: "client_secret_basic",
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			},
		);
		expect(registered.status).toBe(201);
		const client = (await registered.json()) as Record<string, unknown>;
		expect(client.client_id).toBeString();
		expect(client.client_secret).toBeUndefined();
		expect(client.client_name).toBe("Gemini");
		expect(client.token_endpoint_auth_method).toBe("none");
		expect(client.redirect_uris).toEqual([callback]);
	});

	test("a metadata document URL on a private address is refused, never fetched", async () => {
		const { origin } = integrationContext();
		const { challenge } = await pkcePair();
		const authorizeUrl = new URL(`${origin}/api/v1/auth/oauth2/authorize`);
		for (const [name, value] of Object.entries({
			client_id: "https://127.0.0.1/client.json",
			code_challenge: challenge,
			code_challenge_method: "S256",
			redirect_uri: "https://127.0.0.1/callback",
			response_type: "code",
			scope: "openid",
		})) {
			authorizeUrl.searchParams.set(name, value);
		}
		const authorized = await nativeFetch(authorizeUrl, { redirect: "manual" });
		expect(authorized.status).toBe(400);
		expect(await authorized.json()).toMatchObject({ error: "invalid_client" });
	});

	test("a connector an admin created, with its client ID and secret, gets a token the MCP endpoint accepts", async () => {
		const { origin } = integrationContext();
		const redirectUri = "https://claude.ai/api/mcp/auth_callback";
		const resource = `${origin}/api/v1/mcp`;

		const signedIn = await nativeFetch(`${origin}/api/v1/auth/sign-in/email`, {
			body: JSON.stringify({
				email: "admin@integration.test",
				password: "integration-test-password-1234",
			}),
			headers: { "content-type": "application/json", origin },
			method: "POST",
		});
		expect(signedIn.status).toBe(200);
		const cookie = signedIn.headers
			.getSetCookie()
			.map((entry) => entry.split(";")[0])
			.join("; ");

		const createdRes = await nativeFetch(`${origin}/idp/new?/create`, {
			body: new URLSearchParams({
				clientType: "confidential",
				environmentName: "production",
				name: "Claude",
				redirectUris: redirectUri,
				requirePkce: "on",
			}),
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
				cookie,
				origin,
			},
			method: "POST",
		});
		const envelope = (await createdRes.json()) as {
			data?: string;
			type: string;
		};
		expect(envelope.type).toBe("success");
		const { created } = devalue.parse(envelope.data ?? "null") as {
			created: { clientId: string; clientSecret: string };
		};
		const { clientId, clientSecret } = created;
		expect(clientSecret).toBeTruthy();

		const { challenge, verifier } = await pkcePair();
		const authorizeUrl = new URL(`${origin}/api/v1/auth/oauth2/authorize`);
		for (const [name, value] of Object.entries({
			client_id: clientId,
			code_challenge: challenge,
			code_challenge_method: "S256",
			redirect_uri: redirectUri,
			resource,
			response_type: "code",
			scope: "openid offline_access",
			state: "integration",
		})) {
			authorizeUrl.searchParams.set(name, value);
		}
		const authorized = await nativeFetch(authorizeUrl, {
			headers: { cookie },
			redirect: "manual",
		});
		const consentUrl = new URL(
			authorized.headers.get("location") ?? "",
			origin,
		);
		expect(consentUrl.pathname).toBe("/auth/consent");

		const consented = await nativeFetch(
			`${origin}/api/v1/auth/oauth2/consent`,
			{
				body: JSON.stringify({
					accept: true,
					oauth_query: consentUrl.search.slice(1),
				}),
				headers: { "content-type": "application/json", cookie, origin },
				method: "POST",
			},
		);
		expect(consented.status).toBe(200);
		const { url: callback } = (await consented.json()) as { url: string };
		const code = new URL(callback).searchParams.get("code") ?? "";
		expect(code).not.toBe("");

		const tokened = await nativeFetch(`${origin}/api/v1/auth/oauth2/token`, {
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				code_verifier: verifier,
				grant_type: "authorization_code",
				redirect_uri: redirectUri,
				resource,
			}),
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		});
		expect(tokened.status).toBe(200);
		const { access_token: accessToken } = (await tokened.json()) as {
			access_token: string;
		};

		const bearer = { authorization: `Bearer ${accessToken}` };
		await initialize(bearer);
		const called = await readRpc(
			await rpc(bearer, "tools/call", { arguments: {}, name: "list_stacks" }),
		);
		expect(called.result?.isError).toBeFalsy();

		const forged = await rpc(
			{ authorization: `Bearer ${accessToken.slice(0, -4)}AAAA` },
			"tools/list",
		);
		expect(forged.status).toBe(401);
	});
});
