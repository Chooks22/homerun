import type { IacAttribute, IacKind, IacResource } from "#lib/iac/resources.js";
import { loginWallAttributes } from "#lib/iac/resources-identity.js";
import {
	DEFAULT_WORKSTATION_HOME,
	DEFAULT_WORKSTATION_IMAGE,
	DEFAULT_WORKSTATION_PORT,
} from "#lib/workstations.js";

type AttributeFactory = (
	name: string,
	kind: IacKind,
	options?: Omit<Partial<IacAttribute>, "kind" | "name">,
) => IacAttribute;

const required = { required: true };
const secret = { sensitive: true, writeOnly: true };
const replace = { forceNew: true, required: true };
const readOnly = { readOnly: true };

/** A build server: a Docker daemon or a Homerun Agent. */
function remoteHostResource(attr: AttributeFactory): IacResource {
	return {
		adminOnly: true,
		attributes: [
			attr("name", "string", required),
			attr("kind", "string", {
				default: "docker",
				description:
					"docker (a Docker daemon at docker_host) or agent (a Homerun Agent at agent_url).",
				forceNew: true,
			}),
			attr("dockerHost", "string", {
				description: "tcp://host:2376 or ssh://user@host.",
			}),
			attr("tlsCa", "string", secret),
			attr("tlsCert", "string", secret),
			attr("tlsKey", "string", secret),
			attr("agentUrl", "string", {
				description: "The agent's base URL, like `http://10.0.0.5:7420`.",
			}),
			attr("agentToken", "string", {
				...secret,
				description: "Checked against the agent before it's saved.",
			}),
			attr("maxConcurrentBuilds", "int", {
				description:
					"How many builds run on it at once, 0 for no limit. Unset follows the instance's build_concurrency.",
			}),
			attr("agentTokenSet", "bool", readOnly),
			attr("tlsCaSet", "bool", readOnly),
			attr("tlsCertSet", "bool", readOnly),
			attr("tlsKeySet", "bool", readOnly),
		],
		collectionPath: "/remote-hosts",
		description:
			"A remote host git builds can run on: a Docker daemon or a Homerun Agent. Servers enrolled with the dashboard's install command can be imported.",
		importId: ["id"],
		itemPath: "/remote-hosts/{id}",
		label: "name",
		type: "homerun_remote_host",
	};
}

/** A domain and the records of its zone. */
function dnsResources(attr: AttributeFactory): IacResource[] {
	return [
		{
			adminOnly: true,
			attributes: [
				attr("name", "string", replace),
				attr("connectionId", "string", {
					description: "The DNS connection the domain's zone lives in.",
					ref: "homerun_dns_connection",
				}),
				attr("zoneId", "string", {
					description: "The provider's zone id. Required with connection_id.",
				}),
				attr("zoneName", "string", {
					description: "Looked up from the connection when left out.",
				}),
				attr("target", "string", {
					description:
						"What its services' records point at, an IP or a hostname. Unset points them at the base domain.",
				}),
				attr("autoRecords", "bool", {
					default: true,
					description:
						"Create and remove the records of services' hostnames under it.",
				}),
			],
			collectionPath: "/domains",
			description:
				"A domain Homerun manages, optionally linked to a DNS connection's zone.",
			importId: ["id"],
			itemPath: "/domains/{id}",
			label: "name",
			type: "homerun_domain",
		},
		{
			adminOnly: true,
			attributes: [
				attr("domainId", "string", { ...replace, ref: "homerun_domain" }),
				attr("name", "string", {
					...replace,
					description:
						"The full name, like `www.example.com`, or the domain itself for its apex: what the provider answers with.",
				}),
				attr("type", "string", {
					...replace,
					description: "A, AAAA, CNAME, TXT, MX or CAA.",
				}),
				attr("content", "string", {
					...replace,
					description:
						"The value: an address, a hostname without the trailing dot, or unquoted text.",
				}),
				attr("ttl", "int", {
					description: "Seconds from 60 to 86400, automatic when unset.",
					forceNew: true,
				}),
				attr("priority", "int", {
					description: "MX only, 10 when unset.",
					forceNew: true,
				}),
				attr("recordId", "string", readOnly),
				attr("managed", "bool", readOnly),
			],
			collectionPath: "/domains/{domainId}/records",
			description:
				"A DNS record at a domain's provider. Every change replaces it, since some providers derive a record's id from its value.",
			importId: ["domainId", "recordId"],
			itemPath: "/domains/{domainId}/records/{recordId}",
			label: "name",
			type: "homerun_dns_record",
		},
	];
}

/** The settings a workstation and a preset share. */
function workstationSettings(attr: AttributeFactory): IacAttribute[] {
	return [
		attr("image", "string", { default: DEFAULT_WORKSTATION_IMAGE }),
		attr("homePath", "string", { default: DEFAULT_WORKSTATION_HOME }),
		attr("port", "int", {
			default: DEFAULT_WORKSTATION_PORT,
			description: "The IDE's port in the container.",
		}),
		attr("cpuLimit", "string", { description: "Cores, like 1.5." }),
		attr("memoryLimitMb", "int"),
		attr("env", "stringMap", {
			description: "Variables set in the container. PASSWORD is Homerun's.",
			sensitive: true,
		}),
		attr("extensions", "strings", {
			description:
				"Open VSX extension ids (publisher.name) installed on every start.",
		}),
		attr("gitUrl", "string", {
			description: "An http(s) repository cloned into the home directory.",
		}),
		attr("gitBranch", "string"),
		attr("gitProviderId", "string", {
			description:
				"The git provider whose connection authenticates git and, when set, signs in to the IDE.",
			ref: "homerun_git_provider",
		}),
		attr("gitAuthorName", "string"),
		attr("gitAuthorEmail", "string"),
	];
}

/** The API key owner's workstations and presets. */
function workstationResources(attr: AttributeFactory): IacResource[] {
	return [
		{
			attributes: [
				attr("name", "string", required),
				attr("domain", "string", {
					description: "Defaults to `<slug>.dev.<base domain>`.",
					forceNew: true,
				}),
				attr("remoteHostId", "string", {
					description: "The agent host it runs on, this server when unset.",
					forceNew: true,
					ref: "homerun_remote_host",
				}),
				...workstationSettings(attr),
				attr("desiredState", "string", {
					description:
						"running or stopped. A new workstation starts unless it's stopped.",
				}),
				attr("autoStopMode", "string", {
					description: "idle or timer, unset for never.",
				}),
				attr("autoStopMinutes", "int"),
				attr("authRequired", "bool", {
					default: false,
					description:
						"Put Homerun's login wall in front of the IDE instead of its password or git sign-in. The owner always gets in; turning it on or off restarts a running workstation.",
				}),
				...loginWallAttributes("auth"),
				attr("slug", "string", readOnly),
			],
			collectionPath: "/workstations",
			description:
				"One of the API key owner's dev workstations: a browser IDE container with a persistent home volume. Destroying it keeps the volume. The editor settings are set from the dashboard.",
			importId: ["id"],
			itemPath: "/workstations/{id}",
			label: "name",
			type: "homerun_workstation",
		},
		{
			attributes: [
				attr("name", "string", required),
				attr("description", "string"),
				attr("remoteHostId", "string", {
					description: "The agent host it runs on, this server when unset.",
					ref: "homerun_remote_host",
				}),
				...workstationSettings(attr),
				attr("authRequired", "bool", {
					default: false,
					description:
						"Put Homerun's login wall in front of the IDE of every workstation created from this preset, instead of its password or git sign-in.",
				}),
				...loginWallAttributes("auth"),
			],
			collectionPath: "/workstation-presets",
			description:
				"One of the API key owner's workstation presets: settings and a login wall a new workstation starts from.",
			importId: ["id"],
			itemPath: "/workstation-presets/{id}",
			label: "name",
			type: "homerun_workstation_preset",
		},
	];
}

/**
 * The resources of the build servers, domains and DNS records, and the
 * caller's own workstations and presets, built with `resources.ts`'s
 * attribute helper so the two files don't import each other.
 */
export function infrastructureResources(attr: AttributeFactory): IacResource[] {
	return [
		remoteHostResource(attr),
		...dnsResources(attr),
		...workstationResources(attr),
	];
}
