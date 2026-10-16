package dockerapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/orochibraru/homerun/internal/logging"
)

const (
	// ManagedLabel marks every container Homerun created.
	ManagedLabel = "homerun.managed"
	// HelperLabel marks a throwaway helper container (a backup's tar, an env
	// file read, a one-off run) that the worker's janitor may remove once
	// it's stopped or has outlived any job.
	HelperLabel = "homerun.helper"
	// HelperCreatedLabel is when a helper was created, RFC 3339.
	HelperCreatedLabel = "homerun.helper.created"
	helperStderrLimit  = 64 * 1024
)

// HelperLabels returns labels plus the managed and helper labels every
// throwaway container carries, stamped with the current time.
func HelperLabels(labels map[string]string) map[string]string {
	merged := make(map[string]string, len(labels)+3)
	for key, value := range labels {
		merged[key] = value
	}
	merged[ManagedLabel] = "true"
	merged[HelperLabel] = "true"
	merged[HelperCreatedLabel] = time.Now().UTC().Format(time.RFC3339)
	return merged
}

// ImageMount mounts another image's filesystem read-only at Target, so a
// helper can run a binary that image ships (Docker Engine 28 or newer).
type ImageMount struct {
	Image  string `json:"image"`
	Target string `json:"target"`
}

// HelperConfig is a throwaway container RunHelper runs to completion.
type HelperConfig struct {
	Binds           []string
	Cmd             []string
	Entrypoint      []string
	Env             []string
	Image           string
	ImageMounts     []ImageMount
	Labels          map[string]string
	NetworkDisabled bool
	NetworkMode     string
	// Stdin, when set, is streamed into the process's stdin, closed at EOF.
	Stdin io.Reader
	// Stdout, when set, receives the process's stdout as it streams;
	// otherwise it's collected into HelperResult.Stdout.
	Stdout io.Writer
}

// HelperResult is a finished helper's exit code, its stderr (the last 64 KiB)
// and, when HelperConfig.Stdout was nil, its stdout.
type HelperResult struct {
	ExitCode int
	Stderr   string
	Stdout   string
}

type tailBuffer struct {
	data  []byte
	limit int
}

// Write keeps the last limit bytes written.
func (t *tailBuffer) Write(chunk []byte) (int, error) {
	t.data = append(t.data, chunk...)
	if len(t.data) > t.limit {
		t.data = t.data[len(t.data)-t.limit:]
	}
	return len(chunk), nil
}

// EnsureImage pulls image if the daemon doesn't already have it.
func (c *Client) EnsureImage(ctx context.Context, image string) error {
	exists, err := c.ImageExists(ctx, image)
	if err != nil || exists {
		return err
	}
	return c.PullImage(ctx, image, nil, nil)
}

// RunHelper runs a throwaway helper container to completion, streaming
// through its own process rather than Docker's archive API: stdin in (a tar to
// unpack), stdout out (a tar being packed), both under the stall watchdog. The
// image is pulled when missing, the container carries HelperLabels, and it's
// always removed afterward on ControlTimeout; one the daemon won't remove is
// left to the janitor.
//
// A container that starts and exits non-zero is a result, not an error; a
// container that can't be created or started, or a stream that stalls, is.
func (c *Client) RunHelper(ctx context.Context, config HelperConfig) (HelperResult, error) {
	if err := c.EnsureImage(ctx, config.Image); err != nil {
		return HelperResult{}, err
	}
	if err := c.ensureImageMounts(ctx, config.ImageMounts); err != nil {
		return HelperResult{}, err
	}
	id, err := c.CreateContainerFrom(ctx, "", helperBody(config))
	if err != nil {
		return HelperResult{}, err
	}
	defer c.removeHelper(ctx, id)

	path := "/containers/" + id + "/attach"
	query := url.Values{"stream": {"1"}, "stdout": {"1"}, "stderr": {"1"}}
	if config.Stdin != nil {
		query.Set("stdin", "1")
	}
	attached, err := c.hijack(ctx, path, query, nil)
	if err != nil {
		return HelperResult{}, err
	}
	w, streamCtx := newWatch(ctx, http.MethodPost, path, id, c.containerRunning(id))
	stopClosing := context.AfterFunc(streamCtx, func() { _ = attached.Close() })
	defer func() {
		stopClosing()
		w.stop()
		_ = attached.Close()
	}()

	if err := c.StartContainer(ctx, id); err != nil {
		return HelperResult{}, err
	}
	fed := make(chan error, 1)
	if config.Stdin != nil {
		go func() {
			_, err := io.Copy(attached, watchedReader{source: config.Stdin, w: w})
			_ = attached.CloseWrite()
			fed <- err
		}()
	} else {
		fed <- nil
	}

	var collected bytes.Buffer
	stdout := config.Stdout
	if stdout == nil {
		stdout = &collected
	}
	stderr := &tailBuffer{limit: helperStderrLimit}
	streamErr := w.explain(DemuxSplit(watchedReader{source: attached, w: w}, stdout, stderr))
	if streamErr != nil {
		if ctx.Err() != nil {
			return HelperResult{}, ctx.Err()
		}
		return HelperResult{}, streamErr
	}
	code, err := c.WaitContainer(ctx, id)
	if err != nil {
		return HelperResult{}, err
	}
	_ = attached.Close()
	result := HelperResult{ExitCode: code, Stderr: string(stderr.data), Stdout: collected.String()}
	if feedErr := <-fed; feedErr != nil && code == 0 {
		return result, feedErr
	}
	return result, nil
}

// imageMounts is the HostConfig.Mounts entries for mounts, each read-only.
func imageMounts(mounts []ImageMount) []map[string]any {
	entries := make([]map[string]any, 0, len(mounts))
	for _, mount := range mounts {
		entries = append(entries, map[string]any{"ReadOnly": true, "Source": mount.Image, "Target": mount.Target, "Type": "image"})
	}
	return entries
}

// ensureImageMounts pulls every mounted image the daemon doesn't already have.
func (c *Client) ensureImageMounts(ctx context.Context, mounts []ImageMount) error {
	for _, mount := range mounts {
		if err := c.EnsureImage(ctx, mount.Image); err != nil {
			return err
		}
	}
	return nil
}

// helperBody is the create body for config: no TTY, so stdout and stderr come
// back framed, and stdin open for one attach when there's something to feed.
func helperBody(config HelperConfig) map[string]any {
	hostConfig := map[string]any{"Binds": config.Binds}
	if len(config.ImageMounts) > 0 {
		hostConfig["Mounts"] = imageMounts(config.ImageMounts)
	}
	if config.NetworkMode != "" {
		hostConfig["NetworkMode"] = config.NetworkMode
	}
	withStdin := config.Stdin != nil
	body := map[string]any{
		"AttachStderr":    true,
		"AttachStdin":     withStdin,
		"AttachStdout":    true,
		"Cmd":             config.Cmd,
		"Env":             config.Env,
		"HostConfig":      hostConfig,
		"Image":           config.Image,
		"Labels":          HelperLabels(config.Labels),
		"NetworkDisabled": config.NetworkDisabled,
		"OpenStdin":       withStdin,
		"StdinOnce":       withStdin,
		"Tty":             false,
	}
	if len(config.Entrypoint) > 0 {
		body["Entrypoint"] = config.Entrypoint
	}
	return body
}

// removeHelper force-removes a helper even when ctx is already cancelled,
// bounded by ControlTimeout. One the daemon won't remove in time (a wedged
// container) is logged and left for the janitor rather than holding the job.
func (c *Client) removeHelper(ctx context.Context, id string) {
	if err := c.RemoveContainer(context.WithoutCancel(ctx), id); err != nil && !errors.Is(err, ErrNotFound) {
		logging.Warnf(engineScope, "couldn't remove helper %s, leaving it to the janitor: %s", shortID(id), err)
	}
}

// VolumeSize measures what a volume or host path holds, in bytes, with
// `du -sk` in a helper container that mounts it read-only.
func (c *Client) VolumeSize(ctx context.Context, source, image string) (int64, error) {
	result, err := c.RunHelper(ctx, HelperConfig{
		Binds:           []string{source + ":/volume:ro"},
		Cmd:             []string{"du", "-sk", "/volume"},
		Image:           image,
		NetworkDisabled: true,
	})
	if err != nil {
		return 0, err
	}
	if result.ExitCode != 0 {
		return 0, fmt.Errorf("du exited %d: %s", result.ExitCode, strings.TrimSpace(result.Stderr))
	}
	return ParseDuKilobytes(result.Stdout)
}

// ParseDuKilobytes reads the first field of `du -sk`'s output as bytes.
func ParseDuKilobytes(output string) (int64, error) {
	fields := strings.Fields(output)
	if len(fields) == 0 {
		return 0, errors.New("du printed nothing")
	}
	kilobytes, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("unexpected du output %q", strings.TrimSpace(output))
	}
	return kilobytes * 1024, nil
}

// CopyVolume creates the named volume to (or fills the host path) with a copy
// of from, owners, modes and links kept, through a helper container that
// mounts from read-only.
func (c *Client) CopyVolume(ctx context.Context, from, to, image string) error {
	result, err := c.RunHelper(ctx, HelperConfig{
		Binds:           []string{from + ":/from:ro", to + ":/to"},
		Cmd:             []string{"cp", "-a", "/from/.", "/to/"},
		Image:           image,
		NetworkDisabled: true,
	})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("cp exited %d: %s", result.ExitCode, strings.TrimSpace(result.Stderr))
	}
	return nil
}
