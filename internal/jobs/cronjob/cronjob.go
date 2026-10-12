// Package cronjob executes cron_job jobs for the homerun worker: one throwaway
// container, image or host-command helper alike, as the app's prepare step
// resolved it.
package cronjob

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/jobs"
	"github.com/orochibraru/homerun/internal/tracing"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

const (
	flushInterval  = time.Second
	maxOutputBytes = 64_000
	dockerSocket   = "/var/run/docker.sock"
)

// Spec is what the app's cron_job prepare step hands the worker.
type Spec struct {
	Auth           *dockerapi.AuthConfig `json:"auth"`
	Binds          []string              `json:"binds"`
	Cmd            []string              `json:"cmd"`
	DockerSocket   bool                  `json:"dockerSocket"`
	Env            []string              `json:"env"`
	Files          []dockerapi.File      `json:"files"`
	Image          string                `json:"image"`
	Labels         map[string]string     `json:"labels"`
	PidMode        string                `json:"pidMode"`
	Privileged     bool                  `json:"privileged"`
	Remote         *dockerapi.RemoteHost `json:"remote"`
	RunID          string                `json:"runId"`
	TimeoutSeconds int                   `json:"timeoutSeconds"`
	User           string                `json:"user"`
	WorkingDir     string                `json:"workingDir"`
}

// Run executes one cron job run: it runs the spec's container on the local
// daemon or its remote host, appending its output to the cron_job_run row at
// most once a second so the page shows a long run's progress, and returns the
// exit code, whether it timed out and its stdout then stderr (newest 64 KB).
// A non-zero exit or a timeout is a result, not an error.
func Run(ctx context.Context, job jobs.Job) (map[string]any, error) {
	var spec Spec
	if err := job.DecodeSpec(&spec); err != nil {
		return nil, err
	}
	if spec.Image == "" || spec.RunID == "" {
		return nil, errors.New("the cron job spec has no image or run id")
	}
	client := dockerapi.New(job.DockerSocket)
	if spec.Remote != nil {
		remote, err := dockerapi.NewRemote(*spec.Remote)
		if err != nil {
			return nil, err
		}
		client = remote
	}

	binds, groups := withSocket(spec, job.DockerSocket)
	flusher := newFlusher(job, spec.RunID)
	stop := flusher.start()
	ctx, span := tracing.Tracer().Start(ctx, "run container", trace.WithAttributes(
		attribute.String("container.image.name", spec.Image),
		attribute.String("homerun.cronjob.run.id", spec.RunID),
	))
	result, err := client.RunOneOff(ctx, dockerapi.OneOffConfig{
		Auth:       spec.Auth,
		Binds:      binds,
		Cmd:        spec.Cmd,
		Env:        spec.Env,
		Files:      spec.Files,
		GroupAdd:   groups,
		Image:      spec.Image,
		Labels:     spec.Labels,
		OnOutput:   flusher.push,
		PidMode:    spec.PidMode,
		Privileged: spec.Privileged,
		Timeout:    time.Duration(spec.TimeoutSeconds) * time.Second,
		User:       spec.User,
		WorkingDir: spec.WorkingDir,
	})
	stop()
	endRunSpan(span, result, err)
	if err != nil {
		return nil, err
	}
	output := string(result.Stdout) + string(result.Stderr)
	return map[string]any{
		"exitCode": result.ExitCode,
		"output":   Tail(output, maxOutputBytes),
		"timedOut": result.TimedOut,
	}, nil
}

// endRunSpan records how the container ended on span and ends it: a run that
// timed out or exited non-zero is marked failed, like an executor error.
func endRunSpan(span trace.Span, result dockerapi.OneOffResult, err error) {
	defer span.End()
	if err != nil {
		tracing.Record(span, err)
		return
	}
	span.SetAttributes(
		attribute.Int("process.exit.code", result.ExitCode),
		attribute.Bool("homerun.cronjob.timed_out", result.TimedOut),
	)
	switch {
	case result.TimedOut:
		tracing.Record(span, errors.New("the container timed out"))
	case result.ExitCode != 0:
		tracing.Record(span, fmt.Errorf("the container exited with code %d", result.ExitCode))
	default:
		tracing.Record(span, nil)
	}
}

// withSocket adds the Docker socket to spec's binds when it asks for it, at
// /var/run/docker.sock: the local daemon's own socket, or a remote host's
// default one. Locally the socket's group is added too, so a container running
// as a non-root user can still talk to the daemon.
func withSocket(spec Spec, localSocket string) ([]string, []string) {
	if !spec.DockerSocket {
		return spec.Binds, nil
	}
	source := localSocket
	if spec.Remote != nil {
		source = dockerSocket
	}
	binds := append(append([]string{}, spec.Binds...), source+":"+dockerSocket)
	if spec.Remote != nil {
		return binds, nil
	}
	info, err := os.Stat(source)
	if err != nil {
		return binds, nil
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return binds, nil
	}
	return binds, []string{strconv.FormatUint(uint64(stat.Gid), 10)}
}

// Tail returns the last limit bytes of text, cut on a rune boundary.
func Tail(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := len(text) - limit
	for cut < len(text) && !utf8.RuneStart(text[cut]) {
		cut++
	}
	return text[cut:]
}

type flusher struct {
	job     jobs.Job
	runID   string
	mu      sync.Mutex
	pending strings.Builder
}

// newFlusher builds a flusher appending output to runID's cron_job_run row.
func newFlusher(job jobs.Job, runID string) *flusher {
	return &flusher{job: job, runID: runID}
}

// push appends chunk to the pending buffer, flushed on the next tick.
func (f *flusher) push(chunk string) {
	f.mu.Lock()
	f.pending.WriteString(chunk)
	f.mu.Unlock()
}

// start runs the periodic flush loop until the returned stop function is
// called, which flushes one last time before returning.
func (f *flusher) start() func() {
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(flushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				f.flush()
			case <-done:
				f.flush()
				return
			}
		}
	}()
	return func() {
		close(done)
		<-finished
	}
}

// flush appends the pending buffer to the cron_job_run row, if there is any.
func (f *flusher) flush() {
	f.mu.Lock()
	chunk := f.pending.String()
	f.pending.Reset()
	f.mu.Unlock()
	pool := f.job.DB()
	if chunk == "" || pool == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := pool.Exec(ctx,
		`update cron_job_run set output = right(coalesce(output, '') || $2, $3) where id = $1`,
		f.runID, chunk, maxOutputBytes,
	); err != nil {
		f.job.AppendLog("couldn't append cron job output: " + err.Error())
	}
}
