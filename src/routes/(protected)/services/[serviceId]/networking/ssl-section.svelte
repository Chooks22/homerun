<script lang="ts">
	import { ShieldCheck } from "@lucide/svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import { labelClass as label } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { domainHosts, isUnderDomain } from "#lib/service-domains.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	interface Props {
		baseDomain: string;
		behindPangolin: boolean;
		certResolver: string | null;
		submitting: boolean;
		svc: {
			customSslCertEnc: string | null;
			customSslKeyEnc: string | null;
			dnsResolvable: boolean;
			domains: string[];
		};
	}

	let {
		baseDomain,
		behindPangolin,
		certResolver,
		submitting = $bindable(),
		svc,
	}: Props = $props();

	const outsideDomains = $derived(
		domainHosts(svc.domains).filter(
			(domain) => !isUnderDomain(domain, baseDomain),
		),
	);
	const certEditable = $derived(
		svc.dnsResolvable && !behindPangolin && outsideDomains.length > 0,
	);
</script>

<section class="panel rounded-md">
  <PanelHeader icon={ShieldCheck} title="SSL">
    {#snippet description()}
      {#if svc.dnsResolvable && behindPangolin}
        Pangolin serves the public certificates for this service's domains
        : Traefik only encrypts the hop from the tunnel with its default certificate.
      {:else if svc.dnsResolvable && !certResolver}
        Domains under {baseDomain} can't get a public certificate, since
        ACME only issues for real domain names : Traefik serves its self-signed
        default instead.
      {:else if svc.dnsResolvable}
        TLS is automatic via Traefik's
        <code>{certResolver}</code>
        resolver for every domain of this service : no certificate handling
        needed.
      {:else}
        Not applicable : this service isn't publicly routed.
      {/if}
    {/snippet}
    {#snippet trailing()}
      {#if certEditable}
        <SaveButton form="service-ssl" label="Save certificate" pending={submitting} />
      {/if}
    {/snippet}
  </PanelHeader>

  {#if certEditable}
    <form
      id="service-ssl"
      action="?/updateSsl"
      class="space-y-3 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Check the certificate and try again.",
        loading: "Saving the certificate",
        onSettled: () => {
          submitting = false;
        },
        onStart: () => {
          submitting = true;
        },
        success: "Saved. Redeploy for it to take effect.",
      })}
    >
      <p class="text-text-muted text-xs">
        Optional: your own certificate for
        <strong>{outsideDomains.join(", ")}</strong>, instead of the automatic
        one. Requires the admin to have set
        <code>TRAEFIK_DYNAMIC_CONFIG_DIR</code>
        and enabled Traefik's file provider (see compose.yaml) : this app
        writes the cert/key files there, it doesn't touch the Traefik
        container itself.
      </p>
      <div>
        <label class={label} for="customSslCert">Certificate (PEM)</label>
        <Textarea
          class="resize-none"
          id="customSslCert"
          name="customSslCert"
          placeholder={svc.customSslCertEnc
          ? "Unchanged"
          : "-----BEGIN CERTIFICATE-----"}
          rows={4}
        />
      </div>
      <div>
        <label class={label} for="customSslKey">Private key (PEM)</label>
        <Textarea
          class="resize-none"
          id="customSslKey"
          name="customSslKey"
          placeholder={svc.customSslKeyEnc
          ? "Unchanged"
          : "-----BEGIN PRIVATE KEY-----"}
          rows={4}
        />
      </div>
      {#if svc.customSslCertEnc}
        <CheckBox
          checked={false}
          helperText="Clears the certificate and key instead of saving new ones above"
          id="clearSsl"
          label="Remove the stored certificate instead of replacing it"
          name="clearSsl"
        />
      {/if}
      <p class="text-text-subtle text-xs">Redeploy for changes to take effect.</p>
    </form>
  {/if}
</section>
