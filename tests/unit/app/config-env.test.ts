import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
	applyInstanceSettings,
	config,
	configFilePath,
	envDefaultsForDisplay,
	firstNonBlank,
	isPlaceholderAuthSecret,
	isSmtpEnabled,
	parseConfig,
	serviceDomain,
	setDetectedAuthCheckUrl,
	yamlConfigSchema,
} from "../../../src/lib/config";

const saved = {
	AUTH_SECRET: Bun.env.AUTH_SECRET,
	BETTER_AUTH_SECRET: Bun.env.BETTER_AUTH_SECRET,
	CONFIG_FILE: Bun.env.CONFIG_FILE,
	DOCKER_HOST: Bun.env.DOCKER_HOST,
	ORIGIN: Bun.env.ORIGIN,
	PORT: Bun.env.PORT,
	TRAEFIK_DYNAMIC_CONFIG_DIR: Bun.env.TRAEFIK_DYNAMIC_CONFIG_DIR,
};

function writeConfig(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "homerun-config-"));
	const file = join(dir, "homerun.yaml");
	writeFileSync(file, contents);
	return file;
}

function spawnResult(exitCode: number, stdout: string) {
	return { exitCode, stdout: Buffer.from(stdout) } as unknown as ReturnType<
		typeof Bun.spawnSync
	>;
}

function setEnv(name: keyof typeof saved, value: string | undefined) {
	if (value === undefined) {
		delete Bun.env[name];
	} else {
		Bun.env[name] = value;
	}
}

afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		setEnv(name as keyof typeof saved, value);
	}
	applyInstanceSettings({});
});

describe("firstNonBlank", () => {
	test("skips unset, empty and whitespace-only values", () => {
		expect(firstNonBlank(undefined, "", "  ", "real")).toBe("real");
		expect(firstNonBlank("", " \t")).toBeUndefined();
		expect(firstNonBlank()).toBeUndefined();
	});
});

describe("auth secret", () => {
	test("an empty AUTH_SECRET falls through to BETTER_AUTH_SECRET", () => {
		setEnv("AUTH_SECRET", "");
		setEnv("BETTER_AUTH_SECRET", "from-better-auth");
		expect(parseConfig().auth.secret).toBe("from-better-auth");
	});

	test("both blank falls back to the placeholder, which is flagged", () => {
		setEnv("AUTH_SECRET", "   ");
		setEnv("BETTER_AUTH_SECRET", "");
		const secret = parseConfig().auth.secret;
		expect(secret).toBe("default-secret");
		expect(isPlaceholderAuthSecret(secret)).toBe(true);
	});

	test("a real secret isn't flagged, a blank one is", () => {
		expect(isPlaceholderAuthSecret("a-real-secret")).toBe(false);
		expect(isPlaceholderAuthSecret("")).toBe(true);
		expect(isPlaceholderAuthSecret(" ")).toBe(true);
		expect(isPlaceholderAuthSecret(undefined)).toBe(true);
	});

	test("an empty ORIGIN counts as unset", () => {
		setEnv("ORIGIN", "");
		expect(parseConfig().auth.origin).toBeUndefined();
	});
});

describe("traefik.dynamicConfigDir", () => {
	test("falls back to TRAEFIK_DYNAMIC_CONFIG_DIR when the file doesn't set it", () => {
		setEnv("CONFIG_FILE", join(tmpdir(), "homerun-missing-config.yaml"));
		setEnv("TRAEFIK_DYNAMIC_CONFIG_DIR", "/app/traefik-dynamic");
		expect(parseConfig().traefik.dynamicConfigDir).toBe("/app/traefik-dynamic");
	});

	test("the config file wins over the env var", () => {
		const dir = mkdtempSync(join(tmpdir(), "homerun-config-"));
		const file = join(dir, "homerun.yaml");
		writeFileSync(file, "traefik:\n  dynamicConfigDir: /from/file\n");
		setEnv("CONFIG_FILE", file);
		setEnv("TRAEFIK_DYNAMIC_CONFIG_DIR", "/from/env");
		expect(parseConfig().traefik.dynamicConfigDir).toBe("/from/file");
	});

	test("a blank env var counts as unset", () => {
		setEnv("CONFIG_FILE", join(tmpdir(), "homerun-missing-config.yaml"));
		setEnv("TRAEFIK_DYNAMIC_CONFIG_DIR", " ");
		expect(parseConfig().traefik.dynamicConfigDir).toBeUndefined();
	});
});

describe("auth.oauthProviders", () => {
	test("isn't part of the YAML schema", () => {
		expect(
			Object.keys(yamlConfigSchema.shape.auth.unwrap().shape),
		).not.toContain("oauthProviders");
	});

	test("a leftover file value is ignored, the DB list is what applies", () => {
		const dir = mkdtempSync(join(tmpdir(), "homerun-config-"));
		const file = join(dir, "homerun.yaml");
		writeFileSync(
			file,
			[
				"auth:",
				"  oauthProviders:",
				"    - name: from-file",
				"      clientId: id",
				"      clientSecret: secret",
				"      discoveryUrl: https://idp.example.com/.well-known/openid-configuration",
			].join("\n"),
		);
		setEnv("CONFIG_FILE", file);
		expect(parseConfig().auth.oauthProviders).toEqual([]);

		applyInstanceSettings({ oauthProviders: [] });
		expect(config.auth.oauthProviders).toEqual([]);
	});
});

describe("config file", () => {
	test("CONFIG_FILE picks the path, relative to cwd", () => {
		setEnv("CONFIG_FILE", "conf/custom.yaml");
		expect(configFilePath()).toBe(join(process.cwd(), "conf/custom.yaml"));
	});

	test("an invalid file is rejected with the path in the message", () => {
		const file = writeConfig("logLevel: loud\n");
		setEnv("CONFIG_FILE", file);
		expect(() => parseConfig()).toThrow(`Invalid config file ${file}`);
	});

	test("an empty file is the same as no file", () => {
		setEnv("CONFIG_FILE", writeConfig(""));
		expect(parseConfig().baseDomain).toBe("localhost");
	});

	test("the default auth check URL follows PORT, a file value wins", () => {
		setEnv("CONFIG_FILE", join(tmpdir(), "homerun-missing-config.yaml"));
		setEnv("PORT", "4100");
		const parsed = parseConfig();
		expect(parsed.port).toBe(4100);
		expect(parsed.authCheckUrl).toBe(
			"http://host.docker.internal:4100/api/v1/auth-check",
		);
		setEnv("CONFIG_FILE", writeConfig("authCheckUrl: http://custom/check\n"));
		expect(parseConfig().authCheckUrl).toBe("http://custom/check");
	});
});

describe("docker socket detection", () => {
	test("an explicit socketPath is used as-is", () => {
		setEnv("CONFIG_FILE", writeConfig("docker:\n  socketPath: /x.sock\n"));
		setEnv("DOCKER_HOST", "unix:///ignored.sock");
		expect(parseConfig().docker.socketPath).toBe("/x.sock");
	});

	test("DOCKER_HOST wins when it's a unix socket", () => {
		setEnv("CONFIG_FILE", join(tmpdir(), "homerun-missing-config.yaml"));
		setEnv("DOCKER_HOST", "unix:///run/user/1000/docker.sock");
		expect(parseConfig().docker.socketPath).toBe("/run/user/1000/docker.sock");
	});

	test("then the current docker context", () => {
		setEnv("CONFIG_FILE", join(tmpdir(), "homerun-missing-config.yaml"));
		setEnv("DOCKER_HOST", "tcp://remote:2375");
		const spawn = spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(0, "unix:///ctx/docker.sock\n"),
		);
		try {
			expect(parseConfig().docker.socketPath).toBe("/ctx/docker.sock");
		} finally {
			spawn.mockRestore();
		}
	});

	test("then a known socket path, else the classic default", () => {
		setEnv("CONFIG_FILE", join(tmpdir(), "homerun-missing-config.yaml"));
		setEnv("DOCKER_HOST", undefined);
		const candidates = [
			"/var/run/docker.sock",
			`${homedir()}/.orbstack/run/docker.sock`,
			`${homedir()}/.docker/run/docker.sock`,
			`${homedir()}/.colima/default/docker.sock`,
		];
		const spawn = spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(0, "tcp://remote:2375"),
		);
		try {
			expect(candidates).toContain(parseConfig().docker.socketPath);
			spawn.mockReturnValue(spawnResult(1, ""));
			expect(candidates).toContain(parseConfig().docker.socketPath);
			spawn.mockImplementation(() => {
				throw new Error("docker: not found");
			});
			expect(candidates).toContain(parseConfig().docker.socketPath);
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("instance settings", () => {
	test("a DB override applies, and clearing it reverts to the file defaults", () => {
		const defaults = envDefaultsForDisplay();
		applyInstanceSettings({
			baseDomain: "apps.example.com:8443",
			dockerNetworkName: "custom-net",
			pangolinEnabled: true,
			smtpHost: "smtp.example.com",
			traefikEntrypoint: "web",
		});
		expect(config.baseDomain).toBe("apps.example.com");
		expect(config.docker.networkName).toBe("custom-net");
		expect(config.pangolinEnabled).toBe(true);
		expect(config.smtp.host).toBe("smtp.example.com");
		expect(config.traefik.entrypoint).toBe("web");

		applyInstanceSettings({});
		expect(config.baseDomain).toBe(defaults.baseDomain);
		expect(config.docker.networkName).toBe(defaults.dockerNetworkName);
		expect(config.pangolinEnabled).toBe(false);
		expect(config.traefik.entrypoint).toBe(defaults.traefikEntrypoint);
	});

	test("services live under the base domain, or the services subdomain once set", () => {
		applyInstanceSettings({ baseDomain: "example.com" });
		expect(serviceDomain()).toBe("example.com");
		applyInstanceSettings({
			baseDomain: "example.com",
			serviceSubdomain: "apps",
		});
		expect(serviceDomain()).toBe("apps.example.com");
		applyInstanceSettings({});
		expect(config.serviceSubdomain).toBe("");
	});

	test("the display defaults never include secrets", () => {
		const defaults = envDefaultsForDisplay() as Record<string, unknown>;
		expect(defaults).not.toHaveProperty("smtpPassword");
		expect(defaults).not.toHaveProperty("authSecret");
		expect(defaults.traefikCertResolver).toBe("letsencrypt");
	});

	test("a detected auth check URL becomes the default", () => {
		const original = envDefaultsForDisplay().authCheckUrl;
		try {
			setDetectedAuthCheckUrl("http://homerun:3000/api/v1/auth-check");
			applyInstanceSettings({});
			expect(config.authCheckUrl).toBe("http://homerun:3000/api/v1/auth-check");
			applyInstanceSettings({ authCheckUrl: "http://override/check" });
			expect(config.authCheckUrl).toBe("http://override/check");
		} finally {
			setDetectedAuthCheckUrl(original);
		}
	});
});

describe("isSmtpEnabled", () => {
	const complete = {
		smtpEnabled: true,
		smtpFrom: "homerun@example.com",
		smtpHost: "smtp.example.com",
		smtpPassword: "pw",
		smtpPort: 587,
		smtpUser: "user",
	};

	test("needs every field when enabled", () => {
		applyInstanceSettings(complete);
		expect(isSmtpEnabled()).toBe(true);
	});

	test("disabled is off", () => {
		applyInstanceSettings({ ...complete, smtpEnabled: false });
		expect(isSmtpEnabled()).toBe(false);
	});

	test("enabled but incomplete is off, with a warning", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			applyInstanceSettings({
				smtpEnabled: true,
				smtpHost: "smtp.example.com",
			});
			expect(isSmtpEnabled()).toBe(false);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});
