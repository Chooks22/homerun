export type ResourceKind = "cpu" | "memory" | "disk" | "gpu";

export type ResourceLevel = "ok" | "soft" | "hard";

export interface Threshold {
	hard: number;
	soft: number;
}

export type ResourceThresholds = Record<ResourceKind, Threshold>;

export const RESOURCE_KINDS: ResourceKind[] = ["cpu", "memory", "disk", "gpu"];

/** Each threshold as one REST API field (`cpuSoftThreshold`, `cpuHardThreshold`, ...), for the instance settings. */
export const RESOURCE_THRESHOLD_FIELDS = RESOURCE_KINDS.flatMap((kind) => [
	`${kind}SoftThreshold`,
	`${kind}HardThreshold`,
]);

export const RESOURCE_LABELS: Record<ResourceKind, string> = {
	cpu: "CPU",
	disk: "Disk",
	gpu: "GPU",
	memory: "Memory",
};

export const DEFAULT_THRESHOLDS: ResourceThresholds = {
	cpu: { hard: 95, soft: 85 },
	disk: { hard: 95, soft: 85 },
	gpu: { hard: 95, soft: 85 },
	memory: { hard: 95, soft: 85 },
};

export interface HostUsageInput {
	cpuPercent: number;
	diskTotalGb: number | null;
	diskUsedGb: number | null;
	gpu: {
		memTotalMb: number;
		memUsedMb: number;
		utilizationPercent: number;
	} | null;
	memTotalMb: number;
	memUsedMb: number;
}

export interface ResourceReading {
	kind: ResourceKind;
	level: ResourceLevel;
	percent: number;
	threshold: Threshold;
}

/** `used` as a whole percentage of `total`, or null when there's no total to measure against. */
function percentOf(used: number | null, total: number | null): number | null {
	return used !== null && total ? Math.round((used / total) * 100) : null;
}

/**
 * Stored thresholds merged over the defaults, so a category the settings
 * don't mention (or a row from before thresholds existed) falls back to them.
 */
export function withDefaults(
	stored: Partial<Record<ResourceKind, Partial<Threshold>>> | null | undefined,
): ResourceThresholds {
	const merged = { ...DEFAULT_THRESHOLDS };
	for (const kind of RESOURCE_KINDS) {
		merged[kind] = { ...DEFAULT_THRESHOLDS[kind], ...stored?.[kind] };
	}
	return merged;
}

/** Which threshold `percent` has reached. */
export function levelFor(percent: number, threshold: Threshold): ResourceLevel {
	if (percent >= threshold.hard) {
		return "hard";
	}
	return percent >= threshold.soft ? "soft" : "ok";
}

/**
 * The host's usage per category against its thresholds. The GPU counts its
 * busiest of compute and memory, and is left out on a host without one, as is
 * the disk when the worker couldn't read it.
 */
export function readResources(
	host: HostUsageInput,
	thresholds: ResourceThresholds,
): ResourceReading[] {
	const percents: [ResourceKind, number | null][] = [
		["cpu", Math.round(host.cpuPercent)],
		["memory", percentOf(host.memUsedMb, host.memTotalMb)],
		["disk", percentOf(host.diskUsedGb, host.diskTotalGb)],
		[
			"gpu",
			host.gpu
				? Math.max(
						Math.round(host.gpu.utilizationPercent),
						percentOf(host.gpu.memUsedMb, host.gpu.memTotalMb) ?? 0,
					)
				: null,
		],
	];
	return percents
		.filter((entry): entry is [ResourceKind, number] => entry[1] !== null)
		.map(([kind, percent]) => ({
			kind,
			level: levelFor(percent, thresholds[kind]),
			percent,
			threshold: thresholds[kind],
		}));
}

/** A reading in words: "Disk at 97% (hard limit 95%)". */
export function describeReading(reading: ResourceReading): string {
	const limit =
		reading.level === "hard"
			? `hard limit ${reading.threshold.hard}%`
			: `soft limit ${reading.threshold.soft}%`;
	return `${RESOURCE_LABELS[reading.kind]} at ${reading.percent}% (${limit})`;
}

/**
 * Reads the soft and hard percentage for every category from a settings form
 * (`cpuSoft`, `cpuHard`, …), or says what's wrong: each has to be a whole
 * number from 1 to 100, with the soft one no higher than the hard one.
 */
export function parseThresholds(
	get: (name: string) => string | null,
): ResourceThresholds | string {
	const parsed = { ...DEFAULT_THRESHOLDS };
	for (const kind of RESOURCE_KINDS) {
		const soft = Number(get(`${kind}Soft`));
		const hard = Number(get(`${kind}Hard`));
		const label = RESOURCE_LABELS[kind];
		if (
			![soft, hard].every(
				(value) => Number.isInteger(value) && value >= 1 && value <= 100,
			)
		) {
			return `${label} thresholds must be whole percentages from 1 to 100.`;
		}
		if (soft > hard) {
			return `${label}'s soft threshold can't be above its hard one.`;
		}
		parsed[kind] = { hard, soft };
	}
	return parsed;
}
