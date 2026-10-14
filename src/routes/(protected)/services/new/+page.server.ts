import { fail, redirect } from "@sveltejs/kit";
import { buildCacheChoice } from "#lib/build-cache.js";
import { config, serviceDomain } from "#lib/config.js";
import { HOST_VOLUME_PREFIX } from "#lib/constants.js";
import { BuildCacheRegistryDTO } from "#lib/dto/build-cache-registry-dto.js";
import { NotificationDTO } from "#lib/dto/notification-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { ServiceVolumeDTO } from "#lib/dto/service-volume-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { TemplateDTO } from "#lib/dto/template-dto.js";
import { TemplateLinkDTO } from "#lib/dto/template-link-dto.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { serviceDomainConflicts } from "#lib/server/hostname-owner.js";
import {
	type CreateServiceInput,
	createServiceSchema,
	parseEnvVars,
} from "#lib/server/validation/service.js";
import { defaultHostname } from "#lib/service-domains.js";
import { CapacityService } from "#lib/services/capacity.service.js";
import { DeploymentService } from "#lib/services/deploy.service.js";
import { DockerService } from "#lib/services/docker.service.js";
import { GitWebhookService } from "#lib/services/git-webhook.service.js";
import { encryptSecret } from "#lib/services/secrets.js";
import {
	buildTemplateLinkContext,
	createLinkedServices,
	createStackForLinkedServices,
	freeTemplatePorts,
	resolveEnvVarsWithLinks,
	templateHostAccessRefusal,
} from "#lib/services/template-links.js";
import {
	fillSecretInEnv,
	fillSecretInRuntime,
	generateTemplateSecret,
	secretEnvKeysOf,
	submittedSecret,
} from "#lib/template-secrets.js";
import { fillUrlInEnv } from "#lib/template-url.js";
import { resolve } from "$app/paths";

const logger = new Logger("Services");

const NEW_VOLUME = "new";

interface VolumeMountInput {
	containerPath: string;
	newName: string;
	readOnly: boolean;
	volumeId: string;
}

function buildSourceFields(input: CreateServiceInput, slug: string) {
	if (input.buildSource !== "git") {
		return {
			autoDeployOnPush: false,
			gitBakeFile: null,
			gitBuildTarget: null,
			gitBuildContext: null,
			gitBuildMethod: "dockerfile" as const,
			gitDockerfilePath: null,
			gitProviderId: null,
			gitRef: null,
			gitRepo: null,
			gitUrl: null,
			image: input.image as string,
			tag: input.tag || "latest",
		};
	}
	return {
		autoDeployOnPush: input.autoDeployOnPush,
		gitBakeFile: input.gitBakeFile || null,
		gitBuildTarget: input.gitBuildTarget || null,
		gitBuildContext: input.gitBuildContext || null,
		gitBuildMethod: input.gitBuildMethod,
		gitDockerfilePath: input.gitDockerfilePath || null,
		gitProviderId: (input.gitRepo && input.gitProviderId) || null,
		gitRef: input.gitRef || null,
		gitRepo: (input.gitProviderId && input.gitRepo) || null,
		gitUrl: input.gitUrl || null,
		image: `homerun-build-${slug}`,
		tag: "pending",
	};
}

/** The type and icon a service created from `template` starts with, none without one. */
/**
 * The runtime options a service created from `template` in the wizard starts
 * with: the template's own, its `{{secret}}` filled with the password the form
 * submitted for it (the operator may have changed the generated one), or a
 * fresh one when the form had none.
 */
function wizardRuntime(
	template: TemplateDTO | null,
	envVars: Record<string, string>,
) {
	if (!template) {
		return undefined;
	}
	const secret =
		submittedSecret(template.toJSON().envVars ?? {}, envVars) ??
		generateTemplateSecret();
	return fillSecretInRuntime(template.runtimeOptions, secret);
}

/** The template's published ports still free on this host, none without a template or under host networking. */
function wizardPorts(
	template: TemplateDTO | null,
	networkMode: "bridge" | "host",
) {
	return template && networkMode !== "host"
		? freeTemplatePorts(template.publishedPorts)
		: [];
}

function templateIdentity(template: TemplateDTO | null): {
	category: string | null;
	icon: string | null;
} {
	const row = template?.toJSON();
	return { category: row?.category ?? null, icon: row?.icon ?? null };
}

export const load = async ({ url, parent, locals }) => {
	const { user } = await parent();
	const stackId = url.searchParams.get("stackId");
	const templateId = url.searchParams.get("templateId");

	const stackRow = stackId ? await StackDTO.get(stackId) : null;
	const stack = stackRow ? stackId : null;
	const template = templateId ? await TemplateDTO.get(templateId) : null;
	const [
		gitProviders,
		cacheRegistries,
		templateLinks,
		existing,
		volumes,
		stacks,
	] = await Promise.all([
		connectedGitProviders(user.id),
		BuildCacheRegistryDTO.list(),
		template ? TemplateLinkDTO.listForTemplate(template.id) : [],
		ServiceDTO.list(),
		StorageVolumeDTO.list(),
		StackDTO.list(),
	]);

	return {
		baseDomain: config.baseDomain,
		serviceDomain: serviceDomain(),
		buildCacheRegistries: cacheRegistries.map((r) => r.toJSON()),
		builtinCacheRunning: await DockerService.imageMirrorRunning().catch(
			() => false,
		),
		linkableServices: existing.map((svc) => ({
			command: svc.command,
			containerPort: svc.containerPort,
			envVars: svc.envVars ?? {},
			id: svc.id,
			image: svc.image,
			name: svc.name,
			slug: svc.slug,
			stackId: svc.stackId,
		})),
		connectedGitProviders: gitProviders,
		stackId: stack,
		stackSlug: stackRow?.slug ?? null,
		stacks: stacks.map((row) => ({ id: row.id, name: row.name })),
		template: template
			? {
					...template.toJSON(),
					envVars: fillSecretInEnv(
						template.toJSON().envVars ?? {},
						generateTemplateSecret(),
					),
				}
			: null,
		templateHostAccessRefusal:
			template && !can(locals.permissions, "system", "write")
				? templateHostAccessRefusal(
						template,
						templateLinks.map((l) => ({
							runtime: l.linkedTemplateRuntime,
							templateName: l.linkedTemplateName,
						})),
						false,
					)
				: null,
		templateLinks: templateLinks.map((l) => ({
			alias: l.link.alias,
			icon: l.linkedTemplateIcon,
			name: l.linkedTemplateName,
		})),
		volumes: volumes.map((v) => ({
			id: v.id,
			kind: v.kind,
			name: v.name,
			source: v.source,
		})),
	};
};

async function prepareLinkedStack(
	formData: FormData,
	user: { hostAccess: boolean; id: string },
	primary: { name: string; stackId: string | null; slug: string },
) {
	const userId = user.id;
	const templateId = (formData.get("templateId") as string | null) || null;
	const template = templateId ? await TemplateDTO.get(templateId) : null;
	const links = template
		? await buildTemplateLinkContext(template.id, primary.slug)
		: [];
	const refusal = template
		? templateHostAccessRefusal(template, links, user.hostAccess)
		: null;
	if (refusal) {
		return {
			failure: fail(403, {
				error: refusal,
				values: Object.fromEntries(formData),
			}),
		} as const;
	}

	const stackId =
		links.length > 0 && !primary.stackId
			? await createStackForLinkedServices(primary.name, userId)
			: primary.stackId;

	return { links, stackId, template };
}

async function finishLinkedStack(
	links: Awaited<ReturnType<typeof buildTemplateLinkContext>>,
	stackId: string | null,
	userId: string,
	primaryServiceId: string,
): Promise<ServiceDTO[]> {
	if (links.length === 0 || !stackId) {
		return [];
	}
	const linkedServices = await createLinkedServices(links, {
		stackId,
		userId,
	});
	logger.info(
		`Linked services created: primary=${primaryServiceId} count=${linkedServices.length} user=${userId}`,
	);
	for (const linked of linkedServices) {
		NotificationDTO.notify({
			message: `"${linked.name}" was created.`,
			serviceId: linked.id,
			type: "service_created",
		});
	}
	return linkedServices;
}

/** The uniqueness checks a new service can fail on, as one guard: its slug, and its default hostname and domain while publicly routed. */
async function takenFieldFailure(
	input: { dnsResolvable: boolean; domain?: string; slug: string },
	stackId: string | null,
	formData: FormData,
) {
	const errors: Record<string, string[]> = {};
	if (await ServiceDTO.slugTaken(input.slug)) {
		errors.slug = ["That slug is already in use."];
	}
	const stackSlug = stackId ? (await StackDTO.get(stackId))?.slug : null;
	const conflicts = input.dnsResolvable
		? await serviceDomainConflicts([
				defaultHostname(input.slug, stackSlug, serviceDomain()),
				...(input.domain ? [input.domain] : []),
			])
		: [];
	for (const conflict of conflicts) {
		errors[conflict.entry === input.domain ? "domain" : "slug"] = [
			`${conflict.entry} is already routed to ${conflict.owner.label}.`,
		];
	}
	if (Object.keys(errors).length === 0) {
		return null;
	}
	return {
		failure: fail(400, { errors, values: Object.fromEntries(formData) }),
	} as const;
}

/**
 * Reads the Volumes step's parallel `volume*` fields into one mount per row,
 * skipping rows left entirely blank. Returns an error message instead when a
 * row is half filled or its mount path isn't absolute.
 */
function parseVolumeMounts(
	formData: FormData,
): { mounts: VolumeMountInput[] } | { error: string } {
	const ids = formData.getAll("volumeId").map(String);
	const names = formData.getAll("volumeNewName").map(String);
	const paths = formData.getAll("volumeContainerPath").map(String);
	const readOnly = formData.getAll("volumeReadOnly").map(String);
	const mounts: VolumeMountInput[] = [];
	for (const [i, volumeId] of ids.entries()) {
		const containerPath = (paths[i] ?? "").trim();
		if (!(volumeId || containerPath)) {
			continue;
		}
		if (!(volumeId && containerPath)) {
			return { error: "Every volume needs both a volume and a mount path." };
		}
		if (!containerPath.startsWith("/")) {
			return {
				error: `Mount path "${containerPath}" must be absolute (start with /).`,
			};
		}
		mounts.push({
			containerPath,
			newName: (names[i] ?? "").trim(),
			readOnly: readOnly[i] === "on",
			volumeId,
		});
	}
	return { mounts };
}

/**
 * Mounts each wizard volume row into the new service, first creating the
 * StorageVolume for a "new" row (named `<slug>-data` when left blank) or for
 * a Docker volume on this machine Homerun hadn't registered yet.
 */
async function attachVolumeMounts(
	mounts: VolumeMountInput[],
	svc: ServiceDTO,
	userId: string,
) {
	await Promise.all(
		mounts.map(async (mount, i) => {
			const vol = await resolveMountVolume(mount, svc.slug, i, userId);
			if (!vol) {
				logger.warn(
					`Volume not found, skipped: service=${svc.id} volume=${mount.volumeId}`,
				);
				return;
			}
			await ServiceVolumeDTO.attach({
				containerPath: mount.containerPath,
				readOnly: mount.readOnly,
				serviceId: svc.id,
				volumeId: vol.id,
			});
		}),
	);
}

/**
 * The submitted env vars with `{{alias}}` tokens resolved against the
 * template's linked services and `{{url}}` filled with the service's public
 * URL: its custom domain when one was given, else its default hostname.
 */
async function formEnvVars(
	formData: FormData,
	links: Awaited<ReturnType<typeof buildTemplateLinkContext>>,
	target: { domain: string | undefined; slug: string; stackId: string | null },
): Promise<Record<string, string>> {
	const stackSlug = target.stackId
		? (await StackDTO.get(target.stackId))?.slug
		: null;
	const host =
		target.domain || defaultHostname(target.slug, stackSlug, serviceDomain());
	return fillUrlInEnv(
		links.length > 0
			? resolveEnvVarsWithLinks(parseEnvVars(formData), links)
			: parseEnvVars(formData),
		`https://${host}`,
	);
}

/** The StorageVolume a wizard row points at, created on the spot when the row asks for a new or host volume. */
function resolveMountVolume(
	mount: VolumeMountInput,
	slug: string,
	index: number,
	userId: string,
) {
	if (mount.volumeId === NEW_VOLUME) {
		const name =
			mount.newName || (index === 0 ? `${slug}-data` : `${slug}-data-${index}`);
		return StorageVolumeDTO.create({
			description: `Created with ${slug}`,
			kind: "volume",
			name,
			source: name,
			userId,
		});
	}
	if (mount.volumeId.startsWith(HOST_VOLUME_PREFIX)) {
		const name = mount.volumeId.slice(HOST_VOLUME_PREFIX.length);
		return StorageVolumeDTO.create({
			description: "Imported from this machine",
			kind: "volume",
			name,
			source: name,
			userId,
		});
	}
	return StorageVolumeDTO.get(mount.volumeId);
}

/** Logs and notifies a service the wizard just created. */
function announceCreated(
	svc: ServiceDTO,
	input: CreateServiceInput,
	userId: string,
) {
	logger.info(
		`Service created: service=${svc.id} slug=${input.slug} source=${input.buildSource} user=${userId}`,
	);
	NotificationDTO.notify({
		message: `"${svc.name}" was created.`,
		serviceId: svc.id,
		type: "service_created",
	});
}

async function createServiceFromForm(
	formData: FormData,
	user: { hostAccess: boolean; id: string },
) {
	const userId = user.id;
	const rawStackId = formData.get("stackId") as string | null;
	const initialStackId =
		rawStackId && (await StackDTO.get(rawStackId)) ? rawStackId : null;
	const result = createServiceSchema.safeParse(Object.fromEntries(formData));

	if (!result.success) {
		return {
			failure: fail(400, {
				errors: result.error.flatten().fieldErrors,
				values: Object.fromEntries(formData),
			}),
		} as const;
	}

	const input = result.data;

	const volumes = parseVolumeMounts(formData);
	if ("error" in volumes) {
		return {
			failure: fail(400, {
				errors: { volumes: [volumes.error] },
				values: Object.fromEntries(formData),
			}),
		} as const;
	}
	if (input.authRequired && !config.auth.origin) {
		return {
			failure: fail(400, {
				errors: {
					authRequired: [
						"Set the Dashboard URL under Settings → General first : the login wall sends visitors to this instance's sign-in page, so Homerun has to know its own public URL.",
					],
				},
				values: Object.fromEntries(formData),
			}),
		} as const;
	}

	const taken = await takenFieldFailure(input, initialStackId, formData);
	if (taken) {
		return taken;
	}

	const prepared = await prepareLinkedStack(formData, user, {
		name: input.name,
		stackId: initialStackId,
		slug: input.slug,
	});
	if ("failure" in prepared) {
		return { failure: prepared.failure } as const;
	}
	const { links, stackId, template } = prepared;

	const envVars = await formEnvVars(formData, links, {
		domain: input.domain,
		slug: input.slug,
		stackId,
	});

	const svc = await ServiceDTO.create({
		...templateIdentity(template),
		authRequired: input.authRequired,
		domains: input.domain ? [input.domain] : [],
		networkMode: input.networkMode,
		portProtocol: input.portProtocol,
		...buildCacheChoice(input),
		buildSource: input.buildSource,
		containerPort: input.containerPort,
		cpuLimit: input.cpuLimit || null,
		dnsResolvable: input.dnsResolvable,
		envVars,
		secretEnvKeys: secretEnvKeysOf(template?.toJSON().envVars ?? {}).filter(
			(key) => key in envVars,
		),
		healthcheckCommand:
			input.healthcheckCommand || template?.healthcheckCommand || null,
		memoryLimitMb: input.memoryLimitMb ?? null,
		name: input.name,
		publishedPorts: await wizardPorts(template, input.networkMode),
		stackId,
		registryPasswordEnc: input.registryPassword
			? encryptSecret(input.registryPassword)
			: null,
		registryUrl: input.registryUrl || null,
		registryUsername: input.registryUsername || null,
		restartPolicy: input.restartPolicy,
		runtime: wizardRuntime(template, envVars),
		slug: input.slug,
		userId,
		...buildSourceFields(input, input.slug),
	});

	await GitWebhookService.sync(svc, {
		gitProviderId: null,
		gitRepo: null,
		gitWebhookId: null,
	});

	await attachVolumeMounts(volumes.mounts, svc, userId);

	announceCreated(svc, input, userId);

	const linkedServices = await finishLinkedStack(
		links,
		stackId,
		userId,
		svc.id,
	);

	return { linkedServices, stackId, svc } as const;
}

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}

		const formData = await request.formData();
		const full = await CapacityService.refusal();
		if (full) {
			return fail(409, { error: full, values: Object.fromEntries(formData) });
		}
		const result = await createServiceFromForm(formData, {
			hostAccess: can(locals.permissions, "system", "write"),
			id: locals.user.id,
		});
		if ("failure" in result) {
			return result.failure;
		}

		redirect(
			303,
			result.stackId && result.linkedServices.length > 0
				? `${resolve("stacks")}/${result.stackId}`
				: `${resolve("services")}/${result.svc.id}`,
		);
	},

	createAndDeploy: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}

		const formData = await request.formData();
		const result = await createServiceFromForm(formData, {
			hostAccess: can(locals.permissions, "system", "write"),
			id: locals.user.id,
		});
		if ("failure" in result) {
			return result.failure;
		}

		await DeploymentService.enqueueStackDeploy(
			result.svc,
			result.linkedServices,
			locals.user.id,
		);

		redirect(
			303,
			result.stackId && result.linkedServices.length > 0
				? `${resolve("stacks")}/${result.stackId}`
				: `${resolve("services")}/${result.svc.id}`,
		);
	},
};
