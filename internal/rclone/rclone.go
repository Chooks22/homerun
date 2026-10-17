// Package rclone reads a legacy backup archive back from a destination S3
// doesn't cover (SFTP, SMB, WebDAV: a Hetzner Storage Box, a NAS) by running
// rclone in a throwaway helper container. The app resolves which image,
// entrypoint and environment reach the destination; this side only streams
// through it.
package rclone

import (
	"context"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"

	"github.com/orochibraru/homerun/internal/dockerapi"
)

const (
	errorTailChars = 2000
	remoteName     = "dest:"
)

// Remote is one destination reached through an rclone helper container whose
// Env configures a remote named "dest", with Path the directory under it.
type Remote struct {
	Entrypoint []string          `json:"entrypoint"`
	Env        map[string]string `json:"env"`
	Image      string            `json:"image"`
	Label      string            `json:"label"`
	Path       string            `json:"path"`

	Docker *dockerapi.Client `json:"-"`
	Labels map[string]string `json:"-"`
	Log    func(string)      `json:"-"`
}

// Target is key's rclone path under the remote.
func (r *Remote) Target(key string) string {
	return remoteName + path.Join(r.Path, key)
}

// environment renders Env as sorted KEY=value pairs.
func (r *Remote) environment() []string {
	pairs := make([]string, 0, len(r.Env))
	for name, value := range r.Env {
		pairs = append(pairs, name+"="+value)
	}
	sort.Strings(pairs)
	return pairs
}

// run executes one rclone command in a helper container, failing on a
// non-zero exit with the tail of what rclone wrote to stderr.
func (r *Remote) run(ctx context.Context, stdin io.Reader, stdout io.Writer, args ...string) error {
	result, err := r.Docker.RunHelper(ctx, dockerapi.HelperConfig{
		Cmd:        args,
		Entrypoint: r.Entrypoint,
		Env:        r.environment(),
		Image:      r.Image,
		Labels:     r.Labels,
		Stdin:      stdin,
		Stdout:     stdout,
	})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		detail := []rune(strings.TrimSpace(result.Stderr))
		if len(detail) > errorTailChars {
			detail = detail[len(detail)-errorTailChars:]
		}
		return fmt.Errorf("rclone %s exited %d: %s", args[0], result.ExitCode, string(detail))
	}
	return nil
}

// Get opens key for reading. The caller closes the stream.
func (r *Remote) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	reader, writer := io.Pipe()
	go func() {
		_ = writer.CloseWithError(r.run(ctx, nil, writer, "cat", r.Target(key)))
	}()
	return reader, nil
}
