package deploy

import (
	"context"
	"errors"
	"fmt"
	"github.com/orochibraru/homerun/internal/tracing"
	"go.opentelemetry.io/otel/attribute"
	"log"
	"maps"
	"strings"
	"time"
)

// startSwarm creates or updates the swarm service backing the Homerun
// service: an existing
// one is rolled onto the new spec in place, health-gated, anything else is
// created.
func (r *run) startSwarm(ctx context.Context, image resolvedImage) (string, error) {
	workload := r.spec.Workload
	env, err := r.workloadEnv(ctx)
	if err != nil {
		return "", err
	}
	if _, err := r.docker.EnsureNetwork(ctx, map[string]any{
		"Attachable": true,
		"Driver":     "overlay",
		"Name":       workload.Overlay,
	}); err != nil {
		return "", err
	}
	if PublishesThroughIngress(workload.Template) {
		r.ensureIngress(ctx)
	}
	existing, err := r.docker.SwarmServicesByLabel(ctx, serviceIDLabel+"="+r.spec.ServiceID)
	if err != nil {
		return "", err
	}
	if err := tracing.Stage(ctx, "pull on the swarm manager", func(ctx context.Context) error {
		return r.pull(ctx, image.ref(), r.spec.Image.Auth)
	}, attribute.String("homerun.deploy.image", image.ref())); err != nil {
		log.Printf("[homerun-worker] pull before service create failed for %s: %s", image.ref(), err)
	}
	if workload.Privileged {
		r.progress.line("Swarm services can't run privileged or map devices : those settings are ignored under swarm mode.")
	}
	r.multiNodeWarnings(ctx, image)
	check := r.planReadiness(ctx, image.ref(), "task")

	spec := maps.Clone(workload.Template)
	task, _ := spec["TaskTemplate"].(map[string]any)
	task = maps.Clone(task)
	containerSpec, _ := task["ContainerSpec"].(map[string]any)
	containerSpec = maps.Clone(containerSpec)
	if containerSpec == nil {
		containerSpec = map[string]any{}
	}
	containerSpec["Env"] = env
	containerSpec["Image"] = image.ref()
	containerSpec["Labels"] = withLabels(containerSpec["Labels"], ReadinessLabels(check))
	if healthcheck := r.healthcheck(check); healthcheck != nil {
		containerSpec["Healthcheck"] = healthcheck
	}
	task["ContainerSpec"] = containerSpec
	spec["TaskTemplate"] = task
	spec["Name"] = workload.NamePrefix + "-" + randomSuffix()

	if len(existing) > 0 {
		order := SwarmUpdateOrder(r.spec.Volumes, Routed(spec))
		id, err := r.rollOutSwarm(ctx, existing[0].ID, spec, order)
		var failed *kindError
		if err == nil || order != "start-first" || !RetryStopFirst(Routed(spec), r.spec.Volumes) ||
			!errors.As(err, &failed) || failed.kind != FailureRolloutFailed {
			return id, err
		}
		r.progress.line(fmt.Sprintf("The new task failed next to the old one (%s). It may not share its writable volume with a running copy, so trying again with the old task stopped first...", err))
		return r.rollOutSwarm(ctx, existing[0].ID, spec, "stop-first")
	}
	r.progress.line("Creating swarm service...")
	var id string
	if err := tracing.Stage(ctx, "create swarm service", func(ctx context.Context) error {
		id, err = r.docker.CreateSwarmService(ctx, spec)
		return err
	}); err != nil {
		return "", err
	}
	log.Printf("[homerun-worker] swarm service created: id=%s service=%s", id, r.spec.ServiceID)
	return id, nil
}

// PublishesThroughIngress reports whether a swarm service spec publishes a
// port through the routing mesh, which needs the swarm's ingress network.
func PublishesThroughIngress(spec map[string]any) bool {
	endpoint, _ := spec["EndpointSpec"].(map[string]any)
	ports, _ := endpoint["Ports"].([]any)
	for _, raw := range ports {
		port, _ := raw.(map[string]any)
		if mode, _ := port["PublishMode"].(string); mode == "" || mode == "ingress" {
			return true
		}
	}
	return false
}

// ensureIngress recreates the swarm's ingress network when it's gone, since
// swarm refuses to publish a port without one. A failure is only logged: the
// service update that follows reports the real error.
func (r *run) ensureIngress(ctx context.Context) {
	created, err := r.docker.EnsureNetwork(ctx, map[string]any{
		"Driver":  "overlay",
		"Ingress": true,
		"Name":    "ingress",
	})
	if err != nil {
		log.Printf("[homerun-worker] couldn't ensure the swarm ingress network: service=%s : %s", r.spec.ServiceID, err)
		return
	}
	if created {
		r.progress.line("Recreated the swarm's ingress network, which published ports need.")
	}
}

// multiNodeWarnings says what stops working once the swarm has more than one
// node: a locally built image has no registry another node can pull from, and
// volumes are local to each node.
func (r *run) multiNodeWarnings(ctx context.Context, image resolvedImage) {
	nodes, err := r.docker.CountSwarmNodes(ctx)
	if err != nil || nodes < 2 {
		return
	}
	if strings.HasPrefix(image.image, "homerun-build-") {
		r.progress.line("This image was built on this host and never pushed to a registry : replicas placed on another swarm node can't pull it. Set a build cache registry on the Source tab.")
	}
	if len(r.spec.Volumes) > 0 {
		r.progress.line("Volumes are local to each swarm node : a replica placed on another node gets its own empty copy.")
	}
}

// rollOutSwarm updates an existing swarm service to spec in place (keeping its
// name, forcing new tasks) and waits for swarm to finish.
func (r *run) rollOutSwarm(ctx context.Context, id string, spec map[string]any, order string) (string, error) {
	inspected, err := r.docker.InspectSwarmService(ctx, id)
	if err != nil {
		return "", err
	}
	current, err := r.docker.ListSwarmTasks(ctx, id, true)
	if err != nil {
		return "", err
	}
	failureAction := SwarmFailureAction(current)
	if failureAction == "pause" {
		r.progress.line("None of the current tasks is running, so a failed update keeps the new tasks instead of rolling back to the broken ones.")
	}
	if order == "start-first" {
		r.progress.line("Updating the swarm service : each new task starts first, and swarm stops the old one once the new one is running (healthy, when it has a healthcheck)...")
	} else {
		r.progress.line("Updating the swarm service : each old task stops before its replacement starts, since a writable volume can't be shared...")
	}
	task, _ := spec["TaskTemplate"].(map[string]any)
	task = maps.Clone(task)
	task["ForceUpdate"] = inspected.Spec.TaskTemplate.ForceUpdate + 1
	update := maps.Clone(spec)
	update["Name"] = inspected.Spec.Name
	update["TaskTemplate"] = task
	update["RollbackConfig"] = map[string]any{"Order": order, "Parallelism": 1}
	update["UpdateConfig"] = map[string]any{
		"FailureAction":   failureAction,
		"MaxFailureRatio": 0,
		"Monitor":         swarmUpdateMonitorN,
		"Order":           order,
		"Parallelism":     1,
	}
	previousStartedAt := ""
	if inspected.UpdateStatus != nil {
		previousStartedAt = inspected.UpdateStatus.StartedAt
	}
	if err := tracing.Stage(ctx, "update swarm service", func(ctx context.Context) error {
		return r.docker.UpdateSwarmService(ctx, id, inspected.Version.Index, update)
	}, attribute.String("homerun.swarm.service_id", id), attribute.String("homerun.swarm.update_order", order)); err != nil {
		return "", err
	}
	if err := tracing.Stage(ctx, "wait for the rollout", func(ctx context.Context) error {
		return r.awaitSwarmUpdate(ctx, id, previousStartedAt)
	}, attribute.String("homerun.swarm.service_id", id)); err != nil {
		return "", err
	}
	r.progress.line("Swarm finished rolling out the new tasks; Traefik picks them up on its next swarm poll, within 2 seconds.")
	return id, nil
}

// awaitSwarmUpdate polls the swarm service update until it completes, fails,
// or outlives swarmUpdateMaxWait.
func (r *run) awaitSwarmUpdate(ctx context.Context, id, previousStartedAt string) error {
	started := time.Now()
	for {
		if time.Since(started) > swarmUpdateMaxWait {
			return &kindError{kind: FailureRolloutFailed, err: fmt.Errorf(
				"Swarm didn't finish updating the service within %d minutes.", int(swarmUpdateMaxWait.Minutes()))}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(rolloutPoll):
		}
		inspected, err := r.docker.InspectSwarmService(ctx, id)
		if err != nil {
			return err
		}
		switch outcome := SwarmUpdateOutcome(inspected, previousStartedAt); outcome.State {
		case "completed":
			return nil
		case "failed":
			reason := outcome.Reason
			if tasks, err := r.docker.ListSwarmTasks(ctx, id, false); err == nil {
				if taskErr := LastTaskError(tasks); taskErr != "" {
					reason += " Last task error: " + taskErr
				}
			}
			return &kindError{kind: FailureRolloutFailed, err: errors.New(reason)}
		}
	}
}
