import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { RemoteHostDTO } = await import("../../../src/lib/dto/remote-host-dto");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { WorkerClient } = await import("../../../src/lib/server/worker-client");
const { encryptSecret } = await import("../../../src/lib/services/secrets");

type Host = NonNullable<Awaited<ReturnType<typeof RemoteHostDTO.get>>>;
type Settings = Awaited<ReturnType<typeof InstanceSettingsDTO.get>>;

const restorers: { mockRestore: () => void }[] = [];

afterEach(() => {
	for (const restorer of restorers.splice(0)) {
		restorer.mockRestore();
	}
});

/** A RemoteHostDTO over an in-memory row, its writes recorded instead of saved. */
function host(row: Record<string, unknown>) {
	const updates: Record<string, unknown>[] = [];
	const instance = new (
		RemoteHostDTO as unknown as new (
			row: Record<string, unknown>,
		) => Host
	)({
		dockerHost: null,
		id: "h1",
		kind: "docker",
		sshHostKey: null,
		tlsCaEnc: null,
		tlsCertEnc: null,
		tlsKeyEnc: null,
		...row,
	});
	restorers.push(
		spyOn(instance, "update").mockImplementation(
			async (patch: Record<string, unknown>) => {
				updates.push(patch);
			},
		),
	);
	return { instance, updates };
}

/** Stubs the instance's SSH key pair, null for none generated yet. */
function keyPair(pair: { privateKey: string; publicKey: string } | null) {
	restorers.push(
		spyOn(InstanceSettingsDTO, "get").mockResolvedValue({
			sshKeyPair: pair,
		} as unknown as Settings),
	);
}

describe("RemoteHostDTO.toDockerConnection", () => {
	test("a tcp:// host is its TLS connection, with no SSH material and no worker call", async () => {
		const post = spyOn(WorkerClient, "post");
		restorers.push(post);
		const { instance } = host({
			dockerHost: "tcp://10.0.0.5:2376",
			tlsCaEnc: encryptSecret("CA"),
		});
		expect(await instance.toDockerConnection()).toEqual({
			dockerHost: "tcp://10.0.0.5:2376",
			id: "h1",
			tlsCa: "CA",
			tlsCert: null,
			tlsKey: null,
		});
		expect(post).not.toHaveBeenCalled();
	});

	test("an ssh:// host with no recorded host key is probed once and the key recorded", async () => {
		keyPair({ privateKey: "PRIVATE", publicKey: "ssh-ed25519 PUB" });
		const post = spyOn(WorkerClient, "post").mockResolvedValue({
			hostKey: "ssh-ed25519 HOST",
		});
		restorers.push(post);
		const { instance, updates } = host({ dockerHost: "ssh://deploy@10.0.0.7" });
		expect(await instance.toDockerConnection()).toMatchObject({
			dockerHost: "ssh://deploy@10.0.0.7",
			sshHostKey: "ssh-ed25519 HOST",
			sshPrivateKey: "PRIVATE",
		});
		expect(post).toHaveBeenCalledWith("/v1/ssh/docker-probe", {
			dockerHost: "ssh://deploy@10.0.0.7",
			sshHostKey: "",
			sshPrivateKey: "PRIVATE",
		});
		expect(updates).toEqual([{ sshHostKey: "ssh-ed25519 HOST" }]);
	});

	test("an ssh:// host with a recorded host key isn't probed again", async () => {
		keyPair({ privateKey: "PRIVATE", publicKey: "ssh-ed25519 PUB" });
		const post = spyOn(WorkerClient, "post");
		restorers.push(post);
		const { instance, updates } = host({
			dockerHost: "ssh://deploy@10.0.0.7",
			sshHostKey: "ssh-ed25519 KNOWN",
		});
		expect(await instance.toDockerConnection()).toMatchObject({
			sshHostKey: "ssh-ed25519 KNOWN",
			sshPrivateKey: "PRIVATE",
		});
		expect(post).not.toHaveBeenCalled();
		expect(updates).toEqual([]);
	});

	test("an ssh:// host before Homerun has an SSH key says where to get one", async () => {
		keyPair(null);
		const { instance } = host({ dockerHost: "ssh://deploy@10.0.0.7" });
		await expect(instance.toDockerConnection()).rejects.toThrow(
			"Homerun has no SSH key yet",
		);
	});

	test("a build server on an ssh:// host resolves with its SSH material", async () => {
		keyPair({ privateKey: "PRIVATE", publicKey: "ssh-ed25519 PUB" });
		const { instance } = host({
			dockerHost: "ssh://deploy@10.0.0.7",
			sshHostKey: "ssh-ed25519 KNOWN",
		});
		restorers.push(spyOn(RemoteHostDTO, "get").mockResolvedValue(instance));
		expect(await RemoteHostDTO.resolveBuildTarget("h1")).toMatchObject({
			connection: { sshHostKey: "ssh-ed25519 KNOWN", sshPrivateKey: "PRIVATE" },
			hostId: "h1",
			kind: "docker",
		});
	});
});
