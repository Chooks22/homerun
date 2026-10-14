package testsupport

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"golang.org/x/crypto/ssh"
)

// SSHClientKey is a PKCS#8 PEM ed25519 key, the form the app generates, and
// its public half.
func SSHClientKey(t *testing.T) (string, ssh.PublicKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	sshPublic, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Bytes: der, Type: "PRIVATE KEY"})), sshPublic
}

// SSHDockerHost is an SSH server standing in for an ssh:// Docker host: it
// lets one key in and forwards every stream-local channel to
// /var/run/docker.sock onto a fake daemon.
type SSHDockerHost struct {
	// Address is the server's host:port.
	Address string
	// HostKey is the server's host key in authorized_keys form.
	HostKey string
	// RefuseForwarding makes it reject every stream-local channel, as an sshd
	// with forwarding disabled does.
	RefuseForwarding atomic.Bool

	mu          sync.Mutex
	connections []*ssh.ServerConn
	handshakes  int
	socketPaths []string
}

// ServeSSHDocker starts an SSHDockerHost that lets `allowed` in and answers
// its daemon with handler, closed when the test ends.
func ServeSSHDocker(t *testing.T, allowed ssh.PublicKey, handler http.Handler) *SSHDockerHost {
	t.Helper()
	daemon := httptest.NewServer(handler)
	t.Cleanup(daemon.Close)
	_, hostPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPrivate)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if bytes.Equal(key.Marshal(), allowed.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("unknown key")
		},
	}
	config.AddHostKey(hostSigner)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	host := &SSHDockerHost{
		Address: listener.Addr().String(),
		HostKey: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(hostSigner.PublicKey()))),
	}
	t.Cleanup(func() {
		_ = listener.Close()
		host.DropConnections()
	})
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go host.handle(conn, config, daemon.Listener.Addr().String())
		}
	}()
	return host
}

// DockerHost is the ssh:// address of the server for user.
func (h *SSHDockerHost) DockerHost(user string) string {
	return "ssh://" + user + "@" + h.Address
}

// Handshakes is how many SSH connections have been accepted so far.
func (h *SSHDockerHost) Handshakes() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.handshakes
}

// SocketPaths is every socket path a channel asked for.
func (h *SSHDockerHost) SocketPaths() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.socketPaths...)
}

// DropConnections closes every SSH connection, as a host rebooting would.
func (h *SSHDockerHost) DropConnections() {
	h.mu.Lock()
	connections := h.connections
	h.connections = nil
	h.mu.Unlock()
	for _, connection := range connections {
		_ = connection.Close()
	}
}

// handle runs one SSH connection, forwarding its stream-local channels to
// the daemon at daemonAddress.
func (h *SSHDockerHost) handle(conn net.Conn, config *ssh.ServerConfig, daemonAddress string) {
	server, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	h.mu.Lock()
	h.handshakes++
	h.connections = append(h.connections, server)
	h.mu.Unlock()
	go ssh.DiscardRequests(requests)
	for request := range channels {
		if request.ChannelType() != "direct-streamlocal@openssh.com" {
			_ = request.Reject(ssh.UnknownChannelType, "only stream-local channels")
			continue
		}
		var target struct {
			SocketPath string
			Reserved0  string
			Reserved1  uint32
		}
		if err := ssh.Unmarshal(request.ExtraData(), &target); err != nil {
			_ = request.Reject(ssh.ConnectionFailed, err.Error())
			continue
		}
		h.mu.Lock()
		h.socketPaths = append(h.socketPaths, target.SocketPath)
		h.mu.Unlock()
		if h.RefuseForwarding.Load() {
			_ = request.Reject(ssh.Prohibited, "stream-local forwarding disabled")
			continue
		}
		upstream, err := net.Dial("tcp", daemonAddress)
		if err != nil {
			_ = request.Reject(ssh.ConnectionFailed, err.Error())
			continue
		}
		channel, channelRequests, err := request.Accept()
		if err != nil {
			_ = upstream.Close()
			continue
		}
		go ssh.DiscardRequests(channelRequests)
		go func() {
			_, _ = io.Copy(upstream, channel)
			_ = upstream.Close()
		}()
		go func() {
			_, _ = io.Copy(channel, upstream)
			_ = channel.Close()
		}()
	}
}
