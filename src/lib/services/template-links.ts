import { serviceDomain } from "#lib/config.js";
import { NotificationDTO } from "#lib/dto/notification-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { TemplateDTO } from "#lib/dto/template-dto.js";
import { TemplateLinkDTO } from "#lib/dto/template-link-dto.js";
import {
	templateHostAccessMessage,
	templatesNeedingHostAccess,
} from "#lib/host-access.js";
import { Logger } from "#lib/logger.js";
import type { PublishedPort } from "#lib/published-ports.js";
import { defaultHostname } from "#lib/service-domains.js";
import { isDatabaseImage } from "#lib/service-link.js";
import type { ServiceRuntimeOptions } from "#lib/service-runtime.js";
import { slugify, stackScopedSlug, uniqueSlug } from "#lib/slug.js";
import {
	fillSecretInEnv,
	fillSecretInRuntime,
	generateTemplateSecret,
	secretEnvKeysOf,
} from "#lib/template-secrets.js";
import { fillUrlInEnv } from "#lib/template-url.js";
import { CapacityService } from "./capacity.service.ts";
import {
	attachDefaultDataVolume,
	attachTemplateVolumes,
} from "./default-volume";
import { DeploymentService } from "./deploy.service";

const logger = new Logger("Templates");

export interface ResolvedTemplateLink {
	alias: string;
	category: string | null;
	containerPort: number;
	cpuLimit: string | null;
	envVars: Record<string, string>;
	icon: string | null;
	image: string;
	memoryLimitMb: number | null;
	publishedPorts: PublishedPort[];
	restartPolicy: string;
	runtime: ServiceRuntimeOptions;
	secretEnvKeys: string[];
	slug: string;
	tag: string;
	templateName: string;
}

/**
 * Substitutes `{{alias}}` (linked service's slug) and `{{alias.KEY}}`
 * (linked service's env var) tokens in `value` using `context`. A token
 * whose alias or key doesn't resolve is left untouched.
 */
export function resolveLinkTokens(
	value: string,
	context: Record<string, { envVars: Record<string, string>; slug: string }>,
): string {
	return value.replace(
		/\{\{([\w-]+)(?:\.([\w-]+))?\}\}/g,
		(match, alias, key) => {
			const linked = context[alias];
			if (!linked) {
				return match;
			}
			if (!key) {
				return linked.slug;
			}
			return linked.envVars[key] ?? match;
		},
	);
}

/**
 * Resolves every service linked to a template into a `ResolvedTemplateLink`,
 * assigning each a unique slug derived from `primarySlug` and the link's
 * alias (checked against `ServiceDTO.slugTaken`, not yet persisted), and its
 * own fresh `{{secret}}`, filled in before the primary template reads its env
 * through `{{alias.KEY}}`.
 */
export async function buildTemplateLinkContext(
	templateId: string,
	primarySlug: string,
): Promise<ResolvedTemplateLink[]> {
	const links = await TemplateLinkDTO.listForTemplate(templateId);
	const resolved: ResolvedTemplateLink[] = [];
	for (const { link, ...linkedTemplate } of links) {
		// oxlint-disable-next-line no-await-in-loop -- each slug must account for the ones already picked earlier in this same batch, none of which are committed to the DB yet
		const slug = await uniqueSlug(
			slugify(`${primarySlug}-${link.alias}`),
			(candidate) => ServiceDTO.slugTaken(candidate),
		);
		const secret = generateTemplateSecret();
		resolved.push({
			alias: link.alias,
			category: linkedTemplate.linkedTemplateCategory,
			containerPort: linkedTemplate.linkedTemplateContainerPort,
			cpuLimit: linkedTemplate.linkedTemplateCpuLimit,
			envVars: fillSecretInEnv(linkedTemplate.linkedTemplateEnvVars, secret),
			icon: linkedTemplate.linkedTemplateIcon,
			image: linkedTemplate.linkedTemplateImage,
			memoryLimitMb: linkedTemplate.linkedTemplateMemoryLimitMb,
			publishedPorts: linkedTemplate.linkedTemplatePublishedPorts,
			restartPolicy: linkedTemplate.linkedTemplateRestartPolicy,
			runtime: fillSecretInRuntime(
				linkedTemplate.linkedTemplateRuntime,
				secret,
			),
			secretEnvKeys: secretEnvKeysOf(linkedTemplate.linkedTemplateEnvVars),
			slug,
			tag: linkedTemplate.linkedTemplateTag,
			templateName: linkedTemplate.linkedTemplateName,
		});
	}
	return resolved;
}

/**
 * The refusal for a non-admin deploying `template` when it or one of its
 * resolved linked companions asks for host-level access, null when the
 * deploy may go ahead.
 */
export function templateHostAccessRefusal(
	template: TemplateDTO,
	links: Pick<ResolvedTemplateLink, "runtime" | "templateName">[],
	hostAccess: boolean,
): string | null {
	if (hostAccess) {
		return null;
	}
	const names = templatesNeedingHostAccess([
		{ ...template.runtimeOptions, name: template.name },
		...links.map((link) => ({ ...link.runtime, name: link.templateName })),
	]);
	return names.length > 0 ? templateHostAccessMessage(names) : null;
}

/**
 * The ports of a template a new service can actually publish: `ports` minus
 * any host port and protocol another service already publishes, each dropped
 * one logged, so deploying the same template twice doesn't fail on a bind.
 */
export async function freeTemplatePorts(
	ports: PublishedPort[],
): Promise<PublishedPort[]> {
	const taken = await Promise.all(
		ports.map((port) => ServiceDTO.publishedPortTaken([port], "")),
	);
	return ports.filter((port, i) => {
		const owner = taken[i];
		if (owner) {
			logger.warn(
				`Template port skipped: host port ${port.hostPort}/${port.protocol} is already published by ${owner.serviceName}`,
			);
		}
		return !owner;
	});
}

/** Resolves every `{{alias}}`/`{{alias.KEY}}` token in `envVars`' values against the given resolved links. */
export function resolveEnvVarsWithLinks(
	envVars: Record<string, string>,
	links: ResolvedTemplateLink[],
): Record<string, string> {
	const context = Object.fromEntries(
		links.map((l) => [l.alias, { envVars: l.envVars, slug: l.slug }]),
	);
	return Object.fromEntries(
		Object.entries(envVars).map(([key, value]) => [
			key,
			resolveLinkTokens(value, context),
		]),
	);
}

/** Creates a new stack (with a unique slug derived from `name`) to hold a template's primary service and its linked services. */
export async function createStackForLinkedServices(
	name: string,
	userId: string,
): Promise<string> {
	const slug = await uniqueSlug(slugify(name), (candidate) =>
		StackDTO.slugTaken(candidate),
	);
	const stack = await StackDTO.create({ name, slug, userId });
	return stack.id;
}

/** Creates one service per resolved template link inside `params.stackId`, not DNS-resolvable by default since these back the primary service. */
export async function createLinkedServices(
	links: ResolvedTemplateLink[],
	params: { stackId: string; userId: string },
): Promise<ServiceDTO[]> {
	const created: ServiceDTO[] = [];
	for (const link of links) {
		// oxlint-disable-next-line no-await-in-loop -- each companion's ports are checked against the services already created before it
		const publishedPorts = await freeTemplatePorts(link.publishedPorts);
		// oxlint-disable-next-line no-await-in-loop -- services are created one at a time so each gets a fresh slug-uniqueness check against the ones already committed
		const svc = await ServiceDTO.create({
			category: link.category,
			containerPort: link.containerPort,
			cpuLimit: link.cpuLimit,
			dnsResolvable: false,
			envVars: link.envVars,
			icon: link.icon,
			memoryLimitMb: link.memoryLimitMb,
			name: link.templateName,
			publishedPorts,
			stackId: params.stackId,
			restartPolicy: link.restartPolicy,
			runtime: link.runtime,
			secretEnvKeys: link.secretEnvKeys,
			slug: link.slug,
			tag: link.tag,
			userId: params.userId,
			image: link.image,
		});
		// oxlint-disable-next-line no-await-in-loop -- attached to the service just created, before the next one
		await attachDefaultDataVolume(svc, params.userId);
		created.push(svc);
	}
	return created;
}

/**
 * Instantiates a template as a real service: resolves its linked services
 * (creating a stack for them if none was given), resolves `{{alias}}` env
 * var tokens against those links, then creates the primary service and its
 * linked services, each carrying its template's runtime options. Returns a
 * refusal without creating anything when a non-admin deploys a template (or
 * a companion) that needs host access.
 */
export async function createServiceFromTemplate(
	template: TemplateDTO,
	params: { hostAccess: boolean; stackId: string | null; userId: string },
): Promise<
	| {
			linkedServices: ServiceDTO[];
			stackId: string | null;
			svc: ServiceDTO;
	  }
	| { refusal: string }
> {
	const { stackId, userId } = params;
	const row = template.toJSON();
	const stackSlug = stackId ? (await StackDTO.get(stackId))?.slug : null;
	const slug = await uniqueSlug(
		stackScopedSlug(stackSlug, slugify(row.name)),
		(candidate) => ServiceDTO.slugTaken(candidate),
	);
	const links = await buildTemplateLinkContext(row.id, slug);
	const refusal = templateHostAccessRefusal(template, links, params.hostAccess);
	if (refusal) {
		return { refusal };
	}

	const finalStackId =
		links.length > 0 && !stackId
			? await createStackForLinkedServices(row.name, userId)
			: stackId;

	const secret = generateTemplateSecret();
	const finalStackSlug =
		finalStackId && finalStackId !== stackId
			? (await StackDTO.get(finalStackId))?.slug
			: stackSlug;
	const envVars = fillUrlInEnv(
		fillSecretInEnv(
			links.length > 0
				? resolveEnvVarsWithLinks(row.envVars ?? {}, links)
				: (row.envVars ?? {}),
			secret,
		),
		`https://${defaultHostname(slug, finalStackSlug, serviceDomain())}`,
	);

	const svc = await ServiceDTO.create({
		category: row.category,
		containerPort: row.containerPort,
		cpuLimit: row.cpuLimit,
		// Same default as the wizard: a datastore template (Postgres, Redis,
		// …) is for its siblings, not for the public internet.
		dnsResolvable: !isDatabaseImage(row.image),
		envVars,
		healthcheckCommand: row.healthcheckCommand,
		icon: row.icon,
		image: row.image,
		memoryLimitMb: row.memoryLimitMb,
		name: row.name,
		publishedPorts: await freeTemplatePorts(template.publishedPorts),
		stackId: finalStackId,
		restartPolicy: row.restartPolicy,
		runtime: fillSecretInRuntime(template.runtimeOptions, secret),
		secretEnvKeys: secretEnvKeysOf(row.envVars ?? {}),
		slug,
		tag: row.tag,
		userId,
	});
	await attachTemplateVolumes(svc, row.volumes, userId);
	await attachDefaultDataVolume(svc, userId);

	const linkedServices =
		links.length > 0 && finalStackId
			? await createLinkedServices(links, {
					stackId: finalStackId,
					userId,
				})
			: [];

	return { linkedServices, stackId: finalStackId, svc };
}

export type QuickDeployResult =
	| { ok: true; stackId: string | null; serviceId: string }
	| { error: string; ok: false; status: number };

/**
 * One-click template deploy: creates the service(s) via
 * `createServiceFromTemplate`, records a "service created" notification for
 * each, and enqueues the stack deploy job.
 *
 * @returns An error result when the template isn't found (404) or needs
 *   host access a non-admin can't grant (403, nothing is created),
 *   otherwise the created service/stack ids.
 */
export async function quickDeployFromTemplate(
	templateId: string,
	params: { hostAccess: boolean; stackId: string | null; userId: string },
): Promise<QuickDeployResult> {
	const { userId } = params;
	const template = await TemplateDTO.get(templateId);
	if (!template) {
		return { error: "Template not found.", ok: false, status: 404 };
	}
	const full = await CapacityService.refusal();
	if (full) {
		return { error: full, ok: false, status: 409 };
	}

	const created = await createServiceFromTemplate(template, params);
	if ("refusal" in created) {
		return { error: created.refusal, ok: false, status: 403 };
	}
	const { linkedServices, stackId: finalStackId, svc } = created;

	logger.info(
		`Quick-deployed from template: template=${templateId} service=${svc.id} user=${userId}`,
	);
	NotificationDTO.notify({
		message: `"${svc.name}" was created.`,
		serviceId: svc.id,
		type: "service_created",
	});

	for (const linked of linkedServices) {
		NotificationDTO.notify({
			message: `"${linked.name}" was created.`,
			serviceId: linked.id,
			type: "service_created",
		});
	}

	await DeploymentService.enqueueStackDeploy(svc, linkedServices, userId);

	return {
		ok: true,
		stackId: linkedServices.length > 0 ? finalStackId : null,
		serviceId: svc.id,
	};
}
