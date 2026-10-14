import Docker from "dockerode";

const GIT_IMAGE = "alpine/git:latest";
const GIT_DAEMON_PORT = 9418;

export interface GitBuildFixture {
	stop: () => Promise<void>;
	url: string;
}

export async function createGitBuildFixture(
	socketPath: string,
): Promise<GitBuildFixture> {
	const docker = new Docker({ socketPath });
	const id = Math.random().toString(36).slice(2, 8);
	const volumeName = `homerun-it-gitfixture-${id}`;

	await ensureImage(docker);
	await docker.createVolume({ Name: volumeName });

	const state: { daemon: Docker.Container | null } = { daemon: null };
	try {
		return await build();
	} catch (err) {
		if (state.daemon) {
			await state.daemon.remove({ force: true }).catch(() => undefined);
		}
		await docker
			.getVolume(volumeName)
			.remove()
			.catch(() => undefined);
		throw err;
	}

	async function build(): Promise<GitBuildFixture> {
		const seed = await docker.createContainer({
			Cmd: [
				[
					"mkdir -p /srv/repo",
					"cd /srv/repo",
					'printf \'FROM busybox:latest\\nCMD ["sh", "-c", "echo hello from git-build; sleep 3600"]\\n\' > Dockerfile',
					"git init --initial-branch=main -q .",
					"git config user.email integration-tests@homerun.local",
					"git config user.name 'Homerun Integration Tests'",
					"git add -A",
					"git commit -q -m 'git-build fixture'",
					"touch .git/git-daemon-export-ok",
					"cp -r /srv/repo /srv/manifest-repo",
					"cd /srv/manifest-repo",
					"printf 'containerPort: 8080\\nenvVars:\\n  FROM_MANIFEST: \"yes\"\\n' > .homerun.yaml",
					"git add -A",
					"git commit -q -m 'manifest fixture'",
				].join(" && "),
			],
			Entrypoint: ["/bin/sh", "-c"],
			HostConfig: { Binds: [`${volumeName}:/srv`] },
			Image: GIT_IMAGE,
		});
		await seed.start();
		const seeded = await seed.wait();
		const seedLog = (
			await seed.logs({ stderr: true, stdout: true })
		).toString();
		await seed.remove({ force: true });
		if (seeded.StatusCode !== 0) {
			throw new Error(
				`git fixture seed failed (${seeded.StatusCode}): ${seedLog}`,
			);
		}

		state.daemon = await docker.createContainer({
			Cmd: [
				[
					"apk add --no-cache git-daemon >/dev/null",
					"exec git daemon --verbose --base-path=/srv --export-all --reuseaddr --listen=0.0.0.0 /srv",
				].join(" && "),
			],
			Entrypoint: ["/bin/sh", "-c"],
			HostConfig: { Binds: [`${volumeName}:/srv:ro`] },
			Image: GIT_IMAGE,
		});
		const daemon = state.daemon;
		await daemon.start();
		await waitForDaemon(daemon);

		const info = await daemon.inspect();
		const ip = Object.values(info.NetworkSettings?.Networks ?? {}).find(
			(net) => net.IPAddress,
		)?.IPAddress;
		if (!ip) {
			throw new Error(
				"git fixture daemon has no address on the Docker network",
			);
		}

		const started = daemon;
		return {
			stop: async () => {
				await started.remove({ force: true }).catch(() => undefined);
				await docker
					.getVolume(volumeName)
					.remove()
					.catch(() => undefined);
			},
			url: `git://${ip}:${GIT_DAEMON_PORT}/repo`,
		};
	}
}

async function waitForDaemon(
	daemon: Docker.Container,
	timeoutMs = 60_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const log = (await daemon.logs({ stderr: true, stdout: true })).toString();
		if (/Ready to rumble/i.test(log)) {
			return;
		}
		const info = await daemon.inspect();
		if (!info.State?.Running) {
			throw new Error(`git fixture daemon exited: ${log}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("git fixture daemon never became ready");
}

async function ensureImage(docker: Docker): Promise<void> {
	try {
		await docker.getImage(GIT_IMAGE).inspect();
		return;
	} catch {}
	const stream: NodeJS.ReadableStream = await docker.pull(GIT_IMAGE, {});
	await new Promise<void>((resolve, reject) => {
		docker.modem.followProgress(stream, (err) =>
			err ? reject(err) : resolve(),
		);
	});
}
