<script lang="ts">
	import { Settings } from "@lucide/svelte";
	import { onMount } from "svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import {
		SelectContent,
		SelectItem,
		Select as SelectRoot,
		SelectTrigger,
	} from "#lib/components/ui/select/index.js";
	import { PULL_POLICIES } from "#lib/pull-policy.js";
	import { defaultHostname } from "#lib/service-domains.js";
	import { isDeployed } from "#lib/service-state.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { goto } from "$app/navigation";
	import { resolve } from "$app/paths";
	import AutoRedeploySection from "./auto-redeploy-section.svelte";
	import AutoRollbackSection from "./auto-rollback-section.svelte";
	import DangerZoneSection from "./danger-zone-section.svelte";
	import IdentitySection from "./identity-section.svelte";
	import ImageScanSection from "./image-scan-section.svelte";
	import SaveAsTemplateSection from "./save-as-template-section.svelte";
	import StackSection from "./stack-section.svelte";

	const { data, form } = $props();
	const svc = $derived(data.service);

	onMount(() => title.set(`${svc.name} · Settings`));

	const label = "block mb-1.5 text-sm font-medium text-text";
	const errorClass = "mt-1.5 text-xs text-red-500";

	const values = $derived(
		(form?.values as Record<string, string> | undefined) ?? {
			environmentName: svc.environmentName ?? "",
			name: svc.name,
			pullPolicy: svc.pullPolicy,
			restartPolicy: svc.restartPolicy,
			slug: svc.slug,
		},
	);
	const errors = $derived(form?.errors as Record<string, string[]> | undefined);

	let submitting = $state(false);

	const restartPolicyOptions: [string, string][] = [
		["unless-stopped", "Unless stopped"],
		["always", "Always"],
		["on-failure", "On failure"],
		["no", "Never"],
	];
	let restartPolicy = $derived(values.restartPolicy);
	const restartPolicyLabel = $derived(
		restartPolicyOptions.find(([val]) => val === restartPolicy)?.[1] ??
			"Unless stopped",
	);

	let pullPolicy = $derived(values.pullPolicy);
	const pullPolicyOption = $derived(
		PULL_POLICIES.find((opt) => opt.value === pullPolicy) ?? PULL_POLICIES[0],
	);
</script>

<div class="space-y-6">
  <section class="panel rounded-md">
    <PanelHeader
      description="Changes take effect on the next deploy."
      icon={Settings}
      title="Service settings"
    >
      {#snippet trailing()}
        <SaveButton form="service-settings" pending={submitting} />
      {/snippet}
    </PanelHeader>

    <form
      id="service-settings"
      action="?/update"
      class="space-y-5 p-5"
      method="POST"
      use:enhance={enhanceToast({
        action: isDeployed(svc)
          ? {
              label: "Redeploy",
              onClick: () =>
                goto(
                  resolve("/(protected)/services/[serviceId]", {
                    serviceId: svc.id,
                  }),
                ),
            }
          : undefined,
        description: "Changes take effect on the next deploy.",
        error: "Check the form for errors.",
        loading: "Saving the service",
        onSettled: () => {
          submitting = false;
        },
        onStart: () => {
          submitting = true;
        },
        success: "Saved.",
      })}
    >
      <div>
        <label class={label} for="name">
          Name <span class="text-red-500">*</span>
        </label>
        <Input id="name" name="name" required type="text" value={values.name} />
        {#if errors?.name}
          <p class={errorClass}>{errors.name[0]}</p>
        {/if}
      </div>

      <div>
        <label class={label} for="slug">
          Slug <span class="text-red-500">*</span>
        </label>
        <Input
          id="slug"
          maxlength={63}
          name="slug"
          pattern="[a-z0-9\-]+"
          required
          type="text"
          value={values.slug}
        />
        <p class="text-text-subtle mt-1 text-xs">
          {#if svc.dnsResolvable && svc.networkMode !== "host" && svc.defaultDomainEnabled}
            Routed at
            <span class="text-accent">{defaultHostname(values.slug, data.stackSlug, data.serviceDomain)}</span>
            : redeploy to apply a change.
          {:else if svc.dnsResolvable && svc.networkMode !== "host"}
            Its own domains are routed, not {defaultHostname(values.slug, data.stackSlug, data.serviceDomain)}.
            Other services reach it at
            <span class="text-accent">{values.slug}</span>
            : redeploy to apply a change.
          {:else}
            Not publicly routed. Other services reach it at
            <span class="text-accent">{values.slug}</span>
            : redeploy to apply a change.
          {/if}
        </p>
        {#if errors?.slug}
          <p class={errorClass}>{errors.slug[0]}</p>
        {/if}
      </div>

      <p class="text-text-subtle text-xs">
        Container port, network mode, and DNS-resolvability moved to the
        <a
          class="text-accent underline"
          href={resolve("/(protected)/services/[serviceId]/networking", {
            serviceId: svc.id,
          })}
        >Networking</a>
        tab.
      </p>

      <div>
        <label class={label} for="pullPolicy">Pull policy</label>
        <SelectRoot name="pullPolicy" type="single" bind:value={pullPolicy}>
          <SelectTrigger class="w-full" id="pullPolicy">
            {pullPolicyOption.label}
          </SelectTrigger>
          <SelectContent>
            {#each PULL_POLICIES as option (option.value)}
              <SelectItem label={option.label} value={option.value} />
            {/each}
          </SelectContent>
        </SelectRoot>
        <p class="text-text-subtle mt-1.5 text-xs">
          {pullPolicyOption.description}
        </p>
      </div>

      <div>
        <label class={label} for="restartPolicy">Restart policy</label>
        <SelectRoot
          name="restartPolicy"
          type="single"
          bind:value={restartPolicy}
        >
          <SelectTrigger class="w-full" id="restartPolicy">
            {restartPolicyLabel}
          </SelectTrigger>
          <SelectContent>
            {#each restartPolicyOptions as [val, lbl] (val)}
              <SelectItem label={lbl} value={val} />
            {/each}
          </SelectContent>
        </SelectRoot>
      </div>

      {#if !svc.previewParentId}
        <div>
          <label class={label} for="environmentName">Environment</label>
          <Input
            id="environmentName"
            maxlength={32}
            name="environmentName"
            placeholder="production"
            type="text"
            value={values.environmentName}
          />
          <p class="text-text-subtle mt-1 text-xs">
            The environment this service's deployments are recorded under, on the
            Revisions tab and Deployments page, e.g. staging or eu-prod. Leave blank
            for production.
          </p>
          {#if errors?.environmentName}
            <p class={errorClass}>{errors.environmentName[0]}</p>
          {/if}
        </div>
      {/if}

      <p class="text-text-subtle text-xs">
        CPU/memory limits and autoscaling moved to the
        <a
          class="text-accent underline"
          href={resolve("/(protected)/services/[serviceId]/container", {
            serviceId: svc.id,
          })}
        >Compute</a>
        tab.
      </p>
    </form>
  </section>

  <IdentitySection icons={data.icons} {svc} />
  <StackSection stackId={svc.stackId} stacks={data.stacks} />
  <SaveAsTemplateSection />
  <AutoRollbackSection {svc} />
  <ImageScanSection {svc} />
  <AutoRedeploySection cronError={form?.cronError} {svc} />
  <DangerZoneSection activeJobs={data.activeJobs} name={svc.name} />
</div>
