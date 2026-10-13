import { z } from "zod";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { type StatPoint, StatSampleDTO } from "#lib/dto/stat-sample-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { requirePermission } from "#lib/server/remote-auth.js";
import {
	DockerService,
	type SwarmReplica,
} from "#lib/services/docker.service.js";
import { query } from "$app/server";

const rangeSchema = z.enum([
	"live",
	"hour",
	"day",
	"week",
	"month",
	"year",
	"all",
]);

const historyInput = z.object({
	range: rangeSchema,
	serviceId: z.string().nullable().default(null),
	workstationId: z.string().nullable().default(null),
});

/** A workstation's newest resource sample, for its row in the list. */
export interface WorkstationUsage {
	at: Date;
	cpuPercent: number;
	memLimitMb: number | null;
	memUsedMb: number;
}

export interface ServiceUsage {
	cpuPercent: number;
	id: string;
	memUsedMb: number;
	name: string;
	netRxBytes: number;
	netTxBytes: number;
	status: string;
}

export const getStatHistory = query(
	historyInput,
	async ({ range, serviceId, workstationId }): Promise<StatPoint[]> => {
		if (workstationId) {
			const user = requirePermission("workstations", "read");
			const ws = await WorkstationDTO.get(workstationId, user.id);
			return ws
				? await StatSampleDTO.history(range, { workstationId: ws.id })
				: [];
		}
		requirePermission("services", "read");
		if (serviceId) {
			const svc = await ServiceDTO.get(serviceId);
			if (!svc) {
				return [];
			}
		}
		return await StatSampleDTO.history(range, serviceId);
	},
);

/** Every service the caller owns with its newest sample, for the dashboard's sortable usage table. */
export const getServiceUsage = query(async (): Promise<ServiceUsage[]> => {
	requirePermission("services", "read");
	const [services, latest] = await Promise.all([
		ServiceDTO.list(),
		StatSampleDTO.latestPerService(),
	]);
	return services.map((svc) => {
		const sample = latest.get(svc.id);
		return {
			cpuPercent: sample?.cpuPercent ?? 0,
			id: svc.id,
			memUsedMb: sample?.memUsedMb ?? 0,
			name: svc.name,
			netRxBytes: sample?.netRxBytes ?? 0,
			netTxBytes: sample?.netTxBytes ?? 0,
			status: svc.currentStatus,
		};
	});
});

/** The caller's workstations' newest samples, keyed by workstation id; stopped ones and ones never sampled are left out. */
export const getWorkstationUsage = query(
	async (): Promise<Record<string, WorkstationUsage>> => {
		const user = requirePermission("workstations", "read");
		const owned = await WorkstationDTO.listForUser(user.id);
		const latest = await StatSampleDTO.latestPerWorkstation(
			owned.filter((ws) => ws.desiredState === "running").map((ws) => ws.id),
		);
		return Object.fromEntries(
			[...latest].map(([id, sample]) => [
				id,
				{
					at: sample.createdAt,
					cpuPercent: sample.cpuPercent,
					memLimitMb: sample.memLimitMb,
					memUsedMb: sample.memUsedMb,
				},
			]),
		);
	},
);

/** Every replica of a swarm-mode service, with live stats for the ones on this host. Empty for a standalone service. */
export const getReplicaStats = query(
	z.string(),
	async (serviceId): Promise<SwarmReplica[]> => {
		requirePermission("services", "read");
		const svc = await ServiceDTO.get(serviceId);
		if (!svc?.swarmServiceId) {
			return [];
		}
		return await DockerService.listSwarmReplicas(svc.swarmServiceId);
	},
);
