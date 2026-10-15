// Package deploy executes deploy jobs for the homerun worker: it resolves the
// image (a registry pull, a rollback's revision image or a git build), gates it
// on the image scan, then starts the workload as a standalone container or a
// swarm service. Everything that needs the database or a business rule was
// resolved by the app's prepare step into the Spec; progress goes straight to
// the deployment's own log, which the Overview's progress panel polls.
package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/orochibraru/homerun/internal/agent"
	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/jobs"
	"github.com/orochibraru/homerun/internal/jobs/imagescan"
	"github.com/orochibraru/homerun/internal/tracing"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Spec is what the app's prepare step resolves for one deploy.
type Spec struct {
	DeploymentID string         `json:"deploymentId"`
	Env          [][2]string    `json:"env"`
	EnvFiles     []string       `json:"envFiles"`
	Healthchecks Healthchecks   `json:"healthchecks"`
	Image        ImageSpec      `json:"image"`
	Network      string         `json:"network"`
	Readiness    ReadinessInput `json:"readiness"`
	ReleaseEnv   string         `json:"releaseEnv"`
	Route        *RouteSpec     `json:"route"`
	Seeds        []VolumeSeed   `json:"seeds"`
	ServiceID    string         `json:"serviceId"`
	SocketPath   string         `json:"socketPath"`
	Volumes      []Volume       `json:"volumes"`
	Workload     WorkloadSpec   `json:"workload"`
}

// Healthchecks are the Docker Healthcheck specs a readiness check may attach:
// the service's own command (nil without one) and the generated listening one.
type Healthchecks struct {
	Listening map[string]any `json:"listening"`
	Service   map[string]any `json:"service"`
}

// VolumeSeed is a volume that starts as a copy of another the first time it's
// deployed: a pull request preview's copy of its parent's data.
type VolumeSeed struct {
	From   string `json:"from"`
	Image  string `json:"image"`
	Source string `json:"source"`
	Name   string `json:"name"`
}

// Volume is a mounted volume, as far as the rollout strategy cares.
type Volume struct {
	ReadOnly bool `json:"readOnly"`
}

// ImageSpec says where the deploy's image comes from. Kind is "pull",
// "revision", "local-build", "docker-build" or "agent-build".
type ImageSpec struct {
	Auth       *dockerapi.AuthConfig `json:"auth"`
	Build      *BuildSpec            `json:"build"`
	Image      string                `json:"image"`
	Kind       string                `json:"kind"`
	Mirror     *MirrorSpec           `json:"mirror"`
	PullPolicy string                `json:"pullPolicy"`
	Revision   *Revision             `json:"revision"`
	Scan       *ScanSpec             `json:"scan"`
	Tag        string                `json:"tag"`
}

// Revision is the deployment a rollback reuses the image of, with its image
// ref already split into Image and Tag.
type Revision struct {
	Digest    string `json:"digest"`
	GitCommit string `json:"gitCommit"`
	GitRef    string `json:"gitRef"`
	ID        string `json:"id"`
	Image     string `json:"image"`
	ImageID   string `json:"imageId"`
	ImageRef  string `json:"imageRef"`
	Tag       string `json:"tag"`
}

// BuildSpec is a git build: the source, where it builds and how its image
// reaches this host. Registry is the build cache registry, used for the layer
// cache and, on a build server, to publish the image through.
type BuildSpec struct {
	AuthHint   string               `json:"authHint"`
	BuildArgs  map[string]string    `json:"buildArgs"`
	Commit     string               `json:"commit"`
	Credential *agent.GitCredential `json:"credential"`
	Git        GitSource            `json:"git"`
	NoCache    bool                 `json:"noCache"`
	Registry   *Registry            `json:"registry"`
	Server     *BuildServer         `json:"server"`
}

// GitSource is the repository and build settings of a git build.
type GitSource struct {
	BakeFile       *string `json:"bakeFile"`
	BuildTarget    *string `json:"buildTarget"`
	BuildContext   *string `json:"buildContext"`
	BuildMethod    *string `json:"buildMethod"`
	DockerfilePath *string `json:"dockerfilePath"`
	GitRef         *string `json:"gitRef"`
	GitURL         string  `json:"gitUrl"`
}

// Registry is a build cache registry's credentials.
type Registry struct {
	Password    string `json:"password"`
	RegistryURL string `json:"registryUrl"`
	Username    string `json:"username"`
}

// auth converts Registry to the dockerapi.AuthConfig shape.
func (r Registry) auth() dockerapi.AuthConfig {
	return dockerapi.AuthConfig{Password: r.Password, ServerAddress: dockerapi.RegistryHost(r.RegistryURL), Username: r.Username}
}

// BuildServer is the remote host a git build runs on: a Docker daemon over TCP
// or a Homerun Agent.
type BuildServer struct {
	Agent  *AgentConnection      `json:"agent"`
	Docker *dockerapi.RemoteHost `json:"docker"`
	HostID string                `json:"hostId"`
}

// AgentConnection is a registered agent's address and bearer token.
type AgentConnection struct {
	AgentURL string `json:"agentUrl"`
	Token    string `json:"token"`
}

// WorkloadSpec is the container or swarm service to start. Template is the
// Engine API create body (a container) or service spec (swarm) with everything
// but the image, environment, healthcheck, readiness label and name filled in.
type WorkloadSpec struct {
	ContainerPort  int            `json:"containerPort"`
	HostNetwork    bool           `json:"hostNetwork"`
	Kind           string         `json:"kind"`
	NamePrefix     string         `json:"namePrefix"`
	Overlay        string         `json:"overlay"`
	Privileged     bool           `json:"privileged"`
	PublishesPorts bool           `json:"publishesPorts"`
	Slug           string         `json:"slug"`
	StackNetwork   string         `json:"stackNetwork"`
	Template       map[string]any `json:"template"`
}

// Result is what a deploy reports back to the app's finalize step. Built is
// set once a git build succeeded, GitCommit then being the commit it built
// (empty when git didn't say).
type Result struct {
	Built          bool         `json:"built,omitempty"`
	ContainerID    string       `json:"containerId,omitempty"`
	Digest         string       `json:"digest,omitempty"`
	Failure        string       `json:"failure,omitempty"`
	GitCommit      string       `json:"gitCommit,omitempty"`
	GitRef         string       `json:"gitRef,omitempty"`
	Image          string       `json:"image,omitempty"`
	ImageID        string       `json:"imageId,omitempty"`
	Scans          []ScanRecord `json:"scans"`
	ServiceImage   *ImageRef    `json:"serviceImage,omitempty"`
	SwarmServiceID string       `json:"swarmServiceId,omitempty"`
	Tag            string       `json:"tag,omitempty"`
}

// ImageRef is an image name and tag.
type ImageRef struct {
	Image string `json:"image"`
	Tag   string `json:"tag"`
}

// Failure kinds the finalize step treats as "a workload kept running", so
// the service isn't marked failed: the previous one after a scan block or a
// failed rollout, the new one after a failed route check.
const (
	FailureScanBlocked   = "scan-blocked"
	FailureRolloutFailed = "rollout-failed"
	FailureRouteFailed   = "route-failed"
)

type kindError struct {
	kind string
	err  error
}

// Error returns the wrapped error's message.
func (e *kindError) Error() string { return e.err.Error() }

// Unwrap returns the wrapped error.
func (e *kindError) Unwrap() error { return e.err }

type run struct {
	docker *dockerapi.Client
	// platform is this daemon's os/arch, set when a build server has to build
	// for it.
	platform string
	progress progress
	result   Result
	scanner  func(ctx context.Context, target imagescan.Target) (imagescan.Summary, error)
	spec     Spec
}

// Run executes one deploy job. The result comes back even alongside an error,
// so the app still records what happened: a build's commit, the scans, the
// kind of failure.
func Run(ctx context.Context, job jobs.Job) (map[string]any, error) {
	var spec Spec
	if err := job.DecodeSpec(&spec); err != nil {
		return nil, err
	}
	docker := dockerapi.New(job.DockerSocket)
	r := &run{
		docker:   docker,
		progress: progress{job: job, deploymentID: spec.DeploymentID, serviceID: spec.ServiceID},
		result:   Result{Scans: []ScanRecord{}},
		spec:     spec,
		scanner: func(ctx context.Context, target imagescan.Target) (imagescan.Summary, error) {
			return imagescan.Scan(ctx, docker, job.DockerSocket, spec.Network, target)
		},
	}
	trace.SpanFromContext(ctx).SetAttributes(
		attribute.String("homerun.service.id", spec.ServiceID),
		attribute.String("homerun.deployment.id", spec.DeploymentID),
		attribute.String("homerun.deploy.image_source", spec.Image.Kind),
		attribute.String("homerun.deploy.workload", spec.Workload.Kind),
	)
	err := r.deploy(ctx)
	var kinded *kindError
	if errors.As(err, &kinded) {
		r.result.Failure = kinded.kind
	}
	return r.result.asMap(), err
}

// deploy runs the deploy pipeline: build or resolve the image, scan it, start
// the container or swarm service, wait for it to become ready, then check its
// route answers through Traefik.
func (r *run) deploy(ctx context.Context) error {
	var resolved resolvedImage
	if err := tracing.Stage(ctx, ImageStage(r.spec.Image.Kind), func(ctx context.Context) error {
		var err error
		resolved, err = r.resolveImage(ctx)
		return err
	}); err != nil {
		return err
	}
	r.result.Image, r.result.Tag, r.result.Digest = resolved.image, resolved.tag, resolved.digest
	trace.SpanFromContext(ctx).SetAttributes(attribute.String("homerun.deploy.image", resolved.ref()))
	if len(r.spec.Seeds) > 0 {
		if err := tracing.Stage(ctx, "seed volumes", r.seedVolumes); err != nil {
			return err
		}
	}
	r.progress.serviceStatus(ctx, "starting")

	r.progress.line(PhaseContainer)
	if err := tracing.Stage(ctx, "deploy", r.startWorkload(resolved),
		attribute.String("homerun.deploy.workload", r.spec.Workload.Kind),
		attribute.String("homerun.deploy.image", resolved.ref()),
	); err != nil {
		return err
	}

	r.progress.line(PhaseNetwork)
	if inspected, err := r.docker.InspectImage(ctx, resolved.ref()); err == nil {
		r.result.ImageID = inspected.ID
	}
	return tracing.Stage(ctx, "route check", r.checkRoutes)
}

// ImageStage names the trace stage that resolves a deploy's image of kind:
// a pull, a rollback's revision, or a build.
func ImageStage(kind string) string {
	switch kind {
	case "pull":
		return "pull"
	case "revision":
		return "revision"
	default:
		return "build"
	}
}

// startWorkload starts resolved as the spec's swarm service or container,
// recording its id in the result.
func (r *run) startWorkload(resolved resolvedImage) func(context.Context) error {
	return func(ctx context.Context) error {
		if r.spec.Workload.Kind == "swarm" {
			id, err := r.startSwarm(ctx, resolved)
			if err != nil {
				return err
			}
			r.result.SwarmServiceID = id
			return nil
		}
		id, err := r.startContainer(ctx, resolved, false)
		if err != nil {
			return err
		}
		r.result.ContainerID = id
		return nil
	}
}

// seedVolumes fills each seeded volume that doesn't exist yet with a copy of
// its origin, so a preview's first deploy starts from its parent's data and
// later deploys keep what the preview wrote. A failed copy removes the half
// copied volume so the next deploy tries again.
func (r *run) seedVolumes(ctx context.Context) error {
	for _, seed := range r.spec.Seeds {
		exists, err := r.docker.VolumeExists(ctx, seed.Source)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		r.progress.line(fmt.Sprintf("Copying %s into %s for this preview", seed.Name, seed.Source))
		started := time.Now()
		if err := r.docker.CopyVolume(ctx, seed.From, seed.Source, seed.Image); err != nil {
			_ = r.docker.RemoveVolume(context.WithoutCancel(ctx), seed.Source)
			return fmt.Errorf("couldn't copy %s into %s: %w", seed.Name, seed.Source, err)
		}
		r.progress.line(fmt.Sprintf("Copied %s in %s", seed.Name, time.Since(started).Round(time.Second)))
	}
	return nil
}

// asMap round-trips Result through JSON into a map, for the job's stored result.
func (r Result) asMap() map[string]any {
	raw, err := json.Marshal(r)
	if err != nil {
		return nil
	}
	var shaped map[string]any
	if err := json.Unmarshal(raw, &shaped); err != nil {
		return nil
	}
	return shaped
}
