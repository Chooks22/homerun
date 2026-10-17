package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/jobs"
	"github.com/orochibraru/homerun/internal/s3"
)

const (
	rcloneMountPath    = "/opt/rclone"
	resticCacheVolume  = "homerun-restic-cache"
	resticCachePath    = "/cache"
	resticRetryLock    = "10m"
	resticLogEvery     = 30 * time.Second
	resticSummaryShort = 8
)

const resticPrelude = `set -e
export PATH=` + rcloneMountPath + `/usr/local/bin:$PATH
if [ -n "$HOMERUN_PASS" ]; then export RCLONE_CONFIG_DEST_PASS="$(printf %s "$HOMERUN_PASS" | rclone obscure -)"; fi
unset HOMERUN_PASS
`

const resticBackupScript = resticPrelude + `status=0
restic cat config >/dev/null 2>/tmp/cat-config || status=$?
if [ "$status" -eq 10 ]; then
  restic init
elif [ "$status" -ne 0 ]; then
  cat /tmp/cat-config >&2
  exit "$status"
fi
restic backup --json --retry-lock ` + resticRetryLock + ` --host homerun "$1"
if [ "$2" -gt 0 ]; then
  echo "Keeping the newest $2 snapshots and pruning the rest"
  restic forget --quiet --retry-lock ` + resticRetryLock + ` --keep-last "$2" --prune
fi
`

const resticRestoreScript = resticPrelude + `exec restic restore --json --retry-lock ` + resticRetryLock + ` "$@"
`

// Restic is the volume's restic repository: the restic image, the rclone
// image mounted into it so restic reaches the destination through rclone's
// "dest" remote (configured by Env), the repository and its password, a label
// for the log, how many snapshots to keep (0 keeps them all), the prefix a new
// snapshot's key gets, and, for a restore, which snapshot.
type Restic struct {
	Env         map[string]string `json:"env"`
	Image       string            `json:"image"`
	Keep        int               `json:"keep"`
	KeyPrefix   string            `json:"keyPrefix"`
	Label       string            `json:"label"`
	Password    string            `json:"password"`
	RcloneImage string            `json:"rcloneImage"`
	Repository  string            `json:"repository"`
	Snapshot    string            `json:"snapshot"`
}

type resticSummary struct {
	DataAdded           int64  `json:"data_added"`
	DataAddedPacked     int64  `json:"data_added_packed"`
	SnapshotID          string `json:"snapshot_id"`
	TotalBytesProcessed int64  `json:"total_bytes_processed"`
	BytesRestored       int64  `json:"bytes_restored"`
	TotalBytes          int64  `json:"total_bytes"`
}

// resticOutput reads restic's stdout line by line: JSON status lines are
// logged as progress at most every resticLogEvery, error lines as they come,
// the summary is kept, and any plain line (init, forget) goes to the log.
type resticOutput struct {
	lastLog time.Time
	log     func(string)
	pending []byte
	summary *resticSummary
}

// Write splits chunk into lines and handles every complete one.
func (o *resticOutput) Write(chunk []byte) (int, error) {
	o.pending = append(o.pending, chunk...)
	for {
		end := bytes.IndexByte(o.pending, '\n')
		if end < 0 {
			return len(chunk), nil
		}
		o.line(strings.TrimSpace(string(o.pending[:end])))
		o.pending = o.pending[end+1:]
	}
}

// line handles one line of restic's output.
func (o *resticOutput) line(text string) {
	if text == "" || strings.HasPrefix(text, "[") {
		return
	}
	var message struct {
		BytesDone   int64                    `json:"bytes_done"`
		Error       struct{ Message string } `json:"error"`
		Item        string                   `json:"item"`
		MessageType string                   `json:"message_type"`
		PercentDone float64                  `json:"percent_done"`
		TotalBytes  int64                    `json:"total_bytes"`
	}
	if !strings.HasPrefix(text, "{") || json.Unmarshal([]byte(text), &message) != nil {
		o.log(text)
		return
	}
	switch message.MessageType {
	case "status":
		if time.Since(o.lastLog) >= resticLogEvery {
			o.lastLog = time.Now()
			o.log(fmt.Sprintf("%.0f%% done: %s of %s", message.PercentDone*100, s3.MiB(message.BytesDone), s3.MiB(message.TotalBytes)))
		}
	case "error":
		o.log(fmt.Sprintf("Couldn't read %s: %s", message.Item, message.Error.Message))
	case "summary":
		var summary resticSummary
		if json.Unmarshal([]byte(text), &summary) == nil {
			o.summary = &summary
		}
	}
}

// resticHelper is the helper container one restic step runs in: the volume
// mounted at spec.MountPath (read-only for a backup), restic's cache on a
// shared named volume and the rclone image mounted where the script finds it.
func resticHelper(spec Spec, script string, args []string, readOnly bool, stdout io.Writer) dockerapi.HelperConfig {
	mode := ""
	if readOnly {
		mode = ":ro"
	}
	env := []string{
		"RESTIC_CACHE_DIR=" + resticCachePath,
		"RESTIC_PASSWORD=" + spec.Restic.Password,
		"RESTIC_REPOSITORY=" + spec.Restic.Repository,
	}
	for name, value := range spec.Restic.Env {
		env = append(env, name+"="+value)
	}
	sort.Strings(env)
	return dockerapi.HelperConfig{
		Binds:       []string{spec.Source + ":" + spec.MountPath + mode, resticCacheVolume + ":" + resticCachePath},
		Cmd:         args,
		Entrypoint:  []string{"sh", "-c", script, "restic"},
		Env:         env,
		Image:       spec.Restic.Image,
		ImageMounts: []dockerapi.ImageMount{{Image: spec.Restic.RcloneImage, Target: rcloneMountPath}},
		Labels:      spec.HelperLabels,
		Stdout:      stdout,
	}
}

// resticBackup snapshots the volume into its repository, creating the
// repository on first use, then forgets and prunes past spec.Restic.Keep. It
// returns the snapshot's key and the bytes it added to the repository.
func resticBackup(ctx context.Context, job jobs.Job, docker *dockerapi.Client, spec Spec) (string, int64, error) {
	started := time.Now()
	output := &resticOutput{lastLog: started, log: job.AppendLog}
	args := []string{spec.MountPath, strconv.Itoa(spec.Restic.Keep)}
	result, err := docker.RunHelper(ctx, resticHelper(spec, resticBackupScript, args, true, output))
	if err != nil {
		return "", 0, err
	}
	if result.ExitCode != 0 {
		return "", 0, resticFailure("back up", spec, result)
	}
	if output.summary == nil || output.summary.SnapshotID == "" {
		return "", 0, fmt.Errorf("restic finished backing up %q without reporting a snapshot%s", spec.VolumeName, detail(result.Stderr))
	}
	summary := output.summary
	job.AppendLog(fmt.Sprintf("Snapshot %s: scanned %s, %s new, %s stored in %s",
		summary.SnapshotID[:min(resticSummaryShort, len(summary.SnapshotID))], s3.MiB(summary.TotalBytesProcessed),
		s3.MiB(summary.DataAdded), s3.MiB(summary.DataAddedPacked), time.Since(started).Round(time.Second)))
	return spec.Restic.KeyPrefix + summary.SnapshotID, summary.DataAddedPacked, nil
}

// resticRestore restores the snapshot spec.Key names into the volume,
// deleting files the snapshot doesn't have when spec.Wipe is set, and returns
// how many bytes it wrote.
func resticRestore(ctx context.Context, job jobs.Job, docker *dockerapi.Client, spec Spec) (int64, error) {
	args := []string{spec.Restic.Snapshot + ":" + spec.MountPath, "--target", spec.MountPath}
	if spec.Wipe {
		args = append(args, "--delete")
	}
	output := &resticOutput{lastLog: time.Now(), log: job.AppendLog}
	result, err := docker.RunHelper(ctx, resticHelper(spec, resticRestoreScript, args, false, output))
	if err != nil {
		return 0, err
	}
	if result.ExitCode != 0 {
		return 0, resticFailure("restore", spec, result)
	}
	if output.summary == nil {
		return 0, nil
	}
	return max(output.summary.BytesRestored, output.summary.TotalBytes), nil
}

// resticFailure turns a failed restic step into an error naming what it was
// doing, with restic's own words; a wrong password says so plainly.
func resticFailure(action string, spec Spec, result dockerapi.HelperResult) error {
	if result.ExitCode == 12 {
		return fmt.Errorf("Couldn't %s %q: the repository at %s doesn't open with this destination's password", action, spec.VolumeName, spec.Restic.Label)
	}
	return fmt.Errorf("Couldn't %s %q (restic exited %d)%s", action, spec.VolumeName, result.ExitCode, detail(result.Stderr))
}
