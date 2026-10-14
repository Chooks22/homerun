// Package workstation runs dev workstations: a long-lived browser IDE
// container (code-server by default, openvscode-server too) with a persistent home volume and,
// optionally, a git repository cloned into it on first start.
//
// The same Manager is mounted on the local worker's Docker control API (through
// a Hub, which also drives raw remote Docker daemons) and on agent mode's API,
// so a workstation runs on this server, on a remote Docker daemon or on a
// remote agent-mode host through one implementation. On an agent host it's a narrow
// spec rather than an arbitrary container body: an image, its env, a port, CPU
// and memory limits and its own named volume, never a bind mount, a capability
// or privileged mode.
package workstation

import (
	"context"
	"errors"
	"fmt"
	"io"
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

// The states Status reports. Pulling, Starting, Cloning and Configuring only exist while an
// Up is in flight on this process.
const (
	StateCloning     = "cloning"
	StateConfiguring = "configuring"
	StateFailed      = "failed"
	StateMissing     = "missing"
	StatePulling     = "pulling"
	StateRunning     = "running"
	StateStarting    = "starting"
	StateStopped     = "stopped"
)

var (
	idPattern        = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
	namePattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)
	directoryPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
	extensionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9._-]*$`)
	hostPattern      = regexp.MustCompile(`^[A-Za-z0-9.-]+(:[0-9]{1,5})?$`)
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

// Credential is a git provider login stored in the home volume's git
// credential store, so pushes and pulls from the IDE authenticate as the owner.
type Credential struct {
	Host     string `json:"host"`
	Token    string `json:"token"`
	Username string `json:"username"`
}

// Setup is the per-user IDE configuration applied on every start: the git
// identity and credential, code-server's user settings (left alone when
// empty) and the extensions it installs. Extensions a previous start
// installed and that aren't listed any more are uninstalled.
type Setup struct {
	Credential *Credential `json:"credential"`
	Extensions []string    `json:"extensions"`
	GitEmail   string      `json:"gitEmail"`
	GitName    string      `json:"gitName"`
	Settings   string      `json:"settings"`
}

// Spec is everything the app decided about one workstation's container.
// Network joins a Docker network (this server, where Traefik reaches it by
// labels); Publish binds the port on the host instead (an agent host, which the
// main server's Traefik reaches over the network). Args, when set, replace the
// image's command (`--auth none` for code-server behind the git sign-in).
type Spec struct {
	Args        []string          `json:"args"`
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
	Setup       *Setup            `json:"setup"`
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
	if !validHomePath(spec.HomePath) {
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
	if spec.Setup != nil {
		for _, extension := range spec.Setup.Extensions {
			if !extensionPattern.MatchString(extension) {
				problems = append(problems, "setup.extensions must be publisher.name ids")
				break
			}
		}
		if credential := spec.Setup.Credential; credential != nil && (!hostPattern.MatchString(credential.Host) || credential.Token == "") {
			problems = append(problems, "setup.credential needs a host and a token")
		}
	}
	return problems
}

// validHomePath reports whether path is an absolute path a bind can take.
func validHomePath(path string) bool {
	return strings.HasPrefix(path, "/") && !strings.Contains(path, ":")
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
			op.err = redact(err.Error(), spec)
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
	if err := m.pull(ctx, id, spec.Image); err != nil {
		return err
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
	if spec.Git != nil {
		m.setState(op, StateCloning)
		result, err := m.docker.ContainerExec(ctx, containerID, CloneCommand(spec))
		if err != nil {
			return fmt.Errorf("couldn't clone the repository: %w", err)
		}
		if result.ExitCode != 0 {
			return fmt.Errorf("couldn't clone the repository (exit %d): %s", result.ExitCode, strings.TrimSpace(result.Stderr))
		}
	}
	if spec.Setup == nil {
		return nil
	}
	m.setState(op, StateConfiguring)
	result, err := m.docker.ContainerExec(ctx, containerID, SetupCommand(spec))
	if err != nil {
		return fmt.Errorf("couldn't configure the IDE: %w", err)
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("couldn't configure the IDE (exit %d): %s", result.ExitCode, strings.TrimSpace(result.Stderr))
	}
	return nil
}

// pull pulls image on every start, so a moving tag like latest picks up its
// new release. A pull that fails falls back to the copy the daemon already
// has, so an unreachable registry or a locally built image still starts.
func (m *Manager) pull(ctx context.Context, id, image string) error {
	err := m.docker.PullImage(ctx, image, nil, nil)
	if err == nil {
		return nil
	}
	exists, existsErr := m.docker.ImageExists(ctx, image)
	if existsErr != nil || !exists {
		return fmt.Errorf("couldn't pull %s: %w", image, err)
	}
	logging.Warnf(scope, "workstation %s starts from the local copy of %s, the pull failed: %s", id, image, err)
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
	body := map[string]any{
		"Env":          env,
		"ExposedPorts": map[string]any{port: map[string]any{}},
		"HostConfig":   hostConfig,
		"Image":        spec.Image,
		"Labels":       labels,
	}
	if len(spec.Args) > 0 {
		body["Cmd"] = spec.Args
	}
	return body
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

const setupScript = `set -e
home="$1"
export HOME="$home"
if [ -n "$2" ]; then git config --global user.name "$2"; fi
if [ -n "$3" ]; then git config --global user.email "$3"; fi
if [ -n "$5" ]; then
	file="$home/.git-credentials"
	umask 077
	touch "$file"
	{ grep -vF "@$4" "$file" || true; printf '%s\n' "$5"; } > "$file.homerun"
	mv "$file.homerun" "$file"
	git config --global credential.helper store
fi
ide=""
if command -v code-server >/dev/null 2>&1; then
	ide=code-server
elif command -v openvscode-server >/dev/null 2>&1; then
	ide=openvscode-server
else
	for candidate in "${OPENVSCODE_SERVER_ROOT:-/home/.openvscode-server}/bin/openvscode-server" /app/openvscode-server/bin/openvscode-server; do
		if [ -x "$candidate" ]; then
			ide="$candidate"
			break
		fi
	done
fi
case "$ide" in
	*openvscode-server)
		data="$home/.openvscode-server"
		user="$data/data/Machine"
		;;
	*)
		data="$home/.local/share/code-server"
		user="$data/User"
		;;
esac
if [ -n "$6" ]; then
	mkdir -p "$user"
	printf '%s\n' "$6" > "$user/settings.json"
fi
shift 6
managed="$data/homerun-extensions"
if [ "$#" -eq 0 ] && [ ! -s "$managed" ]; then exit 0; fi
if [ -z "$ide" ]; then
	if [ "$#" -eq 0 ]; then exit 0; fi
	echo "this image has neither code-server nor openvscode-server, so extensions can't be installed" >&2
	exit 3
fi
mkdir -p "$(dirname "$managed")"
touch "$managed"
while IFS= read -r old; do
	keep=0
	for ext in "$@"; do
		if [ "$ext" = "$old" ]; then keep=1; fi
	done
	if [ -n "$old" ] && [ "$keep" -eq 0 ]; then "$ide" --uninstall-extension "$old" >/dev/null 2>&1 || true; fi
done < "$managed"
failed=""
for ext in "$@"; do
	"$ide" --install-extension "$ext" >/dev/null 2>&1 || failed="$failed $ext"
done
printf '%s\n' "$@" > "$managed"
if [ -n "$failed" ]; then
	echo "couldn't install:$failed" >&2
	exit 4
fi`

// SetupCommand is the exec that applies spec's Setup inside the running
// container, as its own user: the git identity, the provider credential (one
// line per host in ~/.git-credentials, replacing that host's previous one),
// the IDE's settings.json, then the extension list. The IDE is code-server
// (its User settings.json) or else openvscode-server (its Machine
// settings.json under ~/.openvscode-server), found on PATH, under
// $OPENVSCODE_SERVER_ROOT or where the linuxserver image installs it. Every
// value travels as a positional argument, never interpolated into the script.
func SetupCommand(spec Spec) []string {
	setup := spec.Setup
	host, line := "", ""
	if setup.Credential != nil {
		host = setup.Credential.Host
		line = credentialLine(setup.Credential)
	}
	command := []string{
		"sh", "-c", setupScript, "setup",
		strings.TrimRight(spec.HomePath, "/"), setup.GitName, setup.GitEmail, host, line, setup.Settings,
	}
	return append(command, setup.Extensions...)
}

// credentialLine is credential as a git credential store entry.
func credentialLine(credential *Credential) string {
	username := credential.Username
	if username == "" {
		username = "oauth2"
	}
	return (&url.URL{Host: credential.Host, Scheme: "https", User: url.UserPassword(username, credential.Token)}).String()
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

// redact strips the clone and credential tokens from a message before it's
// stored or logged.
func redact(message string, spec Spec) string {
	tokens := []string{}
	if spec.Git != nil {
		tokens = append(tokens, spec.Git.Token)
	}
	if spec.Setup != nil && spec.Setup.Credential != nil {
		tokens = append(tokens, spec.Setup.Credential.Token)
	}
	for _, token := range tokens {
		if token != "" {
			message = strings.ReplaceAll(message, token, "***")
		}
	}
	return message
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

// Logs opens the output of workstation id's container, its last tail lines
// and, when follow is set, everything it writes after. ErrNotFound when it has
// no container. The caller closes it.
func (m *Manager) Logs(ctx context.Context, id string, tail int, follow bool) (io.ReadCloser, error) {
	containers, err := m.docker.ListContainersByLabel(ctx, IDLabel+"="+id)
	if err != nil {
		return nil, err
	}
	if len(containers) == 0 {
		return nil, dockerapi.ErrNotFound
	}
	return m.docker.ContainerLogsStream(ctx, containers[0].ID, tail, follow)
}

// Connections counts the established TCP connections to port inside
// workstation id's running container (its open IDE tabs, and any connection
// Traefik still pools to it), read from the container's own /proc/net/tcp and
// tcp6. ErrBusy while a start is in flight, ErrNotFound when no container
// runs.
func (m *Manager) Connections(ctx context.Context, id string, port int) (int, error) {
	m.mu.Lock()
	op, ok := m.ops[id]
	busy := ok && !op.done
	m.mu.Unlock()
	if busy {
		return 0, ErrBusy
	}
	containers, err := m.docker.ListContainersByLabel(ctx, IDLabel+"="+id)
	if err != nil {
		return 0, err
	}
	if len(containers) == 0 || containers[0].State != "running" {
		return 0, dockerapi.ErrNotFound
	}
	result, err := m.docker.ContainerExec(ctx, containers[0].ID, []string{"cat", "/proc/net/tcp", "/proc/net/tcp6"})
	if err != nil {
		return 0, fmt.Errorf("couldn't read the container's connections: %w", err)
	}
	if strings.TrimSpace(result.Stdout) == "" {
		return 0, fmt.Errorf("couldn't read the container's connections: %s", strings.TrimSpace(result.Stderr))
	}
	return CountEstablished(result.Stdout, port), nil
}

// DiskUsage measures how many bytes the home directory at path holds in
// workstation id's running container, with `du` exec'd in it and kept to the
// volume's own file system. ErrNotFound when no container of it runs.
func (m *Manager) DiskUsage(ctx context.Context, id, path string) (int64, error) {
	containers, err := m.docker.ListContainersByLabel(ctx, IDLabel+"="+id)
	if err != nil {
		return 0, err
	}
	if len(containers) == 0 || containers[0].State != "running" {
		return 0, dockerapi.ErrNotFound
	}
	result, err := m.docker.ContainerExec(ctx, containers[0].ID, []string{"du", "-s", "-k", "-x", path})
	if err != nil {
		return 0, fmt.Errorf("couldn't measure the home directory: %w", err)
	}
	kilobytes, parseErr := ParseDuKilobytes(result.Stdout)
	if parseErr != nil {
		return 0, fmt.Errorf("couldn't measure the home directory: %s", strings.TrimSpace(result.Stderr))
	}
	return kilobytes * 1024, nil
}

// ParseDuKilobytes reads the size off `du -s -k`'s output, its first field.
// A du that couldn't read some files still prints a total, which counts.
func ParseDuKilobytes(output string) (int64, error) {
	fields := strings.Fields(output)
	if len(fields) == 0 {
		return 0, errors.New("du printed nothing")
	}
	return strconv.ParseInt(fields[0], 10, 64)
}

// Stats reads workstation id's running container's CPU, memory and network
// use. ErrNotFound when no container of it runs.
func (m *Manager) Stats(ctx context.Context, id string) (*dockerapi.ContainerSample, error) {
	containers, err := m.docker.ListContainersByLabel(ctx, IDLabel+"="+id)
	if err != nil {
		return nil, err
	}
	if len(containers) == 0 || containers[0].State != "running" {
		return nil, dockerapi.ErrNotFound
	}
	return m.docker.ContainerStats(ctx, containers[0].ID)
}

// CountEstablished counts the ESTABLISHED entries of a /proc/net/tcp table
// whose local port is port.
func CountEstablished(table string, port int) int {
	count := 0
	for _, line := range strings.Split(table, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[3] != "01" {
			continue
		}
		separator := strings.LastIndex(fields[1], ":")
		if separator < 0 {
			continue
		}
		local, err := strconv.ParseInt(fields[1][separator+1:], 16, 32)
		if err == nil && int(local) == port {
			count++
		}
	}
	return count
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
