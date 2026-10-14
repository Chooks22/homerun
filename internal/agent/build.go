// Package agent is Homerun's git build engine: clone at a pinned commit, build
// with the chosen method, optionally push. The worker runs it in-process for a
// local build, and a worker in agent mode serves it over HTTP (Server) so a
// remote build host can be asked to build.
package agent

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"github.com/orochibraru/homerun/internal/dockerapi"
)

const (
	// GitImage is the image the git-clone helper container runs.
	GitImage        = "alpine/git:latest"
	workspace       = "/workspace"
	repoDir         = workspace + "/repo"
	managedLabel    = "homerun.managed"
	containerSocket = "/var/run/docker.sock"
	recentLineLimit = 40
	cloneTimeout    = 10 * time.Minute
	builderTimeout  = 60 * time.Minute
	cleanupTimeout  = 30 * time.Second
)

// Docker is the subset of the Engine API the agent drives. An interface so the
// build pipeline can be tested against a fake daemon.
type Docker interface {
	ContainerLogs(ctx context.Context, id string, follow bool) (io.ReadCloser, error)
	CreateContainer(ctx context.Context, config dockerapi.ContainerConfig) (string, error)
	CreateVolume(ctx context.Context, name string, labels map[string]string) error
	ImageExists(ctx context.Context, ref string) (bool, error)
	KillContainer(ctx context.Context, id string) error
	Ping(ctx context.Context) error
	PullImage(ctx context.Context, ref string, auth *dockerapi.AuthConfig, onProgress func(string)) error
	PushImage(ctx context.Context, repository, tag string, auth dockerapi.AuthConfig, onProgress func(string)) error
	RemoveContainer(ctx context.Context, id string) error
	RemoveVolume(ctx context.Context, name string) error
	SaveImage(ctx context.Context, ref string) (io.ReadCloser, error)
	StartContainer(ctx context.Context, id string) error
	TagImage(ctx context.Context, source, repository, tag string) error
	WaitContainer(ctx context.Context, id string) (int, error)
}

// PushTarget is the build cache registry a build publishes its image to, when
// the image has to reach a different daemon than the one that built it.
type PushTarget struct {
	Password    string `json:"password"`
	RegistryURL string `json:"registryUrl"`
	Tag         string `json:"tag"`
	Username    string `json:"username"`
}

// BuildInput is POST /v1/build's body: clone a git repo at a ref and build it
// into a local image tagged Tag. Push, when set, names the service's build
// cache registry: the layer cache is imported from and exported to it, and the
// built image is published to it afterward. It's left out when the build and
// the deploy target are this same agent, since the deploy then references the
// local tag directly. Platform is the os/arch of the daemon the image deploys
// to: when this one's differs, the build runs emulated through QEMU.
type BuildInput struct {
	BakeFile       *string        `json:"bakeFile"`
	BuildTarget    *string        `json:"buildTarget"`
	BuildContext   *string        `json:"buildContext"`
	BuildMethod    *string        `json:"buildMethod"`
	Commit         *string        `json:"commit"`
	Credential     *GitCredential `json:"credential"`
	DockerfilePath *string        `json:"dockerfilePath"`
	GitRef         *string        `json:"gitRef"`
	GitURL         string         `json:"gitUrl"`
	NoCache        bool           `json:"noCache"`
	Platform       *string        `json:"platform"`
	Push           *PushTarget    `json:"push"`
	Tag            string         `json:"tag"`

	Cache *CacheRegistry `json:"-"`
}

// BuildResult is POST /v1/build's answer.
type BuildResult struct {
	Commit  *string `json:"commit"`
	Error   string  `json:"error,omitempty"`
	Success bool    `json:"success"`
}

// Builder runs builds against one daemon.
type Builder struct {
	docker     Docker
	socketPath string
	// NewID mints the per-build volume/container id suffix, RandomID outside
	// tests.
	NewID func() string
}

// NewBuilder builds a Builder for the daemon behind socketPath.
func NewBuilder(docker Docker, socketPath string) *Builder {
	return &Builder{docker: docker, socketPath: socketPath, NewID: RandomID}
}

// RandomID returns a fresh 8-character hex id.
func RandomID() string {
	buffer := make([]byte, 4)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

// valueOr dereferences pointer, or returns fallback when it's nil or empty.
func valueOr(pointer *string, fallback string) string {
	if pointer == nil || *pointer == "" {
		return fallback
	}
	return *pointer
}

// Build clones input's repo at its ref into a throwaway volume, builds it with
// the configured method, and pushes the result when input.Push is set. The
// agent image has no git of its own, so cloning runs in an alpine/git
// container against the volume. Progress goes to this process's own log,
// since the HTTP answer is a single JSON result once it's done.
func (b *Builder) Build(ctx context.Context, input BuildInput) BuildResult {
	return b.BuildWithProgress(ctx, input, func(line string) { log.Printf("[build %s] %s", input.Tag, line) })
}

// BuildWithProgress is Build with every progress line sent to progress. A set
// input.Cache imports and exports the layer cache without pushing the image,
// which is what the homerun worker's own local and Docker-remote builds use.
func (b *Builder) BuildWithProgress(ctx context.Context, input BuildInput, progress func(string)) BuildResult {
	ref := valueOr(input.GitRef, "main")
	volume := "homerun-agent-build-" + b.NewID()
	var commit *string

	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
		defer cancel()
		_ = b.docker.RemoveVolume(cleanup, volume)
	}()

	fail := func(err error) BuildResult {
		return BuildResult{Commit: commit, Error: RedactCloneURL(err.Error()), Success: false}
	}

	if err := b.ensureImage(ctx, GitImage, progress); err != nil {
		return fail(err)
	}
	if err := b.docker.CreateVolume(ctx, volume, map[string]string{managedLabel: "true"}); err != nil {
		return fail(err)
	}

	cloneURL := AuthenticatedCloneURL(input.GitURL, input.Credential)
	progress(fmt.Sprintf("Cloning %s (%s)...", RedactCloneURL(cloneURL), ref))
	built, err := b.checkout(ctx, cloneURL, ref, valueOr(input.Commit, ""), volume, progress)
	if built != "" {
		commit = &built
	}
	if err != nil {
		return fail(err)
	}

	builderInput := BuilderInput{
		BakeFile:       valueOr(input.BakeFile, ""),
		BuildTarget:    valueOr(input.BuildTarget, ""),
		BuildContext:   valueOr(input.BuildContext, ""),
		DockerfilePath: valueOr(input.DockerfilePath, ""),
		Method:         valueOr(input.BuildMethod, "dockerfile"),
		NoCache:        input.NoCache,
		Platform:       valueOr(input.Platform, ""),
		RepoDir:        repoDir,
		Tag:            input.Tag,
	}
	if input.Push != nil {
		builderInput.CacheRegistry = &CacheRegistry{
			Password:    input.Push.Password,
			RegistryURL: input.Push.RegistryURL,
			Username:    input.Push.Username,
		}
	} else if input.Cache != nil {
		builderInput.CacheRegistry = input.Cache
	}
	if err := b.runBuilder(ctx, builderInput, volume, progress); err != nil {
		return fail(err)
	}

	if input.Push != nil {
		progress(fmt.Sprintf("Pushing to %s...", input.Push.Tag))
		if err := b.push(ctx, input.Tag, *input.Push); err != nil {
			return fail(err)
		}
	}
	return BuildResult{Commit: commit, Success: true}
}

// ensureImage pulls ref unless it's already on the daemon.
func (b *Builder) ensureImage(ctx context.Context, ref string, progress func(string)) error {
	exists, err := b.docker.ImageExists(ctx, ref)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	progress(fmt.Sprintf("Pulling %s...", ref))
	return b.docker.PullImage(ctx, ref, nil, nil)
}

// checkout checks ref out into the volume, then pins it to commit when one was
// given and the branch has moved past it: the main app sends the commit whose
// required status checks passed, so the build is that commit or it fails.
// Returns the commit that will be built, empty when git didn't report one.
func (b *Builder) checkout(ctx context.Context, cloneURL, ref, commit, volume string, progress func(string)) (string, error) {
	if err := b.runSteps(ctx, GitCheckoutSteps(cloneURL, ref, repoDir), volume); err != nil {
		return "", err
	}
	head := ""
	if output, code, err := b.RunGit(ctx, []string{"-C", repoDir, "rev-parse", "HEAD"}, volume); err == nil && code == 0 {
		head = ExtractCommitSHA(output)
	}
	pinned := strings.ToLower(commit)
	if pinned != "" && head != pinned {
		progress(fmt.Sprintf(
			"The branch moved since its status checks were read, checking out the checked commit %s...",
			pinned[:7],
		))
		if err := b.runSteps(ctx, [][]string{
			{"-C", repoDir, "fetch", "--depth", "1", "origin", pinned},
			{"-C", repoDir, "checkout", "--detach", pinned},
		}, volume); err != nil {
			return "", err
		}
	}
	built := head
	if pinned != "" {
		built = pinned
	}
	if built != "" {
		progress(fmt.Sprintf("Building commit %s", built[:7]))
	}
	return built, nil
}

// runSteps runs git steps in order, stopping at the first that fails with its
// redacted output.
func (b *Builder) runSteps(ctx context.Context, steps [][]string, volume string) error {
	for _, step := range steps {
		output, code, err := b.RunGit(ctx, step, volume)
		if err != nil {
			return err
		}
		if code != 0 {
			if strings.TrimSpace(output) == "" {
				output = fmt.Sprintf("git exited %d", code)
			}
			return errors.New(RedactCloneURL(output))
		}
	}
	return nil
}

// RunGit runs one git command in a throwaway container with the volume mounted
// at the workspace, bounded by the clone timeout, and always removes it.
func (b *Builder) RunGit(ctx context.Context, cmd []string, volume string) (string, int, error) {
	return b.runGit(ctx, cmd, volume, false)
}

// runGit runs one git command in an alpine/git container against volume. With
// stdoutOnly, stderr is dropped from the output, for a command whose output is
// data rather than a message.
func (b *Builder) runGit(ctx context.Context, cmd []string, volume string, stdoutOnly bool) (string, int, error) {
	ctx, cancel := context.WithTimeout(ctx, cloneTimeout)
	defer cancel()
	id, err := b.docker.CreateContainer(ctx, dockerapi.ContainerConfig{
		Binds:      []string{volume + ":" + workspace},
		Cmd:        cmd,
		Entrypoint: []string{"git"},
		Env:        []string{"GIT_TERMINAL_PROMPT=0"},
		Image:      GitImage,
		Labels:     dockerapi.HelperLabels(nil),
	})
	if err != nil {
		return "", 0, err
	}
	defer b.remove(id)
	if err := b.docker.StartContainer(ctx, id); err != nil {
		return "", 0, err
	}
	code, err := b.docker.WaitContainer(ctx, id)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", 0, errors.New("The clone timed out.")
		}
		return "", 0, err
	}
	logs, err := b.docker.ContainerLogs(ctx, id, false)
	if err != nil {
		return "", code, err
	}
	defer func() { _ = logs.Close() }()
	var output strings.Builder
	if stdoutOnly {
		err = dockerapi.DemuxSplit(logs, &output, io.Discard)
	} else {
		err = dockerapi.Demux(logs, &output)
	}
	if err != nil {
		return "", code, err
	}
	return output.String(), code, nil
}

// runBuilder runs the build (BuildKit build or bake, Nixpacks, Railpack or
// pack) in a throwaway docker:cli container with the clone's volume, the
// persistent tools volume and the daemon socket mounted, so the image is tagged
// straight into this daemon. Output is forwarded line by line, and a failure
// carries its most telling line.
func (b *Builder) runBuilder(ctx context.Context, input BuilderInput, volume string, progress func(string)) error {
	env, err := BuilderEnv(input)
	if err != nil {
		return err
	}
	if err := b.ensureImage(ctx, Tools.HelperImage, progress); err != nil {
		return err
	}
	progress(fmt.Sprintf("Building with %s...", input.Method))

	ctx, cancel := context.WithTimeout(ctx, builderTimeout)
	defer cancel()
	id, err := b.docker.CreateContainer(ctx, dockerapi.ContainerConfig{
		Binds: []string{
			volume + ":" + workspace,
			Tools.ToolsVolume + ":/tools",
			b.socketPath + ":" + containerSocket,
		},
		Cmd:        []string{"-c", BuilderScript},
		Entrypoint: []string{"sh"},
		Env:        env,
		Image:      Tools.HelperImage,
		Labels:     dockerapi.HelperLabels(nil),
	})
	if err != nil {
		return err
	}
	defer b.remove(id)
	if err := b.docker.StartContainer(ctx, id); err != nil {
		return err
	}

	recent := []string{}
	streamed := make(chan error, 1)
	go func() {
		logs, err := b.docker.ContainerLogs(ctx, id, true)
		if err != nil {
			streamed <- err
			return
		}
		defer func() { _ = logs.Close() }()
		reader, writer := io.Pipe()
		go func() { _ = writer.CloseWithError(dockerapi.Demux(logs, writer)) }()
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
		scanner.Split(ScanLinesAnyEnding)
		for scanner.Scan() {
			line := strings.TrimRight(scanner.Text(), " \t")
			if strings.TrimSpace(line) == "" {
				continue
			}
			recent = append(recent, line)
			if len(recent) > recentLineLimit {
				recent = recent[1:]
			}
			progress(line)
		}
		streamed <- scanner.Err()
	}()

	code, err := b.docker.WaitContainer(ctx, id)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			kill, cancelKill := context.WithTimeout(context.Background(), cleanupTimeout)
			defer cancelKill()
			_ = b.docker.KillContainer(kill, id)
			return fmt.Errorf("The %s build timed out.", input.Method)
		}
		return err
	}
	<-streamed
	if code != 0 {
		return errors.New(BuildFailureMessage(input.Method, code, recent))
	}
	return nil
}

// ScanLinesAnyEnding splits on \n, \r\n or a bare \r, since BuildKit's plain
// progress output uses carriage returns to redraw a line.
func ScanLinesAnyEnding(data []byte, atEOF bool) (int, []byte, error) {
	for index, char := range data {
		if char == '\n' {
			return index + 1, data[:index], nil
		}
		if char == '\r' {
			if index+1 < len(data) && data[index+1] == '\n' {
				return index + 2, data[:index], nil
			}
			if index+1 < len(data) || atEOF {
				return index + 1, data[:index], nil
			}
			return 0, nil, nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// push tags the local image as the push target and pushes it with the cache
// registry's credentials.
func (b *Builder) push(ctx context.Context, localTag string, target PushTarget) error {
	repository, tag := dockerapi.SplitRef(target.Tag)
	if err := b.docker.TagImage(ctx, localTag, repository, tag); err != nil {
		return err
	}
	return b.docker.PushImage(ctx, repository, tag, dockerapi.AuthConfig{
		Password:      target.Password,
		ServerAddress: dockerapi.RegistryHost(target.RegistryURL),
		Username:      target.Username,
	}, nil)
}

// remove force-removes a helper container, best effort, outside the request's
// own context so a cancelled request still cleans up after itself.
func (b *Builder) remove(id string) {
	cleanup, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancel()
	_ = b.docker.RemoveContainer(cleanup, id)
}
