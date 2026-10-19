<script lang="ts">
	import {
		Check,
		Cpu,
		HardDrive,
		Network,
		Server,
		SlidersHorizontal,
	} from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import TemplateIcon from "#lib/components/template-icon.svelte";
	import type { DetectedConfig } from "#lib/image-config.js";
	import { runtimeOptionsSummary } from "#lib/service-runtime.js";
	import { stackScopedSlug } from "#lib/slug.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { visibleIn } from "#lib/ui-mode.js";
	import { enhance } from "$app/forms";
	import BasicInfoStep, { slugify } from "./basic-info-step.svelte";
	import ComputeStep from "./compute-step.svelte";
	import EnvironmentStep from "./environment-step.svelte";
	import NetworkingStep from "./networking-step.svelte";
	import VolumesStep from "./volumes-step.svelte";
	import WizardNav from "./wizard-nav.svelte";

	const { data, form } = $props();

	onMount(() => {
		title.set("Deploy a Service");
	});

	const values = $derived(form?.values as Record<string, string> | undefined);
	const errors = $derived(form?.errors as Record<string, string[]> | undefined);
	// Flat list of every error message, so a field we forgot to render a
	// dedicated <p> for still surfaces instead of silently failing.
	const templateRuntime = $derived(runtimeOptionsSummary(data.template));
	const errorMessages = $derived(errors ? Object.values(errors).flat() : []);

	const STEPS = [
		{ icon: Server, label: "Basic info" },
		{ icon: Network, label: "Networking" },
		{ icon: SlidersHorizontal, label: "Environment" },
		{ icon: HardDrive, label: "Volumes" },
		{ icon: Cpu, label: "Compute" },
	];
	// Every field lives in $state (not an uncontrolled `value={}`) so its
	// value survives a step being hidden : steps are hidden with a CSS
	// class, not {#if}, specifically so the DOM nodes (and their bound
	// state) never unmount between steps.
	let currentStep = $state(0);

	let slug = $derived(
		values?.slug ??
			(data.template
				? stackScopedSlug(data.stackSlug, slugify(data.template.name))
				: ""),
	);
	let image = $derived(values?.image ?? data.template?.image ?? "");
	let tag = $derived(values?.tag ?? data.template?.tag ?? "latest");
	let detected = $state<DetectedConfig | null>(null);
	let submittingAction = $state<"create" | "createAndDeploy" | null>(null);

	function stepButtonClass(i: number): string {
		if (i === currentStep) {
			return "border-accent bg-accent-light text-accent";
		}
		if (i < currentStep) {
			return "border-border text-text bg-surface-2";
		}
		return "border-border text-text-muted";
	}
</script>

<div class="space-y-6 p-6 md:p-8">
  <div>
    <h1 class="text-text text-lg font-semibold tracking-tight">Deploy a Service</h1>
    <p class="mt-0.5 text-sm text-text-muted">
      Point at an image, fill in the config, deploy.
    </p>
  </div>

  <!-- ═══ Step indicator ═══ -->
  <div class="flex items-center gap-1">
    {#each STEPS as step, i (step.label)}
      {@const StepIcon = step.icon}
      <button
        class="
          flex flex-1 items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm font-medium transition-all {stepButtonClass(
          i,
          )}
       "
        onclick={() => {
          currentStep = i;
        }}
        type="button"
      >
        <div
          class="
            flex size-5 shrink-0 items-center justify-center rounded-full text-xs {i <=
            currentStep
            ? 'bg-accent text-white'
            : 'bg-surface-2 text-text-subtle'}
         "
        >
          {#if i < currentStep}
            <Check class="size-3" />
          {:else}
            {i + 1}
          {/if}
        </div>
        <span class="hidden sm:inline"><StepIcon
            class="mr-1 inline size-3.5"
          />{step.label}</span>
      </button>
    {/each}
  </div>
  <p class="text-text-muted -mt-3 text-xs sm:hidden">
    Step {currentStep + 1} of {STEPS.length} : {STEPS[currentStep].label}
  </p>

  <form
    action="?/create"
    class="space-y-6"
    method="POST"
    use:enhance={enhanceToast({
      error: "Check the form for errors.",
      loading: "Creating the service",
      onSubmit: ({ submitter }) => {
        submittingAction = (submitter as HTMLButtonElement | null)?.formAction.includes(
          "createAndDeploy",
        )
          ? "createAndDeploy"
          : "create";
      },
      onFailure: () => {
        // The failing field could be on any step : jump back to the
        // first one so the top error banner and per-field messages are
        // actually visible, not stranded behind whatever step the user
        // happened to be on when they hit Create.
        currentStep = 0;
      },
      onSettled: () => {
        submittingAction = null;
      },
      success: "Service created.",
    })}
  >
    {#if data.stackId}
      <input name="stackId" type="hidden" value={data.stackId}>
    {/if}

    {#if data.template}
      <input name="templateId" type="hidden" value={data.template.id}>
      <div class="bg-accent/10 text-accent rounded-md px-4 py-3 text-sm font-medium">
        Starting from the {data.template.name} template : review everything
        below (especially any placeholder passwords) before deploying.
        {#if templateRuntime.length > 0}
          <span class="text-text-muted mt-1 block text-xs font-normal">
            It also sets, editable later on the service's Runtime tab:
            {templateRuntime.join(" · ")}
          </span>
        {/if}
      </div>
      {#if data.templateHostAccessRefusal}
        <Alert variant="warning">{data.templateHostAccessRefusal}</Alert>
      {/if}
    {/if}

    {#if data.templateLinks.length > 0}
      <div class="rounded-md panel p-4 text-sm">
        <p class="font-medium text-text">
          {data.stackId
            ? "This will also deploy, alongside this service in the stack:"
            : "This will also deploy, grouped in a new stack:"}
        </p>
        <ul class="mt-2 space-y-1.5">
          {#each data.templateLinks as link (link.alias)}
            <li class="flex items-center gap-2 text-text-muted">
              <TemplateIcon category={null} class="size-4" icon={link.icon} />
              {link.name}
              <span class="text-text-subtle">({link.alias})</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if errorMessages.length > 0}
      <Alert title="Couldn't create the service:">
        <ul class="ml-4 list-disc">
          {#each errorMessages as msg}
            <li>{msg}</li>
          {/each}
        </ul>
      </Alert>
    {/if}

    <div class="flex flex-col gap-6 sm:min-h-136">
      <div class="flex-1 space-y-6">
        <BasicInfoStep
          {data}
          {errors}
          hidden={currentStep !== 0}
          {values}
          bind:detected
          bind:image
          bind:slug
          bind:tag
        />
        <NetworkingStep
          {data}
          {detected}
          {errors}
          hidden={currentStep !== 1}
          {image}
          {slug}
          {values}
        />
        <EnvironmentStep {data} {detected} hidden={currentStep !== 2} />
        <VolumesStep
          {detected}
          {errors}
          hidden={currentStep !== 3}
          {image}
          {slug}
          {tag}
          templateVolumes={data.template?.volumes ?? []}
          volumes={data.volumes}
        />
        <ComputeStep
          collapsible={!visibleIn(data.uiMode, "services/new#compute") &&
          !errors?.cpuLimit &&
          !errors?.memoryLimitMb}
          {errors}
          hidden={currentStep !== 4}
          template={data.template}
          {values}
        />
      </div>

      <WizardNav
        stepCount={STEPS.length}
        {submittingAction}
        bind:currentStep
      />
    </div>
  </form>
</div>
