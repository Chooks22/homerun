package backup_test

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/jobs"
	"github.com/orochibraru/homerun/internal/jobs/backup"
	"github.com/orochibraru/homerun/tests/unit/go/internal/testsupport"
)

type fakeContainer struct {
	bind       string
	binds      []string
	cmd        []string
	code       int
	entrypoint []string
	env        []string
	exited     chan struct{}
	labels     map[string]string
	mounts     []map[string]any
	started    chan struct{}
}

// fakeEngine is a Docker daemon that runs helper containers' tar and find
// against in-memory volumes, rclone's cat against an in-memory remote, and
// restic's backup and restore against in-memory snapshots, over a real
// hijacked attach.
type fakeEngine struct {
	mu         sync.Mutex
	containers map[string]*fakeContainer
	hang       bool
	remote     map[string]string
	removed    []string
	resticCode int
	snapshots  map[string]map[string]string
	volumes    map[string]map[string]string
}

// ServeHTTP answers the handful of Engine endpoints a helper run uses.
func (e *fakeEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == "/_ping" || strings.HasPrefix(path, "/images/"):
		_, _ = io.WriteString(w, `{}`)
	case path == "/containers/create":
		e.create(w, r)
	case strings.HasSuffix(path, "/attach"):
		e.attach(w, e.container(path))
	case strings.HasSuffix(path, "/start"):
		close(e.container(path).started)
		w.WriteHeader(http.StatusNoContent)
	case strings.HasSuffix(path, "/wait"):
		c := e.container(path)
		<-c.exited
		_, _ = fmt.Fprintf(w, `{"StatusCode":%d}`, c.code)
	case strings.HasSuffix(path, "/json"):
		if e.hang {
			<-r.Context().Done()
			return
		}
		_, _ = io.WriteString(w, `{"State":{"Running":true}}`)
	case r.Method == http.MethodDelete:
		e.mu.Lock()
		e.removed = append(e.removed, strings.TrimPrefix(path, "/containers/"))
		e.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// container is the fake container a /containers/<id>/... path is about.
func (e *fakeEngine) container(path string) *fakeContainer {
	id := strings.Split(strings.TrimPrefix(path, "/containers/"), "/")[0]
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.containers[id]
}

// create records a helper's command, bind and labels.
func (e *fakeEngine) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cmd        []string `json:"Cmd"`
		Entrypoint []string `json:"Entrypoint"`
		Env        []string `json:"Env"`
		HostConfig struct {
			Binds  []string
			Mounts []map[string]any
		} `json:"HostConfig"`
		Labels map[string]string `json:"Labels"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	e.mu.Lock()
	id := fmt.Sprintf("helper%d", len(e.containers)+1)
	bind := ""
	if len(body.HostConfig.Binds) > 0 {
		bind = body.HostConfig.Binds[0]
	}
	e.containers[id] = &fakeContainer{
		bind: bind, binds: body.HostConfig.Binds, cmd: body.Cmd, entrypoint: body.Entrypoint, env: body.Env,
		exited: make(chan struct{}), labels: body.Labels, mounts: body.HostConfig.Mounts, started: make(chan struct{}),
	}
	e.mu.Unlock()
	w.WriteHeader(http.StatusCreated)
	_, _ = fmt.Fprintf(w, `{"Id":%q}`, id)
}

// attach hijacks the connection and, once the container starts, runs its
// command: a restic script snapshots or restores the volume, tar -x reads an
// archive in from stdin until the client half-closes, find wipes it, and
// anything else is an rclone command.
func (e *fakeEngine) attach(w http.ResponseWriter, c *fakeContainer) {
	conn, buffered, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	_, _ = buffered.WriteString("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
	_ = buffered.Flush()
	<-c.started
	defer close(c.exited)
	if e.hang {
		time.Sleep(time.Second)
		return
	}
	source := strings.Split(c.bind, ":")[0]
	switch {
	case len(c.entrypoint) > 2 && strings.Contains(c.entrypoint[2], "restic"):
		e.restic(c, source, buffered)
	case strings.Contains(strings.Join(c.cmd, " "), "-xf"):
		e.unpack(source, buffered)
	case c.cmd[0] == "find":
		e.mu.Lock()
		e.volumes[source] = map[string]string{}
		e.mu.Unlock()
	default:
		e.rclone(c, buffered)
	}
	_ = buffered.Flush()
}

// restic runs a restic helper's script against in-memory snapshots: a backup
// copies the volume into a new snapshot and prints restic's JSON status and
// summary, a restore copies a snapshot back (replacing the volume with
// --delete). A non-zero resticCode fails the step with restic's error.
func (e *fakeEngine) restic(c *fakeContainer, source string, stream *bufio.ReadWriter) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.resticCode != 0 {
		_, _ = stream.Write(testsupport.DockerFrame(2, "Fatal: wrong password or no key found"))
		c.code = e.resticCode
		return
	}
	if strings.Contains(c.entrypoint[2], "restic backup") {
		id := fmt.Sprintf("%064d", len(e.snapshots)+1)
		snapshot := map[string]string{}
		for name, content := range e.volumes[source] {
			snapshot[name] = content
		}
		e.snapshots[id] = snapshot
		_, _ = stream.Write(testsupport.DockerFrame(1, "created restic repository 1234 at rclone:dest:base\n"))
		_, _ = stream.Write(testsupport.DockerFrame(1, `{"message_type":"status","percent_done":0.5,"bytes_done":1,"total_bytes":2}`+"\n"))
		_, _ = stream.Write(testsupport.DockerFrame(1, fmt.Sprintf(`{"message_type":"summary","data_added":20,"data_added_packed":12,"total_bytes_processed":40,"snapshot_id":%q}`+"\n", id)))
		return
	}
	snapshot := e.snapshots[strings.Split(c.cmd[0], ":")[0]]
	if slices.Contains(c.cmd, "--delete") {
		e.volumes[source] = map[string]string{}
	}
	for name, content := range snapshot {
		e.volumes[source][name] = content
	}
	_, _ = stream.Write(testsupport.DockerFrame(1, `{"message_type":"summary","total_bytes":7,"bytes_restored":7}`+"\n"))
}

// rclone runs rclone's cat against the in-memory remote, streaming an object
// out.
func (e *fakeEngine) rclone(c *fakeContainer, stream *bufio.ReadWriter) {
	last := c.cmd[len(c.cmd)-1]
	e.mu.Lock()
	defer e.mu.Unlock()
	switch c.cmd[0] {
	case "cat":
		object, found := e.remote[last]
		if !found {
			_, _ = stream.Write(testsupport.DockerFrame(2, "object not found"))
			c.code = 4
			return
		}
		_, _ = stream.Write(testsupport.DockerFrame(1, object))
	}
}

// legacyArchive is a gzipped tar of files named the way the legacy backup's
// `tar -C mount -cf - .` named them.
func legacyArchive(files map[string]string) string {
	var out bytes.Buffer
	zipped := gzip.NewWriter(&out)
	writer := tar.NewWriter(zipped)
	_ = writer.WriteHeader(&tar.Header{Name: "./", Typeflag: tar.TypeDir, Mode: 0o755})
	for name, content := range files {
		_ = writer.WriteHeader(&tar.Header{Name: "./" + name, Mode: 0o644, Size: int64(len(content))})
		_, _ = writer.Write([]byte(content))
	}
	_ = writer.Close()
	_ = zipped.Close()
	return out.String()
}

// unpack reads a tar from stdin into a volume, over what's already there.
func (e *fakeEngine) unpack(source string, stdin io.Reader) {
	reader := tar.NewReader(stdin)
	e.mu.Lock()
	defer e.mu.Unlock()
	for {
		header, err := reader.Next()
		if err != nil {
			_, _ = io.Copy(io.Discard, stdin)
			return
		}
		if header.Typeflag == tar.TypeReg {
			content, _ := io.ReadAll(reader)
			e.volumes[source][strings.TrimPrefix(header.Name, "./")] = string(content)
		}
	}
}

// files lists a volume's file names, sorted.
func (e *fakeEngine) files(source string) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var names []string
	for name := range e.volumes[source] {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// newFakeEngine serves a fakeEngine holding volume "data" on a unix socket.
func newFakeEngine(t *testing.T, files map[string]string) (*fakeEngine, string) {
	engine := &fakeEngine{
		containers: map[string]*fakeContainer{}, remote: map[string]string{},
		snapshots: map[string]map[string]string{}, volumes: map[string]map[string]string{"data": files},
	}
	return engine, testsupport.ServeUnixSocket(t, engine)
}

// fakeSpec is a backup of volume "data" into a restic repository keeping 7
// snapshots.
func fakeSpec() backup.Spec {
	return backup.Spec{
		HelperImage: "alpine:3", HelperLabels: map[string]string{"homerun.volume": "data"},
		MountPath: "/homerun-backup-source",
		Restic: &backup.Restic{
			Env: map[string]string{"RCLONE_CONFIG_DEST_TYPE": "sftp"}, Image: "restic/restic:0.18.1", Keep: 7, KeyPrefix: "restic:data:",
			Label: "sftp://bob@nas/base/restic/data", Password: "hunter2", RcloneImage: "rclone/rclone:1.75.1",
			Repository: "rclone:dest:base/restic/data",
		},
		Source: "data", VolumeName: "data",
	}
}

// runJob runs a backup or backup_restore job against socket.
func runJob(t *testing.T, jobType, socket string, spec backup.Spec) (map[string]any, error) {
	job, _, err := jobs.Recorder(jobType, spec)
	if err != nil {
		t.Fatal(err)
	}
	job.DockerSocket = socket
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return backup.Run(ctx, job)
}

func TestABackupSnapshotsTheVolumeReadOnlyIntoResticAndRestoresIt(t *testing.T) {
	engine, socket := newFakeEngine(t, map[string]string{"a.txt": "hi", "sub/b": "x"})
	spec := fakeSpec()

	result, err := runJob(t, "backup", socket, spec)
	if err != nil {
		t.Fatal(err)
	}
	key, _ := result["key"].(string)
	if !strings.HasPrefix(key, "restic:data:") || result["sizeBytes"].(int64) != 12 {
		t.Fatalf("result = %v", result)
	}
	helper := engine.containers["helper1"]
	if helper.labels[dockerapi.HelperLabel] != "true" || helper.labels["homerun.volume"] != "data" {
		t.Errorf("the helper must carry the helper labels and the spec's own, got %v", helper.labels)
	}
	if !reflect.DeepEqual(helper.binds, []string{"data:/homerun-backup-source:ro", "homerun-restic-cache:/cache"}) {
		t.Errorf("the backup must mount the volume read-only and restic's cache, got %v", helper.binds)
	}
	if len(helper.mounts) != 1 || helper.mounts[0]["Type"] != "image" || helper.mounts[0]["Source"] != "rclone/rclone:1.75.1" || helper.mounts[0]["Target"] != "/opt/rclone" {
		t.Errorf("rclone must be mounted from its image, got %v", helper.mounts)
	}
	for _, want := range []string{"RESTIC_PASSWORD=hunter2", "RESTIC_REPOSITORY=rclone:dest:base/restic/data", "RCLONE_CONFIG_DEST_TYPE=sftp"} {
		if !slices.Contains(helper.env, want) {
			t.Errorf("env should contain %q, got %v", want, helper.env)
		}
	}
	if !reflect.DeepEqual(helper.cmd, []string{"/homerun-backup-source", "7"}) {
		t.Errorf("the script gets the mount path and how many snapshots to keep, got %v", helper.cmd)
	}

	engine.mu.Lock()
	engine.volumes["data"] = map[string]string{"stray": "y"}
	engine.mu.Unlock()
	spec.Key = key
	spec.Restic.Snapshot = strings.TrimPrefix(key, "restic:data:")
	spec.Wipe = true
	if _, err := runJob(t, "backup_restore", socket, spec); err != nil {
		t.Fatal(err)
	}
	if got := engine.files("data"); !reflect.DeepEqual(got, []string{"a.txt", "sub/b"}) {
		t.Fatalf("restored files = %v", got)
	}
	if got := engine.containers["helper2"].binds[0]; got != "data:/homerun-backup-source" {
		t.Errorf("a restore mounts the volume read-write, got %s", got)
	}
	if len(engine.removed) != len(engine.containers) {
		t.Errorf("every helper must be removed, created %d removed %v", len(engine.containers), engine.removed)
	}
}

func TestAWrongRepositoryPasswordSaysSo(t *testing.T) {
	engine, socket := newFakeEngine(t, map[string]string{"a.txt": "hi"})
	engine.resticCode = 12

	_, err := runJob(t, "backup", socket, fakeSpec())
	if err == nil || !strings.Contains(err.Error(), "doesn't open with this destination's password") {
		t.Fatalf("want the password error, got %v", err)
	}
}

func TestAFailedResticStepFailsWithItsStderr(t *testing.T) {
	engine, socket := newFakeEngine(t, map[string]string{"a.txt": "hi"})
	engine.resticCode = 1

	_, err := runJob(t, "backup", socket, fakeSpec())
	if err == nil || !strings.Contains(err.Error(), "restic exited 1") || !strings.Contains(err.Error(), "Fatal: wrong password or no key found") {
		t.Fatalf("want restic's own error, got %v", err)
	}
}

func TestALegacyArchiveStillRestoresFromS3(t *testing.T) {
	engine, socket := newFakeEngine(t, map[string]string{"stray": "y"})
	destination := stubS3(t, map[string]string{"/b/p/data.tar.gz": legacyArchive(map[string]string{"a.txt": "hi", "sub/b": "x"})})
	spec := backup.Spec{
		Destination: destination, HelperImage: "alpine:3", Key: "p/data.tar.gz",
		MountPath: "/homerun-backup-source", Source: "data", VolumeName: "data", Wipe: true,
	}

	if _, err := runJob(t, "backup_restore", socket, spec); err != nil {
		t.Fatal(err)
	}
	if got := engine.files("data"); !reflect.DeepEqual(got, []string{"a.txt", "sub/b"}) {
		t.Fatalf("restored files = %v", got)
	}
}

func TestABackupOnAWedgedContainerFailsInsteadOfHanging(t *testing.T) {
	restore := dockerapi.ControlTimeout
	restoreStall := dockerapi.StallTimeout
	dockerapi.ControlTimeout, dockerapi.StallTimeout = 50*time.Millisecond, 200*time.Millisecond
	t.Cleanup(func() { dockerapi.ControlTimeout, dockerapi.StallTimeout = restore, restoreStall })

	engine, socket := newFakeEngine(t, map[string]string{"a.txt": "hi"})
	engine.hang = true
	started := time.Now()
	_, err := runJob(t, "backup", socket, fakeSpec())
	var stall *dockerapi.StallError
	if !errors.As(err, &stall) || stall.Container != "helper1" {
		t.Fatalf("want a StallError naming the helper, got %v", err)
	}
	if !strings.Contains(err.Error(), "sudo systemctl restart docker") {
		t.Errorf("the error must say how to clear a wedged daemon, got %v", err)
	}
	if took := time.Since(started); took > 5*time.Second {
		t.Fatalf("the stall must be detected within the window, took %s", took)
	}
}

func TestTheBackupLogSaysWhereTheVolumeComesFromAndHowItWent(t *testing.T) {
	_, socket := newFakeEngine(t, map[string]string{"a.txt": "hi"})
	spec := fakeSpec()
	spec.Kind = "volume"
	spec.UsedBy = []string{"postgres (Gitea / Tools)"}
	job, lines, err := jobs.Recorder("backup", spec)
	if err != nil {
		t.Fatal(err)
	}
	job.DockerSocket = socket
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err := backup.Run(ctx, job); err != nil {
		t.Fatal(err)
	}
	log := strings.Join(lines(), "\n")
	for _, want := range []string{
		"Backing up data (Docker volume data), used by postgres (Gitea / Tools)",
		"Repository: sftp://bob@nas/base/restic/data",
		"keep running",
		"created restic repository 1234",
		"Snapshot 00000000: scanned 0.0 MiB, 0.0 MiB new, 0.0 MiB stored",
	} {
		if !strings.Contains(log, want) {
			t.Errorf("log should contain %q, got:\n%s", want, log)
		}
	}
}
