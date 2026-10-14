import { config, serviceDomain } from "#lib/config.js";
import {
	type ServiceDomainFields,
	serviceHostnames,
	splitDomain,
} from "#lib/service-domains.js";
import { isDatabaseImage } from "#lib/service-link.js";
import { certResolverFor } from "../docker/cert-resolver.ts";

/** A deploy whose workload started but whose route through Traefik doesn't answer: the new workload runs, visitors can't reach it. */
export class RouteCheckFailedError extends Error {}

export interface RouteHostSpec {
	certResolver: boolean;
	host: string;
	path: string;
	port: number;
	public: boolean;
}

export interface RouteSpec {
	entrypoint: string;
	errorPages: boolean;
	hosts: RouteHostSpec[];
}

/**
 * What the worker's route check probes once the workload runs: every
 * hostname a Traefik router serves for the service, the container port its
 * router sends it to, whether the local Traefik issues its certificate, and
 * whether DNS automation or Pangolin points it here (`publicHosts`), which
 * makes its public URL worth probing too. Null when there's no HTTP route
 * to check: not DNS resolvable, host networking, a UDP-only port, a database
 * image (which never answers HTTP), or no hostname.
 */
export function routeSpec(params: {
	errorPages: boolean;
	publicHosts: ReadonlySet<string>;
	routed: boolean;
	stackSlug: string | null | undefined;
	svc: ServiceDomainFields & {
		containerPort: number;
		domainPorts: Record<string, number>;
		image: string;
		portProtocol: string | null;
	};
}): RouteSpec | null {
	const { svc } = params;
	if (
		!params.routed ||
		svc.portProtocol === "udp" ||
		isDatabaseImage(svc.image)
	) {
		return null;
	}
	const hosts = serviceHostnames(svc, params.stackSlug, serviceDomain()).map(
		(entry) => {
			const { host, path } = splitDomain(entry);
			return {
				certResolver: Boolean(
					certResolverFor(
						host,
						config.traefik.certResolver,
						config.pangolinEnabled,
						config.traefik.instanceCertNames,
					),
				),
				host,
				path,
				port: svc.domainPorts[entry] ?? svc.containerPort,
				public: params.publicHosts.has(host),
			};
		},
	);
	if (hosts.length === 0) {
		return null;
	}
	return {
		entrypoint: config.traefik.entrypoint,
		errorPages: params.errorPages,
		hosts,
	};
}
