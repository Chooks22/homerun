import type { IacAttribute, IacKind, IacResource } from "#lib/iac/resources.js";
import { RESOURCE_THRESHOLD_FIELDS } from "#lib/resource-thresholds.js";

/** The import id, and the Terraform id, of every singleton resource. */
export const SINGLETON_ID = "instance";

const SINGLETON_NOTE =
	"There's exactly one: creating the resource adopts it and applies the attributes set, attributes left out keep their current value, and destroying it only removes it from the Terraform state, the instance keeps its settings.";

/** One attribute, its Terraform name the snake_case of its API field. */
function setting(
	name: string,
	kind: IacKind,
	options: Omit<Partial<IacAttribute>, "kind" | "name"> = {},
): IacAttribute {
	return {
		kind,
		name,
		tf: name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
		...options,
	};
}

/** A singleton resource at `path`. */
function singleton(
	type: string,
	path: string,
	description: string,
	attributes: IacAttribute[],
): IacResource {
	return {
		attributes,
		collectionPath: path,
		description: `${description} ${SINGLETON_NOTE}`,
		importId: ["id"],
		itemPath: path,
		label: "id",
		singleton: true,
		type,
	};
}

const secret = { sensitive: true, writeOnly: true };
const readOnly = { readOnly: true };

export const IAC_SETTINGS_RESOURCES: IacResource[] = [
	singleton(
		"homerun_instance_settings",
		"/instance/settings",
		"The instance's General, Docker and Networking settings: base domain, dashboard URL, release channel, resource alerts, image scanning, orchestration mode and Traefik.",
		[
			setting("baseDomain", "string", {
				description:
					"Each service gets a subdomain of it, named after its slug. A bare hostname.",
			}),
			setting("serviceSubdomain", "string", {
				description:
					"One DNS label services' default hostnames go under, `slug.service_subdomain.base_domain`. Left unset, they're `slug.base_domain`.",
			}),
			setting("dashboardUrl", "string", {
				description:
					"The dashboard's URL, an origin with no path or trailing slash. Left unset, it's derived from base_domain.",
			}),
			setting("authCheckUrl", "string"),
			setting("authCrossSubdomainCookies", "bool"),
			setting("updateChannel", "string", {
				description: "stable, canary or nightly.",
			}),
			setting("defaultUiMode", "string", {
				description: "simple or advanced.",
			}),
			...RESOURCE_THRESHOLD_FIELDS.map((name) =>
				setting(name, "int", {
					description: "A usage percentage that alerts, 1 to 100.",
				}),
			),
			setting("resourceAlertSustainSeconds", "int"),
			setting("resourceAlertReminderMinutes", "int"),
			setting("dockerNetworkName", "string"),
			setting("dockerSocketPath", "string"),
			setting("orchestrationMode", "string", {
				description:
					"standalone or swarm. Changing it prepares the host (joins or leaves swarm mode).",
			}),
			setting("imageScanEnabled", "bool"),
			setting("imageScanBlockSeverity", "string", {
				description:
					"CRITICAL, HIGH, MEDIUM or LOW: refuse to deploy an image with a finding this severe or worse.",
			}),
			setting("imageScanBlockFixableOnly", "bool"),
			setting("imageScanRequired", "bool"),
			setting("retainedImagesPerService", "int"),
			setting("traefikAcmeEmail", "string"),
			setting("traefikCertResolver", "string"),
			setting("traefikDynamicConfigDir", "string"),
			setting("traefikEntrypoint", "string"),
			setting("traefikHttpCache", "bool"),
		],
	),
	singleton(
		"homerun_smtp_settings",
		"/instance/smtp",
		"The SMTP server Homerun sends email through: sign-in codes and links, invites, notifications.",
		[
			setting("enabled", "bool"),
			setting("host", "string"),
			setting("port", "int"),
			setting("secure", "bool", { description: "Implicit TLS (port 465)." }),
			setting("username", "string"),
			setting("password", "string", {
				...secret,
				description: "Left unset, the stored password stays.",
			}),
			setting("passwordSet", "bool", readOnly),
			setting("from", "string", { description: "The sender address." }),
		],
	),
	singleton(
		"homerun_authentication_settings",
		"/authentication/settings",
		'How people sign in: the emailed code and link methods, the methods the sign-in page features, and the passkey and two-factor requirements. email_otp is what a service\'s login wall needs to offer "email-otp" in auth_providers, and both emailed methods need SMTP configured (homerun_smtp_settings).',
		[
			setting("emailOtp", "bool", {
				description: "Sign in with a code sent by email.",
			}),
			setting("magicLink", "bool", {
				description: "Sign in with a link sent by email.",
			}),
			setting("preferredSignInMethods", "strings", {
				description:
					"The methods the sign-in page features, in order: password, passkey, or oauth: followed by a provider name.",
			}),
			setting("requirePasskey", "bool"),
			setting("requireTwoFactor", "bool"),
			setting("smtpConfigured", "bool", readOnly),
		],
	),
	singleton(
		"homerun_tls_settings",
		"/instance/tls",
		"The instance certificate Traefik serves for every hostname it covers, instead of asking Let's Encrypt. Removing it is done from the dashboard.",
		[
			setting("certificate", "string", {
				...secret,
				description: "The certificate PEM, chain included.",
			}),
			setting("privateKey", "string", {
				...secret,
				description: "The private key PEM.",
			}),
			setting("installed", "bool", readOnly),
			setting("names", "strings", readOnly),
			setting("issuer", "string", readOnly),
			setting("expiresAt", "string", readOnly),
		],
	),
	singleton(
		"homerun_error_pages",
		"/instance/error-pages",
		"The branded pages Traefik shows instead of its own errors, and the login wall's branding.",
		[
			setting("brandName", "string"),
			setting("accentColor", "string", { description: "Like #8b2942." }),
			setting("logoUrl", "string"),
			setting("showPoweredBy", "bool"),
			setting("pageTexts", "stringMap", {
				description:
					"Titles and messages by key: notReadyTitle, notReadyMessage, unavailableTitle, unavailableMessage, notFoundTitle, notFoundMessage, blockedTitle, blockedMessage. One left out shows the default.",
			}),
		],
	),
	singleton(
		"homerun_ip_ban_settings",
		"/instance/ip-bans",
		"When a client address hitting services' blocked paths gets banned, and the CrowdSec LAPI bans are pushed to.",
		[
			setting("enabled", "bool"),
			setting("threshold", "int", {
				description: "Blocked requests before a ban, 1 to 1000.",
			}),
			setting("windowMinutes", "int"),
			setting("durationHours", "int", {
				description: "How long a ban lasts, 0 for forever.",
			}),
			setting("meanMode", "bool"),
			setting("disrespectMode", "bool"),
			setting("crowdsecUrl", "string"),
			setting("crowdsecMachineId", "string"),
			setting("crowdsecPassword", "string", {
				...secret,
				description: "Left unset, the stored password stays.",
			}),
			setting("crowdsecPasswordSet", "bool", readOnly),
		],
	),
	singleton(
		"homerun_registry_settings",
		"/registry/settings",
		"The built-in Docker registry's auth and public hostname. Each change recreates the registry container and waits for it.",
		[
			setting("authEnabled", "bool", {
				description: "Require a token to push or pull.",
			}),
			setting("publicHost", "string", {
				description:
					"Publish the registry at this hostname through Traefik. Needs auth_enabled.",
			}),
		],
	),
	{
		attributes: [
			setting("username", "string", {
				description:
					"The docker login user: 3 to 32 lowercase letters, digits, dashes or underscores.",
				forceNew: true,
				required: true,
			}),
			setting("secret", "string", {
				description:
					"The docker login password, only known to a token Terraform created: an imported one has none.",
				readOnly: true,
				returnedOnCreate: true,
				sensitive: true,
			}),
		],
		collectionPath: "/registry/tokens",
		description:
			"A token that can push to and pull from the built-in Docker registry, once its auth is on (homerun_registry_settings). Its secret is generated on create and kept in the state, so treat the state as a secret.",
		importId: ["id"],
		itemPath: "/registry/tokens/{id}",
		label: "username",
		type: "homerun_registry_token",
	},
];
