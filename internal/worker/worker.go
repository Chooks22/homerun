package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/orochibraru/homerun/internal/activity"
	"github.com/orochibraru/homerun/internal/jobs"
	"github.com/orochibraru/homerun/internal/logging"
	"github.com/orochibraru/homerun/internal/secrets"
	"github.com/orochibraru/homerun/internal/tracing"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// scope labels every line this file logs.
const scope = "worker"

// Worker leases and executes jobs from a Store until its Run context is
// cancelled.
type Worker struct {
	Box               *secrets.Box
	Concurrency       int
	Executors         map[string]Executor
	HeartbeatInterval time.Duration
	ID                string
	NewJob            func(c *ClaimedJob, spec json.RawMessage) jobs.Job
	PollInterval      time.Duration
	ShutdownGrace     time.Duration
	// StallTimeout fails a job that made no progress (no Docker call
	// answered, no byte moved) for this long, even though it still
	// heartbeats. Zero turns the watchdog off.
	StallTimeout time.Duration
	Store        Store

	lastClaimErr string
}

// Run claims and executes jobs until ctx is cancelled, then gives in-flight
// executions ShutdownGrace to finish before cancelling them and releasing
// their leases, so a restarted worker picks them straight back up.
func (w *Worker) Run(ctx context.Context) {
	execCtx, cancelExec := context.WithCancel(context.Background())
	defer cancelExec()

	slots := make(chan struct{}, w.Concurrency)
	var inFlight sync.WaitGroup
	ticker := time.NewTicker(w.PollInterval)
	defer ticker.Stop()

	for ctx.Err() == nil {
		w.fill(ctx, execCtx, slots, &inFlight)
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}

	done := make(chan struct{})
	go func() {
		inFlight.Wait()
		close(done)
	}()
	select {
	case <-done:
		return
	case <-time.After(w.ShutdownGrace):
		logging.Warnf(scope, "in-flight jobs outlived the %s shutdown grace, cancelling them", w.ShutdownGrace)
		cancelExec()
	}
	<-done
}

// fill claims jobs until every slot is busy or nothing is claimable.
func (w *Worker) fill(ctx, execCtx context.Context, slots chan struct{}, inFlight *sync.WaitGroup) {
	for ctx.Err() == nil {
		select {
		case slots <- struct{}{}:
		default:
			return
		}
		job, err := w.Store.Claim(ctx, w.ID)
		if err != nil || job == nil {
			<-slots
			w.reportClaimError(err)
			if err == nil {
				logging.Debugf(scope, "nothing to claim (%d/%d slots busy)", len(slots), w.Concurrency)
			}
			return
		}
		w.lastClaimErr = ""
		logging.Debugf(scope, "claimed job=%s type=%s attempt=%d (%d/%d slots busy)",
			job.ID, job.JobType, job.Attempts, len(slots), w.Concurrency)
		inFlight.Add(1)
		go func() {
			defer inFlight.Done()
			defer func() { <-slots }()
			w.execute(ctx, execCtx, job)
		}()
	}
}

// reportClaimError logs a claim failure once per distinct message rather than
// every poll, so a Postgres outage doesn't flood the log.
func (w *Worker) reportClaimError(err error) {
	if err == nil || err.Error() == w.lastClaimErr {
		return
	}
	w.lastClaimErr = err.Error()
	logging.Errorf(scope, "couldn't claim a job: %s", err)
}

// execute runs one leased job with a heartbeat, then hands the outcome back
// for the TypeScript finalize step. A lost lease (the row was cancelled or
// taken over) cancels the execution and writes nothing; a shutdown that
// cancels it releases the lease instead of recording a failure.
func (w *Worker) execute(ctx, execCtx context.Context, job *ClaimedJob) {
	started := time.Now()
	logging.Infof(scope, "job started: type=%s job=%s attempt=%d", job.JobType, job.ID, job.Attempts)
	spanCtx, span := tracing.Tracer().Start(execCtx, "job "+job.JobType, trace.WithAttributes(
		attribute.String("homerun.job.id", job.ID),
		attribute.String("homerun.job.type", job.JobType),
		attribute.Int("homerun.job.attempt", job.Attempts),
	))
	outcome, outcomeErr := "succeeded", error(nil)
	defer func() {
		span.SetAttributes(attribute.String("homerun.job.outcome", outcome))
		tracing.Record(span, outcomeErr)
		span.End()
	}()
	tracker := activity.NewTracker()
	spanCtx, _ = tracing.WithCursor(spanCtx)
	runCtx, cancel := context.WithCancel(activity.With(spanCtx, tracker))
	defer cancel()

	beat := heartbeat{
		cancel: cancel, jobID: job.ID, lost: make(chan struct{}), stalled: make(chan time.Duration, 1),
		stop: make(chan struct{}), tracker: tracker,
	}
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		w.heartbeat(runCtx, beat)
	}()

	var result map[string]any
	var execErr error
	_ = tracing.Stage(runCtx, "execute", func(ctx context.Context) error {
		result, execErr = w.dispatch(ctx, job)
		return execErr
	})
	close(beat.stop)
	<-heartbeatDone
	lost := beat.lost
	select {
	case quiet := <-beat.stalled:
		result, execErr = nil, StalledError(quiet, execErr)
		outcome = "stalled"
		logging.Errorf(scope, "job %s made no progress for %s, stopped it", job.ID, quiet.Round(time.Second))
	default:
	}

	bookkeeping, done := context.WithTimeout(trace.ContextWithSpan(context.Background(), span), 10*time.Second)
	defer done()
	select {
	case <-lost:
		logging.Warnf(scope, "job %s is no longer leased to this worker after %s, dropping its result",
			job.ID, took(started))
		outcome, outcomeErr = "lost", errors.New("the worker lost the job's lease")
		return
	default:
	}
	if execErr != nil && execCtx.Err() != nil && ctx.Err() != nil {
		logging.Infof(scope, "job %s interrupted by shutdown after %s, releasing it for re-execution",
			job.ID, took(started))
		outcome, outcomeErr = "released", execErr
		if err := w.Store.Release(bookkeeping, job.ID, w.ID); err != nil {
			logging.Errorf(scope, "couldn't release job %s: %s", job.ID, err)
		}
		return
	}
	if err := tracing.Stage(bookkeeping, "finish", func(ctx context.Context) error {
		return w.Store.Finish(ctx, job.ID, w.ID, result, execErr)
	}); err != nil {
		logging.Errorf(scope, "couldn't record job %s's outcome: %s", job.ID, err)
		outcome, outcomeErr = "unrecorded", err
		return
	}
	if execErr != nil {
		outcomeErr = execErr
		if outcome == "succeeded" {
			outcome = "failed"
		}
		logging.Errorf(scope, "job failed: type=%s job=%s after=%s : %s",
			job.JobType, job.ID, took(started), execErr)
		return
	}
	logging.Infof(scope, "job executed: type=%s job=%s after=%s", job.JobType, job.ID, took(started))
	if logging.Enabled(logging.LevelDebug) {
		logging.Debugf(scope, "job %s returned %d result field(s)", job.ID, len(result))
	}
}

// heartbeat is one execution's heartbeat loop state: stop ends it, lost is
// closed when the lease was taken away, and stalled receives how long the job
// had been quiet when the no-progress watchdog stopped it.
type heartbeat struct {
	cancel  context.CancelFunc
	jobID   string
	lost    chan struct{}
	stalled chan time.Duration
	stop    chan struct{}
	tracker *activity.Tracker
}

// heartbeat refreshes the lease and the job's last-progress time every
// HeartbeatInterval until beat.stop closes. When the row stops being this
// worker's, it closes beat.lost and cancels the execution; when the job made
// no progress for StallTimeout, it reports that on beat.stalled and cancels
// the execution, which then fails through the normal retry path.
func (w *Worker) heartbeat(ctx context.Context, beat heartbeat) {
	ticker := time.NewTicker(w.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-beat.stop:
			return
		case <-ticker.C:
		}
		progressAt := beat.tracker.Last()
		if quiet := time.Since(progressAt); w.StallTimeout > 0 && quiet >= w.StallTimeout {
			beat.stalled <- quiet
			beat.cancel()
			return
		}
		ours, err := w.Store.Heartbeat(ctx, beat.jobID, w.ID, progressAt)
		if err != nil {
			logging.Warnf(scope, "heartbeat for job %s failed: %s", beat.jobID, err)
			continue
		}
		if !ours {
			logging.Warnf(scope, "lost the lease on job %s", beat.jobID)
			close(beat.lost)
			beat.cancel()
			return
		}
		logging.Debugf(scope, "heartbeat ok for job %s", beat.jobID)
	}
}

// StalledError is the error a job fails with when the no-progress watchdog
// stopped it after quiet, keeping what the executor itself returned when that
// says more than a cancellation.
func StalledError(quiet time.Duration, cause error) error {
	message := fmt.Sprintf("The job made no progress for %s (no Docker call answered and no data moved), so the worker stopped it.", quiet.Round(time.Second))
	if cause != nil && !errors.Is(cause, context.Canceled) {
		return fmt.Errorf("%s Last error: %w", message, cause)
	}
	return fmt.Errorf("%s The Docker daemon may be stuck: check the worker's health and `docker ps` on the host.", message)
}

// dispatch decrypts the spec and runs the job's executor, turning a missing
// executor, an undecryptable spec or a panic into an ordinary error.
func (w *Worker) dispatch(ctx context.Context, job *ClaimedJob) (result map[string]any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result, err = nil, fmt.Errorf("executor panicked: %v", recovered)
		}
	}()
	logging.Debugf(scope, "dispatching job %s to the %s executor", job.ID, job.JobType)
	executor, ok := w.Executors[job.JobType]
	if !ok {
		return nil, fmt.Errorf("the worker has no executor for job type %q", job.JobType)
	}
	spec, err := w.Box.Decrypt(job.Spec)
	if err != nil {
		return nil, fmt.Errorf("couldn't decrypt the job spec (is AUTH_SECRET the same as the app's?): %w", err)
	}
	return executor(ctx, w.NewJob(job, json.RawMessage(spec)).WithTrace(tracing.CursorFrom(ctx).Event))
}

// took renders how long a job ran, rounded to something a log line can be
// scanned for rather than nanoseconds.
func took(started time.Time) time.Duration {
	return time.Since(started).Round(time.Millisecond)
}
