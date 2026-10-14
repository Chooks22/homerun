import {
	type InstanceSettingsDockerInput,
	InstanceSettingsDTO,
	type InstanceSettingsSmtpInput,
	type InstanceSettingsTraefikInput,
} from "#lib/dto/instance-settings-dto.js";
import { errorPageTextsFromForm, isHexColor } from "#lib/error-pages.js";
import type { BlockSeverity } from "#lib/image-scan.js";
import { type IpBanSettings, MAX_BAN_WINDOW_MINUTES } from "#lib/ip-bans.js";
import { Logger } from "#lib/logger.js";
import { parseAlertTiming } from "#lib/resource-incidents.js";
import { parseThresholds } from "#lib/resource-thresholds.js";
import { MAX_RETAINED_IMAGES, MIN_RETAINED_IMAGES } from "#lib/revisions.js";
import { normalizeBaseDomain } from "#lib/server/validation/base-domain.js";
import { applyAndRebuild } from "#lib/server/validation/instance-settings-form.js";
import { inspectCertificate } from "#lib/tls-certificate.js";
import { CrowdsecService } from "./crowdsec.service.ts";
import { DockerService } from "./docker.service.ts";

const logger = new Logger("InstanceSettings");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRAILING_SLASHES_RE = /\/+$/;

/** An instance settings change refused for the caller's input; nothing was saved. */
export class InstanceSettingsError extends Error {}

export interface CoreSettingsInput {
	authCheckUrl: string | null;
	authCrossSubdomainCookies: boolean | null;
	baseDomain: string | null;
	/** The dashboard's URL, or null to derive it from the base domain and `useHttps`. */
	dashboardUrl: string | null;
	useHttps: boolean;
}

export interface ImageScanSettingsInput {
	imageScanBlockFixableOnly: boolean;
	imageScanBlockSeverity: BlockSeverity | null;
	imageScanEnabled: boolean;
	imageScanRequired: boolean;
}

export interface ErrorPageBrandingInput {
	accentColor: string | null;
	/** Null keeps the stored name. */
	brandName: string | null;
	logoUrl: string | null;
	showPoweredBy: boolean;
}

export interface CrowdsecInput {
	machineId: string;
	/** Null keeps the stored password. */
	password: string | null;
	url: string;
}

/** Reads one text field by name, the shape a form's `FormData` or a `Map` both have. */
export interface FieldSource {
	get(name: string): unknown;
}

/** Whether `value` is a whole number from `min` to `max`. */
function wholeIn(value: number, min: number, max: number): boolean {
	return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Saving the instance-wide settings, shared by the Settings and
 * Authentication pages' actions and the REST API, so both run the same
 * checks and the same side effects (the live config, auth, Traefik, DNS).
 * Every method throws `InstanceSettingsError` for a value it refuses,
 * before saving anything.
 */
class InstanceSettingsServiceClass {
	/**
	 * Saves the base domain, the dashboard URL (derived from the base domain
	 * when not given), the auth-check URL and cross-subdomain cookies, then
	 * applies them to the running instance.
	 *
	 * @throws {InstanceSettingsError} When the base domain isn't a bare hostname or the URL isn't a URL.
	 */
	async saveCore(input: CoreSettingsInput, userId: string): Promise<void> {
		const normalized = input.baseDomain
			? normalizeBaseDomain(input.baseDomain)
			: null;
		if (input.baseDomain && !normalized) {
			throw new InstanceSettingsError(
				'Base domain must be a bare hostname, like "example.com" or "app.example.local" : no "https://", path, or trailing slash.',
			);
		}
		if (input.dashboardUrl && !URL.canParse(input.dashboardUrl)) {
			throw new InstanceSettingsError(
				'Dashboard URL must be a full URL, like "https://homerun.example.com" or "http://localhost:5173".',
			);
		}
		const derivedOrigin = normalized
			? `${input.useHttps ? "https" : "http"}://${normalized.domain}${
					normalized.port ? `:${normalized.port}` : ""
				}`
			: null;
		const settings = await InstanceSettingsDTO.get();
		await settings.updateCore({
			authCheckUrl: input.authCheckUrl,
			authCrossSubdomainCookies: input.authCrossSubdomainCookies,
			authOrigin: input.dashboardUrl
				? new URL(input.dashboardUrl).origin
				: derivedOrigin,
			baseDomain: normalized?.domain ?? null,
		});
		applyAndRebuild(settings);
		logger.info(`Core instance settings updated: user=${userId}`);
	}

	/** Saves the Docker socket path and network name, then applies them to the running instance. */
	async saveDocker(
		input: InstanceSettingsDockerInput,
		userId: string,
	): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		await settings.updateDocker(input);
		applyAndRebuild(settings);
		logger.info(`Docker instance settings updated: user=${userId}`);
	}

	/** Saves the image scanning policy. */
	async saveImageScan(
		input: ImageScanSettingsInput,
		userId: string,
	): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		await settings.updateImageScan(input);
		logger.info(
			`Image scanning updated: enabled=${input.imageScanEnabled} block=${input.imageScanBlockSeverity ?? "off"} fixableOnly=${input.imageScanBlockFixableOnly} required=${input.imageScanRequired} user=${userId}`,
		);
	}

	/**
	 * Saves how many images each service keeps for rollbacks.
	 *
	 * @throws {InstanceSettingsError} When the count is out of range.
	 */
	async saveRetainedImages(count: number, userId: string): Promise<void> {
		if (!wholeIn(count, MIN_RETAINED_IMAGES, MAX_RETAINED_IMAGES)) {
			throw new InstanceSettingsError(
				`Keep between ${MIN_RETAINED_IMAGES} and ${MAX_RETAINED_IMAGES} images per service.`,
			);
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.updateRetainedImages(count);
		logger.info(
			`Retained images per service updated: count=${count} user=${userId}`,
		);
	}

	/**
	 * Saves the resource alert thresholds (`<kind>Soft`/`<kind>Hard` fields)
	 * and timing (`sustainSeconds`, `reminderMinutes`), read through `get`.
	 *
	 * @throws {InstanceSettingsError} When a threshold or a timing is out of range.
	 */
	async saveResources(
		get: (name: string) => string | null,
		userId: string,
	): Promise<void> {
		const thresholds = parseThresholds(get);
		if (typeof thresholds === "string") {
			throw new InstanceSettingsError(thresholds);
		}
		const timing = parseAlertTiming(get);
		if (typeof timing === "string") {
			throw new InstanceSettingsError(timing);
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.updateResourceThresholds(thresholds);
		await settings.updateResourceAlertTiming(timing);
		logger.info(`Resource thresholds saved: user=${userId}`);
	}

	/**
	 * Prepares the host for plain containers or swarm services, then saves the
	 * mode and moves the Newt tunnel along.
	 *
	 * @returns The steps the host went through.
	 * @throws When the host couldn't be prepared; the mode is unchanged then.
	 */
	async setOrchestrationMode(
		mode: "standalone" | "swarm",
		userId: string,
	): Promise<string[]> {
		const steps =
			mode === "swarm"
				? await DockerService.enableSwarmMode()
				: await DockerService.disableSwarmMode();
		const settings = await InstanceSettingsDTO.get();
		await settings.updateOrchestrationMode(mode);
		void DockerService.syncNewt(settings.newtCredentials(), mode === "swarm");
		logger.info(`Orchestration mode updated: mode=${mode} user=${userId}`);
		return steps;
	}

	/**
	 * Saves Traefik's entrypoint, cert resolver, ACME email, dynamic config
	 * directory and HTTP cache, applies them to the running instance and
	 * recreates Traefik when its own configuration changed.
	 *
	 * @returns What happened to Traefik, or null when it was left alone.
	 * @throws {InstanceSettingsError} When the ACME email isn't an email address.
	 */
	async saveTraefik(
		input: InstanceSettingsTraefikInput,
		userId: string,
	): Promise<string | null> {
		if (input.traefikAcmeEmail && !EMAIL_RE.test(input.traefikAcmeEmail)) {
			throw new InstanceSettingsError(
				"ACME account email isn't a valid email address.",
			);
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.updateTraefik(input);
		applyAndRebuild(settings);
		logger.info(`Traefik instance settings updated: user=${userId}`);
		try {
			const acme = await DockerService.applyAcmeEmail(input.traefikAcmeEmail);
			const cache = await DockerService.applyHttpCache(
				settings.toConfigOverride().traefikHttpCache ?? false,
			);
			return acme.updated || cache.updated
				? "Traefik was recreated with the new configuration."
				: null;
		} catch (err) {
			return `Saved, but Traefik wasn't reconfigured: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/** Saves the SMTP settings (a blank password keeps the stored one), then applies them to the running instance. */
	async saveSmtp(
		input: InstanceSettingsSmtpInput,
		userId: string,
	): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		await settings.updateSmtp(input);
		applyAndRebuild(settings);
		logger.info(`SMTP instance settings updated: user=${userId}`);
	}

	/**
	 * Checks a certificate and its key, writes them where Traefik reads them
	 * and saves them.
	 *
	 * @returns The names the certificate covers.
	 * @throws {InstanceSettingsError} When the pair is invalid or Traefik's copy couldn't be written.
	 */
	async installCertificate(
		cert: string,
		key: string,
		userId: string,
	): Promise<string[]> {
		let info: ReturnType<typeof inspectCertificate>;
		try {
			info = inspectCertificate(cert, key);
			await DockerService.syncInstanceCertificate({ cert, key });
		} catch (err) {
			throw new InstanceSettingsError(
				err instanceof Error ? err.message : String(err),
			);
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.updateInstanceCertificate({ ...info, cert, key });
		applyAndRebuild(settings);
		logger.info(
			`Instance certificate installed: names=${info.names.join(",")} user=${userId}`,
		);
		return info.names;
	}

	/** Removes the instance certificate, from the settings and from Traefik. */
	async removeCertificate(userId: string): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		await settings.updateInstanceCertificate(null);
		applyAndRebuild(settings);
		await DockerService.syncInstanceCertificate(null).catch((err) => {
			logger.warn("Couldn't remove the instance certificate file", err);
		});
		logger.info(`Instance certificate removed: user=${userId}`);
	}

	/**
	 * Saves the error pages' brand name, accent colour, logo and Homerun
	 * credit.
	 *
	 * @throws {InstanceSettingsError} When the colour isn't a hex colour or the logo URL isn't http(s).
	 */
	async saveErrorPageBranding(
		input: ErrorPageBrandingInput,
		userId: string,
	): Promise<void> {
		if (input.accentColor && !isHexColor(input.accentColor)) {
			throw new InstanceSettingsError(
				"The accent colour must look like #8b2942.",
			);
		}
		if (input.logoUrl && !/^https?:\/\//i.test(input.logoUrl)) {
			throw new InstanceSettingsError(
				"The logo URL must start with http:// or https://.",
			);
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.updateErrorPages({
			accentColor: input.accentColor,
			brandName: input.brandName ?? undefined,
			logoUrl: input.logoUrl,
			showPoweredBy: input.showPoweredBy,
		});
		logger.info(`Error page branding updated: user=${userId}`);
	}

	/** Saves every error page's title and message from `<kind>Title` / `<kind>Message` fields, a blank one showing the default. */
	async saveErrorPageTexts(fields: FieldSource, userId: string): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		await settings.updateErrorPages({ pages: errorPageTextsFromForm(fields) });
		logger.info(`Error page text updated: user=${userId}`);
	}

	/**
	 * Saves when a client address gets banned for hitting blocked paths.
	 *
	 * @throws {InstanceSettingsError} When the threshold, window or length is out of range.
	 */
	async saveIpBans(input: IpBanSettings, userId: string): Promise<void> {
		if (!wholeIn(input.threshold, 1, 1000)) {
			throw new InstanceSettingsError("Blocked requests must be 1 to 1000.");
		}
		if (!wholeIn(input.windowMinutes, 1, MAX_BAN_WINDOW_MINUTES)) {
			throw new InstanceSettingsError(
				`The window must be 1 to ${MAX_BAN_WINDOW_MINUTES} minutes.`,
			);
		}
		if (!wholeIn(input.durationHours, 0, 8760)) {
			throw new InstanceSettingsError(
				"The ban length must be 0 (forever) to 8760 hours.",
			);
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.updateIpBans(input);
		logger.info(`IP ban settings updated: user=${userId}`);
	}

	/**
	 * Saves the CrowdSec LAPI bans are pushed to after logging in to it with
	 * the machine's credentials, or turns the push off when `input` is null.
	 *
	 * @throws {InstanceSettingsError} When the URL isn't http(s), a credential is missing or the LAPI refuses them.
	 */
	async saveCrowdsec(
		input: CrowdsecInput | null,
		userId: string,
	): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		if (!input?.url) {
			await settings.updateCrowdsec(null);
			logger.info(`CrowdSec push turned off: user=${userId}`);
			return;
		}
		const url = URL.canParse(input.url) ? new URL(input.url) : null;
		if (!(url && ["http:", "https:"].includes(url.protocol))) {
			throw new InstanceSettingsError("The LAPI URL must be an http(s) URL.");
		}
		if (!input.machineId) {
			throw new InstanceSettingsError("The machine id is required.");
		}
		const storedPassword = settings.crowdsecCredentials()?.password ?? null;
		if (!(input.password || storedPassword)) {
			throw new InstanceSettingsError("The machine password is required.");
		}
		const credentials = {
			machineId: input.machineId,
			password: input.password ?? storedPassword ?? "",
			url: url.href.replace(TRAILING_SLASHES_RE, ""),
		};
		try {
			await CrowdsecService.login(credentials);
		} catch (err) {
			throw new InstanceSettingsError(
				`Couldn't log in to CrowdSec: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		await settings.updateCrowdsec({ ...credentials, password: input.password });
		logger.info(`CrowdSec push configured: user=${userId}`);
	}
}

export const InstanceSettingsService = new InstanceSettingsServiceClass();
