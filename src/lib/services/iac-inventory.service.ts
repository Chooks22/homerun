import { BuildCacheRegistryDTO } from "#lib/dto/build-cache-registry-dto.js";
import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { DnsConnectionDTO } from "#lib/dto/dns-connection-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { NotificationChannelDTO } from "#lib/dto/notification-channel-dto.js";
import { ObjectStoreDTO } from "#lib/dto/object-store-dto.js";
import { PublicBucketDTO } from "#lib/dto/public-bucket-dto.js";
import { RedirectDTO } from "#lib/dto/redirect-dto.js";
import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { ServiceDependencyDTO } from "#lib/dto/service-dependency-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { ServiceVolumeDTO } from "#lib/dto/service-volume-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { StatusPageDTO } from "#lib/dto/status-page-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import {
	type GeneratedFile,
	type GenerateScope,
	generateStructure,
	type IacScopeOption,
	type Inventory,
	type LiveObject,
	scopeToService,
	scopeToStack,
} from "#lib/iac/generate.js";
import { Logger } from "#lib/logger.js";
import {
	backupDestinationApiJson,
	bucketApiJson,
	buildCacheRegistryApiJson,
	cronJobApiJson,
	gitProviderApiJson,
	isEnvironmentRow,
	notificationChannelApiJson,
	serviceApiJson,
	serviceEnvironmentApiJson,
	statusPageApiJson,
} from "#lib/server/api-json.js";
import { zipFiles } from "#lib/server/zip.js";
import { GitProviderConfigService } from "#lib/services/git-provider-config.service.js";
import { identityInventory } from "#lib/services/identity-inventory.js";
import { infrastructureInventory } from "#lib/services/infrastructure-inventory.js";
import { ObjectStorageService } from "#lib/services/object-storage.service.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";
import { stackPath } from "#lib/stack-tree.js";

const logger = new Logger("IaC");

/**
 * What's running, in the shape the REST API (and with it the Terraform
 * provider) returns each object: what the IaC page generates
 * configuration from and compares a state with.
 */
class IacInventoryServiceClass {
	/**
	 * Every object a `homerun_*` resource can manage, by resource type. A
	 * notification channel belongs to one account, so only `userId`'s are in;
	 * previews, canaries and the built-in object store are Homerun's own and
	 * left out. A store whose buckets can't be listed is skipped. The
	 * instance-wide settings come as one object per singleton type.
	 */
	async inventory(userId: string): Promise<Inventory> {
		const [services, stores] = await Promise.all([
			ServiceDTO.list(),
			ObjectStoreDTO.list(),
		]);
		const rows = services.map((svc) => svc.toJSON());
		const topLevel = rows.filter((row) => row.previewParentId === null);
		const topLevelIds = new Set(topLevel.map((row) => row.id));
		const [
			stacks,
			dependencies,
			volumes,
			mounts,
			cronJobs,
			redirects,
			channels,
			destinations,
			statusPages,
			dnsConnections,
			gitProviders,
			cacheRegistries,
			buckets,
			serviceAccounts,
			settings,
		] = await Promise.all([
			StackDTO.list(),
			ServiceDependencyDTO.list(),
			StorageVolumeDTO.list(),
			ServiceVolumeDTO.list(),
			CronJobDTO.list(),
			RedirectDTO.list(),
			NotificationChannelDTO.list(userId),
			S3DestinationDTO.list(),
			this.#statusPages(),
			DnsConnectionDTO.list(),
			GitProviderConfigService.list(),
			BuildCacheRegistryDTO.list(),
			this.#buckets(stores),
			ServiceAccountService.list(),
			SettingsApiService.iacInventory(),
		]);
		return {
			...settings,
			...(await infrastructureInventory(userId)),
			...(await identityInventory()),
			homerun_bucket: buckets,
			homerun_build_cache_registry: cacheRegistries.map((registry) =>
				buildCacheRegistryApiJson(registry.toJSON()),
			),
			homerun_backup_destination: destinations.map((destination) =>
				backupDestinationApiJson(destination.toJSON()),
			),
			homerun_cron_job: cronJobs.map((job) => cronJobApiJson(job.toJSON())),
			homerun_dns_connection: dnsConnections.map((connection) => ({
				...connection.summary(),
			})),
			homerun_git_provider: gitProviders.map(gitProviderApiJson),
			homerun_notification_channel: channels.map((channel) =>
				notificationChannelApiJson(channel.toJSON()),
			),
			homerun_object_store: stores
				.filter((store) => store.kind !== "garage")
				.map((store) => ({ ...store.summary() })),
			homerun_redirect: redirects.map((redirect) => ({ ...redirect.toJSON() })),
			homerun_service: topLevel.map(serviceApiJson),
			homerun_service_account: serviceAccounts.map((account) => ({
				...account,
			})),
			homerun_service_dependency: dependencies
				.map((dependency) => dependency.toJSON())
				.filter((row) => topLevelIds.has(row.serviceId))
				.map((row) => ({ ...row })),
			homerun_service_environment: rows
				.filter(isEnvironmentRow)
				.map(serviceEnvironmentApiJson),
			homerun_stack: stacks.map((stack) => ({ ...stack.toJSON() })),
			homerun_status_page: statusPages,
			homerun_volume: volumes
				.map((volume) => volume.toJSON())
				.filter((row) => row.previewServiceId === null)
				.map((row) => ({ ...row })),
			homerun_volume_mount: mounts
				.map((mount) => mount.toJSON())
				.filter((row) => topLevelIds.has(row.serviceId))
				.map((row) => ({ ...row })),
		};
	}

	/** Every status page with its hand-picked services. */
	async #statusPages(): Promise<LiveObject[]> {
		const pages = await StatusPageDTO.list();
		return await Promise.all(
			pages.map(async (page) =>
				statusPageApiJson(page.toJSON(), await page.picks()),
			),
		);
	}

	/** Every bucket of every store that can be listed, with its expiration. */
	async #buckets(stores: ObjectStoreDTO[]): Promise<LiveObject[]> {
		const builtinOn =
			(await InstanceSettingsDTO.get()).toJSON().garageEnabled === true;
		const listed = await Promise.all(
			stores
				.filter((store) => store.kind !== "garage" || builtinOn)
				.map(async (store) => {
					try {
						const [names, publicNames] = await Promise.all([
							ObjectStorageService.bucketNames(store),
							PublicBucketDTO.namesForStore(store.id),
						]);
						return await Promise.all(
							names.map(async (name) =>
								bucketApiJson(
									store.id,
									name,
									(await ObjectStorageService.bucket(store, name))
										?.expirationDays ?? null,
									publicNames.has(name),
								),
							),
						);
					} catch (err) {
						logger.warn(
							`Buckets of ${store.name} left out of the IaC inventory`,
							err,
						);
						return [];
					}
				}),
		);
		return listed.flat();
	}

	/**
	 * Every stack (labelled by its path) and every service that isn't a
	 * preview, as `stack:<id>` / `service:<id>` options for a project's scope.
	 */
	async scopeOptions(): Promise<IacScopeOption[]> {
		const [stackRows, serviceRows] = await Promise.all([
			StackDTO.list(),
			ServiceDTO.list(),
		]);
		const stacks = stackRows.map((stack) => ({
			id: stack.id,
			name: stack.name,
			parentId: stack.parentId,
			slug: stack.slug,
		}));
		const byLabel = (a: IacScopeOption, b: IacScopeOption) =>
			a.label.localeCompare(b.label);
		return [
			...stacks
				.map(
					(stack): IacScopeOption => ({
						group: "Stacks",
						label: stackPath(stack.id, stacks),
						name: stack.name,
						value: `stack:${stack.id}`,
					}),
				)
				.sort(byLabel),
			...serviceRows
				.filter((service) => service.toJSON().previewParentId === null)
				.map(
					(service): IacScopeOption => ({
						group: "Services",
						label: service.name,
						name: service.name,
						value: `service:${service.id}`,
					}),
				)
				.sort(byLabel),
		];
	}

	/**
	 * The Terraform project for one stack (its substacks included) or one
	 * service, found by id or slug, as files, with the slug to name the
	 * folder and the archive after. Null when the stack or service doesn't
	 * exist.
	 */
	async structure(
		userId: string,
		scope: GenerateScope,
		options: { backendAddress: string | null; cli?: string; endpoint: string },
	): Promise<{ files: GeneratedFile[]; name: string; slug: string } | null> {
		const inventory = await this.inventory(userId);
		const type = scope.kind === "stack" ? "homerun_stack" : "homerun_service";
		const root = (inventory[type] ?? []).find(
			(object) => object.id === scope.id || object.slug === scope.id,
		);
		if (!root) {
			return null;
		}
		const name = String(root.name ?? root.slug ?? scope.id);
		const scoped =
			scope.kind === "stack"
				? scopeToStack(inventory, String(root.id))
				: scopeToService(inventory, String(root.id));
		return {
			files: generateStructure(scoped, {
				...options,
				generatedAt: new Date(),
				name,
			}),
			name,
			slug: String(root.slug ?? scope.id),
		};
	}

	/** A generated project as a zip, its files in a `<slug>-terraform/` folder, with the archive's file name. */
	archive(generated: { files: GeneratedFile[]; slug: string }): {
		body: Uint8Array<ArrayBuffer>;
		filename: string;
	} {
		const folder = `${generated.slug}-terraform`;
		return {
			body: zipFiles(
				generated.files.map((file) => ({
					content: file.content,
					path: `${folder}/${file.path}`,
				})),
			),
			filename: `${folder}.zip`,
		};
	}
}

export const IacInventoryService = new IacInventoryServiceClass();
