<script lang="ts">
	import { ChevronRight } from "@lucide/svelte";
	import { page } from "$app/state";

	const PAGE_PATTERNS = Object.keys(
		import.meta.glob("/src/routes/**/+page.svelte"),
	).map(
		(file) =>
			new RegExp(
				`^${file
					.replace(/^\/src\/routes/, "")
					.replace(/\/\+page\.svelte$/, "")
					.replace(/\/\([^/]+\)/g, "")
					.replace(/\[\.\.\.[^\]]+\]/g, ".+")
					.replace(/\[[^\]]+\]/g, "[^/]+")}/?$`,
			),
	);

	/** Whether a page exists at `href`, so a crumb never links to a path that only exists as a URL prefix. */
	function isPage(href: string): boolean {
		return PAGE_PATTERNS.some((pattern) => pattern.test(href));
	}

	interface Crumb {
		href: string;
		label: string;
	}

	const {
		roots,
		skip = [],
	}: {
		roots: { href: string; label: string }[];
		skip?: string[];
	} = $props();

	/**
	 * Finds a display name for an id segment among the current page's loaded
	 * data, so `/stacks/<uuid>` reads as the stack's name.
	 */
	function entityName(segment: string): string | null {
		for (const value of Object.values(page.data)) {
			if (value && typeof value === "object" && "id" in value) {
				const entity = value as Record<string, unknown>;
				if (entity.id === segment) {
					const name = entity.name ?? entity.label ?? entity.title;
					if (typeof name === "string" && name) {
						return name;
					}
				}
			}
		}
		return null;
	}

	/** Turns a static path segment like `cron-jobs` into `Cron jobs`. */
	function humanize(segment: string): string {
		const text = decodeURIComponent(segment).replaceAll("-", " ");
		return text.charAt(0).toUpperCase() + text.slice(1);
	}

	/**
	 * Crumbs a page's `load` returns as `crumbRoot` to stand in for its first
	 * URL segment, e.g. a service in a stack reads Stacks › <stack> instead of
	 * Services.
	 */
	function crumbRoot(): Crumb[] | null {
		const root = (page.data as { crumbRoot?: unknown }).crumbRoot;
		return Array.isArray(root) ? (root as Crumb[]) : null;
	}

	const crumbs = $derived.by<Crumb[]>(() => {
		const segments = page.url.pathname.split("/").filter(Boolean);
		if (segments.length === 0) {
			return [
				{
					href: "/",
					label: roots.find((r) => r.href === "/")?.label ?? "Overview",
				},
			];
		}
		const root = crumbRoot();
		const out: Crumb[] = [];
		let href = "";
		for (const [index, segment] of segments.entries()) {
			href += `/${segment}`;
			if (index === 0 && root) {
				out.push(...root);
				continue;
			}
			if (
				skip.includes(href) ||
				(index < segments.length - 1 && !isPage(href))
			) {
				continue;
			}
			const label =
				roots.find((r) => r.href === href)?.label ??
				entityName(segment) ??
				humanize(segment);
			out.push({ href, label });
		}
		return out;
	});
</script>

<nav aria-label="Breadcrumb" class="min-w-0 flex-1">
  <ol class="flex min-w-0 items-center gap-1 text-sm">
    {#each crumbs as crumb, i (crumb.href)}
      {@const last = i === crumbs.length - 1}
      <li class="min-w-0 items-center gap-1 {last ? 'flex' : 'hidden shrink-0 sm:flex'}">
        {#if i > 0}
          <ChevronRight class="text-text-subtle hidden size-3.5 shrink-0 sm:block" />
        {/if}
        {#if last}
          <span aria-current="page" class="text-text truncate text-xl font-semibold tracking-tight sm:text-sm sm:font-medium sm:tracking-normal">
            {crumb.label}
          </span>
        {:else}
          <a
            class="text-text-muted hover:text-text max-w-48 truncate transition-colors"
            href={crumb.href}
          >
            {crumb.label}
          </a>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
