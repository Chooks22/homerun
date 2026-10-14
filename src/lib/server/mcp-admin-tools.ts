import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";
import {
	dnsRecordApiBody,
	updateDnsRecordApiBody,
} from "#lib/server/validation/infrastructure-api.js";

const domainId = z.string().describe("The domain's id, from list_domains");
const recordId = z
	.string()
	.describe("The provider's record id (recordId), from list_dns_records");

/** A path under a domain's records, with its ids escaped. */
function recordsPath(domain: string, record?: string): string {
	const base = `/domains/${encodeURIComponent(domain)}/records`;
	return record ? `${base}/${encodeURIComponent(record)}` : base;
}

/**
 * Registers the DNS tools: the domains and their records at the provider,
 * which an agent may change, and the provider connections, read as metadata
 * only (their credentials never leave the instance, and connecting or
 * changing one stays on the dashboard).
 */
function registerDnsTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_dns_connections",
		{
			annotations: read,
			description:
				"The DNS provider connections (Cloudflare and the like): id, name, provider and which credential fields are set. The credentials themselves are never returned, and connections are added or changed on the dashboard only.",
		},
		async () => asResult(await api("GET", "/dns-connections")),
	);

	server.registerTool(
		"list_domains",
		{
			annotations: read,
			description:
				"The domains Homerun manages DNS for: name, connection and zone, what their services' records point at (target) and whether those records are made automatically (autoRecords).",
		},
		async () => asResult(await api("GET", "/domains")),
	);

	server.registerTool(
		"list_dns_records",
		{
			annotations: read,
			description:
				"A domain's DNS records as its provider lists them: full name, type, value, TTL, MX priority, and managed when Homerun made it for a service's hostname and keeps it in step.",
			inputSchema: z.object({ domainId }),
		},
		async ({ domainId: id }) => asResult(await api("GET", recordsPath(id))),
	);

	server.registerTool(
		"create_dns_record",
		{
			annotations: change,
			description:
				"Create a DNS record at a domain's provider. Homerun never changes or removes a record made this way on its own.",
			inputSchema: dnsRecordApiBody.extend({ domainId }),
		},
		async ({ domainId: id, ...record }) =>
			asResult(await api("POST", recordsPath(id), record)),
	);

	server.registerTool(
		"update_dns_record",
		{
			annotations: change,
			description:
				"Change a DNS record's fields, keeping the ones left out. The answer carries its id, which changes on providers that derive it from the value.",
			inputSchema: updateDnsRecordApiBody.extend({ domainId, recordId }),
		},
		async ({ domainId: id, recordId: record, ...changes }) =>
			asResult(await api("PATCH", recordsPath(id, record), changes)),
	);

	server.registerTool(
		"delete_dns_record",
		{
			annotations: { destructiveHint: true, openWorldHint: false },
			description:
				"Delete a DNS record at the domain's provider. A managed record comes back on its service's next deploy while the service still has that hostname.",
			inputSchema: z.object({ domainId, recordId }),
		},
		async ({ domainId: id, recordId: record }) =>
			asResult(await api("DELETE", recordsPath(id, record))),
	);
}

/** The path of a registry repository's tags, each segment of its name escaped. */
function repositoryTagsPath(repository: string): string {
	const escaped = repository.split("/").map(encodeURIComponent).join("/");
	return `/registry/repositories/${escaped}/tags`;
}

/**
 * Registers the read-only tools over the built-in registry: its settings,
 * its tokens (never their secrets) and the images it holds. Minting tokens
 * and deleting images stay on the dashboard.
 */
function registerRegistryTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"get_registry_settings",
		{
			annotations: read,
			description:
				"The built-in image registry's settings: whether pushes and pulls need a token, and the public hostname it's published at.",
		},
		async () => asResult(await api("GET", "/registry/settings")),
	);

	server.registerTool(
		"list_registry_tokens",
		{
			annotations: read,
			description:
				"The built-in registry's push and pull tokens: username, created and last used. Their secrets are never returned.",
		},
		async () => asResult(await api("GET", "/registry/tokens")),
	);

	server.registerTool(
		"list_registry_repositories",
		{
			annotations: read,
			description:
				"The built-in registry's repositories (images pushed to it, and the mirror copies Homerun makes to scan and deploy), 100 a page in name order, each with its tags, their digests and the services whose image lives in it.",
			inputSchema: z.object({
				page: z.number().int().min(1).optional().describe("1-based page"),
				search: z
					.string()
					.optional()
					.describe("Only repositories whose name contains this"),
			}),
		},
		async ({ page, search }) => {
			const query = new URLSearchParams({ perPage: "100" });
			if (page) {
				query.set("page", String(page));
			}
			if (search) {
				query.set("q", search);
			}
			return asResult(await api("GET", `/registry/repositories?${query}`));
		},
	);

	server.registerTool(
		"list_registry_tags",
		{
			annotations: read,
			description:
				"One built-in registry repository's tags with the digest each points at. Deleting tags stays on the dashboard.",
			inputSchema: z.object({
				repository: z
					.string()
					.describe(
						"The repository's name, slashes included, from list_registry_repositories",
					),
			}),
		},
		async ({ repository }) =>
			asResult(await api("GET", repositoryTagsPath(repository))),
	);
}

/**
 * Registers the read-only tools over the rest of admin config: remote
 * hosts, users and git providers. None of them change anything: host agent
 * tokens and TLS keys, and git provider secrets are credentials, and users
 * and roles are who may do what, so connecting and granting all stay on the
 * dashboard.
 */
function registerAdminReadTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_remote_hosts",
		{
			annotations: read,
			description:
				"Remote build hosts: a Docker daemon (tcp:// or ssh://) or a Homerun agent, with which of their TLS files and token are set. The secrets themselves are never returned.",
		},
		async () => asResult(await api("GET", "/remote-hosts?perPage=100")),
	);

	server.registerTool(
		"list_users",
		{
			annotations: read,
			description:
				"The human accounts, newest first: name, email, role, custom permissions and last sign-in. Needs read access to Users.",
			inputSchema: z.object({
				search: z
					.string()
					.optional()
					.describe("Only users whose name or email matches this term"),
			}),
		},
		async ({ search }) => {
			const query = new URLSearchParams({ perPage: "100" });
			if (search) {
				query.set("q", search);
			}
			return asResult(await api("GET", `/users?${query}`));
		},
	);

	server.registerTool(
		"list_git_providers",
		{
			annotations: read,
			description:
				"The git providers (GitHub, GitLab, Gitea, Bitbucket) git builds can connect through: id, kind, name, base URL and whether they're on. Client secrets are never returned, and providers are set up on the dashboard only.",
		},
		async () => asResult(await api("GET", "/git-providers")),
	);
}

/** Registers the DNS tools, the built-in registry's tools and the read-only admin config tools. */
export function registerAdminTools(server: McpServer, api: ApiCall): void {
	registerDnsTools(server, api);
	registerRegistryTools(server, api);
	registerAdminReadTools(server, api);
}
