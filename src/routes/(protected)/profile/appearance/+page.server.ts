import { fail } from "@sveltejs/kit";
import { UserPreferencesDTO } from "#lib/dto/user-preferences-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	colorsSchema,
	perPageSchema,
	presetSchema,
	surfaceSchema,
	tabLayoutSchema,
	themeSchema,
	uiModeSchema,
} from "#lib/server/validation/appearance.js";

const logger = new Logger("Appearance");

export const actions = {
	/** Saves the account's UI mode, or clears it to follow the instance default. */
	updateUiMode: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const parsed = uiModeSchema.safeParse(
			Object.fromEntries(await request.formData()),
		);
		if (!parsed.success) {
			return fail(400, {
				error: "Pick simple, advanced or the instance default.",
			});
		}
		const prefs = await UserPreferencesDTO.get(locals.user.id);
		await prefs.updateUiMode(parsed.data.uiMode || null);
		logger.info("UI mode updated", { userId: locals.user.id });
		return { success: true };
	},

	/** Saves the site-wide light/dark/system preference. */
	updateTheme: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const parsed = themeSchema.safeParse(
			Object.fromEntries(await request.formData()),
		);
		if (!parsed.success) {
			return fail(400, { error: "Pick a valid theme." });
		}
		const prefs = await UserPreferencesDTO.get(locals.user.id);
		await prefs.updateTheme(parsed.data.theme);
		logger.info("Theme preference updated", { userId: locals.user.id });
		return { success: true };
	},

	/** Saves the preset that overrides theme, style and colors, or clears it. */
	updatePreset: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const parsed = presetSchema.safeParse(
			Object.fromEntries(await request.formData()),
		);
		if (!parsed.success) {
			return fail(400, { error: "Pick one of the listed presets." });
		}
		const prefs = await UserPreferencesDTO.get(locals.user.id);
		await prefs.updatePreset(parsed.data.preset || null);
		logger.info("Preset updated", { userId: locals.user.id });
		return { success: true };
	},

	/** Saves the surface style panels and buttons are drawn in. */
	updateSurface: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const parsed = surfaceSchema.safeParse(
			Object.fromEntries(await request.formData()),
		);
		if (!parsed.success) {
			return fail(400, { error: "Pick one of the listed styles." });
		}
		const prefs = await UserPreferencesDTO.get(locals.user.id);
		await prefs.updateSurfaceStyle(parsed.data.surfaceStyle);
		logger.info("Surface style updated", { userId: locals.user.id });
		return { success: true };
	},

	/** Saves the palette, the custom accent colour, or the built-in default. */
	updateColors: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const parsed = colorsSchema.safeParse(
			Object.fromEntries(await request.formData()),
		);
		if (!parsed.success) {
			return fail(400, { error: "Pick a palette or a valid color." });
		}
		const prefs = await UserPreferencesDTO.get(locals.user.id);
		const choice = parsed.data;
		if (choice.palette === "") {
			await prefs.updateColors(null);
		} else if (choice.palette === "custom" && "accentColor" in choice) {
			await prefs.updateColors({ accentColor: choice.accentColor });
		} else {
			await prefs.updateColors({ palette: choice.palette });
		}
		logger.info("Colors updated", { userId: locals.user.id });
		return { success: true };
	},

	/** Saves whether page tabs sit above the page or in a column beside it. */
	updateTabLayout: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const parsed = tabLayoutSchema.safeParse(
			Object.fromEntries(await request.formData()),
		);
		if (!parsed.success) {
			return fail(400, { error: "Pick above the page or beside it." });
		}
		const prefs = await UserPreferencesDTO.get(locals.user.id);
		await prefs.updateTabLayout(parsed.data.tabLayout);
		logger.info("Tab layout updated", { userId: locals.user.id });
		return { success: true };
	},

	/** Saves the default page size every paginated list opens with. */
	updatePerPage: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const parsed = perPageSchema.safeParse(
			Object.fromEntries(await request.formData()),
		);
		if (!parsed.success) {
			return fail(400, { error: "Pick one of the listed page sizes." });
		}
		const prefs = await UserPreferencesDTO.get(locals.user.id);
		await prefs.updatePerPage(parsed.data.perPage);
		logger.info("Page size updated", { userId: locals.user.id });
		return { success: true };
	},
};
