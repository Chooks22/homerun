package dockerapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const oneOffCleanupTimeout = 30 * time.Second

// OneOffConfig describes a throwaway container RunOneOff runs to completion.
type OneOffConfig struct {
	Auth        *AuthConfig
	Binds       []string
	Cmd         []string
	Entrypoint  []string
	Env         []string
	Files       []File
	GroupAdd    []string
	Image       string
	Labels      map[string]string
	NetworkMode string
	OnOutput    func(chunk string) `json:"-"`
	PidMode     string
	Privileged  bool
	Timeout     time.Duration
	User        string
	WorkingDir  string
}

// OneOffResult is a finished one-off container's exit code and output.
type OneOffResult struct {
	ExitCode int
	Stderr   []byte
	Stdout   []byte
	TimedOut bool
}

type outputWriter struct {
	mu       *sync.Mutex
	buffer   []byte
	onOutput func(string)
}

// Write buffers chunk and forwards it to onOutput, if set.
func (w *outputWriter) Write(chunk []byte) (int, error) {
	w.mu.Lock()
	w.buffer = append(w.buffer, chunk...)
	w.mu.Unlock()
	if w.onOutput != nil {
		w.onOutput(string(chunk))
	}
	return len(chunk), nil
}

// RunOneOff pulls config.Image if the daemon lacks it, writes config.Files
// into it ahead of its own process (see WithFiles), runs it to completion
// and returns its exit code with stdout and stderr kept apart, streaming each
// chunk to config.OnOutput as it arrives. Past config.Timeout the container is
// killed and the result reports TimedOut rather than an error. The container is
// always removed, even when ctx is cancelled.
func (c *Client) RunOneOff(ctx context.Context, config OneOffConfig) (OneOffResult, error) {
	exists, err := c.ImageExists(ctx, config.Image)
	if err != nil {
		return OneOffResult{}, err
	}
	if !exists {
		if err := c.PullImage(ctx, config.Image, config.Auth, nil); err != nil {
			return OneOffResult{}, err
		}
	}

	config, err = c.withImageFiles(ctx, config)
	if err != nil {
		return OneOffResult{}, err
	}

	id, err := c.createOneOff(ctx, config)
	if err != nil {
		return OneOffResult{}, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), oneOffCleanupTimeout)
		defer cancel()
		_ = c.RemoveContainer(cleanup, id)
	}()

	if err := c.StartContainer(ctx, id); err != nil {
		return OneOffResult{}, err
	}

	var mu sync.Mutex
	stdout := &outputWriter{mu: &mu, onOutput: config.OnOutput}
	stderr := &outputWriter{mu: &mu, onOutput: config.OnOutput}
	streamed := make(chan error, 1)
	go func() {
		logs, err := c.ContainerLogs(ctx, id, true)
		if err != nil {
			streamed <- err
			return
		}
		defer func() { _ = logs.Close() }()
		streamed <- DemuxSplit(logs, stdout, stderr)
	}()

	var timedOut atomic.Bool
	timer := time.AfterFunc(config.Timeout, func() {
		timedOut.Store(true)
		kill, cancel := context.WithTimeout(context.WithoutCancel(ctx), oneOffCleanupTimeout)
		defer cancel()
		_ = c.KillContainer(kill, id)
	})
	defer timer.Stop()

	code, err := c.WaitContainer(ctx, id)
	if err != nil {
		return OneOffResult{}, err
	}
	if err := <-streamed; err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, io.EOF) {
		return OneOffResult{}, err
	}
	mu.Lock()
	defer mu.Unlock()
	return OneOffResult{ExitCode: code, Stderr: stderr.buffer, Stdout: stdout.buffer, TimedOut: timedOut.Load()}, nil
}

// createOneOff creates (but does not start) the one-off container for config,
// labelled as a helper so the janitor can reap it if this process dies first.
func (c *Client) createOneOff(ctx context.Context, config OneOffConfig) (string, error) {
	hostConfig := map[string]any{"Privileged": config.Privileged}
	if config.PidMode != "" {
		hostConfig["PidMode"] = config.PidMode
	}
	if len(config.Binds) > 0 {
		hostConfig["Binds"] = config.Binds
	}
	if config.NetworkMode != "" {
		hostConfig["NetworkMode"] = config.NetworkMode
	}
	if len(config.GroupAdd) > 0 {
		hostConfig["GroupAdd"] = config.GroupAdd
	}
	body := map[string]any{
		"Cmd":        config.Cmd,
		"Env":        config.Env,
		"HostConfig": hostConfig,
		"Image":      config.Image,
		"Labels":     HelperLabels(config.Labels),
		"Tty":        false,
	}
	if len(config.Entrypoint) > 0 {
		body["Entrypoint"] = config.Entrypoint
	}
	if config.WorkingDir != "" {
		body["WorkingDir"] = config.WorkingDir
	}
	if config.User != "" {
		body["User"] = config.User
	}
	response, err := c.request(ctx, http.MethodPost, "/containers/create", nil, body, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = response.Body.Close() }()
	var created struct {
		ID string `json:"Id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		return "", err
	}
	return created.ID, nil
}
