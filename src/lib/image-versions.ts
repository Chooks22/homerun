const VERSION_TAG_RE = /^(v?)(\d+(?:\.\d+)*)(?:[-_.+](.+))?$/i;
const PRERELEASE_RE =
	/^(nightly|dev|rc|beta|alpha|pre|preview|snapshot|edge|canary|next|unstable|main|master)/i;
const TAG_INVALID_CHARS_RE = /[^A-Za-z0-9_.-]+/g;
const TAG_LEADING_RE = /^[.-]+/;
const MAX_TAG_LENGTH = 128;

export interface VersionTag {
	numbers: number[];
	prerelease: boolean;
	suffix: string | null;
	tag: string;
}

export interface RegistryTag {
	digest: string | null;
	name: string;
}

export interface PinCandidates {
	digest: string | null;
	matches: string[];
	suggestion: string;
}

export interface ImageUpdateAvailable {
	digest: string | null;
	foundAt: string;
	tag: string;
}

export type UpdateTrialStatus = "running" | "passed" | "failed";

export interface ImageUpdateTrial {
	at: string;
	message: string | null;
	status: UpdateTrialStatus;
	tag: string;
}

export interface ImageUpdateState {
	available: ImageUpdateAvailable | null;
	checkedAt: string;
	error: string | null;
	notifiedKey: string | null;
	trial: ImageUpdateTrial | null;
}

/** Parses a tag shaped like a version (`1.24.3`, `v2.1-rootless`, `1.25-nightly`), or null for a floating tag like `latest` or `nightly`. */
export function parseVersionTag(tag: string): VersionTag | null {
	const match = tag.match(VERSION_TAG_RE);
	if (!match) {
		return null;
	}
	const suffix = match[3] ?? null;
	return {
		numbers: match[2].split(".").map(Number),
		prerelease: suffix !== null && PRERELEASE_RE.test(suffix),
		suffix,
		tag,
	};
}

/** Compares two versions numerically, a release sorting above a prerelease of the same numbers and, at equal rank, the more specific tag first. */
export function compareVersions(a: VersionTag, b: VersionTag): number {
	const length = Math.max(a.numbers.length, b.numbers.length);
	for (let i = 0; i < length; i++) {
		const diff = (a.numbers[i] ?? 0) - (b.numbers[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	if (a.prerelease !== b.prerelease) {
		return a.prerelease ? -1 : 1;
	}
	return a.numbers.length - b.numbers.length;
}

/** Whether `candidate` is a stable tag of the same flavour as `current`: a prerelease moves to a release, a variant suffix like `-rootless` must stay the same. */
function sameTrack(current: VersionTag, candidate: VersionTag): boolean {
	if (candidate.prerelease) {
		return false;
	}
	if (candidate.numbers.length < current.numbers.length) {
		return false;
	}
	if (current.prerelease) {
		return candidate.suffix === null;
	}
	return (candidate.suffix ?? "") === (current.suffix ?? "");
}

/** The newest stable tag on `current`'s track that sorts above it, or null when `current` isn't a version or nothing newer exists. */
export function newerVersionTag(
	current: string,
	tags: string[],
): string | null {
	const parsed = parseVersionTag(current);
	if (!parsed) {
		return null;
	}
	let best: VersionTag | null = null;
	for (const tag of tags) {
		const candidate = parseVersionTag(tag);
		if (
			candidate &&
			sameTrack(parsed, candidate) &&
			compareVersions(candidate, parsed) > 0 &&
			(!best || compareVersions(candidate, best) > 0)
		) {
			best = candidate;
		}
	}
	return best?.tag ?? null;
}

/** The registry tags pointing at `digest` other than `current`, the most specific stable version first and floating tags last. */
export function tagsMatchingDigest(
	tags: RegistryTag[],
	digest: string,
	current: string,
): string[] {
	const rank = (name: string): number => {
		const parsed = parseVersionTag(name);
		if (!parsed) {
			return 0;
		}
		return (parsed.prerelease ? 10 : 100) + parsed.numbers.length;
	};
	return tags
		.filter((tag) => tag.digest === digest && tag.name !== current)
		.map((tag) => tag.name)
		.sort((a, b) => rank(b) - rank(a) || b.localeCompare(a));
}

/** Whether pinning to `tag` actually pins: a stable version, not a floating name or a moving prerelease tag like `1.25-nightly`. */
export function isPinnableTag(tag: string): boolean {
	const parsed = parseVersionTag(tag);
	return parsed !== null && !parsed.prerelease;
}

/** Turns free text (an image's version label, a user's input) into a valid Docker tag, or "" when nothing usable is left. */
export function sanitizeTag(value: string): string {
	return value
		.trim()
		.replace(TAG_INVALID_CHARS_RE, "-")
		.replace(TAG_LEADING_RE, "")
		.slice(0, MAX_TAG_LENGTH);
}

/** Whether `value` is a valid Docker tag as-is. */
export function isValidTag(value: string): boolean {
	return value.length > 0 && sanitizeTag(value) === value;
}

/** A tag to suggest when no registry tag matches the running image: its version label when it has one, else the current tag stamped with today's date. */
export function suggestLocalTag(
	currentTag: string,
	versionLabel: string | null,
	now = new Date(),
): string {
	const fromLabel = versionLabel ? sanitizeTag(versionLabel) : "";
	if (fromLabel && fromLabel !== currentTag) {
		return fromLabel;
	}
	const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
	return sanitizeTag(`${currentTag}-${stamp}`);
}

/** The key one available update is notified under, so the same update isn't announced twice. */
export function updateKey(update: ImageUpdateAvailable): string {
	return `${update.tag}@${update.digest ?? ""}`;
}
