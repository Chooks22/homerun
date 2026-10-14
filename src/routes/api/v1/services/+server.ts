import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { TemplateDTO } from "#lib/dto/template-dto.js";
import { HOST_ACCESS_MESSAGE, hostAccessRequested } from "#lib/host-access.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { serviceApiJson } from "#lib/server/api-json.js";
import { jsonPage, parseApiListQuery } from "#lib/server/api-pagination.js";
import {
	type CreateServiceApiInput,
	createServiceApiBody,
	createServiceFromTemplateApiBody,
	type ServiceSettingsInput,
} from "#lib/server/validation/api.js";
import { CapacityService } from "#lib/services/capacity.service.js";
import { attachDefaultDataVolume } from "#lib/services/default-volume.js";
import { GitWebhookService } from "#lib/services/git-webhook.service.js";
import { encryptSecret } from "#lib/services/secrets.js";
import { ServiceLifecycleService } from "#lib/services/service-lifecycle.service.js";
import {
	ServiceSettingsError,
	ServiceSettingsService,
} from "#lib/services/service-settings.service.js";
import { createServiceFromTemplate } from "#lib/services/template-links.js";

const logger = new Logger("API");

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const paged = await ServiceDTO.listWithStackNamesPaged(
		parseApiListQuery(url),
		{ includePreviews: true },
	);
	return jsonPage(
		paged.items.map((r) => serviceApiJson(r.service.toJSON())),
		paged,
	);
};

/**
 * Maps the validated API body onto ServiceDTO.create's input, normalizing
 * empty strings to null the way the FormData path does.
 *
 * Real, tested-in-review finding, from this app's own integration test
 * suite (tests/integration/) : buildSource/gitUrl/gitRef/gitBuildContext/
 * gitDockerfilePath were validated by createServiceApiBody but never
 * actually passed to ServiceDTO.create(), so a git-mode POST /services
 * silently created an image-mode service instead (buildSource defaulting
 * to "image", image/tag defaulting to "" since a git-mode request doesn't
 * send them), which then failed at deploy time trying to pull an empty
 * image ref (the daemon surfaces that as a confusing
 * "Get \"http:\": http: no Host in request URL" 500, nothing about a
 * missing image). The REST API and the CLI built on it couldn't create a
 * git-build service at all before this fix.
 */
function toCreateInput(
	input: CreateServiceApiInput,
	stackId: string | null,
	userId: string,
) {
	return {
		...toSourceInput(input),
		authRequired: input.authRequired,
		containerPort: input.containerPort,
		cpuLimit: input.cpuLimit || null,
		dnsResolvable: input.dnsResolvable,
		envVars: input.envVars,
		memoryLimitMb: input.memoryLimitMb ?? null,
		name: input.name,
		stackId,
		pullPolicy: input.pullPolicy,
		restartPolicy: input.restartPolicy,
		runtime: {
			capAdd: input.capAdd,
			command: input.command ?? null,
			devices: input.devices,
			entrypoint: input.entrypoint ?? null,
			envFiles: input.envFiles,
			labels: input.labels,
			privileged: input.privileged,
			runAsUser: input.runAsUser ?? null,
		},
		slug: input.slug,
		userId,
	};
}

/** Where the image comes from : the git-build fields plus registry coordinates. */
function toSourceInput(input: CreateServiceApiInput) {
	return {
		autoDeployOnPush: input.autoDeployOnPush,
		buildSource: input.buildSource,
		gitBakeFile: input.gitBakeFile || null,
		gitBuildTarget: input.gitBuildTarget || null,
		gitBuildContext: input.gitBuildContext || null,
		gitBuildMethod: input.gitBuildMethod,
		gitDockerfilePath: input.gitDockerfilePath || null,
		gitProviderId: input.gitProviderId || null,
		gitRef: input.gitRef || null,
		gitRepo: input.gitRepo || null,
		gitUrl: input.gitUrl || null,
		image: input.image ?? "",
		registryPasswordEnc: input.registryPassword
			? encryptSecret(input.registryPassword)
			: null,
		registryUrl: input.registryUrl || null,
		registryUsername: input.registryUsername || null,
		tag: input.tag ?? "",
	};
}

/** The fields of a create body `ServiceDTO.create` doesn't take, applied as settings once the row exists. */
function extraSettings(input: CreateServiceApiInput): ServiceSettingsInput {
	const created = new Set<string>([
		...Object.keys(toCreateInput(input, null, "")),
		...Object.keys(toCreateInput(input, null, "").runtime),
		"registryPassword",
		"stackId",
	]);
	created.delete("authRequired");
	return Object.fromEntries(
		Object.entries(input).filter(
			([key, value]) => value !== undefined && !created.has(key),
		),
	) as ServiceSettingsInput;
}

/**
 * Creates the service a template describes (and its linked services) in
 * `stackId`, then applies the rest of the body as settings. A refused
 * setting deletes what was created.
 */
async function createFromTemplate(
	input: ServiceSettingsInput & { stackId?: string | null; templateId: string },
	actor: { hostAccess: boolean; userId: string },
): Promise<Response> {
	const template = await TemplateDTO.get(input.templateId);
	if (!template) {
		return Response.json({ error: "Template not found." }, { status: 404 });
	}
	const full = await CapacityService.refusal();
	if (full) {
		return Response.json({ error: full }, { status: 409 });
	}
	const stackId =
		input.stackId && (await StackDTO.get(input.stackId)) ? input.stackId : null;
	const created = await createServiceFromTemplate(template, {
		...actor,
		stackId,
	});
	if ("refusal" in created) {
		return Response.json({ error: created.refusal }, { status: 403 });
	}
	const { stackId: _stack, templateId: _template, ...settings } = input;
	try {
		await ServiceSettingsService.apply(created.svc, settings, actor);
	} catch (err) {
		await ServiceLifecycleService.deleteService(created.svc, { force: true });
		if (err instanceof ServiceSettingsError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		throw err;
	}
	logger.info(
		`Service created from a template via API: service=${created.svc.id} template=${template.id} user=${actor.userId}`,
	);
	return Response.json(serviceApiJson(created.svc.toJSON()), { status: 201 });
}

export const POST = async ({ request, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const actor = {
		hostAccess: can(locals.permissions, "system", "write"),
		userId: locals.user.id,
	};

	const body = await request.json().catch(() => null);
	if (body && typeof body === "object" && "templateId" in body) {
		const fromTemplate = createServiceFromTemplateApiBody.safeParse(body);
		if (!fromTemplate.success) {
			return Response.json(
				{ error: "Invalid request body", issues: fromTemplate.error.flatten() },
				{ status: 400 },
			);
		}
		return await createFromTemplate(fromTemplate.data, actor);
	}
	const result = createServiceApiBody.safeParse(body);
	if (!result.success) {
		return Response.json(
			{ error: "Invalid request body", issues: result.error.flatten() },
			{ status: 400 },
		);
	}
	const input = result.data;

	if (!actor.hostAccess && hostAccessRequested(input)) {
		return Response.json({ error: HOST_ACCESS_MESSAGE }, { status: 403 });
	}

	if (await ServiceDTO.slugTaken(input.slug)) {
		return Response.json(
			{ error: "That slug is already in use." },
			{ status: 409 },
		);
	}

	const full = await CapacityService.refusal();
	if (full) {
		return Response.json({ error: full }, { status: 409 });
	}

	const stackId =
		input.stackId && (await StackDTO.get(input.stackId)) ? input.stackId : null;

	const svc = await ServiceDTO.create(
		toCreateInput(input, stackId, locals.user.id),
	);
	try {
		await ServiceSettingsService.apply(svc, extraSettings(input), actor);
	} catch (err) {
		await ServiceLifecycleService.deleteService(svc, { force: true });
		if (err instanceof ServiceSettingsError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		throw err;
	}

	await attachDefaultDataVolume(svc, locals.user.id);

	await GitWebhookService.sync(svc, {
		gitProviderId: null,
		gitRepo: null,
		gitWebhookId: null,
	});

	logger.info(
		`Service created via API: service=${svc.id} slug=${svc.slug} user=${locals.user.id}`,
	);

	return Response.json(serviceApiJson(svc.toJSON()), { status: 201 });
};
