package workstation_test

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
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
		"option extension": func(s *workstation.Spec) { s.Setup = &workstation.Setup{Extensions: []string{"--force"}} },
		"tokenless credential": func(s *workstation.Spec) {
			s.Setup = &workstation.Setup{Credential: &workstation.Credential{Host: "github.com"}}
		},
		"credential host with a path": func(s *workstation.Spec) {
			s.Setup = &workstation.Setup{Credential: &workstation.Credential{Host: "github.com/x", Token: "t"}}
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

	if _, ok := body["Cmd"]; ok {
		t.Errorf("no args keeps the image's own command, got %v", body["Cmd"])
	}
	withArgs := baseSpec()
	withArgs.Args = []string{"--auth", "none"}
	if cmd := workstation.CreateBody(id, withArgs)["Cmd"]; !slices.Equal(cmd.([]string), withArgs.Args) {
		t.Errorf("args become the container's command, got %v", cmd)
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

func TestSetupCommandPassesValuesAsArguments(t *testing.T) {
	spec := baseSpec()
	spec.Setup = &workstation.Setup{
		Credential: &workstation.Credential{Host: "github.com", Token: "t/k", Username: "alice"},
		Extensions: []string{"esbenp.prettier-vscode", "golang.go"},
		GitEmail:   "alice@example.com",
		GitName:    "Alice",
		Settings:   `{"editor.fontSize":14}`,
	}
	command := workstation.SetupCommand(spec)
	if command[0] != "sh" || command[1] != "-c" || strings.Contains(command[2], "alice") {
		t.Fatalf("the script never carries a value, got %v", command)
	}
	want := []string{"setup", "/home/coder", "Alice", "alice@example.com", "github.com", "https://alice:t%2Fk@github.com", `{"editor.fontSize":14}`, "esbenp.prettier-vscode", "golang.go"}
	if !slices.Equal(command[3:], want) {
		t.Errorf("got %v, want %v", command[3:], want)
	}
	spec.Setup = &workstation.Setup{}
	if command = workstation.SetupCommand(spec); !slices.Equal(command[3:], []string{"setup", "/home/coder", "", "", "", "", ""}) {
		t.Errorf("an empty setup passes empty values, got %v", command[3:])
	}
}

type engine struct {
	calls      []string
	created    map[string]any
	exitCode   int
	execOutput string
	listed     string
	mu         sync.Mutex
	noImage    bool
	pullFails  bool
	running    bool
	hasVolume  bool
}

func (e *engine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, r.Method+" "+r.URL.Path)
	switch {
	case r.URL.Path == "/images/create":
		if e.pullFails {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `{"message":"registry unreachable"}`)
			return
		}
		_, _ = io.WriteString(w, `{"status":"Status: Image is up to date"}`)
	case r.URL.Path == "/images/codercom/code-server:latest/json":
		if e.noImage {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"no such image"}`)
			return
		}
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
		output := procNetTCP
		if e.execOutput != "" {
			output = e.execOutput
		}
		_, _ = w.Write(append([]byte{1, 0, 0, 0, 0, 0, byte(len(output) >> 8), byte(len(output) & 0xff)}, output...))
	case r.URL.Path == "/exec/exec2/json":
		_, _ = io.WriteString(w, `{"ExitCode":0}`)
	case r.URL.Path == "/containers/old/stats":
		_, _ = io.WriteString(w, `{"cpu_stats":{"cpu_usage":{"total_usage":200},"online_cpus":2,"system_cpu_usage":1000},"precpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":900},"memory_stats":{"usage":104857600,"limit":209715200}}`)
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
	for _, call := range []string{"POST /images/create", "POST /volumes/create", "POST /containers/create", "POST /containers/new/start", "POST /containers/new/exec"} {
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

func TestAFailedSetupIsReportedWithoutTheCredential(t *testing.T) {
	fake := &engine{exitCode: 4, hasVolume: true, listed: `[]`}
	server := newServer(t, fake)
	spec := baseSpec()
	spec.Setup = &workstation.Setup{Credential: &workstation.Credential{Host: "github.com", Token: "secret-token"}, Extensions: []string{"golang.go"}}
	body, _ := json.Marshal(spec)
	request(t, http.MethodPut, server.URL+"/v1/workstations/"+id, string(body))
	status := waitFor(t, server, workstation.StateFailed)
	if !strings.Contains(status.Error, "configure the IDE") || strings.Contains(status.Error, "secret-token") {
		t.Errorf("the failure is reported without the token, got %q", status.Error)
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

func TestStatsRouteReadsTheRunningContainer(t *testing.T) {
	fake := &engine{listed: `[]`}
	server := newServer(t, fake)
	response, err := http.Get(server.URL + "/v1/workstations/" + id + "/stats")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Errorf("nothing running is a 404, got %d", response.StatusCode)
	}
	fake.listed = `[{"Id":"old","State":"running"}]`
	response, err = http.Get(server.URL + "/v1/workstations/" + id + "/stats")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	var sample dockerapi.ContainerSample
	_ = json.NewDecoder(response.Body).Decode(&sample)
	if response.StatusCode != http.StatusOK || sample.MemUsedMb != 100 || sample.CPUPercent <= 0 {
		t.Errorf("the container's use is reported, got %d %+v", response.StatusCode, sample)
	}
}

func TestAFailedPullFallsBackToTheLocalImage(t *testing.T) {
	fake := &engine{hasVolume: true, listed: `[]`, pullFails: true}
	server := newServer(t, fake)
	body, _ := json.Marshal(baseSpec())
	request(t, http.MethodPut, server.URL+"/v1/workstations/"+id, string(body))
	fake.mu.Lock()
	fake.listed = `[{"Id":"old","State":"running"}]`
	fake.mu.Unlock()
	waitFor(t, server, workstation.StateRunning)
	if !fake.sawCall("POST /containers/new/start") {
		t.Errorf("the local copy starts, got %v", fake.calls)
	}
}

func TestAFailedPullWithNoLocalImageFails(t *testing.T) {
	fake := &engine{hasVolume: true, listed: `[]`, noImage: true, pullFails: true}
	server := newServer(t, fake)
	body, _ := json.Marshal(baseSpec())
	request(t, http.MethodPut, server.URL+"/v1/workstations/"+id, string(body))
	status := waitFor(t, server, workstation.StateFailed)
	if !strings.Contains(status.Error, "couldn't pull") || fake.sawCall("POST /containers/create") {
		t.Errorf("nothing to start from is a failure, got %q %v", status.Error, fake.calls)
	}
}

func TestParseDuKilobytes(t *testing.T) {
	if got, err := workstation.ParseDuKilobytes("2048\t/home/coder\n"); err != nil || got != 2048 {
		t.Errorf("the first field, got %d %v", got, err)
	}
	if _, err := workstation.ParseDuKilobytes(""); err == nil {
		t.Error("no output is an error")
	}
}

func TestDiskRouteMeasuresTheRunningHome(t *testing.T) {
	fake := &engine{execOutput: "1536\t/home/coder\n", listed: `[]`}
	server := newServer(t, fake)
	get := func(query string) (int, string) {
		response, err := http.Get(server.URL + "/v1/workstations/" + id + "/disk" + query)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, strings.TrimSpace(string(body))
	}
	if code, _ := get("?path=/home/coder"); code != http.StatusNotFound {
		t.Errorf("nothing running is a 404, got %d", code)
	}
	if code, _ := get("?path=home"); code != http.StatusBadRequest {
		t.Errorf("a relative path is a 400, got %d", code)
	}
	fake.mu.Lock()
	fake.listed = `[{"Id":"old","State":"running"}]`
	fake.mu.Unlock()
	if code, body := get("?path=/home/coder"); code != http.StatusOK || body != `{"bytes":1572864}` {
		t.Errorf("du's kilobytes as bytes, got %d %s", code, body)
	}
}

func TestHubDrivesTheRemoteDaemonTheHeaderNames(t *testing.T) {
	local := &engine{listed: `[]`}
	remote := &engine{listed: `[{"Id":"old","State":"exited"}]`}
	localDaemon := httptest.NewServer(local)
	t.Cleanup(localDaemon.Close)
	remoteDaemon := httptest.NewServer(remote)
	t.Cleanup(remoteDaemon.Close)
	router := chi.NewRouter()
	workstation.NewHub(workstation.NewManager(dockerapi.NewWithHTTP(localDaemon.Client(), localDaemon.URL))).Mount(router)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	get := func(header string) (int, workstation.Status) {
		req, _ := http.NewRequest(http.MethodGet, server.URL+"/v1/workstations/"+id, nil)
		if header != "" {
			req.Header.Set(workstation.RemoteHeader, header)
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
	if _, status := get(""); status.State != workstation.StateMissing {
		t.Errorf("no header is the local daemon, got %+v", status)
	}
	host, _ := json.Marshal(dockerapi.RemoteHost{DockerHost: "tcp://" + strings.TrimPrefix(remoteDaemon.URL, "http://")})
	if _, status := get(base64.StdEncoding.EncodeToString(host)); status.State != workstation.StateRunning {
		t.Errorf("the header's daemon answers, got %+v", status)
	}
	if !remote.sawCall("GET /containers/json") {
		t.Errorf("the remote daemon was asked, got %v", remote.calls)
	}
	if code, _ := get("not base64!"); code != http.StatusBadRequest {
		t.Errorf("a malformed header is a 400, got %d", code)
	}
	ssh, _ := json.Marshal(dockerapi.RemoteHost{DockerHost: "ssh://box"})
	if code, _ := get(base64.StdEncoding.EncodeToString(ssh)); code != http.StatusBadRequest {
		t.Errorf("a host the worker can't dial is a 400, got %d", code)
	}
}

func TestSetupScriptDrivesOpenVSCodeServer(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	server := filepath.Join(root, "ide", "bin", "openvscode-server")
	if err := os.MkdirAll(filepath.Dir(server), 0o755); err != nil {
		t.Fatal(err)
	}
	calls := filepath.Join(root, "calls")
	fakeIDE := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + calls + "\n"
	if err := os.WriteFile(server, []byte(fakeIDE), 0o755); err != nil {
		t.Fatal(err)
	}
	spec := baseSpec()
	spec.HomePath = home
	spec.Setup = &workstation.Setup{Extensions: []string{"golang.go"}, Settings: `{"editor.fontSize":14}`}
	run := func(spec workstation.Spec) {
		t.Helper()
		command := workstation.SetupCommand(spec)
		cmd := exec.Command(shell, command[1:]...)
		cmd.Env = []string{"PATH=/usr/bin:/bin", "OPENVSCODE_SERVER_ROOT=" + filepath.Join(root, "ide")}
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("setup failed: %v %s", err, output)
		}
	}
	run(spec)
	settings, err := os.ReadFile(filepath.Join(home, ".openvscode-server", "data", "Machine", "settings.json"))
	if err != nil || strings.TrimSpace(string(settings)) != `{"editor.fontSize":14}` {
		t.Errorf("the settings land in openvscode-server's Machine settings, got %q %v", settings, err)
	}
	spec.Setup = &workstation.Setup{}
	run(spec)
	logged, _ := os.ReadFile(calls)
	if got := strings.Split(strings.TrimSpace(string(logged)), "\n"); !slices.Equal(got, []string{"--install-extension golang.go", "--uninstall-extension golang.go"}) {
		t.Errorf("installed with its own CLI, then uninstalled once dropped, got %q", got)
	}
}
