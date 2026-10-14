import type { z } from "zod";
import { isSmtpEnabled } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { RegistryTokenDTO } from "#lib/dto/registry-token-dto.js";
import { SINGLETON_ID } from "#lib/iac/resources-settings.js";
import { RESOURCE_KINDS } from "#lib/resource-thresholds.js";
import type {
	authenticationSettingsApiBody,
	errorPagesApiBody,
	instanceSettingsApiBody,
	ipBanSettingsApiBody,
	registrySettingsApiBody,
	smtpSettingsApiBody,
	tlsSettingsApiBody,
} from "#lib/server/validation/settings-api.js";
import { DEFAULT_UI_MODE } from "#lib/ui-mode.js";
import { enqueueCoreServiceJob } from "./core-service-queue.ts";
import {
	InstanceSettingsError,
	InstanceSettingsService,
} from "./instance-settings.service.ts";
import type { CoreServiceJob } from "./queue/payloads.ts";
import { QueueService } from "./queue.service.ts";
import { RegistryService } from "./registry.service.ts";

type InstanceSettingsBody = z.infer<typeof instanceSettingsApiBody>;
type SmtpSettingsBody = z.infer<typeof smtpSettingsApiBody>;
type AuthenticationSettingsBody = z.infer<typeof authenticationSettingsApiBody>;
type TlsSettingsBody = z.infer<typeof tlsSettingsApiBody>;
type ErrorPagesBody = z.infer<typeof errorPagesApiBody>;
type IpBanSettingsBody = z.infer<typeof ipBanSettingsApiBody>;
type RegistrySettingsBody = z.infer<typeof registrySettingsApiBody>;

type Json = Record<string, unknown>;

/** Whether `body` carries any of `keys`. */
function sends<T extends object>(body: T, keys: (keyof T)[]): boolean {
	return keys.some((key) => body[key] !== undefined);
}

/** `sent` when the body carries it, `current` when it was left out. */
function pick<T>(sent: T | undefined, current: T): T {
	return sent === undefined ? current : sent;
}

/** A registry token as the API returns it: never its secret's hash. */
function registryTokenJson(token: RegistryTokenDTO): Json {
	const row = token.toJSON();
	return {
		createdAt: row.createdAt,
		id: row.id,
		lastUsedAt: row.lastUsedAt,
		username: row.username,
	};
}

/**
 * The instance-wide settings over the REST API (and so the Terraform
 * provider's singleton resources): each one's JSON shape, and a PATCH that
 * fills what the body leaves out from what's stored, then saves through
 * `InstanceSettingsService`, the same code the dashboard's forms run.
 * Secrets are accepted and never returned, only whether one is stored.
 */
class SettingsApiServiceClass {
	/** The General, Docker and Networking settings. */
	async instanceSettings(): Promise<Json> {
		const settings = await InstanceSettingsDTO.get();
		const row = settings.toJSON();
		const thresholds: Record<string, number> = {};
		for (const kind of RESOURCE_KINDS) {
			thresholds[`${kind}SoftThreshold`] =
				settings.resourceThresholds[kind].soft;
			thresholds[`${kind}HardThreshold`] =
				settings.resourceThresholds[kind].hard;
		}
		return {
			...thresholds,
			authCheckUrl: row.authCheckUrl,
			authCrossSubdomainCookies: row.authCrossSubdomainCookies,
			baseDomain: row.baseDomain,
			dashboardUrl: row.authOrigin,
			defaultUiMode: row.defaultUiMode ?? DEFAULT_UI_MODE,
			dockerNetworkName: row.dockerNetworkName,
			dockerSocketPath: row.dockerSocketPath,
			imageScanBlockFixableOnly: settings.imageScanBlockFixableOnly,
			imageScanBlockSeverity: settings.imageScanBlockSeverity,
			imageScanEnabled: settings.imageScanEnabled,
			imageScanRequired: settings.imageScanRequired,
			orchestrationMode: settings.orchestrationMode,
			resourceAlertReminderMinutes: settings.resourceAlertReminderMinutes,
			resourceAlertSustainSeconds: settings.resourceAlertSustainSeconds,
			retainedImagesPerService: settings.retainedImagesPerService,
			traefikAcmeEmail: row.traefikAcmeEmail,
			traefikCertResolver: row.traefikCertResolver,
			traefikDynamicConfigDir: row.traefikDynamicConfigDir,
			traefikEntrypoint: row.traefikEntrypoint,
			traefikHttpCache: row.traefikHttpCache,
			updateChannel: settings.updateChannel,
		};
	}

	/**
	 * Saves the General, Docker and Networking settings `body` carries, group
	 * by group, each with its page's checks and side effects. A changed
	 * orchestration mode prepares the host first.
	 *
	 * @throws {InstanceSettingsError} When a value is refused; the groups before it are saved.
	 * @throws When the host couldn't be prepared for a new orchestration mode.
	 */
	async patchInstanceSettings(
		body: InstanceSettingsBody,
		userId: string,
	): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		await this.#patchCore(settings, body, userId);
		if (body.updateChannel) {
			await settings.updateUpdateChannel(body.updateChannel);
		}
		if (body.defaultUiMode) {
			await settings.updateDefaultUiMode(body.defaultUiMode);
		}
		await this.#patchResources(settings, body, userId);
		await this.#patchDocker(settings, body, userId);
		await this.#patchImageScan(settings, body, userId);
		if (body.retainedImagesPerService !== undefined) {
			await InstanceSettingsService.saveRetainedImages(
				body.retainedImagesPerService,
				userId,
			);
		}
		await this.#patchTraefik(settings, body, userId);
	}

	/** The base domain, dashboard URL, auth-check URL and cookie scope, with the dashboard URL re-derived when it was derived from the old base domain. */
	async #patchCore(
		settings: InstanceSettingsDTO,
		body: InstanceSettingsBody,
		userId: string,
	): Promise<void> {
		if (
			!sends(body, [
				"authCheckUrl",
				"authCrossSubdomainCookies",
				"baseDomain",
				"dashboardUrl",
			])
		) {
			return;
		}
		const row = settings.toJSON();
		const derived =
			!row.authOrigin ||
			(row.baseDomain !== null &&
				[`https://${row.baseDomain}`, `http://${row.baseDomain}`].includes(
					row.authOrigin,
				));
		await InstanceSettingsService.saveCore(
			{
				authCheckUrl: pick(body.authCheckUrl, row.authCheckUrl),
				authCrossSubdomainCookies: pick(
					body.authCrossSubdomainCookies,
					row.authCrossSubdomainCookies,
				),
				baseDomain: pick(body.baseDomain, row.baseDomain),
				dashboardUrl: pick(body.dashboardUrl, derived ? null : row.authOrigin),
				useHttps: !row.authOrigin?.startsWith("http://"),
			},
			userId,
		);
	}

	/** The orchestration mode when the body changes it, then the Docker socket and network, the one the body leaves out at its stored value. */
	async #patchDocker(
		settings: InstanceSettingsDTO,
		body: InstanceSettingsBody,
		userId: string,
	): Promise<void> {
		if (
			body.orchestrationMode &&
			body.orchestrationMode !== settings.orchestrationMode
		) {
			await InstanceSettingsService.setOrchestrationMode(
				body.orchestrationMode,
				userId,
			);
		}
		if (!sends(body, ["dockerNetworkName", "dockerSocketPath"])) {
			return;
		}
		const row = settings.toJSON();
		await InstanceSettingsService.saveDocker(
			{
				dockerNetworkName: pick(body.dockerNetworkName, row.dockerNetworkName),
				dockerSocketPath: pick(body.dockerSocketPath, row.dockerSocketPath),
			},
			userId,
		);
	}

	/** The resource thresholds and alert timing, the ones the body leaves out at their stored value. */
	async #patchResources(
		settings: InstanceSettingsDTO,
		body: InstanceSettingsBody,
		userId: string,
	): Promise<void> {
		const thresholdKeys = RESOURCE_KINDS.flatMap(
			(kind) => [`${kind}SoftThreshold`, `${kind}HardThreshold`] as const,
		);
		if (
			!sends(body, [
				...thresholdKeys,
				"resourceAlertReminderMinutes",
				"resourceAlertSustainSeconds",
			])
		) {
			return;
		}
		const stored = settings.resourceThresholds;
		const fields: Record<string, number> = {
			reminderMinutes: pick(
				body.resourceAlertReminderMinutes,
				settings.resourceAlertReminderMinutes,
			),
			sustainSeconds: pick(
				body.resourceAlertSustainSeconds,
				settings.resourceAlertSustainSeconds,
			),
		};
		for (const kind of RESOURCE_KINDS) {
			fields[`${kind}Soft`] = pick(
				body[`${kind}SoftThreshold`],
				stored[kind].soft,
			);
			fields[`${kind}Hard`] = pick(
				body[`${kind}HardThreshold`],
				stored[kind].hard,
			);
		}
		await InstanceSettingsService.saveResources((name) => {
			const value = fields[name];
			return value === undefined ? null : String(value);
		}, userId);
	}

	/** The image scanning policy, the fields the body leaves out at their stored value. */
	async #patchImageScan(
		settings: InstanceSettingsDTO,
		body: InstanceSettingsBody,
		userId: string,
	): Promise<void> {
		if (
			!sends(body, [
				"imageScanBlockFixableOnly",
				"imageScanBlockSeverity",
				"imageScanEnabled",
				"imageScanRequired",
			])
		) {
			return;
		}
		await InstanceSettingsService.saveImageScan(
			{
				imageScanBlockFixableOnly: pick(
					body.imageScanBlockFixableOnly,
					settings.imageScanBlockFixableOnly,
				),
				imageScanBlockSeverity: pick(
					body.imageScanBlockSeverity,
					settings.imageScanBlockSeverity,
				),
				imageScanEnabled: pick(
					body.imageScanEnabled,
					settings.imageScanEnabled,
				),
				imageScanRequired: pick(
					body.imageScanRequired,
					settings.imageScanRequired,
				),
			},
			userId,
		);
	}

	/** Traefik's settings, the fields the body leaves out at their stored value. */
	async #patchTraefik(
		settings: InstanceSettingsDTO,
		body: InstanceSettingsBody,
		userId: string,
	): Promise<void> {
		if (
			!sends(body, [
				"traefikAcmeEmail",
				"traefikCertResolver",
				"traefikDynamicConfigDir",
				"traefikEntrypoint",
				"traefikHttpCache",
			])
		) {
			return;
		}
		const row = settings.toJSON();
		await InstanceSettingsService.saveTraefik(
			{
				traefikAcmeEmail: pick(body.traefikAcmeEmail, row.traefikAcmeEmail),
				traefikCertResolver: pick(
					body.traefikCertResolver,
					row.traefikCertResolver,
				),
				traefikDynamicConfigDir: pick(
					body.traefikDynamicConfigDir,
					row.traefikDynamicConfigDir,
				),
				traefikEntrypoint: pick(body.traefikEntrypoint, row.traefikEntrypoint),
				traefikHttpCache: pick(body.traefikHttpCache, row.traefikHttpCache),
			},
			userId,
		);
	}

	/** The SMTP settings: never the password, only whether one is stored. */
	async smtpSettings(): Promise<Json> {
		const row = (await InstanceSettingsDTO.get()).toJSON();
		return {
			enabled: row.smtpEnabled,
			from: row.smtpFrom,
			host: row.smtpHost,
			passwordSet: Boolean(row.smtpPasswordEnc),
			port: row.smtpPort,
			secure: row.smtpSecure,
			username: row.smtpUser,
		};
	}

	/** Saves the SMTP settings `body` carries, the rest kept, then applies them to the running instance. */
	async patchSmtpSettings(
		body: SmtpSettingsBody,
		userId: string,
	): Promise<void> {
		const row = (await InstanceSettingsDTO.get()).toJSON();
		await InstanceSettingsService.saveSmtp(
			{
				smtpEnabled: pick(body.enabled, row.smtpEnabled),
				smtpFrom: pick(body.from, row.smtpFrom),
				smtpHost: pick(body.host, row.smtpHost),
				smtpPassword: body.password,
				smtpPort: pick(body.port, row.smtpPort),
				smtpSecure: pick(body.secure, row.smtpSecure),
				smtpUser: pick(body.username, row.smtpUser),
			},
			userId,
		);
	}

	/** The emailed sign-in methods, the sign-in page's featured methods and the security policy, plus whether SMTP is set up for the emailed ones. */
	async authenticationSettings(): Promise<Json> {
		const settings = await InstanceSettingsDTO.get();
		return {
			...settings.emailSignIn,
			...settings.securityPolicy,
			preferredSignInMethods: settings.preferredSignInMethods,
			smtpConfigured: isSmtpEnabled(),
		};
	}

	/** Saves the authentication settings `body` carries, the rest kept. */
	async patchAuthenticationSettings(
		body: AuthenticationSettingsBody,
	): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		if (sends(body, ["emailOtp", "magicLink"])) {
			await settings.updateEmailSignIn({
				emailOtp: pick(body.emailOtp, settings.emailSignIn.emailOtp),
				magicLink: pick(body.magicLink, settings.emailSignIn.magicLink),
			});
		}
		if (sends(body, ["requirePasskey", "requireTwoFactor"])) {
			await settings.updateSecurityPolicy({
				requirePasskey: pick(
					body.requirePasskey,
					settings.securityPolicy.requirePasskey,
				),
				requireTwoFactor: pick(
					body.requireTwoFactor,
					settings.securityPolicy.requireTwoFactor,
				),
			});
		}
		if (body.preferredSignInMethods) {
			await settings.updatePreferredSignInMethods(body.preferredSignInMethods);
		}
	}

	/** The installed instance certificate's names, issuer and expiry: never the certificate or its key. */
	async tlsSettings(): Promise<Json> {
		const certificate = (await InstanceSettingsDTO.get()).instanceCertificate;
		return {
			expiresAt: certificate?.expiresAt?.toISOString() ?? null,
			installed: certificate !== null,
			issuer: certificate?.issuer ?? null,
			names: certificate?.names ?? [],
		};
	}

	/**
	 * Installs the certificate and key `body` carries, the installed one
	 * filling in the half it leaves out, or removes the installed one when
	 * either is null.
	 *
	 * @throws {InstanceSettingsError} When the pair is invalid or incomplete.
	 */
	async patchTlsSettings(body: TlsSettingsBody, userId: string): Promise<void> {
		if (body.certificate === null || body.privateKey === null) {
			await InstanceSettingsService.removeCertificate(userId);
			return;
		}
		if (!sends(body, ["certificate", "privateKey"])) {
			return;
		}
		const installed = (
			await InstanceSettingsDTO.get()
		).instanceCertificatePem();
		const cert = body.certificate ?? installed?.cert;
		const key = body.privateKey ?? installed?.key;
		if (!(cert && key)) {
			throw new InstanceSettingsError(
				"Send both certificate and privateKey: no certificate is installed to complete them from.",
			);
		}
		await InstanceSettingsService.installCertificate(cert, key, userId);
	}

	/** The error pages' branding and the page texts set (blank ones show the default and are left out). */
	async errorPages(): Promise<Json> {
		const settings = await InstanceSettingsDTO.get();
		const stored = settings.toJSON().errorPages ?? {};
		const pageTexts: Record<string, string> = {};
		for (const [kind, page] of Object.entries(stored.pages ?? {})) {
			for (const [part, value] of Object.entries(page ?? {})) {
				if (typeof value === "string" && value) {
					pageTexts[`${kind}${part[0].toUpperCase()}${part.slice(1)}`] = value;
				}
			}
		}
		return {
			accentColor: settings.errorPages.accentColor,
			brandName: settings.errorPages.brandName,
			logoUrl: settings.errorPages.logoUrl,
			pageTexts,
			showPoweredBy: settings.errorPages.showPoweredBy,
		};
	}

	/**
	 * Saves the error page branding and texts `body` carries. Page texts are
	 * replaced as a whole: a page left out shows its default.
	 *
	 * @throws {InstanceSettingsError} When the colour or the logo URL is refused.
	 */
	async patchErrorPages(body: ErrorPagesBody, userId: string): Promise<void> {
		const current = (await InstanceSettingsDTO.get()).errorPages;
		if (sends(body, ["accentColor", "brandName", "logoUrl", "showPoweredBy"])) {
			await InstanceSettingsService.saveErrorPageBranding(
				{
					accentColor: pick(body.accentColor, current.accentColor),
					brandName: body.brandName ?? null,
					logoUrl: pick(body.logoUrl, current.logoUrl),
					showPoweredBy: pick(body.showPoweredBy, current.showPoweredBy),
				},
				userId,
			);
		}
		if (body.pageTexts) {
			await InstanceSettingsService.saveErrorPageTexts(
				new Map(Object.entries(body.pageTexts)),
				userId,
			);
		}
	}

	/** The IP ban settings and the CrowdSec push: never its password, only whether one is stored. */
	async ipBanSettings(): Promise<Json> {
		const settings = await InstanceSettingsDTO.get();
		return {
			...settings.ipBans,
			crowdsecMachineId: settings.crowdsec.machineId,
			crowdsecPasswordSet: settings.crowdsec.passwordSet,
			crowdsecUrl: settings.crowdsec.url,
		};
	}

	/**
	 * Saves the IP ban settings and the CrowdSec push `body` carries, the rest
	 * kept. CrowdSec is logged in to before it's saved.
	 *
	 * @throws {InstanceSettingsError} When a value is refused or CrowdSec refuses the machine.
	 */
	async patchIpBanSettings(
		body: IpBanSettingsBody,
		userId: string,
	): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		const current = settings.ipBans;
		if (
			sends(body, [
				"disrespectMode",
				"durationHours",
				"enabled",
				"meanMode",
				"threshold",
				"windowMinutes",
			])
		) {
			await InstanceSettingsService.saveIpBans(
				{
					disrespectMode: pick(body.disrespectMode, current.disrespectMode),
					durationHours: pick(body.durationHours, current.durationHours),
					enabled: pick(body.enabled, current.enabled),
					meanMode: pick(body.meanMode, current.meanMode),
					threshold: pick(body.threshold, current.threshold),
					windowMinutes: pick(body.windowMinutes, current.windowMinutes),
				},
				userId,
			);
		}
		if (sends(body, ["crowdsecMachineId", "crowdsecPassword", "crowdsecUrl"])) {
			const url = pick(body.crowdsecUrl, settings.crowdsec.url);
			await InstanceSettingsService.saveCrowdsec(
				url
					? {
							machineId:
								pick(body.crowdsecMachineId, settings.crowdsec.machineId) ?? "",
							password: body.crowdsecPassword ?? null,
							url,
						}
					: null,
				userId,
			);
		}
	}

	/** The built-in registry's auth switch and public hostname. */
	async registrySettings(): Promise<Json> {
		const row = (await InstanceSettingsDTO.get()).toJSON();
		return {
			authEnabled: row.registryAuthEnabled === true,
			publicHost: row.registryPublicHost ?? null,
		};
	}

	/**
	 * Changes the registry's auth and public hostname the way its Settings tab
	 * does, through queued core service jobs, waiting for each: auth goes on
	 * before the registry is published, and off after it's unpublished.
	 *
	 * @throws {InstanceSettingsError} When the change is refused (auth off while published, published without auth).
	 * @throws When a job fails.
	 */
	async patchRegistrySettings(
		body: RegistrySettingsBody,
		userId: string,
	): Promise<void> {
		const current = await this.registrySettings();
		const enabled = pick(body.authEnabled, current.authEnabled as boolean);
		const host = pick(body.publicHost, current.publicHost as string | null);
		const auth =
			enabled === current.authEnabled
				? null
				: { action: "setRegistryAuth" as const, enabled };
		const publish =
			(host ?? "") === (current.publicHost ?? "")
				? null
				: { action: "publishRegistry" as const, host: host ?? "" };
		const [first, second] = enabled ? [auth, publish] : [publish, auth];
		if (first) {
			await this.#registryJob(first, userId);
		}
		if (second) {
			await this.#registryJob(second, userId);
		}
	}

	/** Queues one registry change after its check, and waits for it to finish. */
	async #registryJob(payload: CoreServiceJob, userId: string): Promise<void> {
		const problem =
			payload.action === "setRegistryAuth"
				? await RegistryService.authProblem(payload.enabled)
				: payload.action === "publishRegistry"
					? await RegistryService.publicHostProblem(payload.host)
					: null;
		if (problem) {
			throw new InstanceSettingsError(problem);
		}
		const job = await enqueueCoreServiceJob(payload, userId);
		const finished = await QueueService.wait(job.id);
		if (finished.status !== "succeeded") {
			throw new Error(finished.error ?? "The registry change failed.");
		}
	}

	/** Every registry token, newest first. */
	async registryTokens(): Promise<Json[]> {
		return (await RegistryService.listTokens()).map(registryTokenJson);
	}

	/** One registry token, or null when it doesn't exist. */
	async registryToken(id: string): Promise<Json | null> {
		const token = await RegistryTokenDTO.get(id);
		return token ? registryTokenJson(token) : null;
	}

	/**
	 * Creates a registry token.
	 *
	 * @returns The token with its secret, the only time it's readable.
	 * @throws {InstanceSettingsError} When the username is invalid or taken, or the registry couldn't be updated.
	 */
	async createRegistryToken(username: string, userId: string): Promise<Json> {
		try {
			const created = await RegistryService.createToken(username, userId);
			return {
				...(await this.registryToken(created.id)),
				secret: created.secret,
			};
		} catch (err) {
			throw new InstanceSettingsError(
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	/** Every singleton settings object (with the `SINGLETON_ID` its Terraform state holds), and every registry token, by Terraform resource type, for the IaC page's drift check. */
	async iacInventory(): Promise<Record<string, Json[]>> {
		const [
			instance,
			smtp,
			authentication,
			tls,
			errorPages,
			ipBans,
			registry,
			tokens,
		] = await Promise.all([
			this.instanceSettings(),
			this.smtpSettings(),
			this.authenticationSettings(),
			this.tlsSettings(),
			this.errorPages(),
			this.ipBanSettings(),
			this.registrySettings(),
			this.registryTokens(),
		]);
		const withId = (object: Json) => [{ ...object, id: SINGLETON_ID }];
		return {
			homerun_authentication_settings: withId(authentication),
			homerun_error_pages: withId(errorPages),
			homerun_instance_settings: withId(instance),
			homerun_ip_ban_settings: withId(ipBans),
			homerun_registry_settings: withId(registry),
			homerun_registry_token: tokens,
			homerun_smtp_settings: withId(smtp),
			homerun_tls_settings: withId(tls),
		};
	}
}

export const SettingsApiService = new SettingsApiServiceClass();
