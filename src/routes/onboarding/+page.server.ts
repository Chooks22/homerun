import { fail, redirect } from "@sveltejs/kit";
import {
	config,
	envDefaultsForDisplay,
	isPlaceholderAuthSecret,
} from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { Logger } from "#lib/logger.js";
import { hasAllPermissions } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { normalizeBaseDomain } from "#lib/server/validation/base-domain.js";
import {
	newtFieldsError,
	pangolinInputFromForm,
	saveCloudflareFromForm,
	testCloudflareFromForm,
	testPangolinFromForm,
} from "#lib/server/validation/dns-settings-form.js";
import { applyAndRebuild } from "#lib/server/validation/instance-settings-form.js";
import {
	type OnboardingInput,
	onboardingSchema,
} from "#lib/server/validation/onboarding.js";
import { resolve } from "$app/paths";

const logger = new Logger("Onboarding");

/** Blank optional field means "no override : fall back to the env default", same convention as settings/+page.server.ts's nullableText(). */
function blankToNull(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export const load = async ({ locals }) => {
	// Onboarding is instance-wide, not per-user : a non-admin account can
	// exist before the bootstrap admin has finished it (created by that
	// admin before they got around to this step). They land here too (the
	// parent layout's gate doesn't know about roles), but get a holding
	// message instead of instance-wide config controls.
	if (!hasAllPermissions(locals.permissions)) {
		return { waitingForAdmin: true as const };
	}

	const settings = await InstanceSettingsDTO.get();
	return {
		authSecretIsDefault: isPlaceholderAuthSecret(config.auth.secret),
		envDefaults: envDefaultsForDisplay(),
		settings: settings.toJSON(),
		waitingForAdmin: false as const,
	};
};

/** The base domain typed into the wizard's Core step, falling back to the running one when it isn't valid yet. */
function wizardBaseDomain(formData: FormData): string {
	const raw = (formData.get("baseDomain") as string | null) ?? "";
	return normalizeBaseDomain(raw)?.domain ?? config.baseDomain;
}

const SECRET_FIELDS = [
	"cloudflareApiToken",
	"pangolinApiToken",
	"pangolinNewtSecret",
	"smtpPassword",
];

/** The submitted fields to hand back on a failed submission, minus every secret. */
function echoedValues(formData: FormData): Record<string, FormDataEntryValue> {
	const values = Object.fromEntries(formData);
	for (const field of SECRET_FIELDS) {
		delete values[field];
	}
	return values;
}

/** The DNS integrations switched on without an API token typed or already stored, or with half-filled Newt fields, as a zod-shaped field error map, or null when none are. */
function missingDnsTokens(
	input: OnboardingInput,
	formData: FormData,
	settings: InstanceSettingsDTO,
): Record<string, string[]> | null {
	const current = settings.toJSON();
	const errors: Record<string, string[]> = {};
	if (input.cloudflareEnabled && !input.cloudflareApiToken?.trim()) {
		errors.cloudflareApiToken = [
			"API token is required when Cloudflare is enabled.",
		];
	}
	if (
		input.pangolinEnabled &&
		!(input.pangolinApiToken?.trim() || current.pangolinApiTokenEnc)
	) {
		errors.pangolinApiToken = [
			"API token is required when Pangolin is enabled.",
		];
	}
	const newtError = input.pangolinEnabled
		? newtFieldsError(formData, settings)
		: null;
	if (newtError) {
		errors.pangolinNewtEndpoint = [newtError];
	}
	return Object.keys(errors).length > 0 ? errors : null;
}

/** Persists whichever DNS integrations the wizard switched on, through the same DTO methods Settings → Networking saves with, keeping the Pangolin target and sign-in fields the wizard doesn't show. */
async function saveDnsSettings(
	input: OnboardingInput,
	formData: FormData,
	settings: InstanceSettingsDTO,
	userId: string,
): Promise<void> {
	if (input.cloudflareEnabled) {
		await saveCloudflareFromForm(formData, wizardBaseDomain(formData), userId);
	}
	if (input.pangolinEnabled) {
		const current = settings.toJSON();
		await settings.updatePangolin(
			pangolinInputFromForm(formData, {
				pangolinOwnsAuth: current.pangolinOwnsAuth ?? false,
				pangolinTargetHost: current.pangolinTargetHost,
				pangolinTargetPort: current.pangolinTargetPort,
			}),
		);
	}
}

export const actions = {
	testCloudflare: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!hasAllPermissions(locals.permissions)) {
			throw redirect(302, resolve(""));
		}
		const formData = await request.formData();
		const outcome = await testCloudflareFromForm(
			formData,
			wizardBaseDomain(formData),
		);
		if (!outcome.ok) {
			return fail(400, { error: outcome.error });
		}
		return {
			message: `Cloudflare zone access verified: ${outcome.detail ?? "token accepted"}.`,
		};
	},

	testPangolin: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!hasAllPermissions(locals.permissions)) {
			throw redirect(302, resolve(""));
		}
		const formData = await request.formData();
		const outcome = await testPangolinFromForm(
			formData,
			await InstanceSettingsDTO.get(),
			wizardBaseDomain(formData),
		);
		if (!outcome.ok) {
			return fail(400, { error: outcome.error });
		}
		return {
			message: `Pangolin reachable: ${outcome.detail ?? "org access verified"}.`,
		};
	},

	finish: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!hasAllPermissions(locals.permissions)) {
			throw redirect(302, resolve(""));
		}

		const formData = await request.formData();
		const parsed = onboardingSchema.safeParse(Object.fromEntries(formData));
		if (!parsed.success) {
			return fail(400, {
				errors: parsed.error.flatten().fieldErrors,
				values: echoedValues(formData),
			});
		}
		const input = parsed.data;

		const normalized = normalizeBaseDomain(input.baseDomain);
		if (!normalized) {
			return fail(400, {
				errors: {
					baseDomain: [
						'Base domain must be a bare hostname, like "example.com" or "app.example.local" : no "https://", path, or trailing slash.',
					],
				},
				values: echoedValues(formData),
			});
		}
		// Origin isn't a separate field, same derivation as
		// settings/+page.server.ts's updateCore action : base domain plus the
		// "Use HTTPS" checkbox, so this wizard only ever asks for one domain.
		const baseDomain = normalized.domain;
		const authOrigin = `${input.useHttps ? "https" : "http"}://${
			normalized.domain
		}${normalized.port ? `:${normalized.port}` : ""}`;

		const settings = await InstanceSettingsDTO.get();
		const missingTokens = missingDnsTokens(input, formData, settings);
		if (missingTokens) {
			return fail(400, {
				errors: missingTokens,
				values: echoedValues(formData),
			});
		}
		// authCheckUrl isn't part of this wizard (advanced/rarely-changed,
		// editable later on /settings) : preserve whatever it's currently set
		// to rather than resetting it.
		await settings.updateCore({
			authCheckUrl: settings.toJSON().authCheckUrl,
			authCrossSubdomainCookies: input.authCrossSubdomainCookies,
			authOrigin,
			baseDomain,
		});
		await settings.updateDocker({
			dockerNetworkName: blankToNull(input.dockerNetworkName),
			dockerSocketPath: blankToNull(input.dockerSocketPath),
		});
		await settings.updateTraefik({
			// Not part of this wizard (advanced/rarely-changed, editable later on
			// /settings) : preserve whatever it's currently set to, same as
			// authCheckUrl above.
			traefikAcmeEmail: settings.toJSON().traefikAcmeEmail,
			traefikCertResolver: input.traefikCertResolver,
			traefikDynamicConfigDir: blankToNull(input.traefikDynamicConfigDir),
			traefikEntrypoint: input.traefikEntrypoint,
		});
		await settings.updateSmtp({
			smtpEnabled: input.smtpEnabled,
			smtpFrom: blankToNull(input.smtpFrom),
			smtpHost: blankToNull(input.smtpHost),
			smtpPassword: input.smtpPassword?.trim() || undefined,
			smtpPort: input.smtpPort ?? null,
			smtpSecure: input.smtpSecure,
			smtpUser: blankToNull(input.smtpUser),
		});
		await settings.updateDefaultUiMode(input.defaultUiMode);
		await saveDnsSettings(input, formData, settings, locals.user.id);
		await settings.markOnboardingComplete();

		applyAndRebuild(settings);

		logger.info(`Onboarding completed: user=${locals.user.id}`);
		throw redirect(302, resolve(""));
	},
};
