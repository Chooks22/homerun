// Package backup executes backup and backup_restore jobs for the homerun
// worker: a volume snapshotted into its restic repository on an S3, SFTP, SMB
// or WebDAV destination (reached through rclone), and a snapshot, or a legacy
// tar.gz archive, restored back into the volume, with the services using it
// optionally stopped around the work.
package backup

import (
	"bufio"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/jobs"
	"github.com/orochibraru/homerun/internal/rclone"
	"github.com/orochibraru/homerun/internal/s3"
	"github.com/orochibraru/homerun/internal/tracing"
)

const (
	preCommandTimeout = 15 * time.Minute
	outputTailChars   = 2000
)

// Service is one service using the volume that is stopped around the work:
// its single container, or its swarm service scaled to 0 and back to Replicas.
type Service struct {
	ContainerID    string `json:"containerId"`
	ID             string `json:"id"`
	Name           string `json:"name"`
	Replicas       int    `json:"replicas"`
	SwarmServiceID string `json:"swarmServiceId"`
}

// PreCommand is a shell command run inside a service's container before a backup.
type PreCommand struct {
	Command     string `json:"command"`
	ContainerID string `json:"containerId"`
	ServiceName string `json:"serviceName"`
}

// store is where a legacy tar.gz archive is read from: an S3 bucket or an
// rclone remote.
type store interface {
	Get(ctx context.Context, key string) (io.ReadCloser, error)
}

// Spec is what the app's prepare step resolves for one backup or restore.
// A backup and a snapshot's restore go through Restic; a legacy archive's
// restore reads Key from Remote, when set, or Destination.
type Spec struct {
	Destination  s3.Client         `json:"destination"`
	HelperImage  string            `json:"helperImage"`
	HelperLabels map[string]string `json:"helperLabels"`
	Key          string            `json:"key"`
	Kind         string            `json:"kind"`
	MountPath    string            `json:"mountPath"`
	PreCommand   *PreCommand       `json:"preCommand"`
	Remote       *rclone.Remote    `json:"remote"`
	Restic       *Restic           `json:"restic"`
	Source       string            `json:"source"`
	StopServices []Service         `json:"stopServices"`
	UsedBy       []string          `json:"usedBy"`
	VolumeName   string            `json:"volumeName"`
	Wipe         bool              `json:"wipe"`
}

// Run executes a backup or a backup_restore job and returns the snapshot's or
// archive's key and its size in bytes: what a backup added to the repository,
// what a restore wrote.
func Run(ctx context.Context, job jobs.Job) (map[string]any, error) {
	var spec Spec
	if err := job.DecodeSpec(&spec); err != nil {
		return nil, fmt.Errorf("invalid backup spec: %w", err)
	}
	docker := dockerapi.New(job.DockerSocket)
	if spec.Remote != nil {
		spec.Remote.Docker = docker
		spec.Remote.Labels = spec.HelperLabels
		spec.Remote.Log = job.AppendLog
	}
	key, size := spec.Key, int64(0)
	stage := "backup"
	if job.Type == "backup_restore" {
		stage = "restore"
	}
	err := tracing.Stage(ctx, stage, func(ctx context.Context) error {
		var err error
		if job.Type == "backup_restore" {
			size, err = restore(ctx, job, docker, spec)
		} else {
			key, size, err = backup(ctx, job, docker, spec)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"key": key, "sizeBytes": size}, nil
}

// backup stops spec's services, snapshots the volume into its restic
// repository, then starts them again, returning the snapshot's key and the
// bytes it added.
func backup(ctx context.Context, job jobs.Job, docker *dockerapi.Client, spec Spec) (string, int64, error) {
	if spec.Restic == nil {
		return "", 0, errors.New("the backup spec has no restic repository")
	}
	started := time.Now()
	job.AppendLog(fmt.Sprintf("Backing up %s", describeVolume(spec)))
	job.AppendLog(fmt.Sprintf("Repository: %s", spec.Restic.Label))
	logStopPlan(job, spec)
	if err := runPreCommand(ctx, job, docker, spec.PreCommand); err != nil {
		job.AppendLog(fmt.Sprintf("Backup failed after %s: %s", time.Since(started).Round(time.Second), err))
		return "", 0, err
	}
	var key string
	var size int64
	err := whileStopped(ctx, job, docker, spec.StopServices, func() error {
		var err error
		job.AppendLog(fmt.Sprintf("Snapshotting %s with %s, reaching the destination through %s", spec.VolumeName, spec.Restic.Image, spec.Restic.RcloneImage))
		key, size, err = resticBackup(ctx, job, docker, spec)
		return err
	})
	if err != nil {
		job.AppendLog(fmt.Sprintf("Backup failed after %s: %s", time.Since(started).Round(time.Second), err))
		return "", 0, err
	}
	return key, size, nil
}

// describeVolume names the volume, what it is on the host and the services
// (with their stacks) using it, for the first line of a run's log.
func describeVolume(spec Spec) string {
	what := "Docker volume"
	if spec.Kind == "bind" {
		what = "host path"
	}
	users := "not mounted by any service"
	if len(spec.UsedBy) > 0 {
		users = "used by " + strings.Join(spec.UsedBy, ", ")
	}
	return fmt.Sprintf("%s (%s %s), %s", spec.VolumeName, what, spec.Source, users)
}

// archives is the store spec's archive goes to or comes from.
func archives(spec *Spec) store {
	if spec.Remote != nil {
		return spec.Remote
	}
	return &spec.Destination
}

// destination is where spec's restore comes from: the restic repository and
// snapshot, or a legacy archive's endpoint, bucket and key, or rclone
// remote's address, path and key.
func destination(spec Spec) string {
	if spec.Restic != nil {
		return spec.Restic.Label + " snapshot " + spec.Restic.Snapshot
	}
	if spec.Remote != nil {
		return strings.TrimRight(spec.Remote.Label, "/") + "/" + spec.Key
	}
	return fmt.Sprintf("%s/%s/%s", strings.TrimRight(spec.Destination.Endpoint, "/"), spec.Destination.Bucket, spec.Key)
}

// transferred is a size, how long it took and the resulting throughput.
func transferred(size int64, took time.Duration) string {
	rate := ""
	if seconds := took.Seconds(); seconds >= 1 {
		rate = fmt.Sprintf(", %s/s", s3.MiB(int64(float64(size)/seconds)))
	}
	return fmt.Sprintf("%s (%d bytes) in %s%s", s3.MiB(size), size, took.Round(time.Second), rate)
}

// logStopPlan says which services are stopped around the work, or that the
// ones using the volume keep running through it.
func logStopPlan(job jobs.Job, spec Spec) {
	switch {
	case len(spec.StopServices) > 0:
		names := make([]string, 0, len(spec.StopServices))
		for _, service := range spec.StopServices {
			names = append(names, service.Name)
		}
		job.AppendLog(fmt.Sprintf("Stopping %s while it runs, started again afterwards", strings.Join(names, ", ")))
	case len(spec.UsedBy) > 0:
		job.AppendLog("The services using it keep running: files written meanwhile may be copied half-written")
	}
}

// restore puts spec's snapshot or legacy archive back into the volume,
// wiping it first when spec.Wipe is set, with services stopped throughout.
func restore(ctx context.Context, job jobs.Job, docker *dockerapi.Client, spec Spec) (int64, error) {
	started := time.Now()
	job.AppendLog(fmt.Sprintf("Restoring into %s", describeVolume(spec)))
	if spec.Restic != nil {
		job.AppendLog(fmt.Sprintf("Restoring %s", destination(spec)))
		logStopPlan(job, spec)
		var size int64
		err := whileStopped(ctx, job, docker, spec.StopServices, func() error {
			var err error
			size, err = resticRestore(ctx, job, docker, spec)
			return err
		})
		if err != nil {
			job.AppendLog(fmt.Sprintf("Restore failed after %s: %s", time.Since(started).Round(time.Second), err))
			return 0, err
		}
		job.AppendLog(fmt.Sprintf("Restored %s into %s in %s (files the snapshot doesn't have deleted: %t)", spec.Key, spec.VolumeName, time.Since(started).Round(time.Second), spec.Wipe))
		return size, nil
	}
	job.AppendLog(fmt.Sprintf("Downloading %s", destination(spec)))
	logStopPlan(job, spec)
	archive, size, err := download(ctx, spec)
	if err != nil {
		job.AppendLog(fmt.Sprintf("Restore failed after %s: %s", time.Since(started).Round(time.Second), err))
		return 0, err
	}
	defer func() {
		_ = archive.Close()
		_ = os.Remove(archive.Name())
	}()
	job.AppendLog(fmt.Sprintf("Downloaded %s: %s", spec.Key, transferred(size, time.Since(started))))
	err = whileStopped(ctx, job, docker, spec.StopServices, func() error {
		if spec.Wipe {
			if err := wipe(ctx, docker, spec); err != nil {
				return err
			}
			job.AppendLog("Volume wiped before restore")
		}
		if _, err := archive.Seek(0, io.SeekStart); err != nil {
			return err
		}
		job.AppendLog(fmt.Sprintf("Unpacking into %s through a %s helper container", spec.VolumeName, spec.HelperImage))
		return unpack(ctx, docker, spec, archive)
	})
	if err != nil {
		job.AppendLog(fmt.Sprintf("Restore failed after %s: %s", time.Since(started).Round(time.Second), err))
		return 0, err
	}
	job.AppendLog(fmt.Sprintf("Restored %s into %s in %s (wiped first: %t)", spec.Key, spec.VolumeName, time.Since(started).Round(time.Second), spec.Wipe))
	return size, nil
}

// download fetches spec's backup into a temp file and returns it along with
// its size.
func download(ctx context.Context, spec Spec) (*os.File, int64, error) {
	stream, err := archives(&spec).Get(ctx, spec.Key)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = stream.Close() }()
	file, err := os.CreateTemp("", "homerun-restore-*.tar.gz")
	if err != nil {
		return nil, 0, err
	}
	size, err := io.Copy(file, stream)
	if err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, 0, fmt.Errorf("couldn't download %s: %w", spec.Key, err)
	}
	return file, size, nil
}

// unpack extracts archive (a gzipped tar, or a plain one) into the volume
// through a started helper container running `tar -x` on its stdin, replacing
// files that exist and leaving everything else alone.
func unpack(ctx context.Context, docker *dockerapi.Client, spec Spec, archive io.Reader) error {
	buffered := bufio.NewReader(archive)
	var stream io.Reader = buffered
	if magic, err := buffered.Peek(2); err == nil && magic[0] == 0x1f && magic[1] == 0x8b {
		gz, err := gzip.NewReader(buffered)
		if err != nil {
			return fmt.Errorf("couldn't read %s: %w", spec.Key, err)
		}
		defer func() { _ = gz.Close() }()
		stream = gz
	}
	result, err := docker.RunHelper(ctx, dockerapi.HelperConfig{
		Binds:  []string{spec.Source + ":" + spec.MountPath},
		Cmd:    []string{"tar", "-C", spec.MountPath, "--numeric-owner", "-xf", "-"},
		Image:  spec.HelperImage,
		Labels: spec.HelperLabels,
		Stdin:  stream,
	})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("Couldn't unpack %s into %q (tar exited %d)%s", spec.Key, spec.VolumeName, result.ExitCode, detail(result.Stderr))
	}
	return nil
}

// wipe deletes every file in the volume through a helper container, before a
// restore that wants a clean slate.
func wipe(ctx context.Context, docker *dockerapi.Client, spec Spec) error {
	result, err := docker.RunHelper(ctx, dockerapi.HelperConfig{
		Binds:  []string{spec.Source + ":" + spec.MountPath},
		Cmd:    []string{"find", spec.MountPath, "-mindepth", "1", "-delete"},
		Image:  spec.HelperImage,
		Labels: spec.HelperLabels,
	})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("Couldn't wipe %q before restoring (exit %d)%s", spec.VolumeName, result.ExitCode, detail(result.Stderr))
	}
	return nil
}

// runPreCommand runs pre's command inside its container before the backup,
// failing the job on a non-zero exit or a 15-minute timeout.
func runPreCommand(ctx context.Context, job jobs.Job, docker *dockerapi.Client, pre *PreCommand) error {
	if pre == nil || strings.TrimSpace(pre.Command) == "" {
		return nil
	}
	job.AppendLog(fmt.Sprintf("Running the pre-backup command in %q", pre.ServiceName))
	execCtx, cancel := context.WithTimeout(ctx, preCommandTimeout)
	defer cancel()
	result, err := docker.ContainerExec(execCtx, pre.ContainerID, []string{"/bin/sh", "-c", pre.Command})
	if errors.Is(execCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
		return fmt.Errorf("The pre-backup command in %q was still running after 15 minutes.", pre.ServiceName)
	}
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("The pre-backup command in %q exited %d%s", pre.ServiceName, result.ExitCode,
			detail(result.Stdout+result.Stderr))
	}
	job.AppendLog("Pre-backup command finished" + detail(result.Stdout+result.Stderr))
	return nil
}

// detail trims output and, if long, keeps only its tail, for an error message.
func detail(output string) string {
	if tail := OutputTail(output); tail != "" {
		return ": " + tail
	}
	return "."
}

// OutputTail trims output and, if it's longer than outputTailChars, keeps only
// its tail prefixed with "...".
func OutputTail(output string) string {
	trimmed := []rune(strings.TrimSpace(output))
	if len(trimmed) > outputTailChars {
		return "..." + string(trimmed[len(trimmed)-outputTailChars:])
	}
	return string(trimmed)
}

// whileStopped stops services, runs work, then starts them again regardless
// of whether work or a stop failed, recording desired_state either way.
func whileStopped(ctx context.Context, job jobs.Job, docker *dockerapi.Client, services []Service, work func() error) error {
	restartCtx := context.WithoutCancel(ctx)
	return StopAround(services,
		func(service Service) error {
			setDesiredState(ctx, job, service.ID, "stopped")
			var err error
			if service.SwarmServiceID != "" {
				err = docker.ScaleSwarmService(ctx, service.SwarmServiceID, 0)
			} else {
				err = docker.StopContainer(ctx, service.ContainerID)
			}
			if err != nil {
				return fmt.Errorf("couldn't stop %q: %w", service.Name, err)
			}
			job.AppendLog(fmt.Sprintf("Stopped for a backup or restore: %s", service.Name))
			return nil
		},
		func(service Service) error {
			var err error
			if service.SwarmServiceID != "" {
				err = docker.ScaleSwarmService(restartCtx, service.SwarmServiceID, max(service.Replicas, 1))
			} else {
				err = docker.EnsureContainerStarted(restartCtx, service.ContainerID)
			}
			if err == nil {
				setDesiredState(restartCtx, job, service.ID, "running")
				job.AppendLog(fmt.Sprintf("Started again: %s", service.Name))
			}
			return err
		},
		func(service Service, err error) {
			job.AppendLog(fmt.Sprintf("Couldn't start %q again after a backup or restore: %s", service.Name, err))
		},
		work,
	)
}

// setDesiredState records the service's desired_state, logging but not
// failing the job when there's no database to write to or the write fails.
func setDesiredState(ctx context.Context, job jobs.Job, serviceID, state string) {
	if job.DB() == nil {
		return
	}
	if _, err := job.DB().Exec(ctx, `update service set desired_state = $2 where id = $1`, serviceID, state); err != nil {
		job.AppendLog(fmt.Sprintf("Couldn't record %s as %s: %s", serviceID, state, err))
	}
}

// StopAround stops every service, runs work, then starts every stopped
// service again regardless of whether work or a stop failed; onStartFailure
// reports a service that couldn't be restarted.
func StopAround[T any](services []T, stop, start func(T) error, onStartFailure func(T, error), work func() error) error {
	var stopped []T
	err := func() error {
		for _, service := range services {
			if err := stop(service); err != nil {
				return err
			}
			stopped = append(stopped, service)
		}
		return work()
	}()
	for _, service := range stopped {
		if startErr := start(service); startErr != nil {
			onStartFailure(service, startErr)
		}
	}
	return err
}
