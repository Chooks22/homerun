import { ServiceDTO } from "#lib/dto/service-dto.js";
import { apiError } from "#lib/server/api-route.js";
import { ImageVersionService } from "#lib/services/image-version.service.js";

/**
 * The service a `/services/{serviceId}/version` route acts on, or the
 * response refusing it: 404 when it doesn't exist, 400 when it has no version
 * pinning or update checks (built from git, or an environment, preview or
 * canary of another service).
 */
export async function versionedService(
	serviceId: string,
): Promise<{ svc: ServiceDTO } | { refused: Response }> {
	const svc = await ServiceDTO.get(serviceId);
	if (!svc) {
		return { refused: apiError("Not found", 404) };
	}
	const reason = ImageVersionService.unsupportedReason(svc);
	return reason ? { refused: apiError(reason) } : { svc };
}
