package dockerapi_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/orochibraru/homerun/internal/dockerapi"
)

func TestWithFilesWrapsImageArgv(t *testing.T) {
	config := dockerapi.WithFiles(dockerapi.OneOffConfig{
		Env:   []string{"A=1"},
		Files: []dockerapi.File{{Content: "x", Path: "/etc/app/config.js"}},
	}, dockerapi.ImageConfig{Cmd: []string{"renovate"}, Entrypoint: []string{"/entry.sh"}})
	if config.Entrypoint[0] != "/bin/sh" || config.Entrypoint[1] != "-c" || config.Entrypoint[3] != "homerun-files" {
		t.Errorf("entrypoint = %v", config.Entrypoint)
	}
	if !reflect.DeepEqual(config.Cmd, []string{"/entry.sh", "renovate"}) {
		t.Errorf("cmd = %v", config.Cmd)
	}
	if !reflect.DeepEqual(config.Env, []string{"A=1", "HOMERUN_FILE_0=x"}) {
		t.Errorf("env = %v", config.Env)
	}
}

func TestWithFilesKeepsCommandOverride(t *testing.T) {
	config := dockerapi.WithFiles(dockerapi.OneOffConfig{
		Cmd:   []string{"--dry-run"},
		Files: []dockerapi.File{{Content: "x", Path: "/a"}},
	}, dockerapi.ImageConfig{Cmd: []string{"renovate"}, Entrypoint: []string{"/entry.sh"}})
	if !reflect.DeepEqual(config.Cmd, []string{"/entry.sh", "--dry-run"}) {
		t.Errorf("cmd = %v", config.Cmd)
	}
	overridden := dockerapi.WithFiles(dockerapi.OneOffConfig{
		Entrypoint: []string{"python"},
		Files:      []dockerapi.File{{Content: "x", Path: "/a"}},
	}, dockerapi.ImageConfig{Cmd: []string{"ignored"}})
	if !reflect.DeepEqual(overridden.Cmd, []string{"python"}) {
		t.Errorf("cmd with an entrypoint override = %v", overridden.Cmd)
	}
}

func TestWithFilesNoFilesIsUnchanged(t *testing.T) {
	config := dockerapi.OneOffConfig{Cmd: []string{"echo"}}
	if got := dockerapi.WithFiles(config, dockerapi.ImageConfig{Entrypoint: []string{"x"}}); !reflect.DeepEqual(got, config) {
		t.Errorf("config = %+v", got)
	}
}

func TestFilesScriptWritesFilesThenExecs(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "it's", "config.js")
	second := filepath.Join(dir, "plain.txt")
	content := "module.exports = {\n  \"$HOME\": `x`,\n};\n"
	files := []dockerapi.File{{Content: content, Path: first}, {Content: "", Path: second}}
	cmd := exec.Command("/bin/sh", "-c", dockerapi.FilesScript(files), "homerun-files", "/bin/sh", "-c", "env | grep -c HOMERUN_FILE_ || true")
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOMERUN_FILE_0=" + content, "HOMERUN_FILE_1="}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("script failed: %v\n%s", err, out)
	}
	if string(out) != "0\n" {
		t.Errorf("file variables leaked into the process: %q", out)
	}
	written, err := os.ReadFile(first)
	if err != nil || string(written) != content {
		t.Errorf("first file = %q, %v", written, err)
	}
	if info, err := os.Stat(second); err != nil || info.Size() != 0 {
		t.Errorf("second file = %v, %v", info, err)
	}
}
