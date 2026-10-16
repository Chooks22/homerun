export const UNGROUPED_LABEL = "Ungrouped";

import {
	Activity,
	ArchiveRestore,
	Ban,
	Bell,
	BookOpen,
	Box,
	BrushCleaning,
	CalendarClock,
	ChartBar,
	CheckCircle,
	Clock,
	CloudUpload,
	Database,
	Ghost,
	Globe,
	HardDrive,
	LayoutDashboard,
	Loader2,
	MessagesSquare,
	Network,
	Newspaper,
	NotebookPen,
	Play,
	Rocket,
	ScanSearch,
	Server,
	ShieldCheck,
	Sparkles,
	Terminal,
	Trash2,
	Wallet,
	Workflow,
	XCircle,
} from "@lucide/svelte";
import type { ContainerStatus, JobStatus, JobType } from "#lib/types.js";

export const JOB_STATUS_CONFIG: Record<
	JobStatus,
	{ label: string; class: string; icon: typeof CheckCircle }
> = {
	cancelled: {
		class:
			"border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-400",
		icon: Ban,
		label: "Cancelled",
	},
	failed: {
		class: "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400",
		icon: XCircle,
		label: "Failed",
	},
	queued: {
		class:
			"border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-400",
		icon: Clock,
		label: "Queued",
	},
	running: {
		class: "border-blue-500/25 bg-blue-500/10 text-blue-600 dark:text-blue-400",
		icon: Loader2,
		label: "Running",
	},
	succeeded: {
		class:
			"border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
		icon: CheckCircle,
		label: "Succeeded",
	},
};

export const JOB_TYPE_ICONS: Record<JobType, typeof Database> = {
	backup: CloudUpload,
	backup_prune: Trash2,
	backup_restore: ArchiveRestore,
	core_service: Server,
	cron_job: CalendarClock,
	deploy: Rocket,
	docker_cleanup: BrushCleaning,
	image_scan: ScanSearch,
	notification_delivery: Bell,
	pipeline_sync: Workflow,
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
	backup: "Backup",
	backup_prune: "Backup cleanup",
	backup_restore: "Restore",
	core_service: "Core service",
	cron_job: "Cron job",
	deploy: "Deploy",
	docker_cleanup: "Cleanup",
	image_scan: "Image scan",
	notification_delivery: "Notification",
	pipeline_sync: "CI sync",
};

export const SERVICE_STATUS_CONFIG: Record<
	ContainerStatus,
	{ label: string; class: string; icon: typeof CheckCircle }
> = {
	failed: {
		class: "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400",
		icon: XCircle,
		label: "Failed",
	},
	missing: {
		class:
			"border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400",
		icon: Ghost,
		label: "Missing",
	},
	pending: {
		class:
			"border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-400",
		icon: Clock,
		label: "Pending",
	},
	pulling: {
		class: "border-blue-500/25 bg-blue-500/10 text-blue-600 dark:text-blue-400",
		icon: Loader2,
		label: "Pulling",
	},
	running: {
		class:
			"border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
		icon: CheckCircle,
		label: "Running",
	},
	starting: {
		class:
			"border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400",
		icon: Loader2,
		label: "Starting",
	},
	stopped: {
		class:
			"border-orange-500/25 bg-orange-500/10 text-orange-600 dark:text-orange-400",
		icon: XCircle,
		label: "Stopped",
	},
};

export const TEMPLATE_CATEGORY_ICONS: Record<string, typeof Database> = {
	ai: Sparkles,
	analytics: ChartBar,
	automation: Workflow,
	cache: Database,
	cms: Newspaper,
	communication: MessagesSquare,
	dashboard: LayoutDashboard,
	database: Database,
	development: Terminal,
	finance: Wallet,
	media: Play,
	monitoring: Activity,
	network: Network,
	productivity: NotebookPen,
	reading: BookOpen,
	security: ShieldCheck,
	storage: HardDrive,
	website: Globe,
};

const CHART_TONES = [
	{ bg: "bg-chart-1/12", text: "text-chart-1" },
	{ bg: "bg-chart-2/12", text: "text-chart-2" },
	{ bg: "bg-chart-3/12", text: "text-chart-3" },
	{ bg: "bg-chart-4/12", text: "text-chart-4" },
	{ bg: "bg-chart-5/12", text: "text-chart-5" },
] as const;

export const TEMPLATE_CATEGORY_COLORS: Record<
	string,
	{ bg: string; text: string }
> = {
	ai: CHART_TONES[1],
	analytics: CHART_TONES[1],
	automation: CHART_TONES[3],
	cache: CHART_TONES[2],
	cms: CHART_TONES[4],
	communication: CHART_TONES[2],
	dashboard: CHART_TONES[4],
	database: CHART_TONES[3],
	development: CHART_TONES[2],
	finance: CHART_TONES[3],
	media: CHART_TONES[0],
	monitoring: CHART_TONES[2],
	network: CHART_TONES[1],
	productivity: CHART_TONES[4],
	reading: CHART_TONES[4],
	security: CHART_TONES[0],
	storage: CHART_TONES[3],
	website: CHART_TONES[1],
};

/**
 * The Lucide icon for a template category, or a generic box for unknown or
 * missing categories.
 */
export function templateCategoryIcon(category: string | null): typeof Database {
	return (category && TEMPLATE_CATEGORY_ICONS[category]) || Box;
}

/**
 * The background and text colour classes for a template category's badge, or
 * the accent colours for unknown or missing categories.
 */
export function templateCategoryColor(category: string | null): {
	bg: string;
	text: string;
} {
	return (
		(category && TEMPLATE_CATEGORY_COLORS[category]) || {
			bg: "bg-accent-light",
			text: "text-accent",
		}
	);
}

/**
 * Marks a volume choice that exists on the Docker daemon but isn't a Homerun
 * storage volume yet : the service Volumes tab offers both in one picker and
 * registers the host one on submit.
 */
export const HOST_VOLUME_PREFIX = "docker:";
