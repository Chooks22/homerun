import { fail } from "@sveltejs/kit";
import { OauthClientEnvironmentDTO } from "#lib/dto/oauth-client-environment-dto.js";
import { OauthClientSecretDTO } from "#lib/dto/oauth-client-secret-dto.js";
import { Logger } from "#lib/logger.js";
import { adminApp } from "#lib/server/oauth-app-admin.js";
import { parseEnvironmentForm } from "#lib/server/oauth-app-form.js";
import {
	OauthAppError,
	OauthAppService,
} from "#lib/services/oauth-app.service.js";

const logger = new Logger("OidcProvider");

/** The 400 for a change the app service refused; anything else is rethrown. */
function refused(err: unknown) {
	if (err instanceof OauthAppError) {
		return fail(400, { error: err.message });
	}
	throw err;
}

export const load = async ({ parent }) => {
	const { app } = await parent();
	const [environments, secrets] = await Promise.all([
		OauthClientEnvironmentDTO.listForClient(app.clientId),
		OauthClientSecretDTO.listForClient(app.clientId),
	]);
	return {
		environments: environments.map((env) => env.toJSON()),
		secrets: secrets
			.map((secret) => secret.summary())
			.filter((secret) => secret.environmentId !== null),
	};
};

export const actions = {
	createEnvironment: async ({ locals, params, request }) => {
		const app = await adminApp(locals, params.appId);
		const parsed = parseEnvironmentForm(await request.formData());
		if (!parsed.input) {
			return fail(400, { error: parsed.error });
		}
		try {
			const environment = await OauthAppService.addEnvironment(
				app,
				parsed.input,
			);
			logger.info(
				`OAuth app environment added: client=${app.clientId} env=${environment.name}`,
			);
			if (!app.summary().confidential) {
				return { created: environment.name };
			}
			const { secret } = await OauthAppService.issueSecret(
				app,
				environment.id,
				"Initial secret",
			);
			return {
				created: environment.name,
				secret: { environment: environment.name, value: secret },
			};
		} catch (err) {
			return refused(err);
		}
	},

	updateEnvironment: async ({ locals, params, request }) => {
		const app = await adminApp(locals, params.appId);
		const formData = await request.formData();
		const environment = await OauthClientEnvironmentDTO.get(
			app.clientId,
			String(formData.get("environmentId")),
		);
		if (!environment) {
			return fail(404, { error: "That environment doesn't exist any more." });
		}
		const parsed = parseEnvironmentForm(formData);
		if (!parsed.input) {
			return fail(400, { error: parsed.error });
		}
		try {
			await OauthAppService.updateEnvironment(app, environment, parsed.input);
		} catch (err) {
			return refused(err);
		}
		logger.info(
			`OAuth app environment saved: client=${app.clientId} env=${environment.name}`,
		);
		return { saved: environment.name };
	},

	deleteEnvironment: async ({ locals, params, request }) => {
		const app = await adminApp(locals, params.appId);
		const formData = await request.formData();
		const environments = await OauthClientEnvironmentDTO.listForClient(
			app.clientId,
		);
		const environment = environments.find(
			(env) => env.id === String(formData.get("environmentId")),
		);
		if (!environment) {
			return fail(404, { error: "That environment doesn't exist any more." });
		}
		if (environments.length === 1) {
			return fail(400, {
				error: "An app keeps at least one environment. Delete the app instead.",
			});
		}
		await OauthAppService.deleteEnvironment(app, environment);
		logger.info(
			`OAuth app environment deleted: client=${app.clientId} env=${environment.name}`,
		);
		return { deleted: environment.name };
	},

	issueSecret: async ({ locals, params, request }) => {
		const app = await adminApp(locals, params.appId);
		const formData = await request.formData();
		try {
			const { environment, secret } = await OauthAppService.issueSecret(
				app,
				String(formData.get("environmentId")),
				String(formData.get("label") ?? ""),
			);
			logger.info(
				`OAuth app secret issued: client=${app.clientId} env=${environment.name} user=${locals.user?.id}`,
			);
			return { secret: { environment: environment.name, value: secret } };
		} catch (err) {
			return refused(err);
		}
	},

	revokeSecret: async ({ locals, params, request }) => {
		const app = await adminApp(locals, params.appId);
		const formData = await request.formData();
		const secret = await OauthClientSecretDTO.get(
			app.clientId,
			String(formData.get("secretId")),
		);
		if (!secret) {
			return fail(404, { error: "That secret doesn't exist any more." });
		}
		await secret.delete();
		logger.info(
			`OAuth app secret revoked: client=${app.clientId} user=${locals.user?.id}`,
		);
		return { revoked: true };
	},
};
