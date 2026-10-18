import { error, fail, redirect } from "@sveltejs/kit";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { TemplateDTO } from "#lib/dto/template-dto.js";
import { TemplateLinkDTO } from "#lib/dto/template-link-dto.js";
import { can } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { getGitHubRepoInfo } from "#lib/services/github-repo.service.js";
import {
	quickDeployFromTemplate,
	templateHostAccessRefusal,
} from "#lib/services/template-links.js";
import { resolve } from "$app/paths";

export const load = async ({ params, parent, url, locals }) => {
	await parent();

	const tmpl = await TemplateDTO.get(params.templateId);
	if (!tmpl) {
		error(404, "Template not found");
	}

	const links = await TemplateLinkDTO.listForTemplate(tmpl.id);

	const rawStackId = url.searchParams.get("stackId");
	const stack = rawStackId ? await StackDTO.get(rawStackId) : null;

	const templateJson = tmpl.toJSON();

	return {
		github: getGitHubRepoInfo(templateJson.sourceUrl),
		hostAccessRefusal: templateHostAccessRefusal(
			tmpl,
			links.map((l) => ({
				runtime: l.linkedTemplateRuntime,
				templateName: l.linkedTemplateName,
			})),
			can(locals.permissions, "system", "write"),
		),
		links: links.map((l) => ({
			alias: l.link.alias,
			icon: l.linkedTemplateIcon,
			image: l.linkedTemplateImage,
			name: l.linkedTemplateName,
			tag: l.linkedTemplateTag,
		})),
		stack: stack?.toJSON() ?? null,
		template: templateJson,
	};
};

export const actions = {
	quickDeploy: async ({ params, request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const rawStackId = formData.get("stackId") as string | null;
		const stackId =
			rawStackId && (await StackDTO.get(rawStackId)) ? rawStackId : null;
		const result = await quickDeployFromTemplate(params.templateId, {
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
