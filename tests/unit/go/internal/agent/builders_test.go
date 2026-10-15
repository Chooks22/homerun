package agent_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/orochibraru/homerun/internal/agent"
)

type envCase struct {
	Env   []string `json:"env"`
	Input struct {
		BakeFile      *string `json:"bakeFile"`
		BuildTarget   *string `json:"buildTarget"`
		BuildContext  *string `json:"buildContext"`
		CacheRegistry *struct {
			Password    string `json:"password"`
			RegistryURL string `json:"registryUrl"`
			Username    string `json:"username"`
		} `json:"cacheRegistry"`
		DockerfilePath *string `json:"dockerfilePath"`
		Method         string  `json:"method"`
		RepoDir        string  `json:"repoDir"`
		Tag            string  `json:"tag"`
	} `json:"input"`
	Error *string `json:"error"`
}

// deref dereferences value, or returns "" when it's nil.
func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// builderInput converts the fixture's JSON input into an agent.BuilderInput.
func (c envCase) builderInput() agent.BuilderInput {
	input := agent.BuilderInput{
		BakeFile:       deref(c.Input.BakeFile),
		BuildTarget:    deref(c.Input.BuildTarget),
		BuildContext:   deref(c.Input.BuildContext),
		DockerfilePath: deref(c.Input.DockerfilePath),
		Method:         c.Input.Method,
		RepoDir:        c.Input.RepoDir,
		Tag:            c.Input.Tag,
	}
	if cache := c.Input.CacheRegistry; cache != nil {
		input.CacheRegistry = &agent.CacheRegistry{
			Password: cache.Password, RegistryURL: cache.RegistryURL, Username: cache.Username,
		}
	}
	return input
}

// loadFixture reads and JSON-decodes the file at path into into.
func loadFixture(t *testing.T, path string, into any) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
}

// TestBuilderEnvMatchesTheMainApp pins builderEnv to the environments recorded
// in testdata, captured from the TypeScript implementation it replaced.
func TestBuilderEnvMatchesTheMainApp(t *testing.T) {
	var fixture struct {
		Cases  []envCase `json:"cases"`
		Errors []envCase `json:"errors"`
	}
	loadFixture(t, "testdata/builder-env.json", &fixture)
	if len(fixture.Cases) == 0 || len(fixture.Errors) == 0 {
		t.Fatal("the fixture should carry both working and refused inputs")
	}

	for index, testCase := range fixture.Cases {
		got, err := agent.BuilderEnv(testCase.builderInput())
		if err != nil {
			t.Errorf("case %d (%s): unexpected error %v", index, testCase.Input.Method, err)
			continue
		}
		if strings.Join(got, "\n") != strings.Join(testCase.Env, "\n") {
			t.Errorf("case %d (%s): env differs from the main app's\n want %v\n  got %v",
				index, testCase.Input.Method, testCase.Env, got)
		}
	}

	for index, testCase := range fixture.Errors {
		_, err := agent.BuilderEnv(testCase.builderInput())
		if testCase.Error == nil {
			if err != nil {
				t.Errorf("error case %d: the main app accepts this, got %v", index, err)
			}
			continue
		}
		if err == nil || err.Error() != *testCase.Error {
			t.Errorf("error case %d: want %q, got %v", index, *testCase.Error, err)
		}
	}
}

func TestBuildFailureMessageMatchesTheMainApp(t *testing.T) {
	var cases []struct {
		ExitCode int      `json:"exitCode"`
		Lines    []string `json:"lines"`
		Message  string   `json:"message"`
		Method   string   `json:"method"`
	}
	loadFixture(t, "testdata/build-failure.json", &cases)
	for index, testCase := range cases {
		if got := agent.BuildFailureMessage(testCase.Method, testCase.ExitCode, testCase.Lines); got != testCase.Message {
			t.Errorf("case %d: want %q\n  got %q", index, testCase.Message, got)
		}
	}
}

func TestBuilderToolsAreEmbedded(t *testing.T) {
	if !strings.HasPrefix(agent.BuilderScript, "set -eu\n") {
		t.Error("the builder script should be embedded verbatim")
	}
	for _, method := range []string{"dockerfile", "bake", "nixpacks", "railpack", "heroku", "paketo"} {
		if !agent.IsBuildMethod(method) {
			t.Errorf("%s should be a known build method", method)
		}
		if !strings.Contains(agent.BuilderScript, method) {
			t.Errorf("the script should handle %s", method)
		}
	}
	if agent.IsBuildMethod("docker-compose") {
		t.Error("an unknown method must be refused")
	}
	for _, tool := range []string{"nixpacks", "pack", "railpack"} {
		for _, arch := range []string{"amd64", "arm64"} {
			checksum := agent.Tools.Checksums[tool][arch]
			if len(checksum.Archive) != 64 || len(checksum.Binary) != 64 {
				t.Errorf("%s/%s should carry both sha256 checksums, got %+v", tool, arch, checksum)
			}
			if !strings.Contains(agent.BuilderScript, checksum.Archive) {
				t.Errorf("%s/%s's archive checksum should be baked into the script", tool, arch)
			}
		}
	}
	if agent.Tools.HelperImage == "" || agent.Tools.ToolsVolume == "" {
		t.Errorf("the helper image and tools volume must be set, got %+v", agent.Tools)
	}
}

func TestMustParseToolsRefusesBrokenData(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("broken builder-tools.json should stop the agent at startup, not at build time")
		}
	}()
	agent.MustParseTools([]byte("{nope"))
}

func TestBuilderBuildDir(t *testing.T) {
	cases := []struct {
		context string
		want    string
		wantErr bool
	}{
		{"", "/r", false},
		{".", "/r", false},
		{"  /apps/web/  ", "/r/apps/web", false},
		{"../escape", "", true},
		{"a/../../b", "", true},
	}
	for _, testCase := range cases {
		got, err := agent.BuilderBuildDir("/r", testCase.context)
		if testCase.wantErr {
			if err == nil {
				t.Errorf("%q should be refused", testCase.context)
			}
			continue
		}
		if err != nil || got != testCase.want {
			t.Errorf("%q: want %q, got %q %v", testCase.context, testCase.want, got, err)
		}
	}
}

func TestBuilderEnvPlatform(t *testing.T) {
	input := agent.BuilderInput{Method: "dockerfile", RepoDir: "/workspace/repo", Tag: "svc:abc"}
	env, err := agent.BuilderEnv(input)
	if err != nil || slices.ContainsFunc(env, func(entry string) bool { return strings.HasPrefix(entry, "BUILD_PLATFORM=") }) {
		t.Errorf("no platform leaves the build native, got %v %v", env, err)
	}
	input.Platform = "linux/amd64"
	env, err = agent.BuilderEnv(input)
	if err != nil || !slices.Contains(env, "BUILD_PLATFORM=linux/amd64") || !slices.Contains(env, "BINFMT_IMAGE="+agent.Tools.BinfmtImage) {
		t.Errorf("got %v %v", env, err)
	}
	if !strings.Contains(agent.Tools.BinfmtImage, "@sha256:") {
		t.Errorf("the binfmt image must be pinned by digest, got %q", agent.Tools.BinfmtImage)
	}
	input.Platform = "linux/amd64; rm -rf /"
	if _, err := agent.BuilderEnv(input); err == nil {
		t.Error("a platform that isn't an os/arch pair is refused")
	}
}

func TestBuildCacheRef(t *testing.T) {
	got := agent.BuildCacheRef(agent.CacheRegistry{RegistryURL: "registry.example.com/"}, "svc:abc")
	if got != "registry.example.com/svc:buildcache" {
		t.Errorf("got %q", got)
	}
}

func TestBakeTargetName(t *testing.T) {
	if name, err := agent.BakeTargetName(""); err != nil || name != "default" {
		t.Errorf("an empty target is the default one, got %q %v", name, err)
	}
	if name, err := agent.BakeTargetName(" web "); err != nil || name != "web" {
		t.Errorf("got %q %v", name, err)
	}
	if _, err := agent.BakeTargetName("web; rm -rf /"); err == nil {
		t.Error("anything but a plain target name reaches a shell and must be refused")
	}
}

func TestTruncateRunes(t *testing.T) {
	if got := agent.TruncateRunes("héllo", 2); got != "hé" {
		t.Errorf("a multi-byte character must not be split, got %q", got)
	}
	if got := agent.TruncateRunes("hi", 5); got != "hi" {
		t.Errorf("got %q", got)
	}
}

func TestBuilderEnvNoCache(t *testing.T) {
	input := agent.BuilderInput{Method: "dockerfile", RepoDir: "/workspace/repo", Tag: "app:1"}
	cached, err := agent.BuilderEnv(input)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(cached, "NO_CACHE=1") {
		t.Error("a normal build shouldn't carry NO_CACHE")
	}
	input.NoCache = true
	fresh, err := agent.BuilderEnv(input)
	if err != nil {
		t.Fatal(err)
	}
	if fresh[len(fresh)-1] != "NO_CACHE=1" {
		t.Errorf("a fresh build should end with NO_CACHE=1, got %v", fresh)
	}
}

// runBakeScript runs the builder script's bake method against a fake docker
// CLI that answers `bake --print` with the given testdata fixture and echoes
// every other invocation, returning the combined output and the exit error.
func runBakeScript(t *testing.T, fixture string, extraEnv ...string) (string, error) {
	t.Helper()
	printed, err := filepath.Abs(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	fakeDocker := "#!/bin/sh\ncase \" $* \" in *\" --print \"*) cat \"$BAKE_PRINT\" ;; *) echo \"$@\" ;; esac\n"
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(fakeDocker), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docker-bake.hcl"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", agent.BuilderScript)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"BAKE_PRINT="+printed,
		"BUILD_METHOD=bake",
		"BUILD_DIR="+dir,
		"BUILD_FILE=docker-bake.hcl",
		"BUILD_TARGET=app",
		"IMAGE_TAG=svc:abc",
		"CACHE_REF=",
	)
	cmd.Env = append(cmd.Env, extraEnv...)
	output, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func TestBakeIgnoresCacheOnlyContextTargets(t *testing.T) {
	output, err := runBakeScript(t, "bake-print-contexts.json")
	if err != nil {
		t.Fatalf("targets pulled in as contexts aren't images to tag, got %v: %s", err, output)
	}
	want := "buildx bake --progress plain -f docker-bake.hcl --set app.tags=svc:abc --set app.output=type=docker app"
	if output != want {
		t.Errorf("want %q, got %q", want, output)
	}
}

func TestBakeRefusesAGroupOfImages(t *testing.T) {
	output, err := runBakeScript(t, "bake-print-group.json")
	if err == nil || !strings.Contains(output, "resolves to 2 targets (api web)") {
		t.Errorf("a group building two images must be refused, got %v: %s", err, output)
	}
}

func TestBuilderEnvBuildArgs(t *testing.T) {
	input := agent.BuilderInput{
		BuildArgs: map[string]string{"NEXT_PUBLIC_URL": "https://example.com", "API_KEY": "a b"},
		Method:    "dockerfile",
		RepoDir:   "/workspace/repo",
		Tag:       "app:1",
	}
	env, err := agent.BuilderEnv(input)
	if err != nil {
		t.Fatal(err)
	}
	tail := env[len(env)-3:]
	want := []string{"BUILD_ARGS=API_KEY NEXT_PUBLIC_URL", "HOMERUN_ARG_API_KEY=a b", "HOMERUN_ARG_NEXT_PUBLIC_URL=https://example.com"}
	if !slices.Equal(tail, want) {
		t.Errorf("want %v at the end, got %v", want, env)
	}
	input.BuildArgs = map[string]string{"PATH": "/nope"}
	env, err = agent.BuilderEnv(input)
	if err != nil || slices.Contains(env, "PATH=/nope") {
		t.Errorf("a build variable must not reach the script under its own name, got %v %v", env, err)
	}
	input.BuildArgs = map[string]string{"A;rm -rf /": "x"}
	if _, err := agent.BuilderEnv(input); err == nil {
		t.Error("a build variable name that isn't a shell identifier is refused")
	}
}

func TestBakePassesBuildArgs(t *testing.T) {
	output, err := runBakeScript(t, "bake-print-contexts.json",
		"BUILD_ARGS=GREETING TOKEN",
		"HOMERUN_ARG_GREETING=hello $(touch pwned) world",
		"HOMERUN_ARG_TOKEN=s3cr3t",
	)
	if err != nil {
		t.Fatalf("got %v: %s", err, output)
	}
	want := "buildx bake --progress plain -f docker-bake.hcl --set app.tags=svc:abc --set app.output=type=docker --set app.args.GREETING=hello $(touch pwned) world --set app.args.TOKEN=s3cr3t app"
	if output != want {
		t.Errorf("want %q, got %q", want, output)
	}
}
