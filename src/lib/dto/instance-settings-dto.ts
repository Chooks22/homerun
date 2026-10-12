import { eq } from "drizzle-orm";
import type { EmailSignIn } from "#lib/auth-providers.js";
import {
	type ErrorPagesSettings,
	withErrorPageDefaults,
} from "#lib/error-pages.js";
import type { BlockSeverity, ScanBlockPolicy } from "#lib/image-scan.js";
import { type IpBanSettings, withIpBanDefaults } from "#lib/ip-bans.js";
import {
	DEFAULT_REMINDER_MINUTES,
	DEFAULT_SUSTAIN_SECONDS,
} from "#lib/resource-incidents.js";
import {
	type ResourceThresholds,
	withDefaults,
} from "#lib/resource-thresholds.js";
import { RETAINED_REVISIONS } from "#lib/revisions.js";
import type { SecurityPolicy } from "#lib/security-policy.js";
import { db } from "#lib/server/db/lib.js";
import {
	type GitProviderConfig,
	type GitProviderKind,
	type InstanceOauthProvider,
	type InstanceSettings,
	instanceSettings,
	type OauthTokenAuthMethod,
} from "#lib/server/db/schema.js";
import type { CrowdsecCredentials } from "#lib/services/crowdsec.service.js";
import type { NewtCredentials } from "#lib/services/docker/newt.js";
import { decryptSecret, encryptSecret } from "#lib/services/secrets.js";
import type { TracingColumns } from "#lib/tracing/settings.js";
import type { UpdateChannel } from "#lib/update-channel.js";
import { BaseDTO } from "./base-dto";
import { blankInstanceSettings } from "./instance-settings-blank";

/** Fixed id : this table only ever holds one row. */
const SINGLETON_ID = "default";

export interface InstanceSettingsCoreInput {
	authCheckUrl: string | null;
	authCrossSubdomainCookies: boolean | null;
	authOrigin: string | null;
	baseDomain: string | null;
}

export interface InstanceSettingsDockerInput {
	dockerNetworkName: string | null;
	dockerSocketPath: string | null;
}

export interface InstanceSettingsTraefikInput {
	traefikAcmeEmail: string | null;
	traefikCertResolver: string | null;
	traefikDynamicConfigDir: string | null;
	traefikEntrypoint: string | null;
	traefikHttpCache?: boolean;
}

export interface InstanceSettingsPangolinInput {
	pangolinApiBaseUrl: string | null;
	pangolinOwnsAuth: boolean;
	pangolinTargetHost: string | null;
	/** Blank/undefined means "keep the currently stored token". */
	pangolinApiToken?: string;
	pangolinMainSiteName: string | null;
	pangolinNewtEndpoint: string | null;
	pangolinNewtId: string | null;
	/** Blank/undefined means "keep the currently stored secret". */
	pangolinNewtSecret?: string;
	pangolinOrgId: string | null;
	pangolinTargetPort: number | null;
}

export interface InstanceSettingsSmtpInput {
	smtpEnabled: boolean | null;
	smtpFrom: string | null;
	smtpHost: string | null;
	/** Blank/undefined means "keep the currently stored password". */
	smtpPassword?: string;
	smtpPort: number | null;
	smtpSecure: boolean | null;
	smtpUser: string | null;
}

/** A git provider row coming off the Git Providers form : plaintext secret, blank means "keep existing" on an edit. */
export interface GitProviderInput {
	baseUrl?: string | null;
	clientId: string;
	clientSecret?: string;
	enabled: boolean;
	/** Present when editing an existing provider, or when a new one's id was picked up front (the GitHub App manifest flow); absent otherwise. */
	id?: string;
	kind: GitProviderKind;
	name: string;
}

/** A provider row coming off the settings form : plaintext secret, blank means "keep existing". */
export interface OauthProviderInput {
	clientId: string;
	clientSecret?: string;
	discoveredTokenAuth?: string[];
	discoveryUrl: string;
	enabled: boolean;
	label: string;
	name: string;
	pkce: boolean;
	scopes: string[];
	signOutOfProvider: boolean;
	tokenAuthMethod: OauthTokenAuthMethod;
}

/** The plain-value shape $lib/config.ts's applyInstanceSettings() merges over env defaults. */
export interface InstanceSettingsOverride {
	authCheckUrl?: string | null;
	authCrossSubdomainCookies?: boolean | null;
	authOrigin?: string | null;
	baseDomain?: string | null;
	dockerNetworkName?: string | null;
	dockerSocketPath?: string | null;
	oauthProviders?: Array<{
		clientId: string;
		clientSecret: string;
		discoveryUrl: string;
		enabled: boolean;
		name: string;
		pkce: boolean;
		discoveredTokenAuth: string[];
		label: string;
		scopes: string[];
		signOutOfProvider: boolean;
		tokenAuthMethod: OauthTokenAuthMethod;
	}>;
	pangolinEnabled?: boolean | null;
	pangolinOwnsAuth?: boolean | null;
	smtpEnabled?: boolean | null;
	smtpFrom?: string | null;
	smtpHost?: string | null;
	smtpPassword?: string | null;
	smtpPort?: number | null;
	smtpSecure?: boolean | null;
	smtpUser?: string | null;
	traefikAcmeEmail?: string | null;
	traefikCertResolver?: string | null;
	traefikDynamicConfigDir?: string | null;
	traefikEntrypoint?: string | null;
	traefikHttpCache?: boolean;
	traefikInstanceCertNames?: string[];
}

/**
 * Wraps the singleton `instance_settings` row : DB overrides for
 * instance-level config that otherwise defaults from env vars (see
 * $lib/config.ts). Unlike every other DTO this isn't user-scoped: there's
 * exactly one row, shared across the whole (single-user) instance.
 */
export class InstanceSettingsDTO extends BaseDTO<InstanceSettings> {
	/** Selects the singleton row, creating a blank default one on first read. */
	static async get(): Promise<InstanceSettingsDTO> {
		return (await InstanceSettingsDTO.getOrCreate()).settings;
	}

	/**
	 * Selects the singleton row, creating a blank default one on first read,
	 * and says whether this call is the one that created it : true only on a
	 * brand new database.
	 */
	static async getOrCreate(): Promise<{
		created: boolean;
		settings: InstanceSettingsDTO;
	}> {
		const [existing] = await db
			.select()
			.from(instanceSettings)
			.where(eq(instanceSettings.id, SINGLETON_ID))
			.limit(1);
		if (existing) {
			return { created: false, settings: new InstanceSettingsDTO(existing) };
		}

		const row = blankInstanceSettings(SINGLETON_ID, new Date());
		const inserted = await db
			.insert(instanceSettings)
			.values(row)
			.onConflictDoNothing()
			.returning({ id: instanceSettings.id });
		if (inserted.length === 0) {
			return {
				created: false,
				settings: await InstanceSettingsDTO.get(),
			};
		}
		return { created: true, settings: new InstanceSettingsDTO(row) };
	}

	/** Whether the onboarding wizard has been completed on this instance. */
	get onboardingComplete(): boolean {
		return this.row.onboardingCompletedAt !== null;
	}

	/** Whether env-var links have been turned into recorded dependencies on this instance yet. */
	get dependenciesBackfilled(): boolean {
		return this.row.dependenciesBackfilledAt !== null;
	}

	/** Stamps the one-time dependency backfill as done, so later boots skip it. */
	async markDependenciesBackfilled(): Promise<void> {
		await this.persist({ dependenciesBackfilledAt: new Date() });
	}

	/** Persists the UI mode accounts follow by default, or clears it back to advanced. */
	async updateDefaultUiMode(
		mode: InstanceSettings["defaultUiMode"],
	): Promise<void> {
		await this.persist({ defaultUiMode: mode });
	}

	/** Stamps onboarding as completed now, so the wizard stops being shown. */
	async markOnboardingComplete(): Promise<void> {
		await this.persist({ onboardingCompletedAt: new Date() });
	}

	/**
	 * Whether sign-in must use a passkey or two-factor auth, both off when unset.
	 */
	get securityPolicy(): SecurityPolicy {
		return {
			requirePasskey: this.row.requirePasskey ?? false,
			requireTwoFactor: this.row.requireTwoFactor ?? false,
		};
	}

	/** Persists the passkey and two-factor requirements. */
	async updateSecurityPolicy(input: SecurityPolicy): Promise<void> {
		await this.persist(input);
	}

	/**
	 * Which emailed sign-in methods an admin has switched on: one-time codes
	 * default on, magic links off. Neither works without SMTP, see
	 * `emailSignInAvailability`.
	 */
	get emailSignIn(): EmailSignIn {
		return {
			emailOtp: this.row.emailOtpSignIn ?? true,
			magicLink: this.row.magicLinkSignIn ?? false,
		};
	}

	/** Persists which emailed sign-in methods are switched on. */
	async updateEmailSignIn(input: EmailSignIn): Promise<void> {
		await this.persist({
			emailOtpSignIn: input.emailOtp,
			magicLinkSignIn: input.magicLink,
		});
	}

	/**
	 * The sign-in methods the sign-in page features, in order, empty when unset.
	 */
	get preferredSignInMethods(): string[] {
		return this.row.preferredSignInMethods ?? [];
	}

	/**
	 * Persists the featured sign-in methods, dropping duplicates while keeping
	 * order.
	 */
	async updatePreferredSignInMethods(methods: string[]): Promise<void> {
		await this.persist({ preferredSignInMethods: [...new Set(methods)] });
	}

	/** The branded error pages Traefik serves, every unset field at its default. */
	get errorPages(): ErrorPagesSettings {
		return withErrorPageDefaults(this.row.errorPages);
	}

	/** Persists the error pages' branding or text, merged over what's stored. */
	async updateErrorPages(input: Partial<ErrorPagesSettings>): Promise<void> {
		await this.persist({ errorPages: { ...this.row.errorPages, ...input } });
	}

	/** When a client address gets banned for hitting blocked paths, every unset field at its default. */
	get ipBans(): IpBanSettings {
		return withIpBanDefaults(this.row.ipBans);
	}

	/** Persists the IP ban settings. */
	async updateIpBans(input: IpBanSettings): Promise<void> {
		await this.persist({ ipBans: input });
	}

	/** The CrowdSec LAPI bans are pushed to, as the settings page shows it: never the password, only whether one is stored. */
	get crowdsec(): {
		machineId: string | null;
		passwordSet: boolean;
		url: string | null;
	} {
		return {
			machineId: this.row.crowdsecMachineId,
			passwordSet: Boolean(this.row.crowdsecPasswordEnc),
			url: this.row.crowdsecUrl,
		};
	}

	/** The CrowdSec LAPI URL, machine id and decrypted password, or null unless all three are stored. */
	crowdsecCredentials(): CrowdsecCredentials | null {
		const password = this.row.crowdsecPasswordEnc
			? decryptSecret(this.row.crowdsecPasswordEnc)
			: null;
		return this.row.crowdsecUrl && this.row.crowdsecMachineId && password
			? {
					machineId: this.row.crowdsecMachineId,
					password,
					url: this.row.crowdsecUrl,
				}
			: null;
	}

	/**
	 * Persists the CrowdSec LAPI URL and machine id and, when one was typed,
	 * the re-encrypted password; a blank password keeps the stored one, and
	 * null clears all three.
	 */
	async updateCrowdsec(
		input: { machineId: string; password: string | null; url: string } | null,
	): Promise<void> {
		await this.persist(
			input
				? {
						crowdsecMachineId: input.machineId,
						crowdsecUrl: input.url,
						...(input.password
							? { crowdsecPasswordEnc: encryptSecret(input.password) }
							: {}),
					}
				: {
						crowdsecMachineId: null,
						crowdsecPasswordEnc: null,
						crowdsecUrl: null,
					},
		);
	}

	/** Persists the base domain and auth origin/cookie overrides. */
	async updateCore(input: InstanceSettingsCoreInput): Promise<void> {
		await this.persist(input);
	}

	/** Persists the built-in registry's own settings (auth, public hostname, internal token). */
	async persistRegistry(
		input: Partial<
			Pick<
				InstanceSettings,
				| "registryAuthEnabled"
				| "registryInternalSecretEnc"
				| "registryPublicHost"
			>
		>,
	): Promise<void> {
		await this.persist(input);
	}

	/** Persists the Web Push VAPID key pair, the private half already encrypted. */
	async persistVapid(
		input: Pick<InstanceSettings, "vapidPrivateKeyEnc" | "vapidPublicKey">,
	): Promise<void> {
		await this.persist(input);
	}

	/** Persists the built-in object store's toggle, public host and secrets. */
	async persistGarage(
		input: Partial<
			Pick<
				InstanceSettings,
				| "garageAdminTokenEnc"
				| "garageEnabled"
				| "garagePublicHost"
				| "garageRpcSecretEnc"
			>
		>,
	): Promise<void> {
		await this.persist(input);
	}

	/** Persists the OpenTelemetry collector toggle and the trace retention. */
	async persistTracing(input: TracingColumns): Promise<void> {
		await this.persist(input);
	}

	/** Persists the Docker socket path and network name overrides. */
	async updateDocker(input: InstanceSettingsDockerInput): Promise<void> {
		await this.persist(input);
	}

	/**
	 * Persists the Traefik entrypoint, cert resolver, ACME email and dynamic
	 * config dir overrides.
	 */
	async updateTraefik(input: InstanceSettingsTraefikInput): Promise<void> {
		await this.persist(input);
	}

	/** The soft and hard usage thresholds per resource, the defaults where none is saved. */
	get resourceThresholds(): ResourceThresholds {
		return withDefaults(this.row.resourceThresholds);
	}

	/** How long a resource has to stay past a limit before it alerts, in seconds (60 unless set). */
	get resourceAlertSustainSeconds(): number {
		return this.row.resourceAlertSustainSeconds ?? DEFAULT_SUSTAIN_SECONDS;
	}

	/** Minutes between reminders while a resource stays past a limit, 0 for none (30 unless set). */
	get resourceAlertReminderMinutes(): number {
		return this.row.resourceAlertReminderMinutes ?? DEFAULT_REMINDER_MINUTES;
	}

	/** Persists how long a breach has to last before it alerts and how often an open one reminds. */
	async updateResourceAlertTiming(timing: {
		reminderMinutes: number;
		sustainSeconds: number;
	}): Promise<void> {
		await this.persist({
			resourceAlertReminderMinutes: timing.reminderMinutes,
			resourceAlertSustainSeconds: timing.sustainSeconds,
		});
	}

	/** Persists every resource category's soft and hard threshold. */
	async updateResourceThresholds(
		thresholds: ResourceThresholds,
	): Promise<void> {
		await this.persist({ resourceThresholds: thresholds });
	}

	/** "standalone" (default, null means the same thing) | "swarm". */
	get orchestrationMode(): "standalone" | "swarm" {
		return this.row.orchestrationMode ?? "standalone";
	}

	/** Which releases self-update follows: stable releases, every e2e-tested canary build of `main`, or every nightly build of it. */
	get updateChannel(): UpdateChannel {
		return this.row.updateChannel ?? "stable";
	}

	/** Persists which release channel self-update follows. */
	async updateUpdateChannel(channel: UpdateChannel): Promise<void> {
		await this.persist({ updateChannel: channel });
	}

	/** Persists whether services deploy as plain containers or swarm services. */
	async updateOrchestrationMode(mode: "standalone" | "swarm"): Promise<void> {
		await this.persist({ orchestrationMode: mode });
	}

	/**
	 * Whether every deployed service should be redeployed on the next boot,
	 * set by the installer's `--migrate-to-rootful` once the stack runs on a
	 * new daemon that has none of the old containers.
	 */
	get pendingServiceRedeploy(): boolean {
		return this.row.pendingServiceRedeploy ?? false;
	}

	/** Clears the redeploy-on-boot request once its deploys are queued. */
	async clearPendingServiceRedeploy(): Promise<void> {
		await this.persist({ pendingServiceRedeploy: false });
	}

	/**
	 * Whether images are vulnerability-scanned, on unless explicitly disabled.
	 */
	get imageScanEnabled(): boolean {
		return this.row.imageScanEnabled ?? true;
	}

	/**
	 * The severity at or above which a scan finding blocks a deploy, null to
	 * never block.
	 */
	get imageScanBlockSeverity(): BlockSeverity | null {
		return this.row.imageScanBlockSeverity ?? null;
	}

	/** Whether the block policy only counts findings that have a fixed version. */
	get imageScanBlockFixableOnly(): boolean {
		return this.row.imageScanBlockFixableOnly ?? false;
	}

	/** Whether a deploy fails when its image couldn't be scanned at all, off unless explicitly enabled. */
	get imageScanRequired(): boolean {
		return this.row.imageScanRequired ?? false;
	}

	/** How many distinct images per service are kept on the host for rollbacks, `RETAINED_REVISIONS` when unset. */
	get retainedImagesPerService(): number {
		return this.row.retainedImagesPerService ?? RETAINED_REVISIONS;
	}

	/** Persists how many distinct images per service are kept for rollbacks. */
	async updateRetainedImages(count: number): Promise<void> {
		await this.persist({ retainedImagesPerService: count });
	}

	/** The deploy block policy as one value, for `evaluateScanPolicy`. */
	get imageScanBlockPolicy(): ScanBlockPolicy {
		return {
			fixableOnly: this.imageScanBlockFixableOnly,
			severity: this.imageScanBlockSeverity,
		};
	}

	/** Persists the image scanning toggle and deploy block policy. */
	async updateImageScan(input: {
		imageScanBlockFixableOnly: boolean;
		imageScanBlockSeverity: BlockSeverity | null;
		imageScanEnabled: boolean;
		imageScanRequired: boolean;
	}): Promise<void> {
		await this.persist(input);
	}

	/** Whether Pangolin fronts the instance (its tunnel and resources), null for none. */
	get dnsProvider(): "pangolin" | null {
		return this.row.dnsProvider ?? null;
	}

	/** Turns Pangolin on as the instance's tunnel, or off. */
	async updateDnsProvider(provider: "pangolin" | null): Promise<void> {
		await this.persist({ dnsProvider: provider });
	}

	/** The Pangolin API base URL, if configured. */
	get pangolinApiBaseUrl(): string | null {
		return this.row.pangolinApiBaseUrl;
	}

	/** The Pangolin organisation resources are created in, if configured. */
	get pangolinOrgId(): string | null {
		return this.row.pangolinOrgId;
	}

	/** The Pangolin site new resources are attached to, if configured. */
	get pangolinMainSiteName(): string | null {
		return this.row.pangolinMainSiteName;
	}

	/** The port a created Pangolin target points at, 443 when unset. */
	get pangolinTargetPort(): number {
		return this.row.pangolinTargetPort ?? 443;
	}

	/** The host a created Target points at, null to detect it from where the Pangolin site agent runs (see DockerService.tunnelTargetHost). */
	get pangolinTargetHost(): string | null {
		return this.row.pangolinTargetHost || null;
	}

	/** Whether Pangolin's own SSO gate is left on, and this app's per-service login wall steps aside for anything it publishes. */
	get pangolinOwnsAuth(): boolean {
		return this.row.pangolinOwnsAuth ?? false;
	}

	/** Whether every field PangolinService needs is set : anything less treats the integration as "feature off". */
	get pangolinConfigured(): boolean {
		return this.row.dnsProvider === "pangolin" && this.pangolinCredentialsSet;
	}

	/** Whether the Pangolin API, org and site are all stored, whichever provider is chosen. */
	get pangolinCredentialsSet(): boolean {
		return !!(
			this.row.pangolinApiTokenEnc &&
			this.row.pangolinApiBaseUrl &&
			this.row.pangolinOrgId &&
			this.row.pangolinMainSiteName
		);
	}

	/** Decrypted API token, for PangolinService's own HTTP calls only : never exposed to a `load` return value. */
	decryptPangolinApiToken(): string | null {
		return this.row.pangolinApiTokenEnc
			? decryptSecret(this.row.pangolinApiTokenEnc)
			: null;
	}

	/**
	 * Persists the Pangolin settings and, when a new token was typed, the
	 * re-encrypted API token; a blank token keeps the stored one. Becomes the
	 * DNS provider when none is chosen yet.
	 */
	async updatePangolin(input: InstanceSettingsPangolinInput): Promise<void> {
		const { pangolinApiToken, pangolinNewtSecret, ...rest } = input;
		await this.persist({
			...rest,
			// Blank token field means "leave unchanged" : same convention as
			// cloudflareApiToken/smtpPassword/registryPassword elsewhere.
			...(pangolinApiToken
				? { pangolinApiTokenEnc: encryptSecret(pangolinApiToken) }
				: {}),
			...(pangolinNewtSecret
				? { pangolinNewtSecretEnc: encryptSecret(pangolinNewtSecret) }
				: {}),
			...(this.row.dnsProvider ? {} : { dnsProvider: "pangolin" as const }),
		});
	}

	/**
	 * The credentials Homerun's own Newt container runs with, or null when
	 * Pangolin isn't configured or any of endpoint, id and secret is missing,
	 * meaning the tunnel client runs somewhere else (or not at all).
	 */
	newtCredentials(): NewtCredentials | null {
		const secret = this.row.pangolinNewtSecretEnc
			? decryptSecret(this.row.pangolinNewtSecretEnc)
			: null;
		const endpoint = this.row.pangolinNewtEndpoint;
		const id = this.row.pangolinNewtId;
		if (!(this.pangolinConfigured && endpoint && id && secret)) {
			return null;
		}
		return { endpoint, id, secret };
	}

	/**
	 * Persists the SMTP settings and, when a new password was typed, the
	 * re-encrypted password; a blank password keeps the stored one.
	 */
	async updateSmtp(input: InstanceSettingsSmtpInput): Promise<void> {
		const { smtpPassword, ...rest } = input;
		await this.persist({
			...rest,
			// Blank password field means "leave unchanged" : same convention as
			// service.registryPasswordEnc (never overwrite a stored credential
			// with nothing just because the admin didn't retype it).
			...(smtpPassword ? { smtpPasswordEnc: encryptSecret(smtpPassword) } : {}),
		});
	}

	/** The configured git providers, with client secrets still encrypted. */
	get gitProviders(): GitProviderConfig[] {
		return this.row.gitProviders;
	}

	/**
	 * Replaces the whole git provider list with the submitted one. New providers
	 * get a fresh id; a blank client secret keeps the stored secret of the
	 * provider with the same id.
	 */
	async updateGitProviders(providers: GitProviderInput[]): Promise<void> {
		const existingById = new Map(this.row.gitProviders.map((p) => [p.id, p]));
		const rows: GitProviderConfig[] = providers.map((p) => ({
			baseUrl: p.baseUrl?.trim() || null,
			clientId: p.clientId,
			clientSecretEnc: p.clientSecret
				? encryptSecret(p.clientSecret)
				: (existingById.get(p.id ?? "")?.clientSecretEnc ?? ""),
			enabled: p.enabled,
			id: p.id ?? crypto.randomUUID(),
			kind: p.kind,
			name: p.name,
		}));
		await this.persist({ gitProviders: rows });
	}

	/**
	 * Converts a submitted OAuth provider into its stored shape, encrypting a
	 * newly typed client secret or keeping `existing`'s when it was left blank.
	 */
	#toRow(
		input: OauthProviderInput,
		existing?: InstanceOauthProvider,
	): InstanceOauthProvider {
		return {
			clientId: input.clientId,
			clientSecretEnc: input.clientSecret
				? encryptSecret(input.clientSecret)
				: (existing?.clientSecretEnc ?? ""),
			discoveredTokenAuth: input.discoveredTokenAuth,
			discoveryUrl: input.discoveryUrl,
			enabled: input.enabled,
			label: input.label,
			name: input.name,
			pkce: input.pkce,
			scopes: input.scopes,
			signOutOfProvider: input.signOutOfProvider,
			tokenAuthMethod: input.tokenAuthMethod,
		};
	}

	/** The stored OAuth provider with this name, null when none matches. */
	oauthProvider(name: string): InstanceOauthProvider | null {
		return this.row.oauthProviders.find((p) => p.name === name) ?? null;
	}

	/** Appends a new OAuth provider and persists the list. */
	async addOauthProvider(input: OauthProviderInput): Promise<void> {
		const rows = [...this.row.oauthProviders, this.#toRow(input)];
		await this.persist({ oauthProviders: rows });
	}

	/**
	 * Replaces the OAuth provider named `name` with the submitted one, keeping
	 * its stored secret when none was typed.
	 */
	async updateOauthProvider(
		name: string,
		input: OauthProviderInput,
	): Promise<void> {
		const rows = this.row.oauthProviders.map((p) =>
			p.name === name ? this.#toRow(input, p) : p,
		);
		await this.persist({ oauthProviders: rows });
	}

	/** Removes the OAuth provider named `name` and persists the list. */
	async deleteOauthProvider(name: string): Promise<void> {
		const rows = this.row.oauthProviders.filter((p) => p.name !== name);
		await this.persist({ oauthProviders: rows });
	}

	/**
	 * Writes a partial update to the singleton row and mirrors it onto this
	 * instance.
	 */
	private async persist(
		input: Partial<Omit<InstanceSettings, "createdAt" | "id" | "updatedAt">>,
	): Promise<void> {
		await db
			.update(instanceSettings)
			.set(input)
			.where(eq(instanceSettings.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Decrypts every stored secret into the plain-value shape config.ts needs. */
	toConfigOverride(): InstanceSettingsOverride {
		return {
			authCheckUrl: this.row.authCheckUrl,
			authCrossSubdomainCookies: this.row.authCrossSubdomainCookies,
			authOrigin: this.row.authOrigin,
			baseDomain: this.row.baseDomain,
			dockerNetworkName: this.row.dockerNetworkName,
			dockerSocketPath: this.row.dockerSocketPath,
			pangolinEnabled: this.pangolinConfigured,
			pangolinOwnsAuth: this.pangolinOwnsAuth && this.pangolinConfigured,
			oauthProviders: this.row.oauthProviders.map((p) => ({
				clientId: p.clientId,
				clientSecret: p.clientSecretEnc
					? (decryptSecret(p.clientSecretEnc) ?? "")
					: "",
				discoveryUrl: p.discoveryUrl,
				enabled: p.enabled,
				name: p.name,
				pkce: p.pkce,
				discoveredTokenAuth: p.discoveredTokenAuth ?? [],
				label: p.label || p.name,
				scopes: p.scopes,
				signOutOfProvider: p.signOutOfProvider ?? false,
				tokenAuthMethod: p.tokenAuthMethod ?? "auto",
			})),
			smtpEnabled: this.row.smtpEnabled,
			smtpFrom: this.row.smtpFrom,
			smtpHost: this.row.smtpHost,
			smtpPassword: this.row.smtpPasswordEnc
				? decryptSecret(this.row.smtpPasswordEnc)
				: null,
			smtpPort: this.row.smtpPort,
			smtpSecure: this.row.smtpSecure,
			smtpUser: this.row.smtpUser,
			traefikAcmeEmail: this.row.traefikAcmeEmail,
			traefikCertResolver: this.row.traefikCertResolver,
			traefikDynamicConfigDir: this.row.traefikDynamicConfigDir,
			traefikEntrypoint: this.row.traefikEntrypoint,
			traefikHttpCache: this.row.traefikHttpCache,
			traefikInstanceCertNames: this.row.tlsCertEnc
				? this.row.tlsCertNames
				: [],
		};
	}

	/** The SSH key pair machine terminals sign in with: the public half in authorized_keys form and the decrypted private one; null until generated. */
	get sshKeyPair(): { privateKey: string; publicKey: string } | null {
		const privateKey = this.row.sshPrivateKeyEnc
			? decryptSecret(this.row.sshPrivateKeyEnc)
			: null;
		return privateKey && this.row.sshPublicKey
			? { privateKey, publicKey: this.row.sshPublicKey }
			: null;
	}

	/** Stores the machine terminals' SSH key pair, the private key encrypted. */
	async saveSshKeyPair(pair: {
		privateKey: string;
		publicKey: string;
	}): Promise<void> {
		await this.persist({
			sshPrivateKeyEnc: encryptSecret(pair.privateKey),
			sshPublicKey: pair.publicKey,
		});
	}

	/** Where this server's own terminal connects, null until it's been set. */
	get sshTarget(): {
		host: string;
		hostKey: string | null;
		port: number;
		user: string;
	} | null {
		return this.row.sshHost && this.row.sshUser
			? {
					host: this.row.sshHost,
					hostKey: this.row.sshHostKey,
					port: this.row.sshPort ?? 22,
					user: this.row.sshUser,
				}
			: null;
	}

	/** Sets where this server's terminal connects; a changed host forgets the recorded host key. */
	async updateSshTarget(input: {
		host: string | null;
		port: number | null;
		user: string | null;
	}): Promise<void> {
		await this.persist({
			sshHost: input.host,
			sshHostKey: input.host === this.row.sshHost ? this.row.sshHostKey : null,
			sshPort: input.port,
			sshUser: input.user,
		});
	}

	/** Records the host key this server presented, trusted from then on. */
	async recordSshHostKey(hostKey: string): Promise<void> {
		await this.persist({ sshHostKey: hostKey });
	}

	/** The instance certificate's details for the TLS tab, null when none is installed. */
	get instanceCertificate(): {
		expiresAt: Date | null;
		issuer: string | null;
		names: string[];
	} | null {
		return this.row.tlsCertEnc
			? {
					expiresAt: this.row.tlsCertExpiresAt,
					issuer: this.row.tlsCertIssuer,
					names: this.row.tlsCertNames,
				}
			: null;
	}

	/** The instance certificate and key PEMs, decrypted, null when none is installed or they can't be decrypted. */
	instanceCertificatePem(): { cert: string; key: string } | null {
		const cert = this.row.tlsCertEnc
			? decryptSecret(this.row.tlsCertEnc)
			: null;
		const key = this.row.tlsKeyEnc ? decryptSecret(this.row.tlsKeyEnc) : null;
		return cert && key ? { cert, key } : null;
	}

	/** Stores an instance certificate (already checked), or removes it when `input` is null. */
	async updateInstanceCertificate(
		input: {
			cert: string;
			expiresAt: Date;
			issuer: string;
			key: string;
			names: string[];
		} | null,
	): Promise<void> {
		await this.persist(
			input
				? {
						tlsCertEnc: encryptSecret(input.cert),
						tlsCertExpiresAt: input.expiresAt,
						tlsCertIssuer: input.issuer,
						tlsCertNames: input.names,
						tlsKeyEnc: encryptSecret(input.key),
					}
				: {
						tlsCertEnc: null,
						tlsCertExpiresAt: null,
						tlsCertIssuer: null,
						tlsCertNames: [],
						tlsKeyEnc: null,
					},
		);
	}
}
