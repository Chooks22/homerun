import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { expectOk } from "./support/assert";
import { docker, insertDestination } from "./support/backups";
import { ServiceCleanup } from "./support/cleanup";
import type { ApiClient } from "./support/client";
import { nativeFetch } from "./support/config";
import { apiClient, integrationContext } from "./support/context";

const SFTP_SERVER = `homerun-it-restore-sftp-${Date.now().toString(36)}`;
const SFTP_PASSWORD = "restore-test";

let client: ApiClient;
let cleanup: ServiceCleanup;
let sql: SQL;
let sftpAddress = "";
const dockerVolumes: string[] = [];

async function until<T>(
	what: string,
	check: () => Promise<T | null>,
	timeoutMs = 180_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value !== null) {
			return value;
		}
		await Bun.sleep(1500);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

beforeAll(() => {
	client = apiClient();
	cleanup = new ServiceCleanup(client);
	sql = new SQL(integrationContext().databaseUrl);
	docker(
		"run",
		"-d",
		"--name",
		SFTP_SERVER,
		"rclone/rclone:1.75.1",
		"serve",
		"sftp",
		"/data",
		"--addr",
		":2022",
		"--user",
		"bob",
		"--pass",
		SFTP_PASSWORD,
	);
	sftpAddress = docker(
		"inspect",
		"-f",
		"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
		SFTP_SERVER,
	);
});

afterAll(async () => {
	await cleanup.cleanupAll();
	for (const name of dockerVolumes) {
		Bun.spawnSync(["docker", "volume", "rm", "-f", name]);
	}
	Bun.spawnSync(["docker", "rm", "-f", SFTP_SERVER]);
	await sql.close();
});

describe("restoring a backup from a service's Storage tab", () => {
	test("restores into a new volume, redeploys with it, and a rollback with config puts the old one back", async () => {
		const { origin, userId } = integrationContext();
		const suffix = Date.now().toString(36);
		const created = await client.POST("/services", {
			body: {
				authRequired: false,
				autoDeployOnPush: false,
				buildSource: "image",
				capAdd: [],
				containerPort: 80,
				devices: [],
				dnsResolvable: false,
				envFiles: [],
				envVars: {},
				gitBuildMethod: "dockerfile",
				image: "nginx",
				labels: {},
				name: `restore-${suffix}`,
				privileged: false,
				pullPolicy: "missing",
				restartPolicy: "no",
				slug: `it-restore-${suffix}`,
				tag: "alpine",
			},
		});
		const svc = expectOk(created.data, created.response);
		cleanup.track(svc.id);

		const destinationId = await insertDestination(sql, {
			accessKeyId: "bob",
			bucket: "backups",
			endpoint: `${sftpAddress}:2022`,
			region: "",
			secret: SFTP_PASSWORD,
			type: "sftp",
		});
		const volumeId = crypto.randomUUID();
		const source = `homerun-it-restore-${suffix}`;
		const volumeName = `site-${suffix}`;
		dockerVolumes.push(source);
		const now = new Date();
		await sql`insert into storage_volume (id, name, kind, source, s3_destination_id, user_id, created_at, updated_at)
				values (${volumeId}, ${volumeName}, 'volume', ${source}, ${destinationId}, ${userId}, ${now}, ${now})`;
		await sql`insert into service_volume (id, service_id, volume_id, container_path, read_only, created_at)
				values (${crypto.randomUUID()}, ${svc.id}, ${volumeId}, '/usr/share/nginx/html', false, ${now})`;

		const firstDeploy = await client.POST("/services/{serviceId}/deploy", {
			params: { path: { serviceId: svc.id } },
		});
		const first = expectOk(firstDeploy.data, firstDeploy.response);
		docker(
			"exec",
			first.containerId ?? "",
			"sh",
			"-c",
			"echo v1 > /usr/share/nginx/html/index.html",
		);

		const backup = await nativeFetch(
			`${origin}/api/v1/volumes/${volumeId}/backup`,
			{
				headers: { "x-api-key": integrationContext().apiKey },
				method: "POST",
			},
		);
		const { jobId } = (await backup.json()) as { jobId: string };
		await until("the backup", async () => {
			const job = await client.GET("/jobs/{jobId}", {
				params: { path: { jobId } },
			});
			const status = (job.data as { status?: string } | undefined)?.status;
			if (status === "failed" || status === "cancelled") {
				throw new Error(`backup ${status}: ${JSON.stringify(job.data)}`);
			}
			return status === "succeeded" ? true : null;
		});
		const [{ key }] =
			await sql`select key from backup_run where volume_id = ${volumeId} and kind = 'backup' and success`;
		expect(key).toStartWith("restic:");

		docker(
			"exec",
			first.containerId ?? "",
			"sh",
			"-c",
			"echo v2 > /usr/share/nginx/html/index.html",
		);

		const signedIn = await nativeFetch(`${origin}/api/v1/auth/sign-in/email`, {
			body: JSON.stringify({
				email: "admin@integration.test",
				password: "integration-test-password-1234",
			}),
			headers: { "content-type": "application/json", origin },
			method: "POST",
		});
		const cookie = signedIn.headers
			.getSetCookie()
			.map((entry) => entry.split(";")[0])
			.join("; ");
		const restore = await nativeFetch(
			`${origin}/services/${svc.id}/volumes?/restoreBackup`,
			{
				body: new URLSearchParams({
					confirm: volumeName,
					key: key ?? "",
					mode: "revision",
					volumeId,
				}),
				headers: {
					accept: "application/json",
					"content-type": "application/x-www-form-urlencoded",
					cookie,
					origin,
				},
				method: "POST",
			},
		);
		expect(((await restore.json()) as { type: string }).type).toBe("success");

		const restoredVolumeId = await until(
			"the restored volume to be mounted",
			async () => {
				const [mount] =
					await sql`select volume_id from service_volume where service_id = ${svc.id}`;
				return mount && mount.volume_id !== volumeId
					? (mount.volume_id as string)
					: null;
			},
		);
		const [restored] =
			await sql`select source from storage_volume where id = ${restoredVolumeId}`;
		dockerVolumes.push(restored.source);
		const running = await until("the redeploy", async () => {
			const svcNow = await client.GET("/services/{serviceId}", {
				params: { path: { serviceId: svc.id } },
			});
			const row = svcNow.data as
				| { containerId?: string | null; currentStatus?: string }
				| undefined;
			return row?.currentStatus === "running" &&
				row.containerId &&
				row.containerId !== first.containerId
				? row.containerId
				: null;
		});
		expect(
			docker("exec", running, "cat", "/usr/share/nginx/html/index.html"),
		).toBe("v1");
		expect(
			docker(
				"run",
				"--rm",
				"-v",
				`${source}:/d`,
				"alpine:3",
				"cat",
				"/d/index.html",
			),
		).toBe("v2");

		const rolledBack = await nativeFetch(
			`${origin}/api/v1/services/${svc.id}/revisions/${first.deploymentId}/deploy?restoreConfig=true`,
			{ headers: { "x-api-key": integrationContext().apiKey }, method: "POST" },
		);
		expect(rolledBack.status).toBe(200);
		const [mountAfter] =
			await sql`select volume_id from service_volume where service_id = ${svc.id}`;
		expect(mountAfter.volume_id).toBe(volumeId);
		const svcAfter = await client.GET("/services/{serviceId}", {
			params: { path: { serviceId: svc.id } },
		});
		const containerAfter = (svcAfter.data as { containerId: string })
			.containerId;
		expect(
			docker("exec", containerAfter, "cat", "/usr/share/nginx/html/index.html"),
		).toBe("v2");

		const backupFirst = await nativeFetch(
			`${origin}/services/${svc.id}/volumes?/restoreBackup`,
			{
				body: new URLSearchParams({
					confirm: volumeName,
					key: key ?? "",
					mode: "backupFirst",
					stopServices: "on",
					volumeId,
				}),
				headers: {
					accept: "application/json",
					"content-type": "application/x-www-form-urlencoded",
					cookie,
					origin,
				},
				method: "POST",
			},
		);
		expect(((await backupFirst.json()) as { type: string }).type).toBe(
			"success",
		);
		await until("a backup of the current data, then the restore", async () => {
			const runs =
				await sql`select kind, success from backup_run where volume_id = ${volumeId} order by started_at`;
			if (
				runs.some((run: { success: boolean | null }) => run.success === false)
			) {
				throw new Error(`a run failed: ${JSON.stringify(runs)}`);
			}
			const kinds = runs.map(
				(run: { kind: string; success: boolean | null }) =>
					`${run.kind}:${run.success}`,
			);
			return kinds.join(",") === "backup:true,backup:true,restore:true"
				? true
				: null;
		});
		const containerRestored = await until(
			"the service to run again",
			async () => {
				const svcNow = await client.GET("/services/{serviceId}", {
					params: { path: { serviceId: svc.id } },
				});
				const row = svcNow.data as
					| { containerId?: string | null; currentStatus?: string }
					| undefined;
				return row?.currentStatus === "running" && row.containerId
					? row.containerId
					: null;
			},
		);
		expect(
			docker(
				"exec",
				containerRestored,
				"cat",
				"/usr/share/nginx/html/index.html",
			),
		).toBe("v1");
	}, 600_000);
});
