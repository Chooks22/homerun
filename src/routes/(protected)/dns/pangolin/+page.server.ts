import { fail } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	newtFieldsError,
	pangolinInputFromForm,
	testPangolinFromForm,
} from "#lib/server/validation/dns-settings-form.js";
import { applyAndRebuild } from "#lib/server/validation/instance-settings-form.js";
import { PangolinService } from "#lib/services/pangolin.service.js";

const logger = new Logger("InstanceSettings");

/** Pangolin's registered domains, or the reason they couldn't be listed. */
async function pangolinDomains(): Promise<{
	domains: string[];
	error: string | null;
}> {
	try {
		const domains = await PangolinService.listDomainNames();
		return {
			domains: domains ?? [],
			error: domains ? null : "Finish the settings below to list domains.",
		};
	} catch (err) {
		return {
			domains: [],
			error: err instanceof Error ? err.message : "Couldn't list domains.",
		};
	}
}

export const load = async () => {
	const settings = await InstanceSettingsDTO.get();
	return {
		domains:
			settings.dnsProvider === "pangolin"
				? pangolinDomains()
				: Promise.resolve({ domains: [], error: null }),
		enabled: settings.dnsProvider === "pangolin",
		settings: settings.toJSON(),
	};
};

export const actions = {
	setEnabled: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const enabled = (await request.formData()).get("enabled") === "on";
		const settings = await InstanceSettingsDTO.get();
		await settings.updateDnsProvider(enabled ? "pangolin" : null);
		applyAndRebuild(settings);
		logger.info(`Pangolin ${enabled ? "on" : "off"}: user=${locals.user.id}`);
		return { enabled };
	},

	testPangolin: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const outcome = await testPangolinFromForm(
			await request.formData(),
			await InstanceSettingsDTO.get(),
			config.baseDomain,
		);
		if (!outcome.ok) {
			return fail(400, { error: outcome.error });
		}
		return {
			pangolinTestDetail: outcome.detail,
			pangolinTestOk: true,
			success: true,
		};
	},

	updatePangolin: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const settings = await InstanceSettingsDTO.get();
		const newtError = newtFieldsError(formData, settings);
		if (newtError) {
			return fail(400, { error: newtError });
		}
		await settings.updatePangolin(pangolinInputFromForm(formData));
		applyAndRebuild(settings);
		logger.info(`Pangolin instance settings updated: user=${locals.user.id}`);
		return { savedSection: "pangolin", success: true };
	},
};
