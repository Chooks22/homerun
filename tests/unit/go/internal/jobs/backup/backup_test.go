package backup_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/dockersocket"
	"github.com/orochibraru/homerun/internal/jobs"
	"github.com/orochibraru/homerun/internal/s3"

	"github.com/orochibraru/homerun/internal/jobs/backup"
)

type recorder struct {
	events        []string
	startFailures []string
	failStop      string
	failStart     string
}

// run calls backup.StopAround with recording stop/start/onStartFailure callbacks.
func (r *recorder) run(services []string, work func() error) error {
	return backup.StopAround(services,
		func(s string) error {
			if s == r.failStop {
				return fmt.Errorf("can't stop %s", s)
			}
			r.events = append(r.events, "stop:"+s)
			return nil
		},
		func(s string) error {
			r.events = append(r.events, "start:"+s)
			if s == r.failStart {
				return fmt.Errorf("can't start %s", s)
			}
			return nil
		},
		func(s string, _ error) { r.startFailures = append(r.startFailures, s) },
		work,
	)
}

func TestStopAroundStopsWorksAndStartsAgain(t *testing.T) {
	r := &recorder{}
	err := r.run([]string{"db", "api"}, func() error {
		r.events = append(r.events, "work")
		return nil
	})
	want := []string{"stop:db", "stop:api", "work", "start:db", "start:api"}
	if err != nil || !reflect.DeepEqual(r.events, want) {
		t.Fatalf("err=%v events=%v", err, r.events)
	}
}

func TestStopAroundStartsAgainWhenWorkFails(t *testing.T) {
	r := &recorder{}
	err := r.run([]string{"db"}, func() error { return errors.New("tar") })
	if err == nil || err.Error() != "tar" || !reflect.DeepEqual(r.events, []string{"stop:db", "start:db"}) {
		t.Fatalf("err=%v events=%v", err, r.events)
	}
}

func TestStopAroundFailedStopSkipsWork(t *testing.T) {
	r := &recorder{failStop: "api"}
	ran := false
	err := r.run([]string{"db", "api"}, func() error { ran = true; return nil })
	if err == nil || ran || !reflect.DeepEqual(r.events, []string{"stop:db", "start:db"}) {
		t.Fatalf("err=%v ran=%t events=%v", err, ran, r.events)
	}
}

func TestStopAroundReportsFailedStart(t *testing.T) {
	r := &recorder{failStart: "db"}
	if err := r.run([]string{"db", "api"}, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.startFailures, []string{"db"}) {
		t.Fatalf("start failures = %v", r.startFailures)
	}
}

func TestOutputTail(t *testing.T) {
	if got := backup.OutputTail("  done\n"); got != "done" {
		t.Fatalf("got %q", got)
	}
	tail := backup.OutputTail(strings.Repeat("a", 3000) + "END")
	if !strings.HasPrefix(tail, "...") || !strings.HasSuffix(tail, "END") || len(tail) != 2003 {
		t.Fatalf("tail len=%d", len(tail))
	}
}

// stubS3 starts a fake S3 server backed by an in-memory object store holding
// seed (by request path) and returns a client pointed at it.
func stubS3(t *testing.T, seed map[string]string) s3.Client {
	var mu sync.Mutex
	objects := map[string][]byte{}
	for path, content := range seed {
		objects[path] = []byte(content)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			objects[r.URL.Path], _ = io.ReadAll(r.Body)
		case http.MethodGet:
			object, ok := objects[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(object)
		}
	}))
	t.Cleanup(server.Close)
	return s3.Client{AccessKeyID: "k", Bucket: "b", Endpoint: server.URL, Region: "us-east-1", SecretAccessKey: "s"}
}

// volumeFiles lists the regular file paths inside spec's volume, via a
// throwaway helper container.
func volumeFiles(t *testing.T, docker *dockerapi.Client, spec backup.Spec) []string {
	result, err := docker.RunHelper(context.Background(), dockerapi.HelperConfig{
		Binds: []string{spec.Source + ":" + spec.MountPath + ":ro"},
		Cmd:   []string{"sh", "-c", "cd " + spec.MountPath + " && find . -type f"},
		Image: spec.HelperImage,
	})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("listing the volume: %v %+v", err, result)
	}
	var names []string
	for _, line := range strings.Fields(result.Stdout) {
		names = append(names, strings.TrimPrefix(line, "./"))
	}
	sort.Strings(names)
	return names
}

// runStep runs cmd to completion in a throwaway container with spec's volume
// mounted, failing the test on a non-zero exit.
func runStep(t *testing.T, docker *dockerapi.Client, spec backup.Spec, cmd string) {
	result, err := docker.RunHelper(context.Background(), dockerapi.HelperConfig{
		Binds: []string{spec.Source + ":" + spec.MountPath, "homerun-restic-cache:/cache"},
		Cmd:   []string{"sh", "-c", cmd},
		Image: spec.HelperImage,
	})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("%q: %v %+v", cmd, err, result)
	}
}

func TestBackupAndRestoreRoundTripOnRealDocker(t *testing.T) {
	socket := dockersocket.Resolve("")
	docker := dockerapi.New(socket)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := docker.Ping(ctx); err != nil {
		t.Skipf("no Docker daemon: %v", err)
	}
	volume := fmt.Sprintf("homerun-backup-test-%d", time.Now().UnixNano())
	repository := "/cache/" + volume
	spec := backup.Spec{
		HelperImage: "alpine:3", MountPath: "/homerun-backup-source", Source: volume, VolumeName: volume,
		Restic: &backup.Restic{
			Env: map[string]string{"RCLONE_CONFIG_DEST_TYPE": "local", "RCLONE_LOG_LEVEL": "ERROR"}, Image: "restic/restic:0.18.1", Keep: 1, KeyPrefix: "restic:" + volume + ":",
			Label: "local " + repository, Password: "test", RcloneImage: "rclone/rclone:1.75.1", Repository: "rclone:dest:" + repository,
		},
	}
	t.Cleanup(func() {
		runStep(t, docker, spec, "rm -rf "+repository)
		_ = docker.RemoveVolume(context.Background(), volume)
	})
	if err := docker.EnsureImage(ctx, spec.HelperImage); err != nil {
		t.Fatal(err)
	}
	runStep(t, docker, spec, "echo hi > /homerun-backup-source/a.txt && mkdir /homerun-backup-source/sub && echo x > /homerun-backup-source/sub/b")

	job, lines, _ := jobs.Recorder("backup", spec)
	job.DockerSocket = socket
	first, err := backup.Run(ctx, job)
	if err != nil {
		t.Fatalf("%v, log %v", err, lines())
	}
	runStep(t, docker, spec, "echo y > /homerun-backup-source/extra")
	job, lines, _ = jobs.Recorder("backup", spec)
	job.DockerSocket = socket
	second, err := backup.Run(ctx, job)
	if err != nil {
		t.Fatalf("%v, log %v", err, lines())
	}
	if first["key"] == second["key"] || second["sizeBytes"].(int64) >= first["sizeBytes"].(int64)*4 {
		t.Fatalf("the second snapshot must be its own and small, got %v then %v", first, second)
	}

	runStep(t, docker, spec, "rm /homerun-backup-source/a.txt && echo z > /homerun-backup-source/stray")
	spec.Key = second["key"].(string)
	spec.Restic.Snapshot = strings.TrimPrefix(spec.Key, spec.Restic.KeyPrefix)
	spec.Wipe = true
	job, lines, _ = jobs.Recorder("backup_restore", spec)
	job.DockerSocket = socket
	if _, err := backup.Run(ctx, job); err != nil {
		t.Fatalf("%v, log %v", err, lines())
	}
	if got := volumeFiles(t, docker, spec); !reflect.DeepEqual(got, []string{"a.txt", "extra", "sub/b"}) {
		t.Fatalf("restored files = %v, log %v", got, lines())
	}
}
