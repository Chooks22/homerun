package dockerapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/orochibraru/homerun/tests/unit/go/internal/testsupport"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/orochibraru/homerun/internal/dockerapi"
)

type call struct {
	method, path string
	query        map[string][]string
	header       http.Header
	body         []byte
}

type daemon struct {
	mu     sync.Mutex
	calls  []call
	status int
	body   string
}

// newDaemon starts a fake daemon answering status/body to every request, and
// returns a client pointed at it.
func newDaemon(t *testing.T, status int, body string) (*dockerapi.Client, *daemon) {
	t.Helper()
	d := &daemon{status: status, body: body}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		d.mu.Lock()
		d.calls = append(d.calls, call{r.Method, r.URL.Path, r.URL.Query(), r.Header.Clone(), raw})
		status, body := d.status, d.body
		d.mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return dockerapi.NewWithHTTP(server.Client(), server.URL+"/"), d
}

// set changes what the fake daemon answers from here on.
func (d *daemon) set(status int, body string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.status, d.body = status, body
}

// last returns the most recently recorded call, failing the test if there is none.
func (d *daemon) last(t *testing.T) call {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.calls) == 0 {
		t.Fatal("daemon received no request")
	}
	return d.calls[len(d.calls)-1]
}

// expect asserts the last call matched method/path/query and returns it.
func (d *daemon) expect(t *testing.T, method, path string, query map[string][]string) call {
	t.Helper()
	got := d.last(t)
	if got.method != method || got.path != path {
		t.Errorf("request = %s %s, want %s %s", got.method, got.path, method, path)
	}
	if query == nil {
		query = map[string][]string{}
	}
	if !reflect.DeepEqual(got.query, query) {
		t.Errorf("query = %v, want %v", got.query, query)
	}
	return got
}

func TestPing(t *testing.T) {
	client, d := newDaemon(t, http.StatusOK, "OK")
	if err := client.Ping(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	d.expect(t, http.MethodGet, "/_ping", nil)
}

func TestAPIErrors(t *testing.T) {
	client, d := newDaemon(t, http.StatusInternalServerError, `{"message":"daemon exploded"}`)
	err := client.Ping(context.Background())
	var apiErr *dockerapi.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 500 || apiErr.Message != "daemon exploded" {
		t.Fatalf("JSON error body: err = %v, want *APIError 500 daemon exploded", err)
	}
	if err.Error() != "docker: 500 daemon exploded" {
		t.Errorf("APIError.Error() = %q", err.Error())
	}

	d.set(http.StatusInternalServerError, "  plain failure\n")
	err = client.Ping(context.Background())
	if !errors.As(err, &apiErr) || apiErr.Message != "plain failure" {
		t.Errorf("non-JSON error body: err = %v, want message \"plain failure\"", err)
	}

	d.set(http.StatusInternalServerError, `{"other":"x"}`)
	err = client.Ping(context.Background())
	if !errors.As(err, &apiErr) || apiErr.Message != `{"other":"x"}` {
		t.Errorf("JSON without message: err = %v, want the raw body", err)
	}

	d.set(http.StatusNotFound, "")
	if err := client.Ping(context.Background()); !errors.Is(err, dockerapi.ErrNotFound) {
		t.Errorf("404: err = %v, want ErrNotFound", err)
	}
}

func TestTransportErrors(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	server.Close()
	client := dockerapi.NewWithHTTP(server.Client(), server.URL)
	ctx := context.Background()
	if err := client.Ping(ctx); err == nil {
		t.Error("Ping against a closed server succeeded")
	}
	if _, err := client.CreateContainer(ctx, dockerapi.ContainerConfig{}); err == nil {
		t.Error("CreateContainer against a closed server succeeded")
	}
	if _, err := client.WaitContainer(ctx, "c"); err == nil {
		t.Error("WaitContainer against a closed server succeeded")
	}
	if _, err := client.ContainerLogs(ctx, "c", false); err == nil {
		t.Error("ContainerLogs against a closed server succeeded")
	}
	if err := client.PullImage(ctx, "alpine", nil, nil); err == nil {
		t.Error("PullImage against a closed server succeeded")
	}
	if err := client.PushImage(ctx, "a", "b", dockerapi.AuthConfig{}, nil); err == nil {
		t.Error("PushImage against a closed server succeeded")
	}
	if _, err := dockerapi.NewWithHTTP(http.DefaultClient, "http://bad host").ImageExists(ctx, "x"); err == nil {
		t.Error("request with an unparseable base URL succeeded")
	}
	if err := client.Call(ctx, http.MethodPost, "/x", nil, func() {}); err == nil {
		t.Error("request with an unmarshalable body succeeded")
	}
}

func TestImageExists(t *testing.T) {
	tests := []struct {
		status  int
		want    bool
		wantErr bool
	}{
		{http.StatusOK, true, false},
		{http.StatusNotFound, false, false},
		{http.StatusInternalServerError, false, true},
	}
	for _, tt := range tests {
		client, d := newDaemon(t, tt.status, "{}")
		got, err := client.ImageExists(context.Background(), "alpine:3")
		if got != tt.want || (err != nil) != tt.wantErr {
			t.Errorf("status %d: ImageExists = %v, %v; want %v, error=%v", tt.status, got, err, tt.want, tt.wantErr)
		}
		d.expect(t, http.MethodGet, "/images/alpine:3/json", nil)
	}
}

func TestSplitRef(t *testing.T) {
	tests := []struct{ ref, repo, tag string }{
		{"alpine", "alpine", "latest"},
		{"alpine:3", "alpine", "3"},
		{"alpine/git:latest", "alpine/git", "latest"},
		{"registry.example.com:5000/app", "registry.example.com:5000/app", "latest"},
		{"registry.example.com:5000/app:v1", "registry.example.com:5000/app", "v1"},
	}
	for _, tt := range tests {
		repo, tag := dockerapi.SplitRef(tt.ref)
		if repo != tt.repo || tag != tt.tag {
			t.Errorf("SplitRef(%q) = %q, %q; want %q, %q", tt.ref, repo, tag, tt.repo, tt.tag)
		}
	}
}

func TestRegistryHost(t *testing.T) {
	tests := []struct{ address, host string }{
		{"registry.example.com", "registry.example.com"},
		{"registry.example.com:5000", "registry.example.com:5000"},
		{"git.example.com/owner", "git.example.com"},
		{"https://ghcr.io/owner/team/", "ghcr.io"},
	}
	for _, tt := range tests {
		if got := dockerapi.RegistryHost(tt.address); got != tt.host {
			t.Errorf("RegistryHost(%q) = %q; want %q", tt.address, got, tt.host)
		}
	}
}

// progress joins lines as a Docker pull/push progress stream body.
func progress(lines ...string) string {
	return strings.Join(lines, "\n")
}

func TestPullImage(t *testing.T) {
	ctx := context.Background()
	client, d := newDaemon(t, http.StatusOK, progress(
		`{"status":"Pulling from app"}`,
		`{"id":"abc","progressDetail":{}}`,
		`{"status":"Download complete"}`,
	))
	auth := &dockerapi.AuthConfig{Password: "pw", ServerAddress: "registry.example.com:5000", Username: "me"}
	var lines []string
	if err := client.PullImage(ctx, "registry.example.com:5000/app:v1", auth, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatalf("PullImage: %v", err)
	}
	got := d.expect(t, http.MethodPost, "/images/create", map[string][]string{
		"fromImage": {"registry.example.com:5000/app"}, "tag": {"v1"},
	})
	if want := []string{"Pulling from app", "Download complete"}; !reflect.DeepEqual(lines, want) {
		t.Errorf("progress = %q, want %q", lines, want)
	}
	decoded, err := base64.URLEncoding.DecodeString(got.header.Get("X-Registry-Auth"))
	if err != nil {
		t.Fatalf("X-Registry-Auth isn't base64url: %v", err)
	}
	var sent dockerapi.AuthConfig
	if err := json.Unmarshal(decoded, &sent); err != nil || sent != *auth {
		t.Errorf("X-Registry-Auth = %s (%v), want %+v", decoded, err, *auth)
	}
	if !strings.Contains(string(decoded), `"serveraddress":"registry.example.com:5000"`) {
		t.Errorf("X-Registry-Auth JSON keys wrong: %s", decoded)
	}

	if err := client.PullImage(ctx, "alpine", nil, nil); err != nil {
		t.Fatalf("PullImage without auth or callback: %v", err)
	}
	got = d.expect(t, http.MethodPost, "/images/create", map[string][]string{"fromImage": {"alpine"}, "tag": {"latest"}})
	if _, ok := got.header["X-Registry-Auth"]; ok {
		t.Error("X-Registry-Auth sent without auth")
	}
}

func TestProgressStreamErrors(t *testing.T) {
	tests := []struct{ name, body, want string }{
		{"errorDetail", progress(`{"status":"Pulling"}`, `{"errorDetail":{"message":"manifest unknown"},"error":"short"}`), "manifest unknown"},
		{"bare error", progress(`{"status":"Pulling"}`, `{"error":"denied"}`), "denied"},
		{"malformed", `{"status":"Pulling"} not-json`, "invalid character"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, _ := newDaemon(t, http.StatusOK, tt.body)
			ctx := context.Background()
			if err := client.PullImage(ctx, "alpine", nil, nil); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("PullImage error = %v, want %q", err, tt.want)
			}
			if err := client.PushImage(ctx, "app", "v1", dockerapi.AuthConfig{}, nil); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("PushImage error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestTagImage(t *testing.T) {
	client, d := newDaemon(t, http.StatusCreated, "")
	if err := client.TagImage(context.Background(), "abc123", "registry.local/app", "v2"); err != nil {
		t.Fatalf("TagImage: %v", err)
	}
	d.expect(t, http.MethodPost, "/images/abc123/tag", map[string][]string{"repo": {"registry.local/app"}, "tag": {"v2"}})
}

func TestPushImage(t *testing.T) {
	client, d := newDaemon(t, http.StatusOK, progress(`{"status":"Pushing"}`, `{"status":"v2: digest: sha256:x"}`))
	var lines []string
	auth := dockerapi.AuthConfig{Username: "u", Password: "p", ServerAddress: "registry.local"}
	if err := client.PushImage(context.Background(), "registry.local/app", "v2", auth, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatalf("PushImage: %v", err)
	}
	got := d.expect(t, http.MethodPost, "/images/registry.local/app/push", map[string][]string{"tag": {"v2"}})
	if len(lines) != 2 {
		t.Errorf("progress = %q, want 2 lines", lines)
	}
	decoded, _ := base64.URLEncoding.DecodeString(got.header.Get("X-Registry-Auth"))
	var sent dockerapi.AuthConfig
	if err := json.Unmarshal(decoded, &sent); err != nil || sent != auth {
		t.Errorf("X-Registry-Auth = %s, want %+v", decoded, auth)
	}
}

func TestSaveImage(t *testing.T) {
	client, d := newDaemon(t, http.StatusOK, "tarball-bytes")
	stream, err := client.SaveImage(context.Background(), "app:v1")
	if err != nil {
		t.Fatalf("SaveImage: %v", err)
	}
	body, _ := io.ReadAll(stream)
	_ = stream.Close()
	if string(body) != "tarball-bytes" {
		t.Errorf("SaveImage streamed %q", body)
	}
	d.expect(t, http.MethodGet, "/images/app:v1/get", nil)

	d.set(http.StatusNotFound, "")
	if _, err := client.SaveImage(context.Background(), "gone"); !errors.Is(err, dockerapi.ErrNotFound) {
		t.Errorf("SaveImage on 404 = %v, want ErrNotFound", err)
	}
}

func TestCreateContainer(t *testing.T) {
	client, d := newDaemon(t, http.StatusCreated, `{"Id":"c0ffee","Warnings":[]}`)
	config := dockerapi.ContainerConfig{
		Binds:      []string{"vol:/data", "/host:/mnt:ro"},
		Cmd:        []string{"-c", "echo hi"},
		Entrypoint: []string{"/bin/sh"},
		Env:        []string{"A=1"},
		Image:      "alpine:3",
		Labels:     map[string]string{"homerun.job": "backup"},
	}
	id, err := client.CreateContainer(context.Background(), config)
	if err != nil || id != "c0ffee" {
		t.Fatalf("CreateContainer = %q, %v; want c0ffee", id, err)
	}
	got := d.expect(t, http.MethodPost, "/containers/create", nil)
	if ct := got.header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
	var sent struct {
		Cmd, Entrypoint, Env []string
		HostConfig           struct{ Binds []string }
		Image                string
		Labels               map[string]string
		Tty                  *bool
	}
	if err := json.Unmarshal(got.body, &sent); err != nil {
		t.Fatalf("body isn't JSON: %v (%s)", err, got.body)
	}
	if sent.Tty == nil || *sent.Tty {
		t.Errorf("Tty = %v, want explicit false", sent.Tty)
	}
	if !reflect.DeepEqual(sent.HostConfig.Binds, config.Binds) || !reflect.DeepEqual(sent.Labels, config.Labels) ||
		!reflect.DeepEqual(sent.Entrypoint, config.Entrypoint) || !reflect.DeepEqual(sent.Cmd, config.Cmd) ||
		!reflect.DeepEqual(sent.Env, config.Env) || sent.Image != config.Image {
		t.Errorf("body = %s, doesn't match %+v", got.body, config)
	}

	d.set(http.StatusCreated, "not json")
	if _, err := client.CreateContainer(context.Background(), config); err == nil {
		t.Error("CreateContainer with a bad response body succeeded")
	}
	d.set(http.StatusConflict, `{"message":"name in use"}`)
	var apiErr *dockerapi.APIError
	if _, err := client.CreateContainer(context.Background(), config); !errors.As(err, &apiErr) || apiErr.Message != "name in use" {
		t.Errorf("CreateContainer on 409 = %v", err)
	}
}

func TestStartContainer(t *testing.T) {
	client, d := newDaemon(t, http.StatusNoContent, "")
	if err := client.StartContainer(context.Background(), "c1"); err != nil {
		t.Fatalf("StartContainer: %v", err)
	}
	d.expect(t, http.MethodPost, "/containers/c1/start", nil)
}

func TestWaitContainer(t *testing.T) {
	client, d := newDaemon(t, http.StatusOK, `{"StatusCode":3}`)
	code, err := client.WaitContainer(context.Background(), "c1")
	if err != nil || code != 3 {
		t.Fatalf("WaitContainer = %d, %v; want 3", code, err)
	}
	d.expect(t, http.MethodPost, "/containers/c1/wait", nil)

	d.set(http.StatusOK, "garbage")
	if _, err := client.WaitContainer(context.Background(), "c1"); err == nil {
		t.Error("WaitContainer with a bad body succeeded")
	}
}

func TestContainerLogs(t *testing.T) {
	client, d := newDaemon(t, http.StatusOK, "logdata")
	for _, follow := range []bool{false, true} {
		stream, err := client.ContainerLogs(context.Background(), "c1", follow)
		if err != nil {
			t.Fatalf("ContainerLogs(follow=%v): %v", follow, err)
		}
		body, _ := io.ReadAll(stream)
		_ = stream.Close()
		if string(body) != "logdata" {
			t.Errorf("ContainerLogs(follow=%v) streamed %q", follow, body)
		}
		want := map[string][]string{"stdout": {"1"}, "stderr": {"1"}}
		if follow {
			want["follow"] = []string{"1"}
		}
		d.expect(t, http.MethodGet, "/containers/c1/logs", want)
	}
}

func TestKillContainer(t *testing.T) {
	tests := []struct {
		status  int
		wantErr bool
	}{
		{http.StatusNoContent, false},
		{http.StatusNotFound, false},
		{http.StatusConflict, false},
		{http.StatusInternalServerError, true},
	}
	for _, tt := range tests {
		client, d := newDaemon(t, tt.status, `{"message":"m"}`)
		if err := client.KillContainer(context.Background(), "c1"); (err != nil) != tt.wantErr {
			t.Errorf("status %d: KillContainer = %v, want error=%v", tt.status, err, tt.wantErr)
		}
		d.expect(t, http.MethodPost, "/containers/c1/kill", nil)
	}
}

func TestRemove(t *testing.T) {
	removers := []struct {
		name string
		path string
		fn   func(*dockerapi.Client) error
	}{
		{"RemoveContainer", "/containers/c1", func(c *dockerapi.Client) error { return c.RemoveContainer(context.Background(), "c1") }},
		{"RemoveVolume", "/volumes/v1", func(c *dockerapi.Client) error { return c.RemoveVolume(context.Background(), "v1") }},
	}
	for _, r := range removers {
		for _, tt := range []struct {
			status  int
			wantErr bool
		}{{http.StatusNoContent, false}, {http.StatusNotFound, false}, {http.StatusConflict, true}} {
			client, d := newDaemon(t, tt.status, `{"message":"in use"}`)
			if err := r.fn(client); (err != nil) != tt.wantErr {
				t.Errorf("%s on %d = %v, want error=%v", r.name, tt.status, err, tt.wantErr)
			}
			d.expect(t, http.MethodDelete, r.path, map[string][]string{"force": {"1"}})
		}
	}
}

func TestCreateVolume(t *testing.T) {
	client, d := newDaemon(t, http.StatusCreated, `{"Name":"data"}`)
	labels := map[string]string{"homerun.service": "s1"}
	if err := client.CreateVolume(context.Background(), "data", labels); err != nil {
		t.Fatalf("CreateVolume: %v", err)
	}
	got := d.expect(t, http.MethodPost, "/volumes/create", nil)
	var sent struct {
		Labels map[string]string
		Name   string
	}
	if err := json.Unmarshal(got.body, &sent); err != nil || sent.Name != "data" || !reflect.DeepEqual(sent.Labels, labels) {
		t.Errorf("CreateVolume body = %s (%v)", got.body, err)
	}
}

func TestDemux(t *testing.T) {
	var input bytes.Buffer
	input.Write(testsupport.DockerFrame(1, "out one\n"))
	input.Write(testsupport.DockerFrame(2, "err one\n"))
	input.Write(testsupport.DockerFrame(1, "out two\n"))
	input.Write(testsupport.DockerFrame(1, ""))
	var out bytes.Buffer
	if err := dockerapi.Demux(&input, &out); err != nil {
		t.Fatalf("Demux: %v", err)
	}
	if want := "out one\nerr one\nout two\n"; out.String() != want {
		t.Errorf("Demux wrote %q, want %q", out.String(), want)
	}

	truncatedBody := append(testsupport.DockerFrame(1, "full\n"), testsupport.DockerFrame(2, "cut short")[:12]...)
	out.Reset()
	if err := dockerapi.Demux(bytes.NewReader(truncatedBody), &out); err != nil {
		t.Errorf("Demux on truncated payload = %v, want nil", err)
	}
	if !strings.HasPrefix(out.String(), "full\n") {
		t.Errorf("Demux on truncated payload wrote %q", out.String())
	}

	out.Reset()
	if err := dockerapi.Demux(bytes.NewReader(testsupport.DockerFrame(1, "x")[:5]), &out); err != nil || out.Len() != 0 {
		t.Errorf("Demux on truncated header = %v, wrote %q", err, out.String())
	}
	if err := dockerapi.Demux(bytes.NewReader(nil), &out); err != nil {
		t.Errorf("Demux on empty stream = %v", err)
	}

	boom := errors.New("boom")
	if err := dockerapi.Demux(errReader{boom}, &out); !errors.Is(err, boom) {
		t.Errorf("Demux read error = %v, want boom", err)
	}
	if err := dockerapi.Demux(bytes.NewReader(testsupport.DockerFrame(1, "payload")), errWriter{boom}); !errors.Is(err, boom) {
		t.Errorf("Demux write error = %v, want boom", err)
	}
}

type errReader struct{ err error }

// Read always fails with r.err.
func (r errReader) Read([]byte) (int, error) { return 0, r.err }

type errWriter struct{ err error }

// Write always fails with w.err.
func (w errWriter) Write([]byte) (int, error) { return 0, w.err }

func TestNew(t *testing.T) {
	client := dockerapi.New("/nonexistent/docker.sock")
	if client.Base != "http://docker" {
		t.Errorf("dockerapi.New base = %q", client.Base)
	}
	if err := client.Ping(context.Background()); err == nil {
		t.Error("Ping over a missing socket succeeded")
	}
}

func TestSplitRefDigestPinned(t *testing.T) {
	cases := map[string][2]string{
		"alpine@sha256:abc":                       {"alpine", "sha256:abc"},
		"alpine:3@sha256:abc":                     {"alpine", "sha256:abc"},
		"registry.example.com:5000/app@sha256:ff": {"registry.example.com:5000/app", "sha256:ff"},
	}
	for ref, want := range cases {
		repository, tag := dockerapi.SplitRef(ref)
		if repository != want[0] || tag != want[1] {
			t.Errorf("%s: want %v, got %s %s", ref, want, repository, tag)
		}
	}
}

func TestSwarmJoinInfoPrefersThisManagersAddress(t *testing.T) {
	client, d := newDaemon(t, 200, `{"JoinTokens":{"Worker":"SWMTKN-1-abc"},"Swarm":{"NodeAddr":"10.0.0.1","NodeID":"me","RemoteManagers":[{"Addr":"10.0.0.9:2377","NodeID":"other"},{"Addr":"10.0.0.1:2377","NodeID":"me"}]}}`)
	join, err := client.SwarmJoinInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if join.Token != "SWMTKN-1-abc" || join.ManagerAddress != "10.0.0.1:2377" {
		t.Errorf("join = %+v", join)
	}
	d.expect(t, http.MethodGet, "/info", nil)

	d.set(200, `{"JoinTokens":{"Worker":"t"},"Swarm":{"NodeAddr":"192.0.2.4","NodeID":"me"}}`)
	join, err = client.SwarmJoinInfo(context.Background())
	if err != nil || join.ManagerAddress != "192.0.2.4:2377" {
		t.Errorf("fallback join = %+v, %v", join, err)
	}
}

func TestCountRunningSwarmTasksAsksForStatus(t *testing.T) {
	client, d := newDaemon(t, 200, `{"ServiceStatus":{"RunningTasks":2}}`)
	running, err := client.CountRunningSwarmTasks(context.Background(), "s1")
	if err != nil || running != 2 {
		t.Fatalf("CountRunningSwarmTasks = %d, %v", running, err)
	}
	d.expect(t, http.MethodGet, "/services/s1", map[string][]string{"status": {"true"}})

	d.set(200, `{}`)
	if running, err := client.CountRunningSwarmTasks(context.Background(), "s1"); err != nil || running != 0 {
		t.Errorf("no ServiceStatus = %d, %v", running, err)
	}
}

func TestRemoveSwarmNodeForces(t *testing.T) {
	client, d := newDaemon(t, 200, ``)
	if err := client.RemoveSwarmNode(context.Background(), "n1"); err != nil {
		t.Fatal(err)
	}
	d.expect(t, http.MethodDelete, "/nodes/n1", map[string][]string{"force": {"true"}})
}

func TestSetSwarmNodeLabelsKeepsTheRestOfTheSpec(t *testing.T) {
	client, d := newDaemon(t, 200, `{"Spec":{"Availability":"active","Labels":{"old":"x"},"Role":"worker"},"Version":{"Index":12}}`)
	if err := client.SetSwarmNodeLabels(context.Background(), "n1", map[string]string{"env": "staging"}); err != nil {
		t.Fatal(err)
	}
	got := d.expect(t, http.MethodPost, "/nodes/n1/update", map[string][]string{"version": {"12"}})
	var spec map[string]any
	if err := json.Unmarshal(got.body, &spec); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"Availability": "active", "Labels": map[string]any{"env": "staging"}, "Role": "worker"}
	if !reflect.DeepEqual(spec, want) {
		t.Errorf("spec = %v, want %v", spec, want)
	}
}

func TestSwarmServiceSendsRegistryAuthToWorkers(t *testing.T) {
	ctx := context.Background()
	auth := &dockerapi.AuthConfig{Password: "pw", ServerAddress: "ghcr.io", Username: "me"}
	client, d := newDaemon(t, http.StatusCreated, `{"ID":"s1"}`)
	id, err := client.CreateSwarmService(ctx, map[string]any{"Name": "app"}, auth)
	if err != nil || id != "s1" {
		t.Fatalf("CreateSwarmService = %q, %v", id, err)
	}
	created := d.expect(t, http.MethodPost, "/services/create", nil)

	d.set(http.StatusOK, `{}`)
	if err := client.UpdateSwarmService(ctx, "s1", 7, map[string]any{"Name": "app"}, auth); err != nil {
		t.Fatalf("UpdateSwarmService: %v", err)
	}
	updated := d.expect(t, http.MethodPost, "/services/s1/update", map[string][]string{"version": {"7"}})

	for name, got := range map[string]call{"create": created, "update": updated} {
		decoded, _ := base64.URLEncoding.DecodeString(got.header.Get("X-Registry-Auth"))
		var sent dockerapi.AuthConfig
		if err := json.Unmarshal(decoded, &sent); err != nil || sent != *auth {
			t.Errorf("%s X-Registry-Auth = %s, want %+v", name, decoded, *auth)
		}
	}

	if _, err := client.CreateSwarmService(ctx, map[string]any{"Name": "app"}, nil); err != nil {
		t.Fatalf("CreateSwarmService without auth: %v", err)
	}
	if _, ok := d.last(t).header["X-Registry-Auth"]; ok {
		t.Error("X-Registry-Auth sent without auth")
	}
}

func TestParseDuKilobytes(t *testing.T) {
	got, err := dockerapi.ParseDuKilobytes("2048\t/volume\n")
	if err != nil || got != 2048*1024 {
		t.Errorf("ParseDuKilobytes = %d, %v", got, err)
	}
	if _, err := dockerapi.ParseDuKilobytes(""); err == nil {
		t.Error("empty output should fail")
	}
	if _, err := dockerapi.ParseDuKilobytes("du: /volume: No such file"); err == nil {
		t.Error("non-numeric output should fail")
	}
}
