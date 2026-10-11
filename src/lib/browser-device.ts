const BROWSERS: [RegExp, string][] = [
	[/\bEdg(e|A|iOS)?\//, "Edge"],
	[/\b(OPR|Opera)\//, "Opera"],
	[/\b(Firefox|FxiOS)\//, "Firefox"],
	[/\b(Chrome|CriOS|Chromium)\//, "Chrome"],
	[/\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
	[/\bAndroid\b/, "Android"],
	[/\b(iPhone|iPad|iPod)\b/, "iOS"],
	[/\bWindows\b/, "Windows"],
	[/\bMac OS X\b|\bMacintosh\b/, "macOS"],
	[/\bCrOS\b/, "ChromeOS"],
	[/\bLinux\b/, "Linux"],
];

/**
 * A short human name for the browser a user agent string describes, such as
 * "Firefox on Linux", used to name a browser notification channel.
 */
export function browserDeviceName(userAgent: string): string {
	const browser =
		BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "Browser";
	const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
	return system ? `${browser} on ${system}` : browser;
}
