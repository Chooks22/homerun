import { error, fail } from "@sveltejs/kit";
import { ErrorEventDTO } from "#lib/dto/error-event-dto.js";
import { ErrorIssueDTO } from "#lib/dto/error-issue-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { TraceSpanDTO } from "#lib/dto/trace-span-dto.js";
import { frameLinks } from "#lib/error-tracking/frame-links.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { issueStatusFormSchema } from "#lib/server/validation/error-tracking.js";
import { ErrorTrackingService } from "#lib/services/error-tracking.service.js";
import { normalizeTraceId } from "#lib/tracing/list.js";
import { resolve } from "$app/paths";

const logger = new Logger("ErrorTracking");

export const load = async ({ params, parent }) => {
	const { service } = await parent();
	const issue = await ErrorIssueDTO.getForService(service.id, params.issueId);
	if (!issue) {
		error(404, "Issue not found");
	}
	const event = await ErrorEventDTO.getForIssue(
		issue.id,
		params.eventId ?? null,
	);
	if (params.eventId && !event) {
		error(404, "Event not found");
	}
	const payload = event?.toJSON().payload ?? null;
	const traceId = normalizeTraceId(payload?.contexts.trace?.trace_id);
	const [neighbours, usersAffected, source, traced] = await Promise.all([
		event?.neighbours() ?? null,
		issue.usersAffected(),
		payload ? ErrorTrackingService.sourceRepo(service, payload) : null,
		traceId ? TraceSpanDTO.inScope({ serviceId: service.id }, traceId) : false,
	]);
	return {
		event: event ? { ...event.toJSON(), payload: undefined } : null,
		issue: issue.toJSON(),
		links: payload ? frameLinks(payload, source) : {},
		neighbours,
		payload,
		source,
		traceHref:
			traced && traceId
				? resolve(
						"/(protected)/services/[serviceId]/observability/traces/[traceId]",
						{ serviceId: service.id, traceId },
					)
				: null,
		usersAffected,
	};
};

export const actions = {
	status: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const formData = await request.formData();
		const result = issueStatusFormSchema.safeParse({
			issueId: [params.issueId],
			status: formData.get("status"),
		});
		if (!result.success) {
			return fail(400, { errors: result.error.flatten().fieldErrors });
		}
		await ErrorIssueDTO.setStatus(
			svc.id,
			result.data.issueId,
			result.data.status,
		);
		logger.info(
			`Error issue marked ${result.data.status}: service=${svc.id} issue=${params.issueId} user=${locals.user.id}`,
		);
		return { status: result.data.status };
	},
};
