package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/orochibraru/homerun/internal/activity"
	"github.com/orochibraru/homerun/internal/agent"
	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/tracing"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

const (
	remoteSocket     = "/var/run/docker.sock"
	agentBuildLimit  = 15 * time.Minute
	agentSaveTimeout = 60 * time.Minute
)

var authFailure = regexp.MustCompile(`(?i)could not read (Username|Password)|Authentication failed|terminal prompts disabled`)

// buildImage runs a git build (locally, on a Docker build server or on an
// agent), brings the image onto this host when it was built elsewhere, scans
// it and records it as the service's image. Mirrors #resolveImage's git branch
// in deploy.service.ts.
func (r *run) buildImage(ctx context.Context) (resolvedImage, error) {
	spec := r.spec.Image
	built := resolvedImage{image: spec.Image, tag: spec.Tag}
	var err error
	var host *dockerapi.Version
	if spec.Kind != "local-build" {
		if host, err = r.docker.ServerVersion(ctx); err != nil {
			return resolvedImage{}, err
		}
		r.platform = host.Os + "/" + host.Arch
	}
	trace.SpanFromContext(ctx).SetAttributes(
		attribute.String("homerun.build.kind", spec.Kind),
		attribute.String("homerun.build.method", buildMethod(spec.Build)),
	)
	var remote *dockerapi.Client
	err = tracing.Stage(ctx, "clone and build", func(ctx context.Context) error {
		switch spec.Kind {
		case "local-build":
			return r.dockerBuild(ctx, r.docker, r.spec.SocketPath, spec.Build.Registry)
		case "docker-build":
			var buildErr error
			if remote, buildErr = dockerapi.NewRemote(*spec.Build.Server.Docker); buildErr != nil {
				return buildErr
			}
			return r.dockerBuild(ctx, remote, remoteSocket, spec.Build.Registry)
		case "agent-build":
			return r.agentBuild(ctx, built)
		}
		return nil
	})
	if err == nil && spec.Kind != "local-build" {
		err = tracing.Stage(ctx, "bring the image here", func(ctx context.Context) error {
			var transferErr error
			built, transferErr = r.transfer(ctx, built, remote)
			return transferErr
		})
	}
	if err == nil && host != nil {
		err = r.checkArchitecture(ctx, built.ref(), host.Arch)
	}
	if err != nil {
		return resolvedImage{}, err
	}
	if err := r.scanTargets(ctx, built.ref(), ""); err != nil {
		return resolvedImage{}, err
	}
	r.result.ServiceImage = &ImageRef{Image: built.image, Tag: built.tag}
	return built, nil
}

// buildInput builds the agent.BuildInput for a git build tagged tag.
func (r *run) buildInput(tag string) agent.BuildInput {
	build := r.spec.Image.Build
	input := agent.BuildInput{
		BakeFile:       build.Git.BakeFile,
		BuildTarget:    build.Git.BuildTarget,
		BuildContext:   build.Git.BuildContext,
		BuildMethod:    build.Git.BuildMethod,
		Credential:     build.Credential,
		DockerfilePath: build.Git.DockerfilePath,
		GitRef:         build.Git.GitRef,
		GitURL:         build.Git.GitURL,
		NoCache:        build.NoCache,
		Tag:            tag,
	}
	if build.Commit != "" {
		input.Commit = &build.Commit
	}
	if r.platform != "" {
		input.Platform = &r.platform
	}
	return input
}

// recordCommit stamps the deploy result with the commit and ref that were built.
func (r *run) recordCommit(commit string) {
	r.result.Built = true
	r.result.GitCommit = commit
	if ref := r.spec.Image.Build.Git.GitRef; ref != nil {
		r.result.GitRef = *ref
	}
}

// dockerBuild clones and builds on docker (this host's daemon or a build
// server's), with the builder bound to that daemon's socket at socket.
func (r *run) dockerBuild(ctx context.Context, docker *dockerapi.Client, socket string, cache *Registry) error {
	input := r.buildInput(r.spec.Image.Image + ":" + r.spec.Image.Tag)
	if cache != nil {
		input.Cache = &agent.CacheRegistry{Password: cache.Password, RegistryURL: cache.RegistryURL, Username: cache.Username}
	}
	result := agent.NewBuilder(docker, socket).BuildWithProgress(ctx, input, r.progress.line)
	if !result.Success {
		message := result.Error
		if message == "" {
			message = "Build failed."
		}
		if authFailure.MatchString(message) && r.spec.Image.Build.AuthHint != "" {
			message = r.spec.Image.Build.AuthHint
		}
		return errors.New(message)
	}
	if result.Commit != nil {
		r.recordCommit(*result.Commit)
	} else {
		r.recordCommit("")
	}
	return nil
}

// agentBuild builds on an agent, which also pushes to the cache registry when
// there is one. The agent answers once, so the log gets one summary line.
func (r *run) agentBuild(ctx context.Context, built resolvedImage) error {
	build := r.spec.Image.Build
	input := r.buildInput(built.ref())
	if build.Registry != nil {
		published := publishedRef(*build.Registry, built)
		input.Push = &agent.PushTarget{
			Password:    build.Registry.Password,
			RegistryURL: build.Registry.RegistryURL,
			Tag:         published.ref(),
			Username:    build.Registry.Username,
		}
	}
	if input.BuildMethod == nil {
		method := "dockerfile"
		input.BuildMethod = &method
	}
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	answer, err := r.agentRequest(ctx, http.MethodPost, "/v1/build", nil, bytes.NewReader(body), agentBuildLimit)
	if err != nil {
		return err
	}
	defer func() { _ = answer.Close() }()
	var result agent.BuildResult
	if err := json.NewDecoder(answer).Decode(&result); err != nil {
		return err
	}
	if !result.Success {
		if result.Error == "" {
			return errors.New("Build failed.")
		}
		return errors.New(result.Error)
	}
	commit := build.Commit
	if result.Commit != nil {
		commit = *result.Commit
	}
	if result.Commit != nil {
		r.progress.line(fmt.Sprintf("Built commit %s on agent %s.", shorten(*result.Commit, 7), build.Server.HostID))
	} else {
		r.progress.line(fmt.Sprintf("Build finished on agent %s.", build.Server.HostID))
	}
	r.recordCommit(commit)
	return nil
}

// agentRequest sends one authenticated call to the build server's agent and
// returns its answer's body, turning a non-2xx answer's {error} into the
// returned error. The caller closes the body.
func (r *run) agentRequest(ctx context.Context, method, path string, query url.Values, body io.Reader, timeout time.Duration) (io.ReadCloser, error) {
	connection := r.spec.Image.Build.Server.Agent
	base, err := url.Parse(connection.AgentURL)
	if err != nil {
		return nil, err
	}
	endpoint := base.ResolveReference(&url.URL{Path: path, RawQuery: query.Encode()})
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+connection.Token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	release := activity.Hold(ctx)
	response, err := (&http.Client{Timeout: timeout}).Do(request)
	release()
	if err != nil {
		return nil, fmt.Errorf("Couldn't reach the agent at %s : %w", connection.AgentURL, err)
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return response.Body, nil
	}
	defer func() { _ = response.Body.Close() }()
	var decoded struct {
		Error string `json:"error"`
	}
	if json.NewDecoder(response.Body).Decode(&decoded) == nil && decoded.Error != "" {
		return nil, errors.New(decoded.Error)
	}
	return nil, fmt.Errorf("Agent returned %d.", response.StatusCode)
}

// checkArchitecture fails a deploy whose image was built for another CPU
// architecture than host, this daemon's, which a build server with a different
// CPU hands back when it ignored the platform it was asked for.
func (r *run) checkArchitecture(ctx context.Context, ref, host string) error {
	image, err := r.docker.InspectImage(ctx, ref)
	if err != nil {
		return err
	}
	if message := ArchitectureMismatch(image.Architecture, host); message != "" {
		return errors.New(message)
	}
	return nil
}

// ArchitectureMismatch is the error for an image built for another CPU
// architecture than the host's, empty when they match or either is unknown.
func ArchitectureMismatch(image, host string) string {
	if image == host || image == "" || host == "" {
		return ""
	}
	return fmt.Sprintf(
		"The build server built this image for %s, but this host runs %s, so its containers can't start here. Update the build server's agent: an older one can't build for another architecture.",
		image, host,
	)
}

// publishedRef is built's ref rewritten to live under registry.
func publishedRef(registry Registry, built resolvedImage) resolvedImage {
	return resolvedImage{image: registry.RegistryURL + "/" + built.image, tag: built.tag}
}

// transfer brings an image built on a build server onto this host. With a
// cache registry a Docker build server pushes it (an agent already did) and
// this host pulls it under its published ref; without one it's streamed
// straight from the build server's daemon into this one. remote is nil for an
// agent. Mirrors transferBuiltImage in deploy/build-transfer-step.ts.
func (r *run) transfer(ctx context.Context, built resolvedImage, remote *dockerapi.Client) (resolvedImage, error) {
	build := r.spec.Image.Build
	ref := built.ref()
	if build.Registry == nil {
		r.progress.line(fmt.Sprintf("Streaming the built image from build server %s to this host...", build.Server.HostID))
		var archive io.ReadCloser
		var err error
		if remote != nil {
			archive, err = remote.SaveImage(ctx, ref)
		} else {
			archive, err = r.agentRequest(ctx, http.MethodGet, "/v1/images/save", url.Values{"ref": {ref}}, nil, agentSaveTimeout)
		}
		if err != nil {
			return resolvedImage{}, err
		}
		defer func() { _ = archive.Close() }()
		if err := r.docker.LoadImage(ctx, archive); err != nil {
			return resolvedImage{}, err
		}
		r.progress.line("Loaded " + ref + " onto this host.")
		return built, nil
	}

	published := publishedRef(*build.Registry, built)
	auth := build.Registry.auth()
	if remote != nil {
		r.progress.line("Publishing built image to " + build.Registry.RegistryURL + "...")
		repository, tag := dockerapi.SplitRef(published.ref())
		if err := remote.TagImage(ctx, ref, repository, tag); err != nil {
			return resolvedImage{}, err
		}
		if err := remote.PushImage(ctx, repository, tag, auth, nil); err != nil {
			return resolvedImage{}, err
		}
	}
	r.progress.line("Pulling published image onto this host...")
	if err := r.pull(ctx, published.ref(), &auth); err != nil {
		return resolvedImage{}, err
	}
	return published, nil
}

// buildMethod is the build's method for a trace attribute, dockerfile when
// the spec leaves it unset.
func buildMethod(build *BuildSpec) string {
	if build == nil || build.Git.BuildMethod == nil || *build.Git.BuildMethod == "" {
		return "dockerfile"
	}
	return *build.Git.BuildMethod
}
