import { DnsConnectionDTO } from "#lib/dto/dns-connection-dto.js";
import { DomainDTO } from "#lib/dto/domain-dto.js";
import type {
	InstanceSettingsDTO,
	InstanceSettingsPangolinInput,
} from "#lib/dto/instance-settings-dto.js";
import { cloudflareClient } from "#lib/services/dns-providers/cloudflare.js";
import { inZone } from "#lib/services/dns-providers/http.js";
import { PangolinService } from "#lib/services/pangolin.service.js";
import { checkbox, nullableText } from "./instance-settings-form";

export type DnsTestOutcome =
	| { detail: string | null; ok: true }
	| { error: string; ok: false };

type PangolinTargetFields = Pick<
	InstanceSettingsPangolinInput,
	"pangolinOwnsAuth" | "pangolinTargetHost" | "pangolinTargetPort"
>;

/** A typed secret field, or undefined when left blank so the stored value is kept. */
function secretField(formData: FormData, key: string): string | undefined {
	return (formData.get(key) as string | null)?.trim() || undefined;
}

/**
 * What's wrong with the Newt fields of a settings or onboarding form, or null
 * when they're fine: all blank (the tunnel client runs elsewhere) or
 * endpoint, id and secret all set, the secret either typed or already stored.
 */
export function newtFieldsError(
	formData: FormData,
	settings: InstanceSettingsDTO,
): string | null {
	const endpoint = nullableText(formData, "pangolinNewtEndpoint");
	const id = nullableText(formData, "pangolinNewtId");
	const typedSecret = secretField(formData, "pangolinNewtSecret");
	if (!(endpoint || id || typedSecret)) {
		return null;
	}
	if (!endpoint) {
		return "Newt endpoint is required to run Newt on this host.";
	}
	if (!URL.canParse(endpoint)) {
		return "Newt endpoint must be a full URL, like https://pangolin.example.com.";
	}
	if (!id) {
		return "Newt ID is required to run Newt on this host.";
	}
	if (!(typedSecret || settings.toJSON().pangolinNewtSecretEnc)) {
		return "Newt secret is required to run Newt on this host.";
	}
	return null;
}

/**
 * The Pangolin section of a settings or onboarding form, ready for
 * `updatePangolin`. The target host, target port and SSO ownership come from
 * `preserve` when given, for a form that doesn't show those fields.
 */
export function pangolinInputFromForm(
	formData: FormData,
	preserve?: PangolinTargetFields,
): InstanceSettingsPangolinInput {
	const portRaw = (formData.get("pangolinTargetPort") as string | null)?.trim();
	const port = portRaw ? Number.parseInt(portRaw, 10) : null;
	return {
		pangolinApiBaseUrl: nullableText(formData, "pangolinApiBaseUrl"),
		pangolinApiToken: secretField(formData, "pangolinApiToken"),
		pangolinMainSiteName: nullableText(formData, "pangolinMainSiteName"),
		pangolinNewtEndpoint: nullableText(formData, "pangolinNewtEndpoint"),
		pangolinNewtId: nullableText(formData, "pangolinNewtId"),
		pangolinNewtSecret: secretField(formData, "pangolinNewtSecret"),
		pangolinOrgId: nullableText(formData, "pangolinOrgId"),
		...(preserve ?? {
			pangolinOwnsAuth: checkbox(formData, "pangolinOwnsAuth"),
			pangolinTargetHost: nullableText(formData, "pangolinTargetHost"),
			pangolinTargetPort: Number.isFinite(port) ? port : null,
		}),
	};
}

/**
 * Checks the Cloudflare zone id and token typed into the onboarding form:
 * the token must list the zone, and the zone must hold `baseDomain`.
 *
 * @returns The zone's name on success.
 */
export async function testCloudflareFromForm(
	formData: FormData,
	baseDomain: string,
): Promise<DnsTestOutcome> {
	const zoneId = nullableText(formData, "cloudflareZoneId");
	const token = secretField(formData, "cloudflareApiToken");
	if (!zoneId) {
		return { error: "Enter a zone id first.", ok: false };
	}
	if (!token) {
		return { error: "Enter an API token first.", ok: false };
	}
	try {
		const zone = (await cloudflareClient(token).listZones()).find(
			(candidate) => candidate.id === zoneId,
		);
		if (!zone) {
			return { error: `The token can't see zone ${zoneId}.`, ok: false };
		}
		if (baseDomain && !inZone(baseDomain, zone.name)) {
			return {
				error: `Zone ${zone.name} doesn't hold ${baseDomain}.`,
				ok: false,
			};
		}
		return { detail: `zone ${zone.name}`, ok: true };
	} catch (err) {
		return {
			error: `Couldn't verify zone access: ${err instanceof Error ? err.message : String(err)}`,
			ok: false,
		};
	}
}

/**
 * Saves the onboarding form's Cloudflare token and zone the new way: a
 * Cloudflare DNS connection, and the base domain as a managed domain in that
 * zone, so services' hostnames get their records like any other domain's.
 * A domain already registered under that name is re-linked instead.
 *
 * @throws When the token can't list its zones.
 */
export async function saveCloudflareFromForm(
	formData: FormData,
	baseDomain: string,
	userId: string,
): Promise<void> {
	const zoneId = nullableText(formData, "cloudflareZoneId");
	const token = secretField(formData, "cloudflareApiToken");
	if (!(zoneId && token && baseDomain)) {
		return;
	}
	const zone = (await cloudflareClient(token).listZones()).find(
		(candidate) => candidate.id === zoneId,
	);
	const connection = await DnsConnectionDTO.create({
		credentials: { apiToken: token },
		name: "Cloudflare",
		provider: "cloudflare",
		userId,
	});
	const link = {
		autoRecords: true,
		connectionId: connection.id,
		target: null,
		zoneId,
		zoneName: zone?.name ?? baseDomain,
	};
	const existing = await DomainDTO.forHostname(baseDomain);
	if (existing && existing.name === baseDomain) {
		await existing.update(link);
		return;
	}
	await DomainDTO.create({
		...link,
		dnsChallenge: false,
		name: baseDomain,
		userId,
	});
}

/**
 * Checks the whole Pangolin configuration typed into a form, not just that the
 * token authenticates: the site must exist and a registered domain must cover
 * `baseDomain`, since without either no resource can ever be created. Falls
 * back to the stored token when the field is blank.
 */
export async function testPangolinFromForm(
	formData: FormData,
	settings: InstanceSettingsDTO,
	baseDomain: string,
): Promise<DnsTestOutcome> {
	const baseUrl = nullableText(formData, "pangolinApiBaseUrl");
	const orgId = nullableText(formData, "pangolinOrgId");
	if (!(baseUrl && orgId)) {
		return {
			error: "Enter an API base URL and org id first.",
			ok: false,
		};
	}
	const token =
		secretField(formData, "pangolinApiToken") ??
		settings.decryptPangolinApiToken();
	if (!token) {
		return { error: "Enter an API token first.", ok: false };
	}
	const result = await PangolinService.verifyConnection({
		baseDomain,
		baseUrl,
		orgId,
		siteName: nullableText(formData, "pangolinMainSiteName"),
		token,
	});
	if (!result.success) {
		return {
			error: result.error ?? "Couldn't verify the Pangolin connection.",
			ok: false,
		};
	}
	return { detail: result.detail ?? null, ok: true };
}
