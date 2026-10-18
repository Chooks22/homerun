import { fail, redirect } from "@sveltejs/kit";
import { TemplateDTO } from "#lib/dto/template-dto.js";
import { TemplateLinkDTO } from "#lib/dto/template-link-dto.js";
import { HOST_ACCESS_MESSAGE, hostAccessRequested } from "#lib/host-access.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	parseEnvVars,
	parsePublishedPortsField,
	updateEnvFilesSchema,
	updateRuntimeSchema,
} from "#lib/server/validation/service.js";
import {
	createTemplateSchema,
	parseTags,
} from "#lib/server/validation/template.js";
import { slugify } from "#lib/slug.js";
import { resolve } from "$app/paths";

const logger = new Logger("Templates");

export const load = async ({ parent, locals }) => {
	await parent();

	const templates = await TemplateDTO.list();
	const linkCounts = await Promise.all(
		templates.map((t) => TemplateLinkDTO.countForTemplate(t.id)),
	);
	const linkable = templates
		.filter((_, i) => linkCounts[i] === 0)
		.map((t) => t.toJSON());

	return {
		hostAccess: can(locals.permissions, "system", "write"),
		linkableTemplates: linkable,
	};
};

async function parseLinks(
	formData: FormData,
): Promise<
	{ error: string } | { rows: { alias: string; linkedTemplateId: string }[] }
> {
	const linkTemplateIds = formData.getAll("linkTemplateId").map(String);
	const linkEnabledFlags = formData.getAll("linkEnabled").map(String);

	const rows: { alias: string; linkedTemplateId: string }[] = [];
	const seenAliases = new Set<string>();
	for (let i = 0; i < linkTemplateIds.length; i += 1) {
		if (linkEnabledFlags[i] !== "true") {
			continue;
		}
		const linkedTemplateId = linkTemplateIds[i];
		// oxlint-disable-next-line no-await-in-loop -- a handful of link rows at most, validates in order to fail on the first bad one
		const linked = await TemplateDTO.get(linkedTemplateId);
		if (!linked) {
			return { error: "One of the linked containers wasn't found." };
		}
		// oxlint-disable-next-line no-await-in-loop -- links are validated in order and the first failure stops
		if ((await TemplateLinkDTO.countForTemplate(linkedTemplateId)) > 0) {
			return {
				error: `"${linked.name}" already links to other containers itself, and can't be linked to in turn.`,
			};
		}
		const rawAlias = formData.get(`linkAlias.${linkedTemplateId}`);
		const alias =
			(rawAlias ? String(rawAlias) : "").trim() || slugify(linked.name);
		if (seenAliases.has(alias)) {
			return { error: `The alias "${alias}" is used more than once.` };
		}
		seenAliases.add(alias);
		rows.push({ alias, linkedTemplateId });
	}
	return { rows };
}

function parseTemplateForm(fields: Record<string, FormDataEntryValue>) {
	const result = createTemplateSchema.safeParse(fields);
	const runtime = updateRuntimeSchema.safeParse(fields);
	const envFiles = updateEnvFilesSchema.safeParse(fields);
	if (result.success && runtime.success && envFiles.success) {
		return {
			input: result.data,
			runtimeOptions: { ...runtime.data, ...envFiles.data },
		};
	}
	const errors: Record<string, string[] | undefined> = {
		...(result.success ? {} : result.error.flatten().fieldErrors),
		...(runtime.success ? {} : runtime.error.flatten().fieldErrors),
		...(envFiles.success ? {} : envFiles.error.flatten().fieldErrors),
	};
	return { errors };
}

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const fields = Object.fromEntries(formData);
		const parsed = parseTemplateForm(fields);
		if ("errors" in parsed) {
			return fail(400, { errors: parsed.errors, values: fields });
		}

		const { input, runtimeOptions } = parsed;
		if (
			!can(locals.permissions, "system", "write") &&
			hostAccessRequested(runtimeOptions)
		) {
			return fail(403, { error: HOST_ACCESS_MESSAGE, values: fields });
		}

		const ports = parsePublishedPortsField(formData.get("publishedPorts"));
		if ("error" in ports) {
			return fail(400, { error: ports.error, values: fields });
		}

		const links = await parseLinks(formData);
		if ("error" in links) {
			return fail(400, { error: links.error, values: fields });
		}

		const newTemplate = await TemplateDTO.create({
			...runtimeOptions,
			category: input.category || null,
			containerPort: input.containerPort,
			cpuLimit: input.cpuLimit || null,
			description: input.description || null,
			envVars: parseEnvVars(formData),
			icon: input.icon || null,
			image: input.image,
			memoryLimitMb: input.memoryLimitMb ?? null,
			name: input.name,
			ownerId: locals.user.id,
			publishedPorts: ports.ports,
			restartPolicy: input.restartPolicy,
			tag: input.tag,
			tags: parseTags(input.tags),
		});

		await Promise.all(
			links.rows.map((row) =>
				TemplateLinkDTO.create({
					alias: row.alias,
					linkedTemplateId: row.linkedTemplateId,
					templateId: newTemplate.id,
				}),
			),
		);

		logger.info(`Template created: name=${input.name} user=${locals.user.id}`);
		redirect(303, resolve("templates"));
	},
};
