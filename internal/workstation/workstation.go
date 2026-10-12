// Package workstation runs dev workstations: a long-lived browser IDE
// container (code-server by default) with a persistent home volume and,
// optionally, a git repository cloned into it on first start.
//
// The same Manager is mounted on the local worker's Docker control API and on
// agent mode's API, so a workstation runs on this server or on a remote
// agent-mode host through one implementation. On an agent host it's a narrow
// spec rather than an arbitrary container body: an image, its env, a port, CPU
// and memory limits and its own named volume, never a bind mount, a capability
// or privileged mode.
package workstation

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/logging"
)

const (
	// IDLabel carries the workstation id on its container and volume.
	IDLabel = "homerun.workstation.id"
	scope   = "workstation"
)

// The states Status reports. Pulling, Cloning and Starting only exist while an
// Up is in flight on this process.
const (
	StateCloning  = "cloning"
	StateFailed   = "failed"
	StateMissing  = "missing"
	StatePulling  = "pulling"
	StateRunning  = "running"
	StateStarting = "starting"
	StateStopped  = "stopped"
)

var (
	idPattern        = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
	namePattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)
	directoryPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
)

// ErrBusy is returned when an Up for the same workstation is already running.
var ErrBusy = errors.New("this workstation is already starting")

// Git is the repository cloned into the home volume the first time the
// workstation starts. Username and Token, when set, authenticate the clone only:
// the remote left behind points at the plain URL.
type Git struct {
	Branch    string `json:"branch"`
	Directory string `json:"directory"`
	Token     string `json:"token"`
	URL       string `json:"url"`
	Username  string `json:"username"`
}

// Spec is everything the app decided about one workstation's container.
// Network joins a Docker network (this server, where Traefik reaches it by
// labels); Publish binds the port on the host instead (an agent host, which the
// main server's Traefik reaches over the network).
type Spec struct {
	Env         map[string]string `json:"env"`
	Git         *Git              `json:"git"`
	HomePath    string            `json:"homePath"`
	Image       string            `json:"image"`
	Labels      map[string]string `json:"labels"`
	MemoryBytes int64             `json:"memoryBytes"`
	Name        string            `json:"name"`
	NanoCPUs    int64             `json:"nanoCpus"`
	Network     string            `json:"network"`
	Port        int               `json:"port"`
	Publish     bool              `json:"publish"`
}

// Status is what the daemon and any in-flight start say about a workstation.
type Status struct {
	ContainerID string `json:"containerId,omitempty"`
	Error       string `json:"error,omitempty"`
	HostPort    int    `json:"hostPort"`
	State       string `json:"state"`
}

type operation struct {
	cancel context.CancelFunc
	done   bool
	err    string
	state  string
}

// Manager starts, stops and removes workstations on one daemon, and remembers
// the progress of each start it's running.
type Manager struct {
	docker *dockerapi.Client
	mu     sync.Mutex
	ops    map[string]*operation
}

// NewManager builds a Manager over one daemon.
func NewManager(docker *dockerapi.Client) *Manager {
	return &Manager{docker: docker, ops: map[string]*operation{}}
}

// VolumeName is the home volume of workstation id.
func VolumeName(id string) string {
	return "homerun-workstation-" + id
}

// ValidID reports whether id is safe to use in a label filter and a volume name.
func ValidID(id string) bool {
	return idPattern.MatchString(id)
}

// Validate lists what's wrong with spec, one message per problem.
func Validate(spec Spec) []string {
	problems := []string{}
	if strings.TrimSpace(spec.Image) == "" {
		problems = append(problems, "image is required")
	}
	if !namePattern.MatchString(spec.Name) {
		problems = append(problems, "name must be a lowercase container name")
	}
	if spec.Port < 1 || spec.Port > 65535 {
		problems = append(problems, "port must be between 1 and 65535")
	}
	if !strings.HasPrefix(spec.HomePath, "/") || strings.Contains(spec.HomePath, ":") {
		problems = append(problems, "homePath must be an absolute path")
	}
	if spec.NanoCPUs < 0 || spec.MemoryBytes < 0 {
		problems = append(problems, "resource limits can't be negative")
	}
	if spec.Git != nil {
		parsed, err := url.Parse(spec.Git.URL)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
			problems = append(problems, "git.url must be an http(s) URL")
		}
		if !directoryPattern.MatchString(spec.Git.Directory) || spec.Git.Directory == "." || spec.Git.Directory == ".." {
			problems = append(problems, "git.directory must be a plain directory name")
		}
		if strings.HasPrefix(spec.Git.Branch, "-") {
			problems = append(problems, "git.branch can't start with a dash")
		}
	}
	return problems
}

// Up starts (or recreates) workstation id from spec in the background, and
// answers as soon as the start is under way. A start already running for the
// same id is ErrBusy.
func (m *Manager) Up(id string, spec Spec) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if current, ok := m.ops[id]; ok && !current.done {
		return ErrBusy
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	op := &operation{cancel: cancel, state: StatePulling}
	m.ops[id] = op
	go func() {
		defer cancel()
		err := m.up(ctx, id, spec, op)
		m.mu.Lock()
		defer m.mu.Unlock()
		op.done = true
		if err != nil {
			op.err = redact(err.Error(), spec.Git)
			op.state = StateFailed
			logging.Warnf(scope, "workstation %s failed to start: %s", id, op.err)
			return
		}
		op.state = StateRunning
		logging.Infof(scope, "workstation %s is up", id)
	}()
	return nil
}

// setState records an in-flight start's progress.
func (m *Manager) setState(op *operation, state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	op.state = state
}

// up pulls the image, ensures the home volume, recreates the container,
// starts it, then clones the repository into it when one is set and isn't
// there yet.
func (m *Manager) up(ctx context.Context, id string, spec Spec, op *operation) error {
	if err := m.docker.EnsureImage(ctx, spec.Image); err != nil {
		return fmt.Errorf("couldn't pull %s: %w", spec.Image, err)
	}
	m.setState(op, StateStarting)
	volume := VolumeName(id)
	exists, err := m.docker.VolumeExists(ctx, volume)
	if err != nil {
		return err
	}
	if !exists {
		if err := m.docker.CreateVolume(ctx, volume, map[string]string{dockerapi.ManagedLabel: "true", IDLabel: id}); err != nil {
			return fmt.Errorf("couldn't create the home volume: %w", err)
		}
	}
	if err := m.removeContainers(ctx, id); err != nil {
		return err
	}
	containerID, err := m.docker.CreateContainerFrom(ctx, spec.Name, CreateBody(id, spec))
	if err != nil {
		return fmt.Errorf("couldn't create the container: %w", err)
	}
	if err := m.docker.StartContainer(ctx, containerID); err != nil {
		return fmt.Errorf("couldn't start the container: %w", err)
	}
	if spec.Git == nil {
		return nil
	}
	m.setState(op, StateCloning)
	result, err := m.docker.ContainerExec(ctx, containerID, CloneCommand(spec))
	if err != nil {
		return fmt.Errorf("couldn't clone the repository: %w", err)
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("couldn't clone the repository (exit %d): %s", result.ExitCode, strings.TrimSpace(result.Stderr))
	}
	return nil
}

// CreateBody is the Engine create body for workstation id.
func CreateBody(id string, spec Spec) map[string]any {
	env := make([]string, 0, len(spec.Env))
	for key, value := range spec.Env {
		env = append(env, key+"="+value)
	}
	labels := make(map[string]string, len(spec.Labels)+2)
	for key, value := range spec.Labels {
		labels[key] = value
	}
	labels[dockerapi.ManagedLabel] = "true"
	labels[IDLabel] = id
	port := strconv.Itoa(spec.Port) + "/tcp"
	hostConfig := map[string]any{
		"Binds":         []string{VolumeName(id) + ":" + spec.HomePath},
		"RestartPolicy": map[string]any{"Name": "unless-stopped"},
	}
	if spec.NanoCPUs > 0 {
		hostConfig["NanoCpus"] = spec.NanoCPUs
	}
	if spec.MemoryBytes > 0 {
		hostConfig["Memory"] = spec.MemoryBytes
	}
	if spec.Network != "" {
		hostConfig["NetworkMode"] = spec.Network
	}
	if spec.Publish {
		hostConfig["PortBindings"] = map[string]any{port: []map[string]string{{"HostPort": ""}}}
	}
	return map[string]any{
		"Env":          env,
		"ExposedPorts": map[string]any{port: map[string]any{}},
		"HostConfig":   hostConfig,
		"Image":        spec.Image,
		"Labels":       labels,
	}
}

const cloneScript = `set -e
target="$1/$2"
if [ -e "$target/.git" ]; then exit 0; fi
if [ -n "$4" ]; then git clone --branch "$4" -- "$3" "$target"; else git clone -- "$3" "$target"; fi
git -C "$target" remote set-url origin "$5"`

// CloneCommand is the exec that clones spec's repository into the home
// volume, as the container's own user so the checkout belongs to it, and only
// when it isn't already there. Every value travels as a positional argument,
// never interpolated into the script.
func CloneCommand(spec Spec) []string {
	return []string{
		"sh", "-c", cloneScript, "clone",
		strings.TrimRight(spec.HomePath, "/"), spec.Git.Directory, authenticatedURL(spec.Git), spec.Git.Branch, spec.Git.URL,
	}
}

// authenticatedURL puts the clone credential into an http(s) URL that doesn't
// already carry one.
func authenticatedURL(git *Git) string {
	if git.Token == "" {
		return git.URL
	}
	parsed, err := url.Parse(git.URL)
	if err != nil || parsed.User != nil {
		return git.URL
	}
	username := git.Username
	if username == "" {
		username = "oauth2"
	}
	parsed.User = url.UserPassword(username, git.Token)
	return parsed.String()
}

// redact strips the clone token from a message before it's stored or logged.
func redact(message string, git *Git) string {
	if git == nil || git.Token == "" {
		return message
	}
	return strings.ReplaceAll(message, git.Token, "***")
}

// removeContainers force-removes every container of workstation id.
func (m *Manager) removeContainers(ctx context.Context, id string) error {
	containers, err := m.docker.ListContainersByLabel(ctx, IDLabel+"="+id)
	if err != nil {
		return err
	}
	for _, container := range containers {
		if err := m.docker.RemoveContainerOpts(ctx, container.ID, true); err != nil {
			return fmt.Errorf("couldn't remove the old container: %w", err)
		}
	}
	return nil
}

// forget cancels and drops any start of workstation id.
func (m *Manager) forget(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if op, ok := m.ops[id]; ok {
		op.cancel()
		delete(m.ops, id)
	}
}

// Stop cancels any start in flight and stops the container, keeping it and
// its volume.
func (m *Manager) Stop(ctx context.Context, id string) error {
	m.forget(id)
	containers, err := m.docker.ListContainersByLabel(ctx, IDLabel+"="+id)
	if err != nil {
		return err
	}
	for _, container := range containers {
		if err := m.docker.StopContainer(ctx, container.ID); err != nil && !errors.Is(err, dockerapi.ErrNotFound) {
			return err
		}
	}
	return nil
}

// Remove cancels any start in flight and removes the container, and its home
// volume too when withVolume is set.
func (m *Manager) Remove(ctx context.Context, id string, withVolume bool) error {
	m.forget(id)
	if err := m.removeContainers(ctx, id); err != nil {
		return err
	}
	if withVolume {
		return m.docker.RemoveVolume(ctx, VolumeName(id))
	}
	return nil
}

// Status reports an in-flight or failed start first, then the container
// itself: missing, stopped, failed (exited non-zero) or running with the host
// port it's published on (0 when it isn't).
func (m *Manager) Status(ctx context.Context, id string, port int) (Status, error) {
	m.mu.Lock()
	if op, ok := m.ops[id]; ok {
		if !op.done || op.err != "" {
			status := Status{Error: op.err, State: op.state}
			m.mu.Unlock()
			return status, nil
		}
		delete(m.ops, id)
	}
	m.mu.Unlock()
	containers, err := m.docker.ListContainersByLabel(ctx, IDLabel+"="+id)
	if err != nil {
		return Status{}, err
	}
	if len(containers) == 0 {
		return Status{State: StateMissing}, nil
	}
	container := containers[0]
	inspected, err := m.docker.InspectContainer(ctx, container.ID)
	if errors.Is(err, dockerapi.ErrNotFound) {
		return Status{State: StateMissing}, nil
	}
	if err != nil {
		return Status{}, err
	}
	status := Status{ContainerID: container.ID}
	switch {
	case inspected.State.Running:
		status.State = StateRunning
	case inspected.State.Status == "created" || inspected.State.Status == "restarting":
		status.State = StateStarting
	case inspected.State.ExitCode != 0:
		status.State = StateFailed
		status.Error = fmt.Sprintf("The container exited with code %d.", inspected.State.ExitCode)
	default:
		status.State = StateStopped
	}
	if status.State == StateRunning && port > 0 {
		hostPort, err := m.docker.PublishedPort(ctx, container.ID, strconv.Itoa(port)+"/tcp")
		if err != nil {
			return Status{}, err
		}
		status.HostPort = hostPort
	}
	return status, nil
}
