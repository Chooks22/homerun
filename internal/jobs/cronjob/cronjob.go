// Package cronjob executes cron_job jobs for the homerun worker: one throwaway
// container, image or host-command helper alike, as the app's prepare step
// resolved it.
package cronjob

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/jobs"
)

const (
	flushInterval  = time.Second
	maxOutputBytes = 64_000
)

// Spec is what the app's cron_job prepare step hands the worker.
type Spec struct {
	Auth           *dockerapi.AuthConfig `json:"auth"`
	Cmd            []string              `json:"cmd"`
	Env            []string              `json:"env"`
	Files          []dockerapi.File      `json:"files"`
	Image          string                `json:"image"`
	Labels         map[string]string     `json:"labels"`
	PidMode        string                `json:"pidMode"`
	Privileged     bool                  `json:"privileged"`
	Remote         *dockerapi.RemoteHost `json:"remote"`
	RunID          string                `json:"runId"`
	TimeoutSeconds int                   `json:"timeoutSeconds"`
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

	flusher := newFlusher(job, spec.RunID)
	stop := flusher.start()
	result, err := client.RunOneOff(ctx, dockerapi.OneOffConfig{
		Auth:       spec.Auth,
		Cmd:        spec.Cmd,
		Env:        spec.Env,
		Files:      spec.Files,
		Image:      spec.Image,
		Labels:     spec.Labels,
		OnOutput:   flusher.push,
		PidMode:    spec.PidMode,
		Privileged: spec.Privileged,
		Timeout:    time.Duration(spec.TimeoutSeconds) * time.Second,
		WorkingDir: spec.WorkingDir,
	})
	stop()
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
