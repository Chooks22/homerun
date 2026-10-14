package deploy

import (
	"context"
	"errors"
	"fmt"
	"log"
	"maps"
	"strings"
	"sync"
	"time"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/tracing"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

const (
	managedLabel   = "homerun.managed"
	serviceIDLabel = "homerun.service.id"
)

type resolvedImage struct {
	digest string
	image  string
	tag    string
}

// ref is the image:tag Docker reference for i.
func (i resolvedImage) ref() string { return i.image + ":" + i.tag }

// workloadEnv is the service's environment as a Docker Env list: the env files
// read from the host first, in order, then the service's own variables, a later
// value overriding an earlier one in place, then the built commit under
// ReleaseEnv when the spec names one.
func (r *run) workloadEnv(ctx context.Context) ([]string, error) {
	merged, err := r.readEnvFiles(ctx)
	if err != nil {
		return nil, err
	}
	for _, pair := range r.spec.Env {
		merged = SetEnv(merged, pair[0], pair[1])
	}
	if r.spec.ReleaseEnv != "" && r.result.GitCommit != "" {
		merged = SetEnv(merged, r.spec.ReleaseEnv, r.result.GitCommit)
	}
	env := make([]string, 0, len(merged))
	for _, pair := range merged {
		env = append(env, pair[0]+"="+pair[1])
	}
	return env, nil
}

// SetEnv upserts key=value into env, preserving the existing entry's position
// when key is already present.
func SetEnv(env [][2]string, key, value string) [][2]string {
	for index := range env {
		if env[index][0] == key {
			env[index][1] = value
			return env
		}
	}
	return append(env, [2]string{key, value})
}

// withLabels copies labels and adds extra over it, extra winning on a clash.
func withLabels(labels any, extra map[string]string) map[string]any {
	merged := map[string]any{}
	if existing, ok := labels.(map[string]any); ok {
		maps.Copy(merged, existing)
	}
	for key, value := range extra {
		merged[key] = value
	}
	return merged
}

// startContainer creates and starts the service's container, replacing any
// previous one. When the previous one is running (and neither host networking
// nor a writable volume rules it out) the new one starts next to it and the
// previous one is removed only once the new one is ready; otherwise the
// previous one is removed first.
func (r *run) startContainer(ctx context.Context, image resolvedImage, recreate bool) (string, error) {
	workload := r.spec.Workload
	env, err := r.workloadEnv(ctx)
	if err != nil {
		return "", err
	}
	check := r.planReadiness(ctx, image.ref(), "container")
	previous, err := r.docker.ListContainersByLabel(ctx, serviceIDLabel+"="+r.spec.ServiceID)
	if err != nil {
		return "", err
	}
	running := false
	for _, container := range previous {
		running = running || container.State == "running"
	}
	plan := RolloutStrategy(running, workload.HostNetwork, workload.PublishesPorts, Routed(workload.Template), r.spec.Volumes)
	if recreate {
		plan = RolloutPlan{}
	}
	trace.SpanFromContext(ctx).SetAttributes(
		attribute.Bool("homerun.deploy.blue_green", plan.BlueGreen),
		attribute.String("homerun.deploy.readiness", check.Kind),
		attribute.Int("homerun.deploy.previous_containers", len(previous)),
	)
	if plan.BlueGreen {
		r.progress.line("Keeping the previous container serving until the new one is ready...")
	} else {
		if plan.Reason != "" {
			r.progress.line(plan.Reason)
		}
		r.removePrevious(ctx, previous)
	}

	if !workload.HostNetwork {
		if err := r.ensureBridge(ctx, r.spec.Network); err != nil {
			return "", err
		}
	}

	body := maps.Clone(workload.Template)
	body["Env"] = env
	body["Image"] = image.ref()
	body["Labels"] = withLabels(body["Labels"], ReadinessLabels(check))
	if healthcheck := r.healthcheck(check); healthcheck != nil {
		body["Healthcheck"] = healthcheck
	}
	name := workload.NamePrefix + "-" + randomSuffix()
	r.progress.line("Creating container...")
	var id string
	if err := tracing.Stage(ctx, "create container", func(ctx context.Context) error {
		id, err = r.docker.CreateContainerFrom(ctx, name, body)
		return err
	}, attribute.String("homerun.container.name", name), attribute.String("homerun.deploy.image", image.ref())); err != nil {
		return "", err
	}
	r.progress.line("Starting container...")
	if err := tracing.Stage(ctx, "start container", func(ctx context.Context) error {
		return r.docker.StartContainer(ctx, id)
	}, attribute.String("homerun.container.id", id)); err != nil {
		if plan.BlueGreen {
			r.removeQuietly(ctx, id)
		}
		return "", err
	}
	log.Printf("[homerun-worker] container created and started: %s (%s)", name, id)

	r.joinStackNetwork(ctx, id)
	if plan.BlueGreen {
		if err := tracing.Stage(ctx, "wait until ready", func(ctx context.Context) error {
			return r.awaitReadyOrDiscard(ctx, id, check)
		}, attribute.String("homerun.deploy.readiness", check.Kind), attribute.String("homerun.container.id", id)); err != nil {
			if !RetryStopFirst(Routed(workload.Template), r.spec.Volumes) {
				return "", err
			}
			r.progress.line(fmt.Sprintf("The new container failed next to the old one (%s). It may not share its writable volume with a running copy, so trying again with the old container stopped first...", err))
			return r.startContainer(ctx, image, true)
		}
		r.removePrevious(ctx, previous)
	}
	r.reportReachability()
	return id, nil
}

// ensureBridge creates the named bridge network if it doesn't already exist.
func (r *run) ensureBridge(ctx context.Context, name string) error {
	_, err := r.docker.EnsureNetwork(ctx, map[string]any{
		"CheckDuplicate": true,
		"Driver":         "bridge",
		"Labels":         map[string]string{managedLabel: "true"},
		"Name":           name,
	})
	return err
}

// joinStackNetwork attaches the container to its stack's network under the
// service's slug, best effort: a failure is degraded connectivity, not a
// failed deploy.
func (r *run) joinStackNetwork(ctx context.Context, id string) {
	workload := r.spec.Workload
	if workload.StackNetwork == "" || workload.HostNetwork {
		return
	}
	err := r.ensureBridge(ctx, workload.StackNetwork)
	if err == nil {
		err = r.docker.ConnectNetwork(ctx, workload.StackNetwork, id, []string{workload.Slug})
	}
	if err != nil {
		log.Printf("[homerun-worker] couldn't join stack network %s: service=%s : %s", workload.StackNetwork, r.spec.ServiceID, err)
	}
}

// reportReachability logs how other services (or, on host networking, this
// machine) can reach the deployed workload.
func (r *run) reportReachability() {
	workload := r.spec.Workload
	if workload.HostNetwork {
		r.progress.line(fmt.Sprintf(
			"Running on the host network : reachable directly on this machine's own port %d, not through Traefik.",
			workload.ContainerPort))
		return
	}
	r.progress.line(fmt.Sprintf("Reachable at %s:%d from other services.", workload.Slug, workload.ContainerPort))
}

// removePrevious stops and removes the service's previous containers,
// skipping any that are already gone or won't go.
func (r *run) removePrevious(ctx context.Context, previous []dockerapi.ContainerSummary) {
	if len(previous) == 0 {
		return
	}
	r.progress.line("Removing the previous container...")
	_ = tracing.Stage(ctx, "remove previous container", func(ctx context.Context) error {
		var wait sync.WaitGroup
		for _, container := range previous {
			wait.Go(func() {
				if container.State == "running" {
					_ = r.docker.StopContainer(ctx, container.ID)
				}
				_ = r.docker.RemoveContainer(ctx, container.ID)
			})
		}
		wait.Wait()
		return nil
	}, attribute.Int("homerun.deploy.previous_containers", len(previous)))
}

// removeQuietly removes container id on its own timeout, ignoring any error.
func (r *run) removeQuietly(ctx context.Context, id string) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	_ = r.docker.RemoveContainer(cleanup, id)
}

// awaitReadyOrDiscard polls the new container until it's ready or has failed.
// On failure it logs the container's last output and removes it, so the
// previous container keeps serving.
func (r *run) awaitReadyOrDiscard(ctx context.Context, id string, check Readiness) error {
	started := time.Now()
	current := Verdict{State: "pending"}
	for current.State == "pending" {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(rolloutPoll):
		}
		info, err := r.docker.InspectContainer(ctx, id)
		if err != nil && !errors.Is(err, dockerapi.ErrNotFound) {
			return err
		}
		current = ReadinessVerdict(SampleFromInspect(info), time.Since(started), rolloutSettle, rolloutMaxWait)
	}
	if current.State == "ready" {
		r.progress.line(ReadyLine(check, int(time.Since(started).Round(time.Second).Seconds())))
		return nil
	}
	if output, err := r.docker.ContainerLogsTail(ctx, id, 20); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
			if line != "" {
				r.progress.line("  " + line)
			}
		}
	}
	r.removeQuietly(ctx, id)
	return &kindError{kind: FailureRolloutFailed, err: errors.New(current.Reason + " The previous container keeps serving.")}
}
