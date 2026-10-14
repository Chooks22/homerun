import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { RedirectDTO } = await import("../../../src/lib/dto/redirect-dto");
const { StatusPageDTO } = await import("../../../src/lib/dto/status-page-dto");
const { parseRedirectInput } = await import(
	"../../../src/lib/server/redirect-form"
);

const originalOrigin = config.auth.origin;

beforeEach(() => {
	config.auth.origin = "https://homerun.example.com";
	stub(InstanceSettingsDTO, "get", async () => ({
		toJSON: () => ({ garagePublicHost: "s3.example.com" }),
	}));
	stub(StatusPageDTO, "list", async () => [
		{ domains: ["status.example.com"], name: "Status" },
	]);
	stub(RedirectDTO, "getBySource", async () => null);
});

afterEach(() => {
	restoreStubs();
	config.auth.origin = originalOrigin;
});

function input(source: string) {
	return {
		destination: "https://elsewhere.example.org",
		enabled: "on",
		keepPath: "on",
		permanent: "on",
		source,
	};
}

describe("parseRedirectInput", () => {
	test("refuses the dashboard's host, a core service's public host and a status page domain", async () => {
		expect(await parseRedirectInput(input("homerun.example.com/old"))).toEqual({
			error:
				"homerun.example.com belongs to the Homerun dashboard, it can't be redirected.",
		});
		expect(await parseRedirectInput(input("s3.example.com"))).toEqual({
			error:
				"s3.example.com belongs to object storage, it can't be redirected.",
		});
		expect(await parseRedirectInput(input("status.example.com"))).toEqual({
			error:
				'status.example.com belongs to the status page "Status", it can\'t be redirected.',
		});
	});

	test("accepts any other host", async () => {
		const result = await parseRedirectInput(input("old.example.com"));
		expect(result).toHaveProperty("fields");
	});
});
