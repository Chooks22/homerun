package backup_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/orochibraru/homerun/internal/jobs/backup"
	"github.com/orochibraru/homerun/internal/rclone"
)

// remoteSpec is a restore of volume "data" from a legacy archive on an rclone
// remote under "base".
func remoteSpec() backup.Spec {
	return backup.Spec{
		HelperImage: "alpine:3", Key: "p/data.tar.gz", MountPath: "/homerun-backup-source",
		Remote: &rclone.Remote{Image: "rclone/rclone:1", Label: "sftp://bob@nas/base", Path: "base"},
		Source: "data", VolumeName: "data",
	}
}

func TestALegacyArchiveStillRestoresFromAnRcloneRemote(t *testing.T) {
	engine, socket := newFakeEngine(t, map[string]string{"stray": "y"})
	engine.remote["dest:base/p/data.tar.gz"] = legacyArchive(map[string]string{"a.txt": "hi", "sub/b": "x"})
	spec := remoteSpec()
	spec.Wipe = true

	if _, err := runJob(t, "backup_restore", socket, spec); err != nil {
		t.Fatal(err)
	}
	if got := engine.files("data"); !reflect.DeepEqual(got, []string{"a.txt", "sub/b"}) {
		t.Fatalf("restored files = %v", got)
	}
}

func TestRestoringAMissingRcloneObjectFailsWithRclonesError(t *testing.T) {
	_, socket := newFakeEngine(t, map[string]string{})

	_, err := runJob(t, "backup_restore", socket, remoteSpec())
	if err == nil || !strings.Contains(err.Error(), "rclone cat exited 4: object not found") {
		t.Fatalf("want rclone's error, got %v", err)
	}
}
