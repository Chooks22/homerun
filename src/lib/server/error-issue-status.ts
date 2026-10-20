import { type ActionFailure, fail } from "@sveltejs/kit";
import { ErrorIssueDTO } from "#lib/dto/error-issue-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import type { IssueStatus } from "#lib/error-tracking/event.js";
import { Logger } from "#lib/logger.js";
import { issueStatusFormSchema } from "#lib/server/validation/error-tracking.js";

const logger = new Logger("ErrorTracking");

/**
 * Sets the status of the issues a status form names (`issueId`, repeated,
 * and `status`), for the Errors list's bulk bar and the board's moves alike.
 * Fails with 404 when the service is gone and 400 when the form is invalid.
 */
export async function changeIssueStatus(
	serviceId: string,
	formData: FormData,
	userId: string,
): Promise<
	| ActionFailure<{ error: string }>
	| ActionFailure<{ errors: Record<string, string[] | undefined> }>
	| { changed: number; status: IssueStatus }
> {
	const svc = await ServiceDTO.get(serviceId);
	if (!svc) {
		return fail(404, { error: "Service not found." });
	}
	const result = issueStatusFormSchema.safeParse({
		issueId: formData.getAll("issueId"),
		status: formData.get("status"),
	});
	if (!result.success) {
		return fail(400, { errors: result.error.flatten().fieldErrors });
	}
	const changed = await ErrorIssueDTO.setStatus(
		svc.id,
		result.data.issueId,
		result.data.status,
	);
	logger.info(
		`Error issues marked ${result.data.status}: service=${svc.id} count=${changed} user=${userId}`,
	);
	return { changed, status: result.data.status };
}
