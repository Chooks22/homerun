import { describe, expect, test } from "bun:test";
import {
	configFromImage,
	detectedFrom,
	hasDetected,
	overridableEnv,
	parseDockerfile,
	primaryPort,
	withManifest,
} from "#lib/image-config.js";

const MULTI_STAGE = `# syntax=docker/dockerfile:1
ARG NODE=22
FROM node:\${NODE} AS build
WORKDIR /src
EXPOSE 9999
RUN npm ci && \\
    npm run build

FROM build AS runtime
ARG PORT=3000
ENV NODE_ENV=production \\
    APP_PORT=\${PORT} \\
    GREETING="hello world"
ENV LEGACY some value
WORKDIR app
EXPOSE \${PORT}/tcp 5353/udp 7000-7010
VOLUME ["/data", "/cache"]
VOLUME /logs
USER node
RUN <<SCRIPT
EXPOSE 1234
SCRIPT
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:\${PORT}/ || exit 1
CMD ["node", "dist/server.js"]

FROM alpine AS other
EXPOSE 8080
`;

describe("parseDockerfile", () => {
	test("reads the last stage, which knows nothing of the earlier ones", () => {
		const config = parseDockerfile(MULTI_STAGE);
		expect(config.ports).toEqual([{ port: 8080, protocol: "tcp" }]);
		expect(config.volumes).toEqual([]);
		expect(config.source).toBe("dockerfile");
	});

	test("reads a target stage, inheriting from the stage it's built from", () => {
		const config = parseDockerfile(MULTI_STAGE, "runtime");
		expect(config.ports).toEqual([
			{ port: 9999, protocol: "tcp" },
			{ port: 3000, protocol: "tcp" },
			{ port: 5353, protocol: "udp" },
			{ port: 7000, protocol: "tcp" },
		]);
		expect(config.volumes).toEqual(["/data", "/cache", "/logs"]);
		expect(config.env).toEqual({
			APP_PORT: "3000",
			GREETING: "hello world",
			LEGACY: "some value",
			NODE_ENV: "production",
		});
		expect(config.workdir).toBe("/src/app");
		expect(config.user).toBe("node");
		expect(config.healthcheck).toBe(
			"curl -f http://localhost:${PORT}/ || exit 1",
		);
		expect(config.command).toEqual(["node", "dist/server.js"]);
	});

	test("shell-form commands, and an entrypoint resetting an inherited command", () => {
		const config = parseDockerfile(
			'FROM a AS base\nCMD echo hi\nFROM base\nENTRYPOINT ["/entry"]\nHEALTHCHECK NONE\n',
		);
		expect(config.entrypoint).toEqual(["/entry"]);
		expect(config.command).toBeNull();
		expect(config.healthcheck).toBe("NONE");
		expect(parseDockerfile("FROM a\nCMD echo hi\n").command).toEqual([
			"/bin/sh",
			"-c",
			"echo hi",
		]);
		expect(
			parseDockerfile('FROM a\nCMD ["x"]\nENTRYPOINT ["/e"]\n').command,
		).toEqual(["x"]);
	});

	test("default values and unknown variables", () => {
		const config = parseDockerfile(
			"FROM a\nEXPOSE ${PORT:-8000} $MISSING\nVOLUME ${DIR:-/srv}\n",
		);
		expect(config.ports).toEqual([{ port: 8000, protocol: "tcp" }]);
		expect(config.volumes).toEqual(["/srv"]);
	});

	test("garbage parses to nothing", () => {
		expect(hasDetected(parseDockerfile("not a dockerfile\n\n"))).toBe(false);
		expect(hasDetected(parseDockerfile(""))).toBe(false);
	});
});

describe("configFromImage", () => {
	test("maps an OCI config", () => {
		const config = configFromImage({
			Cmd: ["nginx", "-g", "daemon off;"],
			Env: ["PATH=/usr/bin", "NGINX_VERSION=1.27", "MODE=prod"],
			ExposedPorts: { "53/udp": {}, "80/tcp": {} },
			Healthcheck: { Test: ["CMD-SHELL", "curl -f localhost"] },
			User: "",
			Volumes: { "/var/cache/nginx": {} },
			WorkingDir: "/",
		});
		expect(primaryPort(config)).toEqual({ port: 80, protocol: "tcp" });
		expect(config.volumes).toEqual(["/var/cache/nginx"]);
		expect(config.healthcheck).toBe("curl -f localhost");
		expect(config.user).toBeNull();
		expect(config.source).toBe("image");
		expect(overridableEnv(config.env)).toEqual({ MODE: "prod" });
	});

	test("an empty config", () => {
		expect(hasDetected(configFromImage(null))).toBe(false);
		expect(primaryPort(configFromImage({}))).toBeNull();
	});
});

describe("withManifest", () => {
	const dockerfile = parseDockerfile(
		'FROM a\nEXPOSE 8080\nENV MODE=dev KEEP=1\nUSER app\nCMD ["serve"]\n',
	);

	test("the manifest wins for what it sets and lists the rest", () => {
		const config = withManifest(dockerfile, {
			errors: [],
			manifest: {
				containerPort: 3000,
				envVars: { MODE: "prod" },
				healthcheckCommand: "curl -f localhost:3000",
				memoryLimitMb: 512,
				runAsUser: "1000",
			},
			path: "apps/web/.homerun.json",
		});
		expect(primaryPort(config)).toEqual({ port: 3000, protocol: "tcp" });
		expect(config.ports).toHaveLength(2);
		expect(config.env).toEqual({ KEEP: "1", MODE: "prod" });
		expect(config.healthcheck).toBe("curl -f localhost:3000");
		expect(config.user).toBe("1000");
		expect(config.command).toEqual(["serve"]);
		expect(config.manifest).toEqual({
			errors: [],
			keys: ["memoryLimitMb"],
			path: "apps/web/.homerun.json",
		});
		expect(detectedFrom(config)).toBe(".homerun.json and the Dockerfile");
	});

	test("a manifest alone, and an invalid one", () => {
		const alone = withManifest(null, {
			errors: [],
			manifest: { healthcheckDisabled: true, portProtocol: "both" },
			path: ".homerun.yaml",
		});
		expect(alone.healthcheck).toBe("NONE");
		expect(alone.ports).toEqual([]);
		expect(detectedFrom(alone)).toBe(".homerun.yaml");
		const broken = withManifest(dockerfile, {
			errors: ["containerPort: too big"],
			manifest: null,
			path: ".homerun.json",
		});
		expect(hasDetected(broken)).toBe(true);
		expect(broken.manifest?.errors).toEqual(["containerPort: too big"]);
		expect(broken.ports).toEqual(dockerfile.ports);
		expect(detectedFrom(dockerfile)).toBe("the Dockerfile");
		expect(detectedFrom(configFromImage({}))).toBe("the image");
	});
});
