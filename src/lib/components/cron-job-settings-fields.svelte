<script lang="ts">
	import CheckBox from "#lib/components/check-box.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import ScheduleField from "#lib/components/schedule-field.svelte";
	import { Input } from "#lib/components/ui/input/index.js";

	interface CronJobSettingsValues {
		description: string | null;
		enabled: boolean;
		name: string;
		schedule: string;
		timeoutSeconds: number;
	}

	const { values }: { values: CronJobSettingsValues } = $props();
</script>

<section class="panel space-y-4 rounded-md p-5">
  <div class="grid gap-3 sm:grid-cols-2">
    <div>
      <label class={labelClass} for="name">Name</label>
      <Input
        id="name"
        name="name"
        placeholder="Nightly database dump"
        type="text"
        value={values.name}
      />
    </div>
    <ScheduleField id="schedule" name="schedule" value={values.schedule} />
  </div>

  <div>
    <label class={labelClass} for="description">Description (optional)</label>
    <Input
      id="description"
      name="description"
      placeholder="What this job does"
      type="text"
      value={values.description ?? ""}
    />
  </div>

  <div>
    <label class={labelClass} for="timeoutSeconds">Timeout (seconds)</label>
    <Input
      id="timeoutSeconds"
      name="timeoutSeconds"
      placeholder="900"
      type="number"
      value={String(values.timeoutSeconds)}
    />
  </div>

  <CheckBox
    checked={values.enabled}
    helperText="Run this job on its schedule. Off, it only runs when you press Run now or call the API, for a one-off task."
    id="enabled"
    label="Enable schedule"
    name="enabled"
  />
</section>
