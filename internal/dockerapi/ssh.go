package dockerapi

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// remoteDockerSocket is where the daemon listens on an ssh:// host, the same
// default the docker CLI assumes.
const remoteDockerSocket = "/var/run/docker.sock"

const (
	// sshDialTimeout bounds reaching the host and the SSH handshake.
	sshDialTimeout = 15 * time.Second
	// sshKeepAliveInterval is how often a live connection is checked, so a
	// host that vanished is noticed instead of hanging the next call.
	sshKeepAliveInterval = 30 * time.Second
	// sshIdleTimeout is how long a connection with no open channel is kept
	// before it's closed.
	sshIdleTimeout = 5 * time.Minute
	// sshIdleConnTimeout is how long the HTTP client keeps an idle channel
	// to the daemon for reuse.
	sshIdleConnTimeout = 90 * time.Second
)

// ErrSSHHostKeyChanged is returned when an ssh:// Docker host presents a
// different host key than the one recorded for it.
var ErrSSHHostKeyChanged = errors.New("the remote host's SSH host key changed since it was recorded")

// sshTunnel is one SSH connection to an ssh:// Docker host, shared by every
// connection to its daemon: each is a stream-local channel to the daemon's
// socket. The SSH connection is opened on first use, reopened when it drops,
// and closed once no channel has been open for sshIdleTimeout.
type sshTunnel struct {
	address string
	config  *ssh.ClientConfig
	user    string

	mu        sync.Mutex
	client    *ssh.Client
	lastUsed  time.Time
	open      int
	presented string
}

// tunnelConn is a channel to the daemon's socket that gives its slot back to
// the tunnel when closed.
type tunnelConn struct {
	net.Conn
	once    sync.Once
	release func()
}

// Close closes the channel and releases its slot once.
func (c *tunnelConn) Close() error {
	c.once.Do(c.release)
	return c.Conn.Close()
}

// newRemoteSSH builds a client for an ssh://user@host[:port] Docker host,
// authenticating with host.SSHPrivateKey and checking the host against
// host.SSHHostKey, or accepting whatever key it presents when that's empty.
func newRemoteSSH(parsed *url.URL, host RemoteHost) (*Client, *sshTunnel, error) {
	user := parsed.User.Username()
	if user == "" {
		return nil, nil, fmt.Errorf("the Docker host %q has no user, e.g. ssh://user@host", host.DockerHost)
	}
	if host.SSHPrivateKey == "" {
		return nil, nil, errors.New("no SSH key was sent for the ssh:// Docker host")
	}
	signer, err := ssh.ParsePrivateKey([]byte(host.SSHPrivateKey))
	if err != nil {
		return nil, nil, fmt.Errorf("couldn't read the SSH key: %w", err)
	}
	port := parsed.Port()
	if port == "" {
		port = "22"
	}
	tunnel := &sshTunnel{address: net.JoinHostPort(parsed.Hostname(), port), user: user}
	tunnel.config = &ssh.ClientConfig{
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			tunnel.presented = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
			if host.SSHHostKey != "" && strings.TrimSpace(host.SSHHostKey) != tunnel.presented {
				return ErrSSHHostKeyChanged
			}
			return nil
		},
		Timeout: sshDialTimeout,
		User:    user,
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return tunnel.dial(ctx)
		},
		IdleConnTimeout: sshIdleConnTimeout,
	}
	client := &Client{dial: tunnel.dial, http: &http.Client{Transport: transport}, Base: "http://docker"}
	return client, tunnel, nil
}

// ProbeSSH connects to an ssh:// Docker host, accepting whatever host key it
// presents when host.SSHHostKey is empty, checks that its daemon answers, and
// returns the host key it presented, for the caller to record.
func ProbeSSH(ctx context.Context, host RemoteHost) (string, error) {
	parsed, err := url.Parse(host.DockerHost)
	if err != nil {
		return "", fmt.Errorf("invalid Docker host %q: %w", host.DockerHost, err)
	}
	if parsed.Scheme != "ssh" {
		return "", fmt.Errorf("%q isn't an ssh:// Docker host", host.DockerHost)
	}
	client, tunnel, err := newRemoteSSH(parsed, host)
	if err != nil {
		return "", err
	}
	defer tunnel.close()
	if err := client.Ping(ctx); err != nil {
		return "", unwrapURLError(err)
	}
	tunnel.mu.Lock()
	defer tunnel.mu.Unlock()
	return tunnel.presented, nil
}

// unwrapURLError drops the net/http "Get \"http://docker/_ping\":" prefix, so
// the SSH failure itself is what the caller reads.
func unwrapURLError(err error) error {
	var urlError *url.Error
	if errors.As(err, &urlError) {
		return urlError.Err
	}
	return err
}

// dial opens a channel to the daemon's socket, connecting first when there's
// no live SSH connection, and reconnecting once when the one it had is dead.
func (t *sshTunnel) dial(ctx context.Context) (net.Conn, error) {
	for attempt := 0; ; attempt++ {
		client, err := t.acquire(ctx)
		if err != nil {
			return nil, err
		}
		conn, err := client.DialContext(ctx, "unix", remoteDockerSocket)
		if err == nil {
			return &tunnelConn{Conn: conn, release: func() { t.release(client) }}, nil
		}
		t.release(client)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var refused *ssh.OpenChannelError
		if errors.As(err, &refused) {
			return nil, fmt.Errorf(
				"the SSH server at %s wouldn't connect to %s (%s): check its sshd allows stream-local forwarding and that %q can use the Docker socket",
				t.address, remoteDockerSocket, refused.Message, t.user)
		}
		t.drop(client)
		if attempt > 0 {
			return nil, fmt.Errorf("the SSH connection to %s keeps dropping: %w", t.address, err)
		}
	}
}

// acquire returns the live SSH connection, opening it when there's none, and
// counts one more channel on it.
func (t *sshTunnel) acquire(ctx context.Context) (*ssh.Client, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.client == nil {
		client, err := t.connect(ctx)
		if err != nil {
			return nil, err
		}
		t.client = client
		t.open = 0
		go t.watch(client)
	}
	t.open++
	t.lastUsed = time.Now()
	return t.client, nil
}

// connect dials the host and runs the SSH handshake, both bounded by
// sshDialTimeout.
func (t *sshTunnel) connect(ctx context.Context) (*ssh.Client, error) {
	dialer := net.Dialer{Timeout: sshDialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", t.address)
	if err != nil {
		return nil, fmt.Errorf("couldn't reach %s over SSH: %w", t.address, err)
	}
	_ = conn.SetDeadline(time.Now().Add(sshDialTimeout))
	clientConn, channels, requests, err := ssh.NewClientConn(conn, t.address, t.config)
	if err != nil {
		_ = conn.Close()
		return nil, t.describe(err)
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(clientConn, channels, requests), nil
}

// describe turns a handshake failure into what to do about it.
func (t *sshTunnel) describe(err error) error {
	if errors.Is(err, ErrSSHHostKeyChanged) {
		return fmt.Errorf("%s: %w", t.address, ErrSSHHostKeyChanged)
	}
	if strings.Contains(err.Error(), "unable to authenticate") {
		return fmt.Errorf("the SSH server at %s refused Homerun's key for %q: add Homerun's public key (Terminal page) to that user's ~/.ssh/authorized_keys", t.address, t.user)
	}
	return fmt.Errorf("the SSH handshake with %s failed: %w", t.address, err)
}

// release gives back one channel's slot on client, if it's still the live
// connection.
func (t *sshTunnel) release(client *ssh.Client) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.client == client && t.open > 0 {
		t.open--
		t.lastUsed = time.Now()
	}
}

// drop forgets client and closes it, so the next dial reconnects.
func (t *sshTunnel) drop(client *ssh.Client) {
	t.mu.Lock()
	if t.client == client {
		t.client = nil
	}
	t.mu.Unlock()
	_ = client.Close()
}

// close closes the live SSH connection, if any.
func (t *sshTunnel) close() {
	t.mu.Lock()
	client := t.client
	t.mu.Unlock()
	if client != nil {
		t.drop(client)
	}
}

// idle reports whether client is the live connection and has had no channel
// open for sshIdleTimeout.
func (t *sshTunnel) idle(client *ssh.Client) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.client == client && t.open == 0 && time.Since(t.lastUsed) >= sshIdleTimeout
}

// watch keeps client honest until it closes: a keepalive every
// sshKeepAliveInterval closes it when the host stops answering, and an idle
// connection is closed rather than held forever.
func (t *sshTunnel) watch(client *ssh.Client) {
	closed := make(chan struct{})
	go func() {
		_ = client.Wait()
		close(closed)
	}()
	ticker := time.NewTicker(sshKeepAliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-closed:
			t.drop(client)
			return
		case <-ticker.C:
			if t.idle(client) || !keepAlive(client) {
				t.drop(client)
			}
		}
	}
}

// keepAlive reports whether the host answers a keepalive request within
// sshDialTimeout.
func keepAlive(client *ssh.Client) bool {
	answered := make(chan error, 1)
	go func() {
		_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
		answered <- err
	}()
	select {
	case err := <-answered:
		return err == nil
	case <-time.After(sshDialTimeout):
		return false
	}
}
