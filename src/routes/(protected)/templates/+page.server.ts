import { fail, redirect } from "@sveltejs/kit";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { TemplateDTO } from "#lib/dto/template-dto.js";
import { TemplateLinkDTO } from "#lib/dto/template-link-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { can } from "#lib/permissions.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { quickDeployFromTemplate } from "#lib/services/template-links.js";
import { resolve } from "$app/paths";

async function withLinkedNames(templates: TemplateDTO[]) {
	const links = await Promise.all(
		templates.map((t) => TemplateLinkDTO.listForTemplate(t.id)),
	);
	return templates.map((t, i) => ({
		...t.toJSON(),
		linkedNames: links[i].map((l) => l.linkedTemplateName),
	}));
}

export const load = async ({ parent, url }) => {
	const { preferences } = await parent();

	const builtinQuery = parseListQuery(
		url,
		{
			filterKeys: ["category"],
			pageParam: "bpage",
			sortKeys: sortKeysOf(BASE_SORTS),
		},
		preferences.perPage,
	);
	const customQuery = parseListQuery(
		url,
		{
			filterKeys: ["category"],
			pageParam: "cpage",
			sortKeys: sortKeysOf(BASE_SORTS),
		},
		preferences.perPage,
	);

	const rawStackId = url.searchParams.get("stackId");
	const [builtins, custom, categories, stack] = await Promise.all([
		TemplateDTO.listPaged("builtin", builtinQuery),
		TemplateDTO.listPaged("custom", customQuery),
		TemplateDTO.categoryCounts(builtinQuery.q),
		rawStackId ? StackDTO.get(rawStackId) : null,
	]);

	const [builtinItems, customItems] = await Promise.all([
		withLinkedNames(builtins.items),
		withLinkedNames(custom.items),
	]);

	return {
		builtins: builtinItems,
		filtered: builtinQuery.active,
		builtinsPage: builtins.page,
		builtinsPerPage: builtins.perPage,
		builtinsTotal: builtins.total,
		categories,
		custom: customItems,
		customPage: custom.page,
		customPerPage: custom.perPage,
		customTotal: custom.total,
		stack: stack?.toJSON() ?? null,
	};
};

export const actions = {
	quickDeploy: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const templateId = formData.get("templateId") as string | null;
		const rawStackId = formData.get("stackId") as string | null;
		if (!templateId) {
			return fail(400, { error: "Missing template." });
		}

		const stackId =
			rawStackId && (await StackDTO.get(rawStackId)) ? rawStackId : null;
		const result = await quickDeployFromTemplate(templateId, {
			hostAccess: can(locals.permissions, "system", "write"),
			stackId,
			userId: locals.user.id,
		});

		if (!result.ok) {
			return fail(result.status, { error: result.error });
		}

		redirect(
			303,
			result.stackId
				? `${resolve("stacks")}/${result.stackId}`
				: `${resolve("services")}/${result.serviceId}`,
		);
	},
};
