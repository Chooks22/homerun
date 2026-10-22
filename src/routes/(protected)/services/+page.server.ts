import { fail } from "@sveltejs/kit";
import { config, serviceDomain } from "#lib/config.js";
import { ServiceDependencyDTO } from "#lib/dto/service-dependency-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { Logger } from "#lib/logger.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { loadServiceListing } from "#lib/server/service-listing.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { dependencyLayers } from "#lib/service-graph.js";
import {
	buildLinkEnv,
	defaultUrlKey,
	defaultVarPrefix,
	detectLinkEngine,
	linkRoles,
} from "#lib/service-link.js";
import { ServiceLifecycleService } from "#lib/services/service-lifecycle.service.js";
import { uniqueSlug } from "#lib/slug.js";

const logger = new Logger("Services");

const SLUG_STRIP_RE = /[^a-z0-9]+/g;
const SLUG_TRIM_RE = /^-+|-+$/g;

/**
 * Puts two linked services on one stack network : into whichever stack
 * one of them is already in, or a new one named after the first. Two services
 * only actually reach each other by slug once they share one.
 */
async function groupPair(
	svc: ServiceDTO,
	target: ServiceDTO,
	userId: string,
): Promise<string> {
	const existing = svc.stackId ?? target.stackId;
	const stackId =
		existing ??
		(
			await StackDTO.create({
				name: svc.name,
				slug: await uniqueSlug(slugify(svc.name) || "stack", (slug) =>
					StackDTO.slugTaken(slug),
				),
				userId,
			})
		).id;

	await Promise.all(
		[svc, target]
			.filter((row) => row.stackId !== stackId)
			.map((row) => row.update({ stackId })),
	);
	return stackId;
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(SLUG_STRIP_RE, "-")
		.replace(SLUG_TRIM_RE, "")
		.slice(0, 63);
}

const BULK_OPS = ["delete", "restart", "start", "stop"] as const;

type BulkOp = (typeof BULK_OPS)[number];

const OP_PAST_TENSE: Record<BulkOp, string> = {
	delete: "deleted",
	restart: "restarted",
	start: "started",
	stop: "stopped",
};

async function runOp(
	op: BulkOp,
	svc: ServiceDTO,
	userId: string,
	deleteVolumes = false,
) {
	if (op === "delete") {
		await ServiceLifecycleService.deleteService(svc, { deleteVolumes });
	} else if (op === "start") {
		await ServiceLifecycleService.startService(svc);
	} else if (op === "stop") {
		await ServiceLifecycleService.stopService(svc);
	} else {
		await ServiceLifecycleService.restartService(svc);
	}
	logger.info(`Service ${OP_PAST_TENSE[op]}: service=${svc.id} user=${userId}`);
}

async function runSingle(op: BulkOp, formData: FormData, userId: string) {
	const serviceId = formData.get("serviceId");
	if (typeof serviceId !== "string" || !serviceId) {
		return fail(400, { error: "Missing service id." });
	}

	const svc = await ServiceDTO.get(serviceId);
	if (!svc) {
		return fail(404, { error: "Service not found." });
	}

	try {
		await runOp(op, svc, userId, formData.get("deleteVolumes") === "true");
	} catch (error) {
		return fail(400, {
			error:
				error instanceof Error ? error.message : `Couldn't ${op} this service.`,
		});
	}
	return { success: true };
}

function parseBulk(formData: FormData) {
	const op = formData.get("op");
	if (typeof op !== "string" || !BULK_OPS.includes(op as BulkOp)) {
		return { error: "Unknown bulk action." } as const;
	}
	const ids = formData
		.getAll("serviceId")
		.filter((v): v is string => typeof v === "string" && v.length > 0);
	if (ids.length === 0) {
		return { error: "No services selected." } as const;
	}
	return { ids, op: op as BulkOp } as const;
}

/**
 * The selected services grouped into batches that run one after another:
 * dependencies before the services that need them for a start or restart,
 * the other way round for a stop, and everything at once for a delete.
 */
async function bulkLayers(
	op: BulkOp,
	services: ServiceDTO[],
): Promise<ServiceDTO[][]> {
	if (op === "delete") {
		return [services];
	}
	const byId = new Map(services.map((svc) => [svc.id, svc]));
	const layers = dependencyLayers(
		services.map((svc) => svc.id),
		await ServiceDependencyDTO.map(),
	);
	return (op === "stop" ? layers : layers.reverse()).map((layer) =>
		layer.flatMap((id) => byId.get(id) ?? []),
	);
}

async function runBulk(formData: FormData, userId: string) {
	const parsed = parseBulk(formData);
	if ("error" in parsed) {
		return fail(400, { error: parsed.error });
	}

	const found = (
		await Promise.all(parsed.ids.map((id) => ServiceDTO.get(id)))
	).filter((svc): svc is ServiceDTO => svc !== null);

	const settled: PromiseSettledResult<void>[] = [];
	for (const layer of await bulkLayers(parsed.op, found)) {
		// oxlint-disable-next-line no-await-in-loop -- each layer waits for the services the next one depends on
		const results = await Promise.allSettled(
			layer.map((svc) =>
				runOp(parsed.op, svc, userId, formData.get("deleteVolumes") === "true"),
			),
		);
		settled.push(...results);
	}

	const succeeded = settled.filter((r) => r.status === "fulfilled").length;
	const failed = parsed.ids.length - succeeded;

	if (succeeded === 0) {
		const firstRejection = settled.find((r) => r.status === "rejected");
		return fail(400, {
			error:
				firstRejection?.reason instanceof Error
					? firstRejection.reason.message
					: `Couldn't ${parsed.op} the selected services.`,
		});
	}

	return { failed, op: parsed.op, succeeded, success: true };
}

export const load = async ({ parent, url }) => {
	const { preferences } = await parent();
	const query = parseListQuery(
		url,
		{ filterKeys: ["status", "stack"], sortKeys: sortKeysOf(BASE_SORTS) },
		preferences.perPage,
	);
	const treeView = url.searchParams.get("view") === "tree";
	return {
		baseDomain: config.baseDomain,
		filtered: query.active,
		listing: loadServiceListing(query, treeView),
		page: query.page,
		perPage: query.perPage,
		serviceDomain: serviceDomain(),
		treeView,
	};
};

export const actions = {
	/**
	 * Writes the connection variables for `targetId` into `serviceId`'s own
	 * env, the same values the wizard's link picker would have produced. The
	 * context menu's "Link to…" : a service that needs a database shouldn't
	 * mean retyping a URL that Homerun can derive. Every link also records
	 * the consumer's dependency on the provider (start order), and format
	 * `none` records only that.
	 */
	link: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const serviceId = formData.get("serviceId") as string | null;
		const targetId = formData.get("targetId") as string | null;
		const format = (formData.get("format") as string | null) ?? "url";
		if (!(serviceId && targetId)) {
			return fail(400, { error: "Pick a service to link to." });
		}

		const [source, picked] = await Promise.all([
			ServiceDTO.get(serviceId),
			ServiceDTO.get(targetId),
		]);
		if (!(source && picked)) {
			return fail(404, { error: "Service not found." });
		}
		const { consumer: svc, provider: target } = linkRoles(source, picked);

		const engine = detectLinkEngine(target.image);
		const linkTarget = {
			command: target.command,
			containerPort: target.containerPort,
			envVars: target.envVars,
			image: target.image,
			name: target.name,
			slug: target.slug,
		};
		const dependencyOnly = format === "none";
		const rows = dependencyOnly
			? []
			: buildLinkEnv({
					format:
						format === "vars" || format === "jdbc" || format === "postgresql"
							? format
							: "url",
					prefix: defaultVarPrefix(engine, linkTarget),
					target: linkTarget,
					urlKey: defaultUrlKey(engine, linkTarget),
				});

		try {
			await ServiceDependencyDTO.add(svc.id, target.id);
		} catch (error) {
			if (dependencyOnly) {
				return fail(400, {
					error: error instanceof Error ? error.message : "Couldn't link them.",
				});
			}
			logger.warn(
				`Link recorded without a dependency: service=${svc.id} target=${target.id}`,
				error,
			);
		}
		if (rows.length > 0) {
			await svc.update({
				envVars: {
					...svc.envVars,
					...Object.fromEntries(rows.map((row) => [row.key, row.value])),
				},
			});
		}

		const groupedInto =
			formData.get("alsoGroup") === "on"
				? await groupPair(svc, target, locals.user.id)
				: null;

		logger.info(
			`Service linked: service=${svc.id} target=${target.id} stack=${groupedInto ?? "none"} user=${locals.user.id}`,
		);
		return {
			consumer: svc.name,
			grouped: groupedInto !== null,
			linked: rows.map((row) => row.key),
			success: true,
		};
	},

	/** Moves a service into a stack, creating one when `newStackName` is given. */
	group: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const serviceIds = formData.getAll("serviceId").map(String).filter(Boolean);
		const stackId = (formData.get("stackId") as string | null) || null;
		const newStackName =
			(formData.get("newStackName") as string | null)?.trim() || null;

		if (serviceIds.length === 0) {
			return fail(400, { error: "Nothing to move." });
		}

		let targetStackId = stackId;
		if (newStackName) {
			const slug = slugify(newStackName);
			if (await StackDTO.slugTaken(slug)) {
				return fail(400, { error: "A stack with that slug already exists." });
			}
			const stack = await StackDTO.create({
				name: newStackName,
				slug,
				userId: locals.user.id,
			});
			targetStackId = stack.id;
		}

		const services = await Promise.all(
			serviceIds.map((id) => ServiceDTO.get(id)),
		);
		await Promise.all(
			services
				.filter((svc) => svc !== null)
				.map((svc) => svc.update({ stackId: targetStackId })),
		);
		logger.info(
			`Services grouped: services=${serviceIds.join(",")} stack=${targetStackId ?? "none"} user=${locals.user.id}`,
		);
		return { grouped: serviceIds.length, success: true };
	},

	bulk: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return runBulk(await request.formData(), locals.user.id);
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return runSingle("delete", await request.formData(), locals.user.id);
	},

	restart: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return runSingle("restart", await request.formData(), locals.user.id);
	},

	start: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return runSingle("start", await request.formData(), locals.user.id);
	},

	stop: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return runSingle("stop", await request.formData(), locals.user.id);
	},
};
