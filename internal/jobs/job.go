// Package jobs holds the Job every executor under internal/jobs/<type> runs
// with. It lives apart from internal/worker so executors can import it without
// an import cycle through the worker's own registry.
package jobs

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Job is one claimed job row as an executor sees it.
type Job struct {
	// Attempts is how many times the job has been claimed, this run included.
	Attempts int
	// DockerSocket is the local Docker daemon's unix socket path.
	DockerSocket string
	// ID is the job row's id.
	ID string
	// Spec is the decrypted JSON the TypeScript prepare step produced.
	Spec json.RawMessage
	// Type is the job type, e.g. "deploy".
	Type string

	pool     *pgxpool.Pool
	recorder *recorder
	trace    func(string)
}

type recorder struct {
	mu    sync.Mutex
	lines []string
}

// New builds a Job bound to pool, which AppendLog and DB use.
func New(id, jobType string, attempts int, spec json.RawMessage, dockerSocket string, pool *pgxpool.Pool) Job {
	return Job{Attempts: attempts, DockerSocket: dockerSocket, ID: id, Spec: spec, Type: jobType, pool: pool}
}

// Recorder builds a database-less Job for tests: spec is marshalled as its
// Spec, and every AppendLog line is collected and returned by lines().
func Recorder(jobType string, spec any) (job Job, lines func() []string, err error) {
	raw, err := json.Marshal(spec)
	if err != nil {
		return Job{}, nil, err
	}
	rec := &recorder{}
	job = Job{Attempts: 1, ID: "test-job", Spec: raw, Type: jobType, recorder: rec}
	return job, func() []string {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		return append([]string(nil), rec.lines...)
	}, nil
}

// DecodeSpec unmarshals the job's spec into target.
func (j Job) DecodeSpec(target any) error {
	return json.Unmarshal(j.Spec, target)
}

// DB is the shared Postgres pool, for the few direct writes an executor makes
// (a deployment's log and status). Nil for a Recorder job.
func (j Job) DB() *pgxpool.Pool {
	return j.pool
}

// WithTrace returns the job with every line it logs also handed to trace,
// which the worker points at the job's current trace span.
func (j Job) WithTrace(trace func(string)) Job {
	j.trace = trace
	return j
}

// Trace records line as an event on the job's current trace span, without
// writing it to the job's log.
func (j Job) Trace(line string) {
	if j.trace != nil {
		j.trace(line)
	}
}

// AppendLog appends one line to the job row's log column, and records it as
// an event on the job's current trace span. A failed write is logged, never
// returned: losing a log line must not fail the job.
func (j Job) AppendLog(line string) {
	j.Trace(line)
	if j.recorder != nil {
		j.recorder.mu.Lock()
		j.recorder.lines = append(j.recorder.lines, line)
		j.recorder.mu.Unlock()
		return
	}
	if j.pool == nil {
		log.Printf("[homerun-worker] job=%s %s", j.ID, line)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := j.pool.Exec(ctx, `update job set log = log || $2 || E'\n' where id = $1`, j.ID, line); err != nil {
		log.Printf("[homerun-worker] couldn't append to job %s's log: %s", j.ID, err)
	}
}
