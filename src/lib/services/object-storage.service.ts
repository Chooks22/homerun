import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ObjectStoreDTO } from "#lib/dto/object-store-dto.js";
import { PublicBucketDTO } from "#lib/dto/public-bucket-dto.js";
import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { Logger } from "#lib/logger.js";
import {
	BUILTIN_STORE_NAME,
	bucketNameProblem,
	GARAGE_REGION,
} from "#lib/object-storage.js";
import {
	PUBLIC_BUCKETS_FILE,
	publicBucketsConfig,
	publicBucketUrl,
} from "#lib/public-bucket-routes.js";
import type { ObjectStoreFormValues } from "#lib/server/validation/object-store.js";
import { DOMAIN_RE } from "#lib/service-domains.js";
import { syncCoreHostDns } from "./dns.service.ts";
import { certResolverFor } from "./docker/cert-resolver.ts";
import { errorPagesTarget } from "./docker/error-pages.ts";
import {
	GARAGE_CONTAINER_NAME,
	GARAGE_S3_PORT,
	type GarageDesiredState,
} from "./docker/garage-container.ts";
import { DockerService } from "./docker.service.ts";
import {
	GarageAdminClient,
	type GarageBucketKey,
	type GaragePermissions,
} from "./s3/garage-admin.ts";
import {
	type BucketUsage,
	ObjectStoreClient,
} from "./s3/object-store-client.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

const logger = new Logger("ObjectStorage");

const HOMERUN_KEY_NAME = "homerun";
const START_ATTEMPTS = 20;
const START_DELAY_MS = 1000;

export interface BuiltinStatus {
	enabled: boolean;
	publicHost: string | null;
	running: boolean;
	usageBytes: number | null;
}

export interface BucketRow {
	name: string;
	public: boolean;
	storeId: string;
	storeKind: ObjectStoreDTO["kind"];
	storeName: string;
}

export interface StoreFailure {
	message: string;
	storeName: string;
}

export interface BucketDetail {
	endpoint: string;
	expirationDays: number | null;
	keys: GarageBucketKey[] | null;
	region: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Object storage: the built-in Garage node and any S3-compatible store
 * connected to the instance, their buckets, lifecycle rules and, on the
 * built-in store, per-bucket access keys.
 */
class ObjectStorageServiceClass {
	/** The built-in store's toggle, whether its container runs, and the bytes its buckets hold. */
	async builtinStatus(): Promise<BuiltinStatus> {
		const settings = (await InstanceSettingsDTO.get()).toJSON();
		const running = await DockerService.garageRunning().catch(() => false);
		let usageBytes: number | null = null;
		if (running) {
			usageBytes = await this.#builtinUsageBytes().catch(() => null);
		}
		return {
			enabled: settings.garageEnabled === true,
			publicHost: settings.garagePublicHost ?? null,
			running,
			usageBytes,
		};
	}

	/** The total size of every bucket on the built-in store. */
	async #builtinUsageBytes(): Promise<number> {
		const admin = await this.#admin();
		const infos = await Promise.all(
			(await admin.bucketNames()).map((name) => admin.bucket(name)),
		);
		return infos.reduce((sum, info) => sum + (info?.bytes ?? 0), 0);
	}

	/** The container settings Garage should run with, minting its secrets the first time. */
	async #desiredState(): Promise<GarageDesiredState> {
		const settings = await InstanceSettingsDTO.get();
		const row = settings.toJSON();
		let rpcSecret = row.garageRpcSecretEnc
			? decryptSecret(row.garageRpcSecretEnc)
			: null;
		let adminToken = row.garageAdminTokenEnc
			? decryptSecret(row.garageAdminTokenEnc)
			: null;
		if (!(rpcSecret && adminToken)) {
			rpcSecret = randomBytes(32).toString("hex");
			adminToken = randomBytes(32).toString("base64url");
			await settings.persistGarage({
				garageAdminTokenEnc: encryptSecret(adminToken),
				garageRpcSecretEnc: encryptSecret(rpcSecret),
			});
		}
		return { adminToken, publicHost: row.garagePublicHost ?? null, rpcSecret };
	}

	/**
	 * The admin client for the running Garage node.
	 *
	 * @throws When Garage isn't reachable or its token can't be decrypted.
	 */
	async #admin(): Promise<GarageAdminClient> {
		const row = (await InstanceSettingsDTO.get()).toJSON();
		const token = row.garageAdminTokenEnc
			? decryptSecret(row.garageAdminTokenEnc)
			: null;
		if (!token) {
			throw new Error("The built-in object store has never been turned on.");
		}
		const endpoints = await DockerService.garageEndpoints();
		return new GarageAdminClient(endpoints.admin, token);
	}

	/**
	 * Turns the built-in store on: starts Garage, gives the fresh node its
	 * layout, and the first time, creates Homerun's own key and the store row
	 * every bucket page uses.
	 *
	 * @throws When Garage doesn't come up or refuses its first setup.
	 */
	async enableBuiltin(userId: string): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		await settings.persistGarage({ garageEnabled: true });
		await DockerService.reconcileGarage(await this.#desiredState());
		const admin = await this.#waitForAdmin();
		await admin.ensureLayout();
		if (await ObjectStoreDTO.builtin()) {
			return;
		}
		const key = await admin.createKey(HOMERUN_KEY_NAME);
		await ObjectStoreDTO.create({
			accessKeyId: key.accessKeyId,
			endpoint: "",
			kind: "garage",
			name: BUILTIN_STORE_NAME,
			region: GARAGE_REGION,
			secretAccessKey: key.secretAccessKey,
			userId,
		});
		logger.info("Built-in object store set up.");
	}

	/** Retries reaching the admin API while a just-created container starts. */
	async #waitForAdmin(): Promise<GarageAdminClient> {
		let lastError: unknown = null;
		for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- polling until the container answers
				return await this.#admin();
			} catch (err) {
				lastError = err;
				// oxlint-disable-next-line no-await-in-loop -- polling until the container answers
				await sleep(START_DELAY_MS);
			}
		}
		throw new Error(`Garage didn't come up: ${message(lastError)}`);
	}

	/** Turns the built-in store off: removes the container, keeps its volumes and the store row. */
	async disableBuiltin(): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		await settings.persistGarage({ garageEnabled: false });
		await DockerService.reconcileGarage(null);
		await this.syncPublicRoutes();
	}

	/** Why `host` can't be published right now (not a hostname, or the store is off), or null, checked before the change is queued. */
	async builtinPublicHostProblem(host: string): Promise<string | null> {
		const trimmed = host.trim().toLowerCase();
		if (trimmed && !DOMAIN_RE.test(trimmed)) {
			return "That isn't a hostname, e.g. s3.example.com.";
		}
		const settings = (await InstanceSettingsDTO.get()).toJSON();
		return settings.garageEnabled === true
			? null
			: "Turn the built-in object store on first.";
	}

	/**
	 * Publishes the built-in store's S3 API at `host` through Traefik, or
	 * takes it back to internal-only with an empty host.
	 *
	 * @throws When the host isn't a hostname or the store is off.
	 */
	async setBuiltinPublicHost(host: string): Promise<void> {
		const trimmed = host.trim().toLowerCase();
		if (trimmed && !DOMAIN_RE.test(trimmed)) {
			throw new Error("That isn't a hostname, e.g. s3.example.com.");
		}
		const settings = await InstanceSettingsDTO.get();
		const row = settings.toJSON();
		if (row.garageEnabled !== true) {
			throw new Error("Turn the built-in object store on first.");
		}
		await settings.persistGarage({ garagePublicHost: trimmed || null });
		await DockerService.reconcileGarage(await this.#desiredState());
		await this.syncPublicRoutes();
		void syncCoreHostDns(
			"Object storage",
			row.garagePublicHost ?? null,
			trimmed || null,
		);
	}

	/** Brings Garage back after a worker restart, the way the registry is re-asserted. */
	async reassertBuiltin(): Promise<void> {
		const row = (await InstanceSettingsDTO.get()).toJSON();
		if (row.garageEnabled !== true) {
			return;
		}
		await DockerService.reconcileGarage(await this.#desiredState());
		await this.syncPublicRoutes();
		if (row.garagePublicHost) {
			void syncCoreHostDns("Object storage", null, row.garagePublicHost);
		}
	}

	/**
	 * The S3 endpoint people and other containers use: an external store's
	 * own URL, or for the built-in one its public hostname when published,
	 * its address on the shared Docker network otherwise.
	 */
	async publicEndpoint(store: ObjectStoreDTO): Promise<string> {
		if (store.kind !== "garage") {
			return store.endpoint;
		}
		const row = (await InstanceSettingsDTO.get()).toJSON();
		return row.garagePublicHost
			? `https://${row.garagePublicHost}`
			: `http://${GARAGE_CONTAINER_NAME}:${GARAGE_S3_PORT}`;
	}

	/**
	 * An S3 client for a store, signed with its stored credentials and, for
	 * the built-in one, pointed at whichever Garage address answers from here.
	 *
	 * @throws When the secret can't be decrypted or Garage isn't reachable.
	 */
	async client(store: ObjectStoreDTO): Promise<ObjectStoreClient> {
		const secretAccessKey = store.decryptSecretAccessKey();
		if (!secretAccessKey) {
			throw new Error(`Couldn't decrypt ${store.name}'s secret.`);
		}
		const endpoint =
			store.kind === "garage"
				? (await DockerService.garageEndpoints()).s3
				: store.endpoint;
		return new ObjectStoreClient({
			accessKeyId: store.accessKeyId,
			endpoint,
			region: store.region,
			secretAccessKey,
		});
	}

	/**
	 * Proves credentials work by listing buckets with them, before a store
	 * is saved.
	 *
	 * @throws With the store's own error.
	 */
	async testCredentials(input: {
		accessKeyId: string;
		endpoint: string;
		region: string;
		secretAccessKey: string;
	}): Promise<number> {
		return (await new ObjectStoreClient(input).listBuckets()).length;
	}

	/**
	 * Saves a new external store once its credentials list buckets.
	 *
	 * @throws When the store refuses the credentials.
	 */
	async createStore(
		values: ObjectStoreFormValues,
		userId: string,
	): Promise<ObjectStoreDTO> {
		try {
			await this.testCredentials(values);
		} catch (cause) {
			throw new Error(
				`Couldn't list buckets with these settings: ${message(cause)}`,
			);
		}
		return await ObjectStoreDTO.create({ ...values, kind: "s3", userId });
	}

	/**
	 * Saves an external store's edited connection once it lists buckets; a
	 * blank secret keeps the stored one.
	 *
	 * @throws When the store refuses the credentials.
	 */
	async updateStore(
		store: ObjectStoreDTO,
		values: ObjectStoreFormValues,
	): Promise<void> {
		try {
			await this.testCredentials({
				...values,
				secretAccessKey:
					values.secretAccessKey || store.decryptSecretAccessKey(),
			});
		} catch (cause) {
			throw new Error(
				`Couldn't list buckets with these settings: ${message(cause)}`,
			);
		}
		await store.update(values);
	}

	/**
	 * The names of a store's buckets.
	 *
	 * @throws When the store can't be listed.
	 */
	async bucketNames(store: ObjectStoreDTO): Promise<string[]> {
		return store.kind === "garage"
			? await (await this.#admin()).bucketNames()
			: (await (await this.client(store)).listBuckets()).map(
					(bucket) => bucket.name,
				);
	}

	/**
	 * Every bucket on every store, by store then name. A store that can't be
	 * listed (unreachable, wrong credentials, the built-in one switched off)
	 * is reported in `failures` instead of failing the whole list.
	 */
	async buckets(): Promise<{ failures: StoreFailure[]; rows: BucketRow[] }> {
		const builtinOn =
			(await InstanceSettingsDTO.get()).toJSON().garageEnabled === true;
		const stores = (await ObjectStoreDTO.list()).filter(
			(store) => store.kind !== "garage" || builtinOn,
		);
		const rows: BucketRow[] = [];
		const failures: StoreFailure[] = [];
		await Promise.all(
			stores.map(async (store) => {
				try {
					const [names, publicNames] = await Promise.all([
						this.bucketNames(store),
						PublicBucketDTO.namesForStore(store.id),
					]);
					for (const name of names) {
						rows.push({
							name,
							public: publicNames.has(name),
							storeId: store.id,
							storeKind: store.kind,
							storeName: store.name,
						});
					}
				} catch (err) {
					failures.push({ message: message(err), storeName: store.name });
				}
			}),
		);
		rows.sort(
			(a, b) =>
				a.storeName.localeCompare(b.storeName) || a.name.localeCompare(b.name),
		);
		return { failures, rows };
	}

	/**
	 * How much a bucket holds. Exact and instant on the built-in store; on
	 * another store, counted by listing at most 10,000 objects.
	 *
	 * @throws When the bucket can't be read.
	 */
	async usage(store: ObjectStoreDTO, bucket: string): Promise<BucketUsage> {
		if (store.kind === "garage") {
			const info = await (await this.#admin()).bucket(bucket);
			return {
				bytes: info?.bytes ?? 0,
				capped: false,
				objects: info?.objects ?? 0,
			};
		}
		return await (await this.client(store)).usage(bucket);
	}

	/**
	 * Creates a bucket on a store. On the built-in store it gets a global
	 * name every key can address, and Homerun's own key owns it.
	 *
	 * @throws When the name is invalid or the store refuses it.
	 */
	async createBucket(store: ObjectStoreDTO, bucket: string): Promise<void> {
		const problem = bucketNameProblem(bucket);
		if (problem) {
			throw new Error(problem);
		}
		if (store.kind === "garage") {
			await (await this.#admin()).createBucket(bucket, store.accessKeyId);
			return;
		}
		await (await this.client(store)).createBucket(bucket);
	}

	/**
	 * Deletes an empty bucket, or with `empty` deletes every object in it
	 * first.
	 *
	 * @throws With a plain message when it still holds objects.
	 */
	async deleteBucket(
		store: ObjectStoreDTO,
		bucket: string,
		empty = false,
	): Promise<void> {
		if (empty) {
			await this.emptyBucket(store, bucket);
		}
		if (store.kind === "garage") {
			await (await this.#admin()).deleteBucket(bucket);
		} else {
			await (await this.client(store)).deleteBucket(bucket);
		}
		await this.setPublic(store, bucket, false);
	}

	/**
	 * Deletes every object in a bucket, returning how many went.
	 *
	 * @throws When the store refuses to list or delete them.
	 */
	async emptyBucket(store: ObjectStoreDTO, bucket: string): Promise<number> {
		return await (await this.client(store)).emptyBucket(bucket);
	}

	/**
	 * Makes a bucket public or private again, and republishes the built-in
	 * store's public-bucket routes on its S3 hostname.
	 */
	async setPublic(
		store: ObjectStoreDTO,
		bucket: string,
		isPublic: boolean,
	): Promise<void> {
		await PublicBucketDTO.setPublic(store.id, bucket, isPublic);
		if (store.kind === "garage") {
			await this.syncPublicRoutes();
		}
	}

	/**
	 * The URL a public bucket's objects are served under, ending in "/": the
	 * built-in store's published S3 hostname when it has one, this instance's
	 * `/public/` route otherwise.
	 */
	async publicUrl(
		store: ObjectStoreDTO,
		bucket: string,
		fallbackOrigin: string,
	): Promise<string> {
		const row = (await InstanceSettingsDTO.get()).toJSON();
		return publicBucketUrl({
			bucket,
			origin: config.auth.origin ?? fallbackOrigin,
			publicHost:
				row.garageEnabled === true ? (row.garagePublicHost ?? null) : null,
			storeId: store.id,
			storeKind: store.kind,
		});
	}

	/**
	 * Rewrites the Traefik file routing unsigned reads of the built-in
	 * store's public buckets on its S3 hostname to this app, or removes it
	 * when the store is off, unpublished or has no public bucket. Failures
	 * are logged, never thrown.
	 */
	async syncPublicRoutes(): Promise<void> {
		const dir = config.traefik.dynamicConfigDir;
		const target = errorPagesTarget(config.authCheckUrl);
		if (!(dir && target)) {
			return;
		}
		const path = join(dir, PUBLIC_BUCKETS_FILE);
		try {
			const row = (await InstanceSettingsDTO.get()).toJSON();
			const store = await ObjectStoreDTO.builtin();
			const host =
				row.garageEnabled === true ? (row.garagePublicHost ?? null) : null;
			const content =
				store && host
					? publicBucketsConfig({
							buckets: [...(await PublicBucketDTO.namesForStore(store.id))],
							certResolver: certResolverFor(
								host,
								config.traefik.certResolver,
								config.pangolinEnabled,
								config.traefik.instanceCertNames,
							),
							entrypoint: config.traefik.entrypoint,
							host,
							storeId: store.id,
							target,
						})
					: null;
			if (content === null) {
				await rm(path, { force: true });
			} else {
				await mkdir(dir, { recursive: true });
				await writeFile(path, content);
			}
		} catch (err) {
			logger.error("Couldn't publish the public buckets' routes", err);
		}
	}

	/**
	 * A bucket's connection details, lifecycle and, on the built-in store,
	 * the keys that can reach it (Homerun's own left out), or null when the
	 * built-in store has no bucket by that name.
	 *
	 * @throws When the bucket can't be read.
	 */
	async bucket(
		store: ObjectStoreDTO,
		bucket: string,
	): Promise<BucketDetail | null> {
		const [expirationDays, info] = await Promise.all([
			(await this.client(store)).expirationDays(bucket),
			store.kind === "garage"
				? (await this.#admin()).bucket(bucket)
				: Promise.resolve(undefined),
		]);
		if (info === null) {
			return null;
		}
		const keys = info
			? info.keys.filter((key) => key.accessKeyId !== store.accessKeyId)
			: null;
		return {
			endpoint: await this.publicEndpoint(store),
			expirationDays,
			keys,
			region: store.region,
		};
	}

	/**
	 * Expires a bucket's objects after `days`, or stops expiring them with
	 * null.
	 *
	 * @throws With the store's own error.
	 */
	async setExpiration(
		store: ObjectStoreDTO,
		bucket: string,
		days: number | null,
	): Promise<void> {
		await (await this.client(store)).setExpirationDays(bucket, days);
	}

	/**
	 * Creates a key on the built-in store with `permissions` on one bucket.
	 *
	 * @returns The key and its secret, which Garage hands out only now.
	 * @throws When the store isn't the built-in one or the bucket is missing.
	 */
	async createKey(
		store: ObjectStoreDTO,
		bucket: string,
		name: string,
		permissions: GaragePermissions,
	): Promise<{ accessKeyId: string; secretAccessKey: string }> {
		if (store.kind !== "garage") {
			throw new Error(
				"Keys for this store are managed in its provider's console.",
			);
		}
		const admin = await this.#admin();
		const info = await admin.bucket(bucket);
		if (!info) {
			throw new Error(`${bucket} doesn't exist.`);
		}
		const key = await admin.createKey(name);
		await admin.allow(info.id, key.accessKeyId, permissions);
		return {
			accessKeyId: key.accessKeyId,
			secretAccessKey: key.secretAccessKey,
		};
	}

	/**
	 * Deletes a key on the built-in store. Homerun's own key can't go.
	 *
	 * @throws When it's Homerun's key or the store isn't the built-in one.
	 */
	async revokeKey(store: ObjectStoreDTO, accessKeyId: string): Promise<void> {
		if (store.kind !== "garage") {
			throw new Error(
				"Keys for this store are managed in its provider's console.",
			);
		}
		if (accessKeyId === store.accessKeyId) {
			throw new Error("That's Homerun's own key, it can't be revoked here.");
		}
		await (await this.#admin()).deleteKey(accessKeyId);
	}

	/**
	 * Adds a bucket as a backup destination: with a dedicated read/write key
	 * on the built-in store, with the store's own credentials otherwise.
	 *
	 * @throws When the key can't be created.
	 */
	async useAsBackupDestination(
		store: ObjectStoreDTO,
		bucket: string,
		userId: string,
	): Promise<S3DestinationDTO> {
		const credentials =
			store.kind === "garage"
				? await this.createKey(store, bucket, `backups-${bucket}`, {
						owner: false,
						read: true,
						write: true,
					})
				: {
						accessKeyId: store.accessKeyId,
						secretAccessKey: store.decryptSecretAccessKey(),
					};
		return await S3DestinationDTO.create({
			...credentials,
			bucket,
			endpoint: await this.publicEndpoint(store),
			name: `${bucket} (${store.name})`,
			region: store.region,
			type: "s3",
			userId,
		});
	}
}

export const ObjectStorageService = new ObjectStorageServiceClass();
