const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Human byte size, used by the resource graphs and the usage table. */
export function formatBytes(bytes: number): string {
	let value = Math.max(0, bytes);
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

/**
 * Formats a date as a short US-style date ("Jan 5, 2026"), or an em dash when
 * there is none.
 */
export function formatDate(date: Date | null): string {
	if (!date) {
		return "—";
	}
	return new Date(date).toLocaleDateString("en-US", {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/**
 * Formats how long ago a date was as a compact relative string ("just now",
 * "5m ago", "3h ago", "2d ago").
 */
export function timeAgo(date: Date | string): string {
	const d = new Date(date);
	const diff = Date.now() - d.getTime();
	if (diff < 60_000) {
		return "just now";
	}
	if (diff < 3_600_000) {
		return `${Math.floor(diff / 60_000)}m ago`;
	}
	if (diff < 86_400_000) {
		return `${Math.floor(diff / 3_600_000)}h ago`;
	}
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

const UPPERCASE_RE = /[A-Z]/;
const DIGIT_RE = /[0-9]/;
const SYMBOL_RE = /[^A-Za-z0-9]/;

/**
 * Scores a password from 0 to 4, one point each for being at least 12 characters
 * long and containing an uppercase letter, a digit and a symbol.
 */
export function getPasswordStrength(password: string): number {
	if (!password) {
		return 0;
	}
	let s = 0;
	if (password.length >= 12) {
		s += 1;
	}
	if (UPPERCASE_RE.test(password)) {
		s += 1;
	}
	if (DIGIT_RE.test(password)) {
		s += 1;
	}
	if (SYMBOL_RE.test(password)) {
		s += 1;
	}
	return s;
}

/**
 * Maps a `getPasswordStrength` score to the strength meter's bar colour class,
 * label and text colour class.
 */
export function getPasswordStrengthMeta(strength: number) {
	if (strength === 0) {
		return { bar: "bg-[var(--color-surface-3)]", label: "", text: "" };
	}
	if (strength === 1) {
		return { bar: "bg-red-500", label: "Weak", text: "text-red-500" };
	}
	if (strength === 2) {
		return { bar: "bg-yellow-500", label: "Fair", text: "text-yellow-500" };
	}
	if (strength === 3) {
		return { bar: "bg-blue-500", label: "Good", text: "text-blue-500" };
	}
	return { bar: "bg-green-500", label: "Strong", text: "text-green-500" };
}

/**
 * What the dashboard shows in place of a hidden value: the same run of
 * bullets whatever the value's real length, so the mask never gives it away.
 */
export const SECRET_MASK = "•".repeat(24);
