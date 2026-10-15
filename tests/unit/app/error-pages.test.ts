import { describe, expect, mock, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const {
	authBranding,
	brandAccentStyle,
	DEFAULT_ERROR_PAGES,
	errorPageKind,
	errorPageTextsFromForm,
	isHexColor,
	renderErrorPage,
	withErrorPageDefaults,
} = await import("../../../src/lib/error-pages");
const { ERROR_PAGES_MIDDLEWARE, errorPagesConfig, errorPagesTarget } =
	await import("../../../src/lib/services/docker/error-pages");
const { buildContainerLabels } = await import(
	"../../../src/lib/services/docker/labels"
);

describe("withErrorPageDefaults", () => {
	test("nothing stored gives the defaults", () => {
		expect(withErrorPageDefaults(null)).toEqual(DEFAULT_ERROR_PAGES);
	});

	test("blank fields and a malformed colour fall back, the rest is kept", () => {
		const settings = withErrorPageDefaults({
			accentColor: "red",
			brandName: "  ",
			logoUrl: "https://acme.test/logo.svg",
			pages: {
				blocked: { message: "", title: "" },
				notFound: { message: "", title: "Lost?" },
				notReady: { message: "Soon.", title: "" },
				unavailable: { message: "", title: "" },
				waking: { message: "", title: "" },
			},
			showPoweredBy: false,
		});
		expect(settings.accentColor).toBeNull();
		expect(settings.brandName).toBe("Homerun");
		expect(settings.logoUrl).toBe("https://acme.test/logo.svg");
		expect(settings.pages.notFound).toEqual({
			message: DEFAULT_ERROR_PAGES.pages.notFound.message,
			title: "Lost?",
		});
		expect(settings.pages.notReady).toEqual({
			message: "Soon.",
			title: DEFAULT_ERROR_PAGES.pages.notReady.title,
		});
		expect(settings.showPoweredBy).toBe(false);
	});
});

describe("errorPageKind", () => {
	test("a 404 on a service's host is on its way, on any other host there's nothing", () => {
		expect(errorPageKind(404, true)).toBe("notReady");
		expect(errorPageKind(404, false)).toBe("notFound");
	});

	test("gateway errors are temporary", () => {
		for (const status of [502, 503, 504]) {
			expect(errorPageKind(status, false)).toBe("unavailable");
		}
	});
});

describe("isHexColor", () => {
	test("only #rrggbb passes", () => {
		expect(isHexColor("#8B2942")).toBe(true);
		expect(isHexColor("#fff")).toBe(false);
		expect(isHexColor("red")).toBe(false);
	});
});

describe("renderErrorPage", () => {
	test("escapes every setting it prints", () => {
		const html = renderErrorPage(
			withErrorPageDefaults({
				brandName: '<script>alert("x")</script>',
				logoUrl: 'https://x.test/a.png" onerror="alert(1)',
				pages: {
					blocked: { message: "", title: "" },
					notFound: { message: "<b>gone</b>", title: "T" },
					notReady: { message: "", title: "" },
					unavailable: { message: "", title: "" },
					waking: { message: "", title: "" },
				},
			}),
			"notFound",
			404,
		);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<b>gone</b>");
		expect(html).not.toContain('" onerror="');
		expect(html).toContain("&lt;b&gt;gone&lt;/b&gt;");
	});

	test("pages that should clear on their own reload themselves", () => {
		const settings = withErrorPageDefaults(null);
		expect(renderErrorPage(settings, "notReady", 404)).toContain(
			'http-equiv="refresh"',
		);
		expect(renderErrorPage(settings, "unavailable", 503)).toContain(
			'http-equiv="refresh"',
		);
		expect(renderErrorPage(settings, "notFound", 404)).not.toContain(
			'http-equiv="refresh"',
		);
	});

	test("the waking page reloads every two seconds", () => {
		const html = renderErrorPage(withErrorPageDefaults(null), "waking", 503);
		expect(html).toContain('http-equiv="refresh" content="2"');
		expect(html).toContain("Waking up");
	});

	test("Powered by Homerun only shows under another brand", () => {
		expect(
			renderErrorPage(withErrorPageDefaults(null), "notFound", 404),
		).not.toContain("Powered by");
		expect(
			renderErrorPage(
				withErrorPageDefaults({ brandName: "Acme" }),
				"notFound",
				404,
			),
		).toContain('Powered by <a href="https://orochibraru.com/homerun"');
		expect(
			renderErrorPage(
				withErrorPageDefaults({ brandName: "Acme", showPoweredBy: false }),
				"notFound",
				404,
			),
		).not.toContain("Powered by");
	});

	test("a logo replaces the built-in mark and the custom accent is used", () => {
		const html = renderErrorPage(
			withErrorPageDefaults({
				accentColor: "#123456",
				logoUrl: "https://acme.test/logo.svg",
			}),
			"unavailable",
			502,
		);
		expect(html).toContain(
			'<img class="logo" src="https://acme.test/logo.svg"',
		);
		expect(html).not.toContain('class="mark"');
		expect(html).toContain("--accent:#123456");
		expect(html).toContain("502");
	});
});

describe("authBranding", () => {
	test("Homerun's own look brands nothing", () => {
		expect(authBranding(withErrorPageDefaults(null))).toBeNull();
	});

	test("a logo or accent alone brands the pages, crediting nobody", () => {
		expect(
			authBranding(withErrorPageDefaults({ accentColor: "#123456" })),
		).toEqual({
			accentColor: "#123456",
			brandName: "Homerun",
			logoUrl: null,
			poweredBy: false,
		});
	});

	test("another brand credits Homerun unless turned off", () => {
		expect(
			authBranding(withErrorPageDefaults({ brandName: "Acme" }))?.poweredBy,
		).toBe(true);
		expect(
			authBranding(
				withErrorPageDefaults({ brandName: "Acme", showPoweredBy: false }),
			)?.poweredBy,
		).toBe(false);
	});
});

describe("brandAccentStyle", () => {
	test("repaints the accent tokens only for a valid colour", () => {
		const branding = {
			accentColor: "#123456",
			brandName: "Acme",
			logoUrl: null,
			poweredBy: true,
		};
		expect(brandAccentStyle(branding)).toContain("--color-accent:#123456");
		expect(brandAccentStyle(branding)).toContain("--primary:#123456");
		expect(brandAccentStyle({ ...branding, accentColor: "red;x:y" })).toBe("");
		expect(brandAccentStyle({ ...branding, accentColor: null })).toBe("");
		expect(brandAccentStyle(null)).toBe("");
	});
});

describe("errorPageTextsFromForm", () => {
	test("reads every page's fields, trimmed and capped", () => {
		const form = new FormData();
		form.set("notReadyTitle", "  Hold on ");
		form.set("notReadyMessage", "x".repeat(500));
		const pages = errorPageTextsFromForm(form);
		expect(pages.notReady.title).toBe("Hold on");
		expect(pages.notReady.message).toHaveLength(400);
		expect(pages.notFound).toEqual({ message: "", title: "" });
	});
});

describe("Traefik error pages config", () => {
	test("targets the forwardAuth origin", () => {
		expect(errorPagesTarget("http://homerun-auth:3000/api/v1/auth-check")).toBe(
			"http://homerun-auth:3000",
		);
		expect(errorPagesTarget("not a url")).toBeNull();
	});

	test("defines a lowest-priority catch-all and the gateway errors middleware", () => {
		const yaml = errorPagesConfig({
			entrypoint: "websecure",
			proof: "p",
			target: "http://homerun-auth:3000",
		});
		expect(yaml).toContain("rule: PathPrefix(`/`)");
		expect(yaml).toContain("priority: 1");
		expect(yaml).toContain("- websecure");
		expect(yaml).toContain("path: /homerun-error/404");
		expect(yaml).toContain('- "502-504"');
		expect(yaml).toContain("query: /homerun-error/{status}");
		expect(yaml).toContain("- url: http://homerun-auth:3000");
	});

	test("a service's routers carry the middleware first, only when asked", () => {
		const base = {
			containerPort: 80,
			serviceId: "svc",
			slug: "app",
		};
		expect(
			buildContainerLabels({ ...base, errorPages: true })[
				"traefik.http.routers.app.middlewares"
			],
		).toBe(`${ERROR_PAGES_MIDDLEWARE},app-retry`);
		expect(
			buildContainerLabels(base)["traefik.http.routers.app.middlewares"],
		).toBe("app-retry");
	});
});
