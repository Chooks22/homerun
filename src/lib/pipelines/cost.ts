import type { PipelineProvider, PipelineRateRule } from "./types.ts";

const MINUTE_MS = 60_000;

export const GITHUB_DEFAULT_RATES: PipelineRateRule[] = [
	{ label: "self-hosted", rate: 0 },
	{ label: "ubuntu", rate: 0.006 },
	{ label: "linux", rate: 0.006 },
	{ label: "windows", rate: 0.01 },
	{ label: "macos", rate: 0.062 },
];

/** The rate rules a service starts with: GitHub's hosted runner prices for GitHub, nothing for GitLab and Gitea, whose runners are usually your own. */
export function defaultRates(
	provider: PipelineProvider | null,
): PipelineRateRule[] {
	return provider === "github" ? GITHUB_DEFAULT_RATES : [];
}

/** Whole minutes a job is billed for, rounded up the way GitHub bills each job; zero when it never ran. */
export function billableMinutes(
	startedAt: string | null,
	finishedAt: string | null,
): number {
	if (!(startedAt && finishedAt)) {
		return 0;
	}
	const ms = Date.parse(finishedAt) - Date.parse(startedAt);
	return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / MINUTE_MS) : 0;
}

/**
 * The per-minute rate of a job's runner: the first rule, in order, whose
 * label starts one of the job's runner labels or its runner name, else zero.
 */
export function rateFor(
	rules: PipelineRateRule[],
	labels: string[],
	runner: string | null,
): number {
	const names = [...labels, ...(runner ? [runner] : [])].map((name) =>
		name.toLowerCase(),
	);
	const rule = rules.find((candidate) =>
		names.some((name) => name.startsWith(candidate.label.toLowerCase())),
	);
	return rule?.rate ?? 0;
}

/** Rate rules as the settings textarea shows them, one `label = rate` per line. */
export function formatRates(rules: PipelineRateRule[]): string {
	return rules.map((rule) => `${rule.label} = ${rule.rate}`).join("\n");
}

/**
 * Parses the settings textarea: one `label = dollars per minute` per line,
 * blank lines ignored.
 *
 * @throws When a line isn't a label and a non-negative number.
 */
export function parseRates(text: string): PipelineRateRule[] {
	const rules: PipelineRateRule[] = [];
	for (const [index, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		const match = /^([^=\s][^=]*?)\s*=\s*(\d+(?:\.\d+)?)$/.exec(line);
		if (!match) {
			throw new Error(
				`Line ${index + 1} should read "label = dollars per minute", like "ubuntu = 0.006".`,
			);
		}
		rules.push({ label: match[1], rate: Number(match[2]) });
	}
	return rules;
}
