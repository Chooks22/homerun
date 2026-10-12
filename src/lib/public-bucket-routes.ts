export const PUBLIC_BUCKETS_FILE = "homerun-public-buckets.yml";

export const PUBLIC_BUCKET_ROUTER_PRIORITY = 9300;

export const PUBLIC_BUCKET_SERVICE = "homerun-public-buckets";

const ANONYMOUS_READ = [
	"(Method(`GET`) || Method(`HEAD`))",
	"!HeaderRegexp(`Authorization`, `.+`)",
	"!QueryRegexp(`X-Amz-Signature`, `.+`)",
].join(" && ");

/**
 * The URL a public bucket's objects are served under, ending in "/": the
 * built-in store's own S3 hostname when it's published, so links look like
 * plain path-style S3 URLs, this instance's `/public/` route otherwise.
 */
export function publicBucketUrl(params: {
	bucket: string;
	origin: string;
	publicHost: string | null;
	storeId: string;
	storeKind: string;
}): string {
	const bucket = encodeURIComponent(params.bucket);
	return params.storeKind === "garage" && params.publicHost
		? `https://${params.publicHost}/${bucket}/`
		: `${params.origin}/public/${params.storeId}/${bucket}/`;
}

/**
 * The Traefik dynamic config serving the built-in store's public buckets at
 * its published S3 hostname: per bucket, a router that outranks Garage's own
 * label router for unsigned GET/HEAD requests under `/<bucket>/` only, and
 * prefixes them onto this app's `/public/<storeId>` route, so signed S3
 * calls still reach Garage untouched. Null when there's no host or no public
 * bucket.
 */
export function publicBucketsConfig(params: {
	buckets: string[];
	certResolver: string | null;
	entrypoint: string;
	host: string | null;
	storeId: string;
	target: string;
}): string | null {
	if (!params.host || params.buckets.length === 0) {
		return null;
	}
	const prefix = "homerun-public-bucket-prefix";
	const tls = params.certResolver
		? `      tls:\n        certResolver: ${params.certResolver}`
		: "      tls: {}";
	const routers = [...params.buckets]
		.sort()
		.flatMap((bucket, index) => [
			`    homerun-public-bucket-${index}:`,
			`      rule: Host(\`${params.host}\`) && PathPrefix(\`/${bucket}/\`) && ${ANONYMOUS_READ}`,
			`      priority: ${PUBLIC_BUCKET_ROUTER_PRIORITY}`,
			"      entryPoints:",
			`        - ${params.entrypoint}`,
			"      middlewares:",
			`        - ${prefix}`,
			`      service: ${PUBLIC_BUCKET_SERVICE}`,
			tls,
		]);
	return [
		"http:",
		"  routers:",
		...routers,
		"  middlewares:",
		`    ${prefix}:`,
		"      addPrefix:",
		`        prefix: /public/${params.storeId}`,
		"  services:",
		`    ${PUBLIC_BUCKET_SERVICE}:`,
		"      loadBalancer:",
		"        servers:",
		`          - url: ${params.target}`,
		"",
	].join("\n");
}
