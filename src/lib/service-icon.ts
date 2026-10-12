export const MAX_ICON_BYTES = 256 * 1024;

export const ICON_UPLOAD_TYPES = [
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/svg+xml",
	"image/webp",
];

export const DASHBOARD_ICON_PREFIX = "di:";
export const DASHBOARD_ICON_NAME = /^[a-z0-9][a-z0-9-]*$/;

export type IconTheme = "dark" | "light";

const BUNDLED_ICON = /^[a-z0-9][a-z0-9._-]*\.(svg|png|webp|jpg)$/;
const DATA_URL = /^data:(image\/[a-z+.-]+);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Whether `icon` is a picture to render (a bundled file, a Dashboard Icon or an upload) rather than empty, which means the category's generic icon. */
export function hasIconImage(icon: string | null | undefined): icon is string {
	return (
		!!icon &&
		(icon.startsWith("data:") ||
			icon.startsWith(DASHBOARD_ICON_PREFIX) ||
			icon.includes("."))
	);
}

/**
 * The `<img src>` for an icon: an uploaded data URL as is, a Dashboard Icon
 * through Homerun's proxy (asking for its `theme` variant when one is given),
 * a bundled file under `/template-icons/`.
 */
export function iconSrc(icon: string, theme?: IconTheme): string {
	if (icon.startsWith("data:")) {
		return icon;
	}
	if (icon.startsWith(DASHBOARD_ICON_PREFIX)) {
		const path = `/icons/dashboard/${icon.slice(DASHBOARD_ICON_PREFIX.length)}.svg`;
		return theme ? `${path}?theme=${theme}` : path;
	}
	return `/template-icons/${icon}`;
}

/**
 * Why `icon` can't be stored on a service, or null when it can: empty (no
 * icon), a bundled template icon from `bundled`, a `di:<name>` Dashboard
 * Icon, or a base64 image data URL of an allowed type under `MAX_ICON_BYTES`.
 */
export function iconProblem(
	icon: string,
	bundled: readonly string[],
): string | null {
	if (icon === "") {
		return null;
	}
	if (icon.startsWith(DASHBOARD_ICON_PREFIX)) {
		return DASHBOARD_ICON_NAME.test(icon.slice(DASHBOARD_ICON_PREFIX.length))
			? null
			: "That isn't a Dashboard Icons name.";
	}
	if (icon.startsWith("data:")) {
		const type = DATA_URL.exec(icon)?.[1];
		if (!(type && ICON_UPLOAD_TYPES.includes(type))) {
			return "Upload a PNG, JPEG, WebP, GIF or SVG image.";
		}
		const bytes = Math.floor(((icon.length - icon.indexOf(",") - 1) * 3) / 4);
		return bytes > MAX_ICON_BYTES
			? `The icon is over ${MAX_ICON_BYTES / 1024} KB : use a smaller image.`
			: null;
	}
	return BUNDLED_ICON.test(icon) && bundled.includes(icon)
		? null
		: "Pick an icon from the library or upload one.";
}
