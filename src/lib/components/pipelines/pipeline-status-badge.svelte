<script lang="ts">
	import { PIPELINE_STATUS_LABELS } from "#lib/pipelines/list.js";
	import type { PipelineStatus } from "#lib/pipelines/types.js";

	interface Props {
		status: PipelineStatus;
	}

	const { status }: Props = $props();

	const tone: Record<PipelineStatus, string> = {
		cancelled: "bg-surface-2 text-text-muted",
		failure: "bg-red-500/10 text-red-500",
		queued: "bg-amber-500/10 text-amber-600",
		running: "bg-sky-500/10 text-sky-600",
		skipped: "bg-surface-2 text-text-subtle",
		success: "bg-green-500/10 text-green-600",
	};
</script>

<span class="rounded-full px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap uppercase {tone[status]}">
  {PIPELINE_STATUS_LABELS[status]}
</span>
