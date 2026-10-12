package cronjob_test

import (
	"context"
	"encoding/json"
	"github.com/orochibraru/homerun/tests/unit/go/internal/testsupport"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/jobs"
	"github.com/orochibraru/homerun/internal/jobs/cronjob"
)

type fakeDaemon struct {
	mu      sync.Mutex
	created map[string]any
	pulled  string
	killed  bool
	removed bool
	exit    int
	image   string
	hang    bool
	release chan struct{}
}

// ServeHTTP answers the fake daemon's canned responses for a cron job run.
func (d *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case strings.HasPrefix(path, "/images/") && strings.HasSuffix(path, "/json"):
		if d.image == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(d.image))
	case path == "/images/create":
		d.mu.Lock()
		d.pulled = r.URL.Query().Get("fromImage") + ":" + r.URL.Query().Get("tag")
		d.mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"done"}` + "\n"))
	case path == "/containers/create":
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		d.mu.Lock()
		d.created = body
		d.mu.Unlock()
		_, _ = w.Write([]byte(`{"Id":"c1"}`))
	case path == "/containers/c1/start":
		w.WriteHeader(http.StatusNoContent)
	case path == "/containers/c1/logs":
		_, _ = w.Write(testsupport.DockerFrame(1, "out\n"))
		_, _ = w.Write(testsupport.DockerFrame(2, "err\n"))
		_, _ = w.Write(testsupport.DockerFrame(1, "more\n"))
	case path == "/containers/c1/wait":
		if d.hang {
			<-d.release
		}
		d.mu.Lock()
		code := d.exit
		d.mu.Unlock()
		_, _ = w.Write([]byte(`{"StatusCode":` + strconv.Itoa(code) + `}`))
	case path == "/containers/c1/kill":
		d.mu.Lock()
		d.killed = true
		d.exit = 9
		d.mu.Unlock()
		close(d.release)
		w.WriteHeader(http.StatusNoContent)
	case path == "/containers/c1" && r.Method == http.MethodDelete:
		d.mu.Lock()
		d.removed = true
		d.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotImplemented)
	}
}

// run executes spec against the fake daemon d and returns its result.
func run(t *testing.T, d *fakeDaemon, spec cronjob.Spec) map[string]any {
	t.Helper()
	job, _, err := jobs.Recorder("cron_job", spec)
	if err != nil {
		t.Fatal(err)
	}
	job.DockerSocket = testsupport.ServeUnixSocket(t, d)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := cronjob.Run(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestRunHostCommand(t *testing.T) {
	d := &fakeDaemon{exit: 3}
	result := run(t, d, cronjob.Spec{
		Cmd:            []string{"nsenter", "-t", "1", "--", "sh", "-c", "hostname"},
		Env:            []string{"A=1"},
		Image:          "alpine:3",
		Labels:         map[string]string{"homerun.cronjob.id": "j1"},
		PidMode:        "host",
		Privileged:     true,
		RunID:          "r1",
		TimeoutSeconds: 60,
	})
	if result["exitCode"] != 3 || result["timedOut"] != false || result["output"] != "out\nmore\nerr\n" {
		t.Errorf("result = %v", result)
	}
	if d.pulled != "alpine:3" || !d.removed {
		t.Errorf("pulled = %q removed = %v", d.pulled, d.removed)
	}
	host := d.created["HostConfig"].(map[string]any)
	if host["Privileged"] != true || host["PidMode"] != "host" {
		t.Errorf("HostConfig = %v", host)
	}
	if d.created["Labels"].(map[string]any)["homerun.cronjob.id"] != "j1" {
		t.Errorf("Labels = %v", d.created["Labels"])
	}
}

func TestRunWritesFilesBeforeTheImageEntrypoint(t *testing.T) {
	d := &fakeDaemon{image: `{"Config":{"Entrypoint":["/entry.sh"],"Cmd":["renovate"]}}`}
	run(t, d, cronjob.Spec{
		Files:          []dockerapi.File{{Content: "{}", Path: "/tmp/config.json"}},
		Image:          "renovate/renovate:latest",
		RunID:          "r1",
		TimeoutSeconds: 60,
		WorkingDir:     "/homerun",
	})
	entrypoint := d.created["Entrypoint"].([]any)
	if entrypoint[0] != "/bin/sh" || !strings.Contains(entrypoint[2].(string), "'/tmp/config.json'") {
		t.Errorf("Entrypoint = %v", entrypoint)
	}
	if cmd := d.created["Cmd"].([]any); len(cmd) != 2 || cmd[0] != "/entry.sh" || cmd[1] != "renovate" {
		t.Errorf("Cmd = %v", cmd)
	}
	if env := d.created["Env"].([]any); len(env) != 1 || env[0] != "HOMERUN_FILE_0={}" {
		t.Errorf("Env = %v", env)
	}
	if d.created["WorkingDir"] != "/homerun" {
		t.Errorf("WorkingDir = %v", d.created["WorkingDir"])
	}
}

func TestRunTimeout(t *testing.T) {
	d := &fakeDaemon{hang: true, release: make(chan struct{})}
	result := run(t, d, cronjob.Spec{Image: "busybox:latest", RunID: "r1", TimeoutSeconds: 0})
	if result["timedOut"] != true || result["exitCode"] != 9 || !d.killed {
		t.Errorf("result = %v killed = %v", result, d.killed)
	}
}

func TestRunRejectsSSHRemote(t *testing.T) {
	job, _, _ := jobs.Recorder("cron_job", map[string]any{
		"image": "busybox:latest", "remote": map[string]any{"dockerHost": "ssh://me@box"}, "runId": "r1",
	})
	if _, err := cronjob.Run(context.Background(), job); err == nil {
		t.Error("expected an error for an ssh:// host")
	}
}

func TestTail(t *testing.T) {
	if got := cronjob.Tail("abcdef", 3); got != "def" {
		t.Errorf("tail = %q", got)
	}
	if got := cronjob.Tail("aé", 1); got != "" {
		t.Errorf("tail cut a rune: %q", got)
	}
}
