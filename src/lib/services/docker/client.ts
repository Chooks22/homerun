/**
 * A registered remote host's Docker connection, as a `remote_host` row stores
 * it (see RemoteHostDTO's `toConnection`).
 *
 * This file used to own the app's dockerode client too. It doesn't any more :
 * the app holds no Docker socket at all, every engine call goes to the Go
 * worker (see `#lib/server/worker-client.ts`), and a remote host is reached
 * through its own Homerun Agent (`agent-client.service.ts`) rather than by
 * pointing a second local client at it. What's left here is the shape the
 * database stores and the worker's own `dockerapi.RemoteHost` expects, which
 * is why it stays in the docker/ folder rather than moving into the DTO.
 */
export interface RemoteHostConnection {
	dockerHost: string;
	id: string;
	sshHostKey?: string | null;
	sshPrivateKey?: string | null;
	tlsCa?: string | null;
	tlsCert?: string | null;
	tlsKey?: string | null;
}
