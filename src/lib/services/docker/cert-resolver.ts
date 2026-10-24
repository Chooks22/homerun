import {
	challengeDomainFor,
	DNS_CHALLENGE_RESOLVER,
	wildcardNames,
} from "#lib/acme-dns.js";
import { config, serviceDomain } from "#lib/config.js";
import { certificateCovers } from "#lib/tls-certificate.js";

const IPV4_HOST_RE = /(^|\.)\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_HOST_RE = /(^|\.)localhost$/;

/**
 * The Traefik cert resolver to attach to a router for `host`, or null when
 * none should be : behind Pangolin (which terminates TLS itself), no
 * resolver configured, `host` is covered by the instance certificate
 * (`instanceCertNames`, served as Traefik's default, which a resolver would
 * override), `host` is a bare hostname/IPv4/`localhost` that ACME could
 * never issue a certificate for anyway, or the wildcard certificate of one of
 * the DNS-challenge domains (`config.traefik.dnsChallengeDomains`) covers it. A deeper name
 * under such a domain gets the DNS-01 resolver.
 */
export function certResolverFor(
	host: string,
	resolver: string,
	behindPangolin: boolean,
	instanceCertNames: string[] = [],
): string | null {
	if (
		behindPangolin ||
		certificateCovers(instanceCertNames, host) ||
		!resolver ||
		!host.includes(".") ||
		IPV4_HOST_RE.test(host) ||
		LOCAL_HOST_RE.test(host)
	) {
		return null;
	}
	const dnsDomain = challengeDomainFor(
		host,
		config.traefik.dnsChallengeDomains,
	);
	if (!dnsDomain) {
		return resolver;
	}
	if (certificateCovers(wildcardNames(dnsDomain, serviceDomain()), host)) {
		return null;
	}
	return DNS_CHALLENGE_RESOLVER;
}
