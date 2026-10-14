import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { serviceApiJson } from "#lib/server/api-json.js";
import { updateServiceApiBody } from "#lib/server/validation/api.js";
import { WorkloadDetachError } from "#lib/services/docker/workload-removal.js";
import { DockerService } from "#lib/services/docker.service.js";
import {
	ServiceBusyError,
	ServiceLifecycleService,
} from "#lib/services/service-lifecycle.service.js";
import {
	ServiceSettingsError,
	ServiceSettingsService,
} from "#lib/services/service-settings.service.js";

const logger = new Logger("API");

export const GET = async ({ params, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const svc = await ServiceDTO.get(params.serviceId);
	if (!svc) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	// Real, tested-in-review finding, from this app's own integration test
	// suite (tests/integration/) : unlike the dashboard's own
	// [serviceId]/+layout.server.ts, which reconciles `currentStatus`
	// against live Docker/agent state on every page load, this route used to
	// just return the raw DB row. start/stop/restart (below, and the sibling
	// action routes) only ever update `desiredState`, never `currentStatus`
	// directly, so an API consumer polling this endpoint after a stop/start
	// would see a stale `currentStatus` forever, never reflecting reality
	// unless someone happened to also load the dashboard page for that
	// service. Same fix, same call, as the dashboard's own reconciliation.
	if (svc.containerId || svc.swarmServiceId) {
		await DockerService.syncServiceStatus(svc.id);
		const fresh = await ServiceDTO.get(params.serviceId);
		return Response.json(serviceApiJson((fresh ?? svc).toJSON()));
	}
	return Response.json(serviceApiJson(svc.toJSON()));
};

export const PATCH = async ({ params, request, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const svc = await ServiceDTO.get(params.serviceId);
	if (!svc) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	const body = await request.json().catch(() => null);
	const result = updateServiceApiBody.safeParse(body);
	if (!result.success) {
		return Response.json(
			{ error: "Invalid request body", issues: result.error.flatten() },
			{ status: 400 },
		);
	}
	try {
		await ServiceSettingsService.apply(svc, result.data, {
			hostAccess: can(locals.permissions, "system", "write"),
			userId: locals.user.id,
		});
	} catch (err) {
		if (err instanceof ServiceSettingsError) {
			return Response.json(err.body(), { status: err.status });
		}
		throw err;
	}
	logger.info(
		`Service updated via API: service=${svc.id} user=${locals.user.id}`,
	);
	return Response.json(serviceApiJson(svc.toJSON()));
};

export const DELETE = async ({ params, locals, url }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const svc = await ServiceDTO.get(params.serviceId);
	if (!svc) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	const force = url.searchParams.get("force") === "true";
	const deleteVolumes = url.searchParams.get("deleteVolumes") === "true";
	try {
		await ServiceLifecycleService.deleteService(svc, { deleteVolumes, force });
	} catch (error) {
		if (
			error instanceof WorkloadDetachError ||
			error instanceof ServiceBusyError
		) {
			return Response.json({ error: error.message }, { status: 409 });
		}
		throw error;
	}
	logger.info(
		`Service deleted via API: service=${svc.id} force=${force} user=${locals.user.id}`,
	);
	return new Response(null, { status: 204 });
};
