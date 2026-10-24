import { applyInstanceSettings } from "#lib/config.js";
import type { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { AcmeDnsService } from "#lib/services/acme-dns.service.js";
import { rebuildAuth } from "#lib/services/auth.js";
import { syncDashboardDns } from "#lib/services/dns.service.js";
import { syncErrorPages } from "#lib/services/docker/error-pages.js";
import { DockerService } from "#lib/services/docker.service.js";
import { IpBanService } from "#lib/services/ip-ban.service.js";
import { RedirectService } from "#lib/services/redirect.service.js";

/** A trimmed text field from the form, or null when it is missing or blank. */
export function nullableText(formData: FormData, key: string): string | null {
	const value = (formData.get(key) as string | null)?.trim();
	return value ? value : null;
}

/** Whether a checkbox field was ticked. */
export function checkbox(formData: FormData, key: string): boolean {
	return formData.get(key) === "on";
}

/**
 * Applies freshly saved instance settings to the running process : merges them
 * into the live config, rebuilds the auth instance, and resyncs the dashboard's
 * Traefik router, the error pages config, DNS record and Newt container in the background without
 * waiting for any of them.
 */
export function applyAndRebuild(settings: InstanceSettingsDTO) {
	applyInstanceSettings(settings.toConfigOverride());
	rebuildAuth();
	void DockerService.syncDashboardRouter();
	void AcmeDnsService.syncRouters();
	void syncErrorPages();
	void RedirectService.sync();
	void IpBanService.sync();
	void syncDashboardDns();
	void DockerService.syncNewt(
		settings.newtCredentials(),
		settings.orchestrationMode === "swarm",
	);
}
