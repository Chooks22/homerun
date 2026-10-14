import { afterEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { TemplateDTO } = await import("../../../src/lib/dto/template-dto");
const { EXTRA_ICONS } = await import("../../../src/lib/icon-library");
const { listIconLibrary } = await import(
	"../../../src/lib/server/icon-library"
);

afterEach(() => {
	restoreStubs();
});

describe("listIconLibrary", () => {
	test("lists the templates' logos as Apps first, then the extra icons they don't already cover", async () => {
		const [shared] = EXTRA_ICONS;
		stub(TemplateDTO, "listBundledIcons", async () => [
			{ icon: "redis.svg", name: "Redis" },
			{ icon: shared.icon, name: "Shared" },
		]);
		const icons = await listIconLibrary();
		expect(icons.slice(0, 2)).toEqual([
			{ group: "Apps", icon: "redis.svg", name: "Redis" },
			{ group: "Apps", icon: shared.icon, name: "Shared" },
		]);
		expect(icons.filter((entry) => entry.icon === shared.icon)).toHaveLength(1);
		expect(icons).toHaveLength(EXTRA_ICONS.length + 1);
	});
});
