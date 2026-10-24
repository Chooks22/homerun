package workerapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/janitor"
	"github.com/orochibraru/homerun/internal/workerapi"
)

const token = "worker-token"

// fakeDaemon stands in for the Docker Engine, answering a fixed body per path.
type fakeDaemon struct {
	bodies map[string]string
	status map[string]int
}

// ServeHTTP answers whatever was registered for the request's path, or 404.
func (f *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, ok := f.bodies[r.URL.Path]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"No such container"}`)
		return
	}
	if status, ok := f.status[r.URL.Path]; ok {
		w.WriteHeader(status)
	}
	_, _ = io.WriteString(w, body)
}

// newAPI stands a worker control API over a fake daemon.
func newAPI(t *testing.T, daemon *fakeDaemon) *httptest.Server {
	t.Helper()
	engine := httptest.NewServer(daemon)
	t.Cleanup(engine.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	docker := dockerapi.NewWithHTTP(engine.Client(), engine.URL)
	api := httptest.NewServer(workerapi.NewServer(ctx, token, docker).Handler())
	t.Cleanup(api.Close)
	return api
}

// call sends one request to the control API, with the bearer token unless
// anonymous is set.
func call(t *testing.T, api *httptest.Server, method, path string, anonymous bool) (int, string) {
	t.Helper()
	request, err := http.NewRequest(method, api.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !anonymous {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, string(body)
}

func TestHealthIsOpenAndEverythingElseIsNot(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{"/containers/json": `[]`}})

	if status, body := call(t, api, http.MethodGet, "/v1/health", true); status != http.StatusOK {
		t.Fatalf("health must be reachable without a token, got %d %s", status, body)
	}
	if status, _ := call(t, api, http.MethodGet, "/v1/containers", true); status != http.StatusUnauthorized {
		t.Fatalf("an unauthenticated control call must be 401, got %d", status)
	}
	if status, _ := call(t, api, http.MethodGet, "/v1/containers", false); status != http.StatusOK {
		t.Fatalf("an authenticated control call must pass, got %d", status)
	}
}

func TestHealthListsWedgedHelpers(t *testing.T) {
	engine := httptest.NewServer(&fakeDaemon{bodies: map[string]string{}})
	t.Cleanup(engine.Close)
	server := workerapi.NewServer(context.Background(), token, dockerapi.NewWithHTTP(engine.Client(), engine.URL))
	api := httptest.NewServer(server.Handler())
	t.Cleanup(api.Close)
	health := func() []janitor.Wedged {
		_, body := call(t, api, http.MethodGet, "/v1/health", true)
		var decoded struct {
			WedgedContainers []janitor.Wedged `json:"wedgedContainers"`
		}
		if err := json.Unmarshal([]byte(body), &decoded); err != nil || decoded.WedgedContainers == nil {
			t.Fatalf("health must always carry wedgedContainers, got %s", body)
		}
		return decoded.WedgedContainers
	}
	if len(health()) != 0 {
		t.Fatal("no janitor means nothing wedged")
	}
	since := time.Date(2026, 9, 26, 18, 7, 0, 0, time.UTC)
	server.Wedged = func() []janitor.Wedged { return []janitor.Wedged{{ID: "abc", Name: "helper", Since: since}} }
	if got := health(); len(got) != 1 || got[0].ID != "abc" || !got[0].Since.Equal(since) {
		t.Fatalf("wedged helpers must be reported, got %+v", got)
	}
}

func TestExtractIntoVolumeNeedsSourceTargetAndImage(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{}})
	status, body := call(t, api, http.MethodPut, "/v1/volumes/archive?source=files", false)
	if status != http.StatusBadRequest || !strings.Contains(body, "target is required") || !strings.Contains(body, "image is required") {
		t.Fatalf("want a 400 naming the missing params, got %d %s", status, body)
	}
}

func TestHealthBootIDIsStablePerServerAndDiffersAcrossRestarts(t *testing.T) {
	daemon := &fakeDaemon{bodies: map[string]string{}}
	bootID := func(api *httptest.Server) string {
		_, body := call(t, api, http.MethodGet, "/v1/health", true)
		var health struct {
			BootID string `json:"bootId"`
		}
		if err := json.Unmarshal([]byte(body), &health); err != nil || health.BootID == "" {
			t.Fatalf("health must carry a bootId, got %s", body)
		}
		return health.BootID
	}
	first := newAPI(t, daemon)
	if id := bootID(first); id != bootID(first) {
		t.Fatal("one worker process must answer the same bootId every time")
	}
	if bootID(first) == bootID(newAPI(t, daemon)) {
		t.Fatal("a restarted worker must answer a new bootId")
	}
}

func TestContainerStatusDerivation(t *testing.T) {
	cases := map[string]struct {
		state    string
		exitCode int
		want     string
	}{
		"a running container":            {state: "running", want: "running"},
		"one created but not started":    {state: "created", want: "starting"},
		"one restarting":                 {state: "restarting", want: "starting"},
		"a clean exit":                   {state: "exited", exitCode: 0, want: "stopped"},
		"a non-zero exit":                {state: "exited", exitCode: 137, want: "failed"},
		"a dead container that exited 0": {state: "dead", exitCode: 0, want: "stopped"},
		"an unrecognised state":          {state: "paused", want: "stopped"},
	}
	for name, testCase := range cases {
		inspect, err := json.Marshal(map[string]any{
			"Id":    "c1",
			"State": map[string]any{"ExitCode": testCase.exitCode, "Status": testCase.state},
		})
		if err != nil {
			t.Fatal(err)
		}
		api := newAPI(t, &fakeDaemon{bodies: map[string]string{
			"/containers/c1/json": string(inspect),
		}})
		_, body := call(t, api, http.MethodGet, "/v1/containers/c1/status", false)
		var decoded struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal([]byte(body), &decoded); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if decoded.Status != testCase.want {
			t.Errorf("%s: want %q, got %q", name, testCase.want, decoded.Status)
		}
	}
}

func TestAContainerTheDaemonNeverHeardOfReadsAsMissing(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{}})
	_, body := call(t, api, http.MethodGet, "/v1/containers/gone/status", false)
	if !strings.Contains(body, `"missing"`) {
		t.Fatalf(`a 404 from the daemon must read as "missing", not "failed": %s`, body)
	}
}

func TestHealthHidesHomerunsOwnReadinessCheck(t *testing.T) {
	generated, err := json.Marshal(map[string]any{
		"Config": map[string]any{"Labels": map[string]string{"homerun.readiness": "listening"}},
		"State":  map[string]any{"Health": map[string]any{"Status": "healthy"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{"/containers/c1/json": string(generated)}})
	if _, body := call(t, api, http.MethodGet, "/v1/containers/c1/health", false); strings.TrimSpace(body) != "null" {
		t.Fatalf("a generated readiness check isn't the image's own healthcheck, got %s", body)
	}

	declared, err := json.Marshal(map[string]any{
		"Config": map[string]any{"Labels": map[string]string{}},
		"State": map[string]any{"Health": map[string]any{
			"Log":    []any{map[string]any{"Output": "all good"}},
			"Status": "healthy",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	api = newAPI(t, &fakeDaemon{bodies: map[string]string{"/containers/c1/json": string(declared)}})
	_, body := call(t, api, http.MethodGet, "/v1/containers/c1/health", false)
	if !strings.Contains(body, "healthy") || !strings.Contains(body, "all good") {
		t.Fatalf("a real healthcheck must report its status and last output, got %s", body)
	}
}

func TestSwarmStatusAggregation(t *testing.T) {
	replicated := `{"Spec":{"Mode":{"Replicated":{"Replicas":2}}}}`
	cases := map[string]struct {
		tasks string
		want  string
	}{
		"no tasks yet":              {tasks: `[]`, want: "pending"},
		"one running wins":          {tasks: `[{"Status":{"State":"failed"}},{"Status":{"State":"running"}}]`, want: "running"},
		"a failed task with no run": {tasks: `[{"Status":{"State":"failed"}}]`, want: "failed"},
		"a rejected task":           {tasks: `[{"Status":{"State":"rejected"}}]`, want: "failed"},
		"still starting":            {tasks: `[{"Status":{"State":"preparing"}}]`, want: "starting"},
	}
	for name, testCase := range cases {
		api := newAPI(t, &fakeDaemon{bodies: map[string]string{
			"/services/s1": replicated,
			"/tasks":       testCase.tasks,
		}})
		_, body := call(t, api, http.MethodGet, "/v1/swarm/services/s1/status", false)
		if !strings.Contains(body, `"`+testCase.want+`"`) {
			t.Errorf("%s: want %q, got %s", name, testCase.want, body)
		}
	}
}

func TestInspectSwarmServiceByName(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{
		"/services/homerun-newt": `{"ID":"s1","Spec":{"Name":"homerun-newt","Labels":{"homerun.core":"newt"}}}`,
	}})
	status, body := call(t, api, http.MethodGet, "/v1/swarm/services/homerun-newt", false)
	if status != http.StatusOK || !strings.Contains(body, `"homerun.core":"newt"`) {
		t.Fatalf("the labels are what tells a sync whether the service is current, got %d %s", status, body)
	}
	if status, _ := call(t, api, http.MethodGet, "/v1/swarm/services/gone", false); status != http.StatusNotFound {
		t.Fatalf("a missing service must read as 404, got %d", status)
	}
}

func TestCreateSwarmServiceNeedsAName(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{"/services/create": `{"ID":"s1"}`}})
	status, body := call(t, api, http.MethodPost, "/v1/swarm/services", false)
	if status != http.StatusBadRequest {
		t.Fatalf("an empty body has no name, got %d %s", status, body)
	}
}

func TestASwarmServiceScaledToZeroIsStopped(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{
		"/services/s1": `{"Spec":{"Mode":{"Replicated":{"Replicas":0}}}}`,
		"/tasks":       `[{"Status":{"State":"running"}}]`,
	}})
	if _, body := call(t, api, http.MethodGet, "/v1/swarm/services/s1/status", false); !strings.Contains(body, "stopped") {
		t.Fatalf("zero replicas is stopped however its leftover tasks look, got %s", body)
	}
}

func TestRunningTaskCountComesFromTheDaemonsOwnStatus(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{
		"/services": `[{"ID":"s1","ServiceStatus":{"RunningTasks":3,"DesiredTasks":3}}]`,
	}})
	if _, body := call(t, api, http.MethodGet, "/v1/swarm/services/s1/running-tasks/count", false); !strings.Contains(body, `"count":3`) {
		t.Fatalf("want the daemon's RunningTasks, got %s", body)
	}
	if status, _ := call(t, api, http.MethodGet, "/v1/swarm/services/gone/running-tasks/count", false); status != http.StatusNotFound {
		t.Fatalf("a missing service must read as 404, got %d", status)
	}
}

func TestLogsAreDemuxedBeforeTheyLeaveTheWorker(t *testing.T) {
	framed := "\x01\x00\x00\x00\x00\x00\x00\x06hello\n" + "\x02\x00\x00\x00\x00\x00\x00\x06world\n"
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{"/containers/c1/logs": framed}})
	_, body := call(t, api, http.MethodGet, "/v1/containers/c1/logs?follow=0", false)
	if body != "hello\nworld\n" {
		t.Fatalf("the 8-byte frame headers must be stripped, got %q", body)
	}
}

func TestTtyLogsArePassedThroughUnmangled(t *testing.T) {
	// Every service Homerun deploys runs with Tty, and a TTY container's logs
	// carry no frame headers at all. Demuxing them anyway would eat eight
	// bytes out of each imaginary frame.
	raw := "listening on :8080\nready\n"
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{"/containers/c1/logs": raw}})
	_, body := call(t, api, http.MethodGet, "/v1/containers/c1/logs?follow=0", false)
	if body != raw {
		t.Fatalf("unframed TTY output must pass through untouched, got %q", body)
	}
}

func TestShortUnframedLogsSurvive(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{"/containers/c1/logs": "hi\n"}})
	_, body := call(t, api, http.MethodGet, "/v1/containers/c1/logs?follow=0", false)
	if body != "hi\n" {
		t.Fatalf("output shorter than one header must still come through, got %q", body)
	}
}

func TestPruneRejectsAnUnknownKind(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{}})
	status, body := call(t, api, http.MethodPost, "/v1/prune/everything", false)
	if status != http.StatusBadRequest || !strings.Contains(body, "kind") {
		t.Fatalf("an unknown prune kind must be a 400 naming the field, got %d %s", status, body)
	}
}

func TestAnUnknownTerminalSessionIs404(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{}})
	if status, _ := call(t, api, http.MethodGet, "/v1/terminal/nope", false); status != http.StatusNotFound {
		t.Fatalf("an unknown session must be 404, got %d", status)
	}
	if status, _ := call(t, api, http.MethodDelete, "/v1/terminal/nope", false); status != http.StatusOK {
		t.Fatalf("closing an already-closed session is a success, got %d", status)
	}
}

func TestUnknownPathsAnswerJSON(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{}})
	status, body := call(t, api, http.MethodGet, "/v1/nope", false)
	if status != http.StatusNotFound || !strings.Contains(body, "Not found") {
		t.Fatalf("want a JSON 404, got %d %s", status, body)
	}
}

func TestConnectContainerPassesTheDaemonStatusThrough(t *testing.T) {
	api := newAPI(t, &fakeDaemon{
		bodies: map[string]string{"/networks/overlay/connect": `{"message":"endpoint already exists"}`},
		status: map[string]int{"/networks/overlay/connect": http.StatusForbidden},
	})
	connect := func(network string) int {
		request, err := http.NewRequest(http.MethodPost, api.URL+"/v1/containers/abc/connect",
			strings.NewReader(`{"network":"`+network+`","aliases":[]}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		return response.StatusCode
	}
	if status := connect("overlay"); status != http.StatusForbidden {
		t.Fatalf("an already-attached container must answer 403, got %d", status)
	}
	if status := connect("missing"); status != http.StatusNotFound {
		t.Fatalf("a missing network or container must answer 404, got %d", status)
	}
}

func TestSwarmLogsOnlyStreamCurrentTasksLabelledByReplica(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{
		"/tasks":           `[{"ID":"t2","Slot":2},{"ID":"t1","Slot":1}]`,
		"/tasks/t1/logs":   "2026-09-25T10:00:00Z ready\n",
		"/tasks/t2/logs":   "2026-09-25T10:00:01Z listening",
		"/services/s/logs": "old generation crashed\n",
	}})
	status, body := call(t, api, http.MethodGet, "/v1/swarm/services/s/logs?follow=0", false)
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, body)
	}
	for _, want := range []string{
		"[replica 1] 2026-09-25T10:00:00Z ready\n",
		"[replica 2] 2026-09-25T10:00:01Z listening\n",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in %q", want, body)
		}
	}
	if strings.Contains(body, "old generation") {
		t.Errorf("dead generations leaked into %q", body)
	}
}

func TestSwarmLogsFallBackToTheServiceWhenNoTaskIsCurrent(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{
		"/tasks":           `[]`,
		"/services/s/logs": "exec format error\n",
	}})
	_, body := call(t, api, http.MethodGet, "/v1/swarm/services/s/logs?follow=0", false)
	if body != "exec format error\n" {
		t.Errorf("body = %q", body)
	}
}

func TestTagImageNeedsSourceRepositoryAndTagAndMapsAMissingImageTo404(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{"/images/sha256:abc/tag": ``}})
	post := func(body string) (int, string) {
		request, err := http.NewRequest(http.MethodPost, api.URL+"/v1/images/tag", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		read, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(read)
	}
	if status, body := post(`{"source":"sha256:abc"}`); status != http.StatusBadRequest ||
		!strings.Contains(body, "repository is required") || !strings.Contains(body, "tag is required") {
		t.Fatalf("want a 400 naming the missing fields, got %d %s", status, body)
	}
	if status, body := post(`{"source":"sha256:abc","repository":"gitea/gitea","tag":"1.25.0-dev"}`); status != http.StatusOK {
		t.Fatalf("want the tag to succeed, got %d %s", status, body)
	}
	if status, _ := post(`{"source":"sha256:gone","repository":"gitea/gitea","tag":"1.25.0-dev"}`); status != http.StatusNotFound {
		t.Fatalf("a missing image must answer 404, got %d", status)
	}
}
