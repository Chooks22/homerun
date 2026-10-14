import type { GateTarget } from "#lib/server/app-gate.js";
import { gatedService } from "#lib/server/gated-service-cache.js";
import {
	WorkstationSignInService,
	workstationIdOf,
} from "#lib/services/workstation/sign-in.js";

/**
 * Service `serviceId`'s login wall (on or off) as a gate target, from the
 * 10-second gated-service cache; null when the service is gone.
 */
export async function serviceGateTarget(
	serviceId: string,
): Promise<GateTarget | null> {
	const service = await gatedService(serviceId);
	if (!service) {
		return null;
	}
	return {
		authAllowedEmails: service.authAllowedEmails,
		authAllowedGroups: service.authAllowedGroups,
		authAllowedUserIds: service.authAllowedUserIds,
		authProviders: service.authProviders,
		authRequired: service.authRequired,
		domains: service.domains,
		key: service.id,
		name: service.name,
		ownerId: null,
	};
}

/**
 * The service or workstation a gate token's `serviceId` names, for
 * `/app-auth` and the sign-in page: `workstation:<id>` resolves to that
 * workstation's wall, anything else to a service. Null when it's gone.
 */
export async function gateTarget(key: string): Promise<GateTarget | null> {
	const workstationId = workstationIdOf(key);
	return workstationId === null
		? await serviceGateTarget(key)
		: await WorkstationSignInService.wall(workstationId);
}
