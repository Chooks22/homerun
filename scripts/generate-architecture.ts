import { parse } from "yaml";

type Group = "clients" | "host" | "remote" | "external";

interface Component {
	group: Group;
	id: string;
	label: string;
}

interface Edge {
	from: string;
	to: string;
	via: string;
	why: string;
}

interface ComposeService {
	command?: string[];
	environment?: Record<string, string>;
	image?: string;
	labels?: string[];
	ports?: string[];
	volumes?: string[];
}

const COMPOSE_PATH = "internal/installer/compose.yaml";
const DOC_PATH = "docs/architecture.md";
const START = "<!-- architecture:start -->";
const END = "<!-- architecture:end -->";

const compose = parse(await Bun.file(COMPOSE_PATH).text()) as {
	services: Record<string, ComposeService>;
};

/**
 * Returns a service from the installer's compose file, throwing when the
 * diagram's model names one the file no longer has.
 */
function service(name: string): ComposeService {
	const found = compose.services[name];
	if (!found) {
		throw new Error(`${COMPOSE_PATH} has no "${name}" service`);
	}
	return found;
}

/**
 * Resolves a service's env var to its literal value or its `${VAR:-default}`
 * default, throwing when the variable is missing.
 */
function envValue(name: string, key: string): string {
	const raw = service(name).environment?.[key];
	if (raw === undefined) {
		throw new Error(`${COMPOSE_PATH}: ${name} has no ${key}`);
	}
	return raw.replace(/^\$\{[A-Z_]+:-(.*)\}$/, "$1");
}

/**
 * Returns the value of a `--flag=value` Traefik command-line flag, throwing
 * when the compose file no longer passes it.
 */
function traefikFlag(flag: string): string {
	const entry = service("traefik").command?.find((arg) =>
		arg.startsWith(`--${flag}=`),
	);
	if (!entry) {
		throw new Error(`${COMPOSE_PATH}: traefik lacks --${flag}`);
	}
	return entry.slice(flag.length + 3);
}

/**
 * Lists the compose services that satisfy a predicate, throwing when one of
 * them has no reason in `reasons`, so a new socket holder or database client
 * can't slip into the stack without showing up in the diagram.
 */
function holders(
	predicate: (svc: ComposeService) => boolean,
	reasons: Record<string, Omit<Edge, "from">>,
): Edge[] {
	return Object.entries(compose.services)
		.filter(([, svc]) => predicate(svc))
		.map(([name]) => {
			const reason = reasons[name];
			if (!reason) {
				throw new Error(`${COMPOSE_PATH}: explain why "${name}" needs this`);
			}
			return { from: name, ...reason };
		});
}

const known = new Set(["app", "worker", "traefik", "postgres"]);
const unknown = Object.keys(compose.services).filter((n) => !known.has(n));
if (unknown.length > 0) {
	throw new Error(`Add ${unknown.join(", ")} to ${import.meta.path}`);
}

const workerUrl = envValue("app", "WORKER_URL");
if (!workerUrl.endsWith(`:${envValue("worker", "WORKER_PORT")}`)) {
	throw new Error(`${COMPOSE_PATH}: WORKER_URL doesn't match WORKER_PORT`);
}
const databaseHost = envValue("app", "DATABASE_URL").match(/@([^/]+)\//)?.[1];
const dynamicDir = envValue("app", "TRAEFIK_DYNAMIC_CONFIG_DIR");
const sharedVolume = service("app")
	.volumes?.find((v) => v.endsWith(`:${dynamicDir}`))
	?.split(":")[0];
const traefikDynamicDir = traefikFlag("providers.file.directory");
if (
	!sharedVolume ||
	!service("traefik").volumes?.includes(`${sharedVolume}:${traefikDynamicDir}`)
) {
	throw new Error(
		`${COMPOSE_PATH}: app and traefik no longer share ${dynamicDir}`,
	);
}
const dockerNetwork = traefikFlag("providers.docker.network");
const appPort = service("app")
	.labels?.find((l) => l.includes("loadbalancer.server.port="))
	?.split("=")[1];
const publicPorts = (service("traefik").ports ?? [])
	.map((p) => p.split(":").at(-1))
	.join("/");
traefikFlag("certificatesresolvers.letsencrypt.acme.httpchallenge");

const isSocketMount = (svc: ComposeService) =>
	(svc.volumes ?? []).some((v) => v.includes("docker.sock"));
const hasDatabase = (svc: ComposeService) =>
	svc.environment?.DATABASE_URL !== undefined;

const components: Component[] = [
	{ group: "clients", id: "browser", label: "Browser (dashboard)" },
	{ group: "clients", id: "cli", label: "homerun CLI" },
	{ group: "clients", id: "mcp", label: "MCP clients (Claude, agents)" },
	{ group: "clients", id: "installer", label: "Installer" },
	{
		group: "host",
		id: "traefik",
		label: `Traefik (\`${service("traefik").image}\`)`,
	},
	{ group: "host", id: "app", label: "SvelteKit app" },
	{ group: "host", id: "worker", label: "Go worker (homerun-worker)" },
	{
		group: "host",
		id: "postgres",
		label: `Postgres (\`${service("postgres").image}\`)`,
	},
	{ group: "host", id: "docker", label: "Docker daemon" },
	{ group: "host", id: "services", label: "Deployed services" },
	{
		group: "host",
		id: "registry",
		label: "Built-in registry (homerun-mirror)",
	},
	{ group: "host", id: "newt", label: "Newt tunnel (homerun-newt)" },
	{ group: "remote", id: "buildhost", label: "Build servers / remote hosts" },
	{ group: "remote", id: "swarmnodes", label: "Swarm worker nodes" },
	{
		group: "external",
		id: "git",
		label: "Git providers (GitHub, GitLab, Gitea, Bitbucket)",
	},
	{ group: "external", id: "dns", label: "DNS provider APIs" },
	{ group: "external", id: "pangolin", label: "Pangolin" },
	{ group: "external", id: "s3", label: "S3 storage" },
	{
		group: "external",
		id: "fileserver",
		label: "SFTP, SMB and WebDAV storage (NAS, Storage Box)",
	},
	{
		group: "external",
		id: "notify",
		label:
			"Notification targets (Discord, Slack, Telegram, webhook, SMTP, browser push services)",
	},
	{ group: "external", id: "acme", label: "Let's Encrypt" },
	{
		group: "external",
		id: "registries",
		label: "Container registries (Docker Hub, GHCR, build cache)",
	},
];

const edges: Edge[] = [
	{
		from: "browser",
		to: "traefik",
		via: `HTTPS on ports ${publicPorts}`,
		why: "Reach the dashboard and every deployed app by hostname, with TLS.",
	},
	{
		from: "traefik",
		to: "app",
		via: `HTTP to port ${appPort}`,
		why: "Route the dashboard hostname to the app.",
	},
	{
		from: "traefik",
		to: "app",
		via: "forwardAuth to `/api/v1/auth-check` (`homerun-auth` alias)",
		why: "The per-app login wall: every request to a gated service is checked first.",
	},
	{
		from: "traefik",
		to: "services",
		via: `HTTP on the ${dockerNetwork} network`,
		why: "Route slug.baseDomain and custom domains to each service's container port.",
	},
	{
		from: "app",
		to: "traefik",
		via: `YAML files in the \`${sharedVolume}\` volume (file provider, \`${traefikDynamicDir}\`)`,
		why: "Dashboard router, redirects and custom certificates, which need no container and keep working when Docker is wedged.",
	},
	{
		from: "traefik",
		to: "acme",
		via: "ACME HTTP-01 challenge",
		why: "Issue and renew TLS certificates for every routed hostname.",
	},
	{
		from: "app",
		to: "worker",
		via: `HTTP to \`${new URL(workerUrl).host}\` + Bearer \`WORKER_TOKEN\` (derived from \`AUTH_SECRET\` when unset)`,
		why: "The app holds no Docker socket: status, start/stop, logs, terminal, stats and swarm calls all go through the worker.",
	},
	...holders(hasDatabase, {
		app: {
			to: "postgres",
			via: `SQL to ${databaseHost} (Drizzle over bun-sql)`,
			why: "All state, and the job queue: the app queues and prepares jobs, then finalizes them.",
		},
		worker: {
			to: "postgres",
			via: `SQL to \`${databaseHost}\` (\`pgx\`)`,
			why: "Leases execute-stage job rows, heartbeats, writes deploy logs and results, so no job is lost on a restart.",
		},
	}),
	...holders(isSocketMount, {
		traefik: {
			to: "docker",
			via: "Docker socket, read-only",
			why: "Discover routers from container labels (Docker provider).",
		},
		worker: {
			to: "docker",
			via: "Docker socket (`unix://`)",
			why: "The only read-write socket holder: deploys, builds, scans, backups, cron jobs, exec and logs.",
		},
	}),
	{
		from: "docker",
		to: "services",
		via: "containers or swarm services",
		why: "Runs what you deploy.",
	},
	{
		from: "docker",
		to: "registry",
		via: "`registry:2` container on `127.0.0.1:5055`",
		why: "Created on demand as the image mirror, optionally a private registry.",
	},
	{
		from: "worker",
		to: "registry",
		via: "Registry v2 HTTP (skopeo in helper containers)",
		why: "Copies each deploy's image through the mirror so Trivy scans it before it runs.",
	},
	{
		from: "docker",
		to: "registries",
		via: "Registry v2 HTTPS",
		why: "Pull service images; builds push to a build cache registry when one is set.",
	},
	{
		from: "worker",
		to: "buildhost",
		via: "HTTPS `POST /v1/build` + Bearer token (worker in agent mode)",
		why: "Build a git service on another machine without exposing its Docker daemon.",
	},
	{
		from: "worker",
		to: "buildhost",
		via: "Docker Engine API over tcp:// (TLS) or ssh://",
		why: "The other build-server kind: build straight on a remote daemon.",
	},
	{
		from: "worker",
		to: "buildhost",
		via: "SSH with Homerun's key",
		why: "Machine terminals: a browser shell on this server and every remote host.",
	},
	{
		from: "app",
		to: "buildhost",
		via: "HTTPS `GET /v1/stats` + Bearer token",
		why: "Verify an agent's token before saving it as a build server.",
	},
	{
		from: "buildhost",
		to: "app",
		via: "HTTPS `/api/v1/nodes/enroll` + one-time `hrn_` token",
		why: "The Add a server command installs and registers the machine itself.",
	},
	{
		from: "swarmnodes",
		to: "docker",
		via: "`docker swarm join`",
		why: "Extra capacity: swarm places replicas on joined nodes.",
	},
	{
		from: "worker",
		to: "git",
		via: "`git clone` in an `alpine/git` helper (on the building daemon)",
		why: "Fetch the source for a git-based build.",
	},
	{
		from: "app",
		to: "git",
		via: "HTTPS REST with each user's OAuth token",
		why: "Connect accounts, browse repos, register webhooks, poll branches, read status checks.",
	},
	{
		from: "git",
		to: "app",
		via: "HTTPS webhook to `/api/v1/webhooks/git/{serviceId}`",
		why: "Deploy on push and pull request previews.",
	},
	{
		from: "app",
		to: "dns",
		via: "HTTPS provider APIs",
		why: "Create and update records for every hostname a service answers on.",
	},
	{
		from: "app",
		to: "pangolin",
		via: "HTTPS Pangolin API",
		why: "Create a resource and target per hostname when Pangolin is the DNS provider.",
	},
	{
		from: "docker",
		to: "newt",
		via: "container or one-replica swarm service",
		why: "Runs the tunnel client when Pangolin's Newt credentials are set.",
	},
	{
		from: "newt",
		to: "pangolin",
		via: "outbound tunnel",
		why: "Publish this host's routes with no inbound ports open.",
	},
	{
		from: "newt",
		to: "traefik",
		via: `HTTPS on the ${dockerNetwork} network`,
		why: "Hand tunnelled requests to the usual Traefik routers.",
	},
	{
		from: "worker",
		to: "s3",
		via: "S3 API multipart PUT and GET",
		why: "Stream volume backups up and restores down.",
	},
	{
		from: "app",
		to: "s3",
		via: "S3 ListObjectsV2 (SigV4)",
		why: "List existing backups for the restore picker.",
	},
	{
		from: "worker",
		to: "fileserver",
		via: "SFTP, SMB or WebDAV from an rclone helper container",
		why: "Stream volume backups up and restores down, and list them for the restore picker.",
	},
	{
		from: "app",
		to: "notify",
		via: "HTTPS webhooks, Telegram Bot API, SMTP, Web Push",
		why: "Notifications (to a closed browser too), invites and emailed sign-in codes.",
	},
	{
		from: "cli",
		to: "app",
		via: "HTTPS REST `/api/v1` + `x-api-key`",
		why: "Deploy, inspect and manage from a terminal or CI.",
	},
	{
		from: "mcp",
		to: "app",
		via: "Streamable HTTP `/api/v1/mcp` + OAuth access token or API key",
		why: "AI agents manage services; each tool calls the REST API as the caller.",
	},
	{
		from: "services",
		to: "app",
		via: "HTTPS to the dashboard URL",
		why: "Sentry-compatible error ingest and Sign in with Homerun (OIDC).",
	},
	{
		from: "installer",
		to: "docker",
		via: "`docker compose pull` and `up`",
		why: "Install and upgrade the app, worker, Traefik and Postgres stack.",
	},
];

const ids = new Set(components.map((c) => c.id));
for (const edge of edges) {
	if (!(ids.has(edge.from) && ids.has(edge.to))) {
		throw new Error(
			`Edge ${edge.from} -> ${edge.to} names an unknown component`,
		);
	}
}

const groupTitles: Record<Group, string> = {
	clients: "Clients",
	external: "External services",
	host: "Homerun host",
	remote: "Other machines",
};

const mermaidText = (text: string) =>
	text.replaceAll('"', "'").replaceAll("`", "");
const labelOf = (id: string) =>
	components.find((c) => c.id === id)?.label ?? id;
const cell = (text: string) => text.replaceAll("|", "\\|");

const mermaid = [
	"flowchart LR",
	...(Object.keys(groupTitles) as Group[]).flatMap((group) => [
		`  subgraph ${group}["${groupTitles[group]}"]`,
		...components
			.filter((c) => c.group === group)
			.map((c) => `    ${c.id}["${mermaidText(c.label)}"]`),
		"  end",
	]),
	...edges.map((e) => `  ${e.from} -->|"${mermaidText(e.via)}"| ${e.to}`),
];

const table = [
	"| From | To | How | Why |",
	"| --- | --- | --- | --- |",
	...edges.map(
		(e) =>
			`| ${cell(labelOf(e.from))} | ${cell(labelOf(e.to))} | ${cell(e.via)} | ${cell(e.why)} |`,
	),
];

const generated = [
	START,
	"",
	"<!-- Generated by scripts/generate-architecture.ts, run bun run gen -->",
	"",
	"```mermaid",
	...mermaid,
	"```",
	"",
	...table,
	"",
	END,
].join("\n");

const doc = await Bun.file(DOC_PATH).text();
const startAt = doc.indexOf(START);
const endAt = doc.indexOf(END);
if (startAt === -1 || endAt < startAt) {
	throw new Error(`${DOC_PATH} is missing its ${START} / ${END} markers`);
}
await Bun.write(
	DOC_PATH,
	doc.slice(0, startAt) + generated + doc.slice(endAt + END.length),
);

const prettier = Bun.spawnSync(["bunx", "prettier", "--write", DOC_PATH], {
	stderr: "inherit",
	stdout: "ignore",
});
if (prettier.exitCode !== 0) {
	throw new Error(`prettier failed on ${DOC_PATH}`);
}

console.log(`Wrote ${DOC_PATH}`);
