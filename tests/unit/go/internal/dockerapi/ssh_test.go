package dockerapi_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/tests/unit/go/internal/testsupport"
)

// pingDaemon answers /_ping and nothing else.
var pingDaemon = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/_ping" {
		_, _ = io.WriteString(w, "OK")
		return
	}
	w.WriteHeader(http.StatusNotFound)
})

func TestProbeSSHReturnsTheHostKeyAndNewRemoteReusesOneConnection(t *testing.T) {
	private, public := testsupport.SSHClientKey(t)
	host := testsupport.ServeSSHDocker(t, public, pingDaemon)
	remote := dockerapi.RemoteHost{DockerHost: host.DockerHost("deploy"), SSHPrivateKey: private}

	hostKey, err := dockerapi.ProbeSSH(context.Background(), remote)
	if err != nil {
		t.Fatal(err)
	}
	if hostKey != host.HostKey {
		t.Fatalf("host key = %q, want %q", hostKey, host.HostKey)
	}

	remote.SSHHostKey = hostKey
	client, err := dockerapi.NewRemote(remote)
	if err != nil {
		t.Fatal(err)
	}
	before := host.Handshakes()
	var group sync.WaitGroup
	for range 5 {
		group.Go(func() {
			if err := client.Ping(context.Background()); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	if got := host.Handshakes() - before; got != 1 {
		t.Fatalf("handshakes = %d, want one shared connection", got)
	}
	for _, path := range host.SocketPaths() {
		if path != "/var/run/docker.sock" {
			t.Fatalf("socket path = %q", path)
		}
	}
}

func TestNewRemoteReconnectsAfterTheConnectionDrops(t *testing.T) {
	private, public := testsupport.SSHClientKey(t)
	host := testsupport.ServeSSHDocker(t, public, pingDaemon)
	client, err := dockerapi.NewRemote(dockerapi.RemoteHost{
		DockerHost: host.DockerHost("deploy"), SSHHostKey: host.HostKey, SSHPrivateKey: private,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	host.DropConnections()
	if err := client.Ping(context.Background()); err != nil {
		t.Fatalf("a dropped connection should be reopened: %v", err)
	}
	if got := host.Handshakes(); got != 2 {
		t.Fatalf("handshakes = %d, want 2", got)
	}
}

func TestNewRemoteRefusesAChangedHostKey(t *testing.T) {
	private, public := testsupport.SSHClientKey(t)
	host := testsupport.ServeSSHDocker(t, public, pingDaemon)
	other := testsupport.ServeSSHDocker(t, public, pingDaemon)
	client, err := dockerapi.NewRemote(dockerapi.RemoteHost{
		DockerHost: host.DockerHost("deploy"), SSHHostKey: other.HostKey, SSHPrivateKey: private,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ping(context.Background()); !errors.Is(err, dockerapi.ErrSSHHostKeyChanged) {
		t.Fatalf("err = %v, want ErrSSHHostKeyChanged", err)
	}
	_, err = dockerapi.ProbeSSH(context.Background(), dockerapi.RemoteHost{
		DockerHost: host.DockerHost("deploy"), SSHHostKey: other.HostKey, SSHPrivateKey: private,
	})
	if !errors.Is(err, dockerapi.ErrSSHHostKeyChanged) {
		t.Fatalf("probe err = %v, want ErrSSHHostKeyChanged", err)
	}
}

func TestProbeSSHExplainsAnUnknownKeyAndRefusedForwarding(t *testing.T) {
	private, public := testsupport.SSHClientKey(t)
	stranger, _ := testsupport.SSHClientKey(t)
	host := testsupport.ServeSSHDocker(t, public, pingDaemon)

	_, err := dockerapi.ProbeSSH(context.Background(), dockerapi.RemoteHost{
		DockerHost: host.DockerHost("deploy"), SSHPrivateKey: stranger,
	})
	if err == nil || !strings.Contains(err.Error(), "authorized_keys") || !strings.Contains(err.Error(), `"deploy"`) {
		t.Fatalf("err = %v, want the authorized_keys hint for deploy", err)
	}

	host.RefuseForwarding.Store(true)
	_, err = dockerapi.ProbeSSH(context.Background(), dockerapi.RemoteHost{
		DockerHost: host.DockerHost("deploy"), SSHPrivateKey: private,
	})
	if err == nil || !strings.Contains(err.Error(), "stream-local forwarding") {
		t.Fatalf("err = %v, want the forwarding hint", err)
	}
}

func TestSSHRemoteHostsNeedAUserAKeyAndARecordedHostKey(t *testing.T) {
	private, _ := testsupport.SSHClientKey(t)
	cases := []struct {
		host dockerapi.RemoteHost
		want string
	}{
		{dockerapi.RemoteHost{DockerHost: "ssh://box", SSHHostKey: "ssh-ed25519 AAAA", SSHPrivateKey: private}, "no user"},
		{dockerapi.RemoteHost{DockerHost: "ssh://deploy@box", SSHHostKey: "ssh-ed25519 AAAA"}, "no SSH key"},
		{dockerapi.RemoteHost{DockerHost: "ssh://deploy@box", SSHHostKey: "ssh-ed25519 AAAA", SSHPrivateKey: "nope"}, "couldn't read the SSH key"},
		{dockerapi.RemoteHost{DockerHost: "ssh://deploy@box", SSHPrivateKey: private}, "no SSH host key"},
		{dockerapi.RemoteHost{DockerHost: "unix:///var/run/docker.sock"}, "only tcp:// and ssh://"},
	}
	for _, testCase := range cases {
		if _, err := dockerapi.NewRemote(testCase.host); err == nil || !strings.Contains(err.Error(), testCase.want) {
			t.Errorf("%s: err = %v, want %q", testCase.host.DockerHost, err, testCase.want)
		}
	}
	if _, err := dockerapi.ProbeSSH(context.Background(), dockerapi.RemoteHost{DockerHost: "tcp://box:2375"}); err == nil {
		t.Error("probing a tcp:// host should fail")
	}
	if _, err := dockerapi.ProbeSSH(context.Background(), dockerapi.RemoteHost{DockerHost: "ssh://deploy@127.0.0.1:1", SSHPrivateKey: private}); err == nil || !strings.Contains(err.Error(), "couldn't reach") {
		t.Errorf("err = %v, want couldn't reach", err)
	}
}
