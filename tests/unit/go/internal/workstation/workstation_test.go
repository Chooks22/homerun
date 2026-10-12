package workstation_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/workstation"
)

const id = "0b5f8a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"

func baseSpec() workstation.Spec {
	return workstation.Spec{
		Env:      map[string]string{"PASSWORD": "hunter2"},
		HomePath: "/home/coder",
		Image:    "codercom/code-server:latest",
		Name:     "homerun-ws-alice",
		Port:     8080,
	}
}

func TestValidateRejectsWhatTheDaemonWouldChokeOn(t *testing.T) {
	if problems := workstation.Validate(baseSpec()); len(problems) != 0 {
		t.Fatalf("a plain spec is valid, got %v", problems)
	}
	cases := map[string]func(*workstation.Spec){
		"no image":          func(s *workstation.Spec) { s.Image = " " },
		"uppercase name":    func(s *workstation.Spec) { s.Name = "Alice" },
		"port out of range": func(s *workstation.Spec) { s.Port = 70000 },
		"relative home":     func(s *workstation.Spec) { s.HomePath = "home" },
		"negative memory":   func(s *workstation.Spec) { s.MemoryBytes = -1 },
		"ssh git url":       func(s *workstation.Spec) { s.Git = &workstation.Git{Directory: "app", URL: "git@github.com:a/b.git"} },
		"path traversal":    func(s *workstation.Spec) { s.Git = &workstation.Git{Directory: "..", URL: "https://github.com/a/b"} },
		"nested directory":  func(s *workstation.Spec) { s.Git = &workstation.Git{Directory: "a/b", URL: "https://github.com/a/b"} },
		"option branch": func(s *workstation.Spec) {
			s.Git = &workstation.Git{Branch: "--upload-pack=x", Directory: "b", URL: "https://github.com/a/b"}
		},
	}
	for name, mutate := range cases {
		spec := baseSpec()
		mutate(&spec)
		if problems := workstation.Validate(spec); len(problems) == 0 {
			t.Errorf("%s: want a problem", name)
		}
	}
}

func TestCreateBodyJoinsANetworkLocallyAndPublishesOnAnAgent(t *testing.T) {
	local := baseSpec()
	local.Network = "homerun"
	local.Labels = map[string]string{"traefik.enable": "true"}
	local.NanoCPUs = 2_000_000_000
	local.MemoryBytes = 4 << 30
	body := workstation.CreateBody(id, local)
	host := body["HostConfig"].(map[string]any)
	if host["NetworkMode"] != "homerun" || host["PortBindings"] != nil {
		t.Errorf("a local workstation joins the network and publishes nothing, got %v", host)
	}
	if binds := host["Binds"].([]string); len(binds) != 1 || binds[0] != workstation.VolumeName(id)+":/home/coder" {
		t.Errorf("the home volume is mounted at the home path, got %v", binds)
	}
	if host["NanoCpus"] != int64(2_000_000_000) || host["Memory"] != int64(4<<30) {
		t.Errorf("limits are passed through, got %v", host)
	}
	labels := body["Labels"].(map[string]string)
	if labels["traefik.enable"] != "true" || labels[dockerapi.ManagedLabel] != "true" || labels[workstation.IDLabel] != id {
		t.Errorf("the app's labels plus the managed and id labels, got %v", labels)
	}
	if env := body["Env"].([]string); !slices.Contains(env, "PASSWORD=hunter2") {
		t.Errorf("env is passed through, got %v", env)
	}

	remote := baseSpec()
	remote.Publish = true
	host = workstation.CreateBody(id, remote)["HostConfig"].(map[string]any)
	bindings, ok := host["PortBindings"].(map[string]any)["8080/tcp"]
	if !ok || host["NetworkMode"] != nil || host["Memory"] != nil {
		t.Errorf("an agent workstation publishes its port on an ephemeral host port, got %v", host)
	}
	if got := bindings.([]map[string]string); got[0]["HostPort"] != "" {
		t.Errorf("the host port is left to the daemon, got %v", got)
	}
}

func TestCloneCommandPassesValuesAsArguments(t *testing.T) {
	spec := baseSpec()
	spec.HomePath = "/home/coder/"
	spec.Git = &workstation.Git{Branch: "main", Directory: "app", Token: "tok", URL: "https://github.com/a/b.git", Username: "alice"}
	command := workstation.CloneCommand(spec)
	if command[0] != "sh" || command[1] != "-c" || strings.Contains(command[2], "github.com") {
		t.Fatalf("the script never carries a value, got %v", command)
	}
	want := []string{"clone", "/home/coder", "app", "https://alice:tok@github.com/a/b.git", "main", "https://github.com/a/b.git"}
	if !slices.Equal(command[3:], want) {
		t.Errorf("got %v, want %v", command[3:], want)
	}
	spec.Git.Token = ""
	if command = workstation.CloneCommand(spec); command[6] != "https://github.com/a/b.git" {
		t.Errorf("no token, no credential in the URL, got %v", command)
	}
}

type engine struct {
	calls     []string
	created   map[string]any
	exitCode  int
	listed    string
	mu        sync.Mutex
	running   bool
	hasVolume bool
}

func (e *engine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, r.Method+" "+r.URL.Path)
	switch {
	case r.URL.Path == "/images/codercom/code-server:latest/json":
		_, _ = io.WriteString(w, `{}`)
	case r.URL.Path == "/volumes/"+workstation.VolumeName(id):
		if !e.hasVolume {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"no such volume"}`)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	case r.URL.Path == "/volumes/create":
		e.hasVolume = true
		_, _ = io.WriteString(w, `{}`)
	case r.URL.Path == "/containers/json":
		_, _ = io.WriteString(w, e.listed)
	case r.URL.Path == "/containers/create":
		_ = json.NewDecoder(r.Body).Decode(&e.created)
		_, _ = io.WriteString(w, `{"Id":"new"}`)
	case r.URL.Path == "/containers/new/start":
		e.running = true
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/containers/new/exec":
		_, _ = io.WriteString(w, `{"Id":"exec1"}`)
	case r.URL.Path == "/exec/exec1/start":
		w.WriteHeader(http.StatusOK)
	case r.URL.Path == "/exec/exec1/json":
		_, _ = io.WriteString(w, `{"ExitCode":`+strconv.Itoa(e.exitCode)+`}`)
	case r.URL.Path == "/containers/old/json":
		_, _ = io.WriteString(w, `{"Id":"old","State":{"Running":true,"Status":"running"},"NetworkSettings":{"Ports":{"8080/tcp":[{"HostIp":"0.0.0.0","HostPort":"49153"}]}}}`)
	case r.URL.Path == "/containers/old/exec":
		_, _ = io.WriteString(w, `{"Id":"exec2"}`)
	case r.URL.Path == "/exec/exec2/start":
		_, _ = w.Write(append([]byte{1, 0, 0, 0, 0, 0, byte(len(procNetTCP) >> 8), byte(len(procNetTCP) & 0xff)}, procNetTCP...))
	case r.URL.Path == "/exec/exec2/json":
		_, _ = io.WriteString(w, `{"ExitCode":0}`)
	case r.URL.Path == "/containers/old/logs":
		line := "listening on 0.0.0.0:8080\n"
		_, _ = w.Write(append([]byte{1, 0, 0, 0, 0, 0, 0, byte(len(line))}, line...))
	case strings.HasPrefix(r.URL.Path, "/containers/old"):
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"unexpected"}`)
	}
}

func (e *engine) sawCall(call string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Contains(e.calls, call)
}

func newServer(t *testing.T, fake *engine) *httptest.Server {
	t.Helper()
	daemon := httptest.NewServer(fake)
	t.Cleanup(daemon.Close)
	router := chi.NewRouter()
	workstation.NewManager(dockerapi.NewWithHTTP(daemon.Client(), daemon.URL)).Mount(router)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server
}

func request(t *testing.T, method, url, body string) (int, workstation.Status) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	var status workstation.Status
	_ = json.NewDecoder(response.Body).Decode(&status)
	return response.StatusCode, status
}

func waitFor(t *testing.T, server *httptest.Server, want string) workstation.Status {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, status := request(t, http.MethodGet, server.URL+"/v1/workstations/"+id+"?port=8080", "")
		if status.State == want {
			return status
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("never reached %s", want)
	return workstation.Status{}
}

func TestUpCreatesTheVolumeStartsTheContainerAndClones(t *testing.T) {
	fake := &engine{listed: `[]`}
	server := newServer(t, fake)
	spec := baseSpec()
	spec.Git = &workstation.Git{Directory: "app", URL: "https://github.com/a/b.git"}
	body, _ := json.Marshal(spec)
	code, status := request(t, http.MethodPut, server.URL+"/v1/workstations/"+id, string(body))
	if code != http.StatusAccepted || status.State != workstation.StatePulling {
		t.Fatalf("want a 202 while it starts, got %d %+v", code, status)
	}
	fake.mu.Lock()
	fake.listed = `[{"Id":"old","State":"running"}]`
	fake.mu.Unlock()
	status = waitFor(t, server, workstation.StateRunning)
	if status.HostPort != 49153 {
		t.Errorf("the published port is reported, got %+v", status)
	}
	for _, call := range []string{"POST /volumes/create", "POST /containers/create", "POST /containers/new/start", "POST /containers/new/exec"} {
		if !fake.sawCall(call) {
			t.Errorf("missing %s", call)
		}
	}
}

func TestAFailedCloneIsReported(t *testing.T) {
	fake := &engine{exitCode: 1, hasVolume: true, listed: `[]`}
	server := newServer(t, fake)
	spec := baseSpec()
	spec.Git = &workstation.Git{Directory: "app", Token: "secret-token", URL: "https://github.com/a/b.git"}
	body, _ := json.Marshal(spec)
	request(t, http.MethodPut, server.URL+"/v1/workstations/"+id, string(body))
	status := waitFor(t, server, workstation.StateFailed)
	if !strings.Contains(status.Error, "clone") || strings.Contains(status.Error, "secret-token") {
		t.Errorf("the failure is reported without the token, got %q", status.Error)
	}
	if fake.sawCall("POST /volumes/create") {
		t.Error("an existing volume is reused")
	}
}

func TestStatusOfAMissingWorkstationAndBadInput(t *testing.T) {
	server := newServer(t, &engine{listed: `[]`})
	if _, status := request(t, http.MethodGet, server.URL+"/v1/workstations/"+id, ""); status.State != workstation.StateMissing {
		t.Errorf("no container is missing, got %+v", status)
	}
	if code, _ := request(t, http.MethodGet, server.URL+"/v1/workstations/a%20b", ""); code != http.StatusBadRequest {
		t.Errorf("a malformed id is a 400, got %d", code)
	}
	if code, _ := request(t, http.MethodPut, server.URL+"/v1/workstations/"+id, `{"image":""}`); code != http.StatusBadRequest {
		t.Errorf("an invalid spec is a 400, got %d", code)
	}
}

func TestRemoveDropsTheVolumeOnlyWhenAsked(t *testing.T) {
	fake := &engine{hasVolume: true, listed: `[{"Id":"old","State":"exited"}]`}
	server := newServer(t, fake)
	request(t, http.MethodDelete, server.URL+"/v1/workstations/"+id, "")
	if !fake.sawCall("DELETE /containers/old") || fake.sawCall("DELETE /volumes/"+workstation.VolumeName(id)) {
		t.Errorf("the container goes, the volume stays, got %v", fake.calls)
	}
	request(t, http.MethodDelete, server.URL+"/v1/workstations/"+id+"?volume=1", "")
	if !fake.sawCall("DELETE /volumes/" + workstation.VolumeName(id)) {
		t.Errorf("volume=1 removes the volume, got %v", fake.calls)
	}
}

func TestLogsStreamTheContainerOutputOr404(t *testing.T) {
	fake := &engine{listed: `[]`}
	server := newServer(t, fake)
	response, err := http.Get(server.URL + "/v1/workstations/" + id + "/logs?follow=0")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Errorf("no container is a 404, got %d", response.StatusCode)
	}

	fake.mu.Lock()
	fake.listed = `[{"Id":"old","State":"running"}]`
	fake.mu.Unlock()
	response, err = http.Get(server.URL + "/v1/workstations/" + id + "/logs?follow=0&tail=10")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || string(body) != "listening on 0.0.0.0:8080\n" {
		t.Errorf("the demuxed output, got %d %q", response.StatusCode, body)
	}
}

const procNetTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1
   1: 0200A8C0:1F90 0300A8C0:D4E2 01 00000000:00000000 00:00000000 00000000  1000        0 2 1
   2: 0200A8C0:1F90 0300A8C0:D4E4 06 00000000:00000000 00:00000000 00000000  1000        0 3 1
   3: 0200A8C0:A1B2 5DB8D822:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 4 1
`

func TestCountEstablishedOnlyCountsLiveConnectionsToThePort(t *testing.T) {
	if got := workstation.CountEstablished(procNetTCP, 8080); got != 1 {
		t.Errorf("one established connection to 8080, not the listener, TIME_WAIT or outbound, got %d", got)
	}
	if got := workstation.CountEstablished("", 8080); got != 0 {
		t.Errorf("an empty table has none, got %d", got)
	}
}

func TestConnectionsRouteReadsTheRunningContainer(t *testing.T) {
	fake := &engine{listed: `[]`}
	server := newServer(t, fake)
	get := func(query string) (int, string) {
		response, err := http.Get(server.URL + "/v1/workstations/" + id + "/connections" + query)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, strings.TrimSpace(string(body))
	}
	if code, _ := get("?port=8080"); code != http.StatusNotFound {
		t.Errorf("nothing running is a 404, got %d", code)
	}
	if code, _ := get(""); code != http.StatusBadRequest {
		t.Errorf("no port is a 400, got %d", code)
	}
	fake.mu.Lock()
	fake.listed = `[{"Id":"old","State":"running"}]`
	fake.mu.Unlock()
	if code, body := get("?port=8080"); code != http.StatusOK || body != `{"connections":1}` {
		t.Errorf("one open tab, got %d %s", code, body)
	}
}
