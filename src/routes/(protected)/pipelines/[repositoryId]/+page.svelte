<script lang="ts">
	import PipelineRunList from "#lib/components/pipelines/pipeline-run-list.svelte";
	import PipelineStats from "#lib/components/pipelines/pipeline-stats.svelte";

	const { data } = $props();
</script>

<div class="space-y-6">
  <PipelineStats
    allTime={data.overview.allTime}
    window={data.overview.window}
    windowDays={data.windowDays}
    workflows={data.overview.workflows}
  />
  <PipelineRunList
    emptySubtitle={data.repository.pipelinesEnabled
      ? "Runs show up here after the first sync."
      : "Turn syncing on under Settings to read this repository's runs."}
    listing={data.listing}
    searched={data.searched}
  />
</div>
