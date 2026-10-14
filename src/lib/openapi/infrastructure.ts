import { z } from "zod";
import {
	dnsRecordApiBody,
	domainApiBody,
	remoteHostApiBody,
	updateDnsRecordApiBody,
	updateDomainApiBody,
	updateRemoteHostApiBody,
	updateWorkstationApiBody,
	updateWorkstationPresetApiBody,
	workstationApiBody,
	workstationPresetApiBody,
} from "#lib/server/validation/infrastructure-api.js";
import { AUTO_STOP_MODES } from "#lib/workstations.js";
import type { ParamDef, RouteDef } from "./registry";
import { errorResponse } from "./schemas";

const timestamp = z.string().meta({ description: "ISO 8601 timestamp" });

/** The part of `resources.ts`'s crudRoutes spec these resources use. */
interface CrudRouteSpec {
	createBody?: z.ZodType;
	idParam: ParamDef;
	notes?: Partial<Record<"create" | "delete" | "list" | "update", string>>;
	noun: string;
	paginated?: boolean;
	parentParams?: ParamDef[];
	path: string;
	plural: string;
	response: z.ZodType;
	tag: string;
	updateBody?: z.ZodType;
}

export const remoteHostResponse = z.object({
	agentTokenSet: z.boolean(),
	agentUrl: z.string().nullable(),
	createdAt: timestamp,
	dockerHost: z.string().nullable(),
	id: z.string(),
	kind: z.enum(["docker", "agent"]),
	name: z.string(),
	tlsCaSet: z.boolean(),
	tlsCertSet: z.boolean(),
	tlsKeySet: z.boolean(),
	updatedAt: timestamp,
	userId: z.string(),
});

export const domainResponse = z.object({
	autoRecords: z.boolean(),
	connectionId: z.string().nullable(),
	createdAt: timestamp,
	id: z.string(),
	name: z.string(),
	target: z.string().nullable(),
	userId: z.string(),
	zoneId: z.string().nullable(),
	zoneName: z.string().nullable(),
});

export const dnsRecordResponse = z.object({
	content: z.string(),
	domainId: z.string(),
	id: z.string().meta({ description: "<domainId>/<recordId>" }),
	managed: z.boolean().meta({
		description:
			"Whether Homerun created it for a service's hostname, and keeps it in step",
	}),
	name: z.string().meta({ description: "The full name" }),
	priority: z.number().int().nullable(),
	recordId: z.string().meta({
		description:
			"The provider's id. Providers that derive it from the value (Hetzner, Google, Azure, GoDaddy and the like) change it when the record changes",
	}),
	ttl: z.number().int().nullable(),
	type: z.string(),
});

const workstationSettingsResponse = {
	cpuLimit: z.string().nullable(),
	createdAt: timestamp,
	editorSettings: z.record(z.string(), z.unknown()),
	env: z.record(z.string(), z.string()),
	extensions: z.array(z.string()),
	gitAuthorEmail: z.string().nullable(),
	gitAuthorName: z.string().nullable(),
	gitBranch: z.string().nullable(),
	gitProviderId: z.string().nullable(),
	gitUrl: z.string().nullable(),
	homePath: z.string(),
	id: z.string(),
	image: z.string(),
	memoryLimitMb: z.number().int().nullable(),
	name: z.string(),
	port: z.number().int(),
	remoteHostId: z.string().nullable(),
	updatedAt: timestamp,
	userId: z.string(),
};

const workstationWallResponse = {
	authAllowedEmails: z.array(z.string()),
	authAllowedGroups: z.array(z.string()),
	authAllowedUserIds: z.array(z.string()),
	authProviders: z.array(z.string()),
	authRequired: z.boolean(),
};

export const workstationResponse = z.object({
	...workstationSettingsResponse,
	...workstationWallResponse,
	autoStopAt: timestamp.nullable(),
	autoStopMinutes: z.number().int().nullable(),
	autoStopMode: z.enum(AUTO_STOP_MODES).nullable(),
	desiredState: z.enum(["running", "stopped"]),
	domain: z.string().nullable(),
	lastError: z.string().nullable(),
	signInWithGit: z.boolean(),
	slug: z.string(),
});

export const workstationPresetResponse = z.object({
	...workstationSettingsResponse,
	...workstationWallResponse,
	description: z.string().nullable(),
});

/** The REST routes of remote hosts, domains and their DNS records, workstations and workstation presets. */
export function infrastructureRoutes(
	crudRoutes: (spec: CrudRouteSpec) => RouteDef[],
): RouteDef[] {
	return [
		...crudRoutes({
			createBody: remoteHostApiBody,
			idParam: { description: "Remote host id", name: "hostId" },
			notes: {
				create:
					"A build server: a Docker daemon (tcp:// or ssh://) or a Homerun Agent, whose token is checked against the agent before saving.",
				delete:
					"Deletes the host's record; services building on it fall back to this server.",
				update:
					"Changes the fields sent and keeps the rest. A blank or missing token or TLS field keeps the stored one; an agent is checked again when its URL or token changes.",
			},
			noun: "remote host",
			paginated: true,
			path: "/remote-hosts",
			plural: "remote hosts",
			response: remoteHostResponse,
			tag: "Remote hosts",
			updateBody: updateRemoteHostApiBody,
		}),
		...crudRoutes({
			createBody: domainApiBody,
			idParam: { description: "Domain id", name: "domainId" },
			notes: {
				delete: "Removes the domain from Homerun; its records stay.",
			},
			noun: "domain",
			path: "/domains",
			plural: "domains",
			response: domainResponse,
			tag: "DNS",
			updateBody: updateDomainApiBody,
		}),
		...crudRoutes({
			createBody: dnsRecordApiBody,
			idParam: { description: "The provider's record id", name: "recordId" },
			notes: {
				create:
					"Creates the record at the domain's DNS provider. A record made here is the caller's: Homerun never changes or removes it on its own.",
				update:
					"Changes the fields sent and keeps the rest. The answer carries the record's id, which changes on providers that derive it from the value.",
			},
			noun: "DNS record",
			parentParams: [{ description: "Domain id", name: "domainId" }],
			path: "/domains/{domainId}/records",
			plural: "DNS records of a domain",
			response: dnsRecordResponse,
			tag: "DNS",
			updateBody: updateDnsRecordApiBody,
		}),
		...crudRoutes({
			createBody: workstationApiBody,
			idParam: { description: "Workstation id", name: "workstationId" },
			notes: {
				create:
					"Creates one of the caller's workstations and starts it, unless desiredState is stopped. A hostname something else already routes answers 409.",
				delete:
					"Removes the container and the record. ?volume=true deletes the home volume too.",
				update:
					"Changes the fields sent and keeps the rest; settings apply on the next start, the login wall policy at once. desiredState starts or stops it, and turning authRequired on or off restarts a running one.",
			},
			noun: "workstation",
			paginated: true,
			path: "/workstations",
			plural: "workstations of the caller",
			response: workstationResponse,
			tag: "Workstations",
			updateBody: updateWorkstationApiBody,
		}),
		{
			description:
				"Recreates the workstation's container from its current settings, like the dashboard's Recreate: the image is pulled again, so a moving tag picks up its new release, and the home volume survives. Starts a stopped one. Answers once the start is under way.",
			method: "post",
			path: "/workstations/{workstationId}/recreate",
			pathParams: [{ description: "Workstation id", name: "workstationId" }],
			responses: {
				200: { description: "Recreating", schema: workstationResponse },
				401: { description: "Unauthorized", schema: errorResponse },
				404: { description: "Not found", schema: errorResponse },
				502: {
					description:
						"The worker or agent refused the start or couldn't be reached; the message is also the workstation's last error",
					schema: errorResponse,
				},
			},
			summary: "Recreate a workstation",
			tags: ["Workstations"],
		},
		...crudRoutes({
			createBody: workstationPresetApiBody,
			idParam: { description: "Preset id", name: "presetId" },
			noun: "workstation preset",
			path: "/workstation-presets",
			plural: "workstation presets of the caller",
			response: workstationPresetResponse,
			tag: "Workstations",
			updateBody: updateWorkstationPresetApiBody,
		}),
	];
}
