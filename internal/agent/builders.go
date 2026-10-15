package agent

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"slices"
	"strings"
)

// BuilderScript is the shell script that runs a build inside the helper
// container, shared by the agent and the homerun worker.
//
//go:embed builder.sh
var BuilderScript string

//go:embed builder-tools.json
var builderToolsJSON []byte

// BuilderChecksum is the sha256 of a tool's release archive and of the binary
// inside it.
type BuilderChecksum struct {
	Archive string `json:"archive"`
	Binary  string `json:"binary"`
}

// BuilderTools is everything the build runs with besides the script: the
// supported methods, the tool versions and their checksums.
type BuilderTools struct {
	BakeTargetPattern string                                `json:"bakeTargetPattern"`
	BinfmtImage       string                                `json:"binfmtImage"`
	BuildMethods      []string                              `json:"buildMethods"`
	Checksums         map[string]map[string]BuilderChecksum `json:"checksums"`
	DefaultBakeFile   string                                `json:"defaultBakeFile"`
	DefaultBakeTarget string                                `json:"defaultBakeTarget"`
	HelperImage       string                                `json:"helperImage"`
	NixpacksVersion   string                                `json:"nixpacksVersion"`
	PackBuilders      map[string]string                     `json:"packBuilders"`
	PackVersion       string                                `json:"packVersion"`
	RailpackVersion   string                                `json:"railpackVersion"`
	ToolsVolume       string                                `json:"toolsVolume"`
}

// Tools is builder-tools.json, parsed once at startup.
var Tools = MustParseTools(builderToolsJSON)

// bakeTargetPattern is tools.BakeTargetPattern, compiled once.
var bakeTargetPattern = regexp.MustCompile(Tools.BakeTargetPattern)

// platformPattern is an os/arch pair, which reaches the shell as a variable.
var platformPattern = regexp.MustCompile(`^[a-z0-9]+/[a-z0-9]+$`)

// BuildArgNamePattern is a build-time variable's name: a shell identifier, so
// it can name an environment variable inside the builder container.
var BuildArgNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// buildArgEnvPrefix namespaces build-time variables inside the builder
// container, so one named like the script's own (PATH, BUILD_DIR) can't
// clobber it.
const buildArgEnvPrefix = "HOMERUN_ARG_"

// MustParseTools parses builder-tools.json, panicking on invalid data since a
// broken embed should stop the agent at startup, not at build time.
func MustParseTools(raw []byte) BuilderTools {
	var parsed BuilderTools
	if err := json.Unmarshal(raw, &parsed); err != nil {
		panic(fmt.Sprintf("builder-tools.json is invalid: %s", err))
	}
	return parsed
}

// IsBuildMethod reports whether method is one the builder knows.
func IsBuildMethod(method string) bool {
	return slices.Contains(Tools.BuildMethods, method)
}

// CacheRegistry is the registry a build imports its BuildKit layer cache from
// and exports it to.
type CacheRegistry struct {
	Password    string
	RegistryURL string
	Username    string
}

// BuilderInput is what selects and configures a build.
type BuilderInput struct {
	BakeFile string
	// BuildArgs are the service's build-time variables, handed to whichever
	// tool builds as build args (Dockerfile, bake) or build env (Nixpacks,
	// Railpack, buildpacks).
	BuildArgs      map[string]string
	BuildTarget    string
	BuildContext   string
	CacheRegistry  *CacheRegistry
	DockerfilePath string
	Method         string
	NoCache        bool
	// Platform is the os/arch the image has to run on, empty for the building
	// daemon's own.
	Platform string
	RepoDir  string
	Tag      string
}

// BuilderBuildDir is the directory the builder is pointed at: the repository,
// or the build context inside it with surrounding slashes trimmed. A context
// that climbs out with ".." is refused.
func BuilderBuildDir(repoDir, buildContext string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(buildContext), "/")
	if trimmed == "" || trimmed == "." {
		return repoDir, nil
	}
	if slices.Contains(strings.Split(trimmed, "/"), "..") {
		return "", fmt.Errorf("The build context can't leave the repository.")
	}
	return repoDir + "/" + trimmed, nil
}

// builderFilePath resolves a build definition file against the build
// directory, refusing one that resolves outside the repository.
func builderFilePath(repoDir, buildDir, file, fallback string) (string, error) {
	relative := strings.TrimLeft(strings.TrimSpace(file), "/")
	if relative == "" {
		relative = fallback
	}
	resolved := path.Clean(buildDir + "/" + relative)
	if !strings.HasPrefix(resolved, repoDir+"/") {
		return "", fmt.Errorf("The build file %s can't leave the repository.", relative)
	}
	return resolved, nil
}

// BuildCacheRef is the registry ref a service's BuildKit layer cache lives at.
func BuildCacheRef(registry CacheRegistry, tag string) string {
	return strings.TrimRight(registry.RegistryURL, "/") + "/" + strings.Split(tag, ":")[0] + ":buildcache"
}

// BakeTargetName is the bake target to build, the default when none is given.
// Anything but a plain target name is refused, since it reaches the shell.
func BakeTargetName(target string) (string, error) {
	name := strings.TrimSpace(target)
	if name == "" {
		name = Tools.DefaultBakeTarget
	}
	if !bakeTargetPattern.MatchString(name) {
		return "", fmt.Errorf(
			"The bake target %s isn't valid, use letters, digits, dashes and underscores.", name,
		)
	}
	return name, nil
}

// BuilderEnv is the builder container's environment. User input only ever
// reaches the script as variables, never spliced into the script itself.
func BuilderEnv(input BuilderInput) ([]string, error) {
	buildDir, err := BuilderBuildDir(input.RepoDir, input.BuildContext)
	if err != nil {
		return nil, err
	}
	env := map[string]string{
		"BUILD_DIR":        buildDir,
		"BUILD_METHOD":     input.Method,
		"CACHE_PASSWORD":   "",
		"CACHE_REF":        "",
		"CACHE_REGISTRY":   "",
		"CACHE_USERNAME":   "",
		"IMAGE_TAG":        input.Tag,
		"NIXPACKS_VERSION": Tools.NixpacksVersion,
		"PACK_VERSION":     Tools.PackVersion,
		"PACK_VOLUME_KEY":  strings.Split(input.Tag, ":")[0],
		"RAILPACK_VERSION": Tools.RailpackVersion,
	}
	if cache := input.CacheRegistry; cache != nil {
		env["CACHE_PASSWORD"] = cache.Password
		env["CACHE_REF"] = BuildCacheRef(*cache, input.Tag)
		env["CACHE_REGISTRY"] = cache.RegistryURL
		env["CACHE_USERNAME"] = cache.Username
	}
	if input.NoCache {
		env["NO_CACHE"] = "1"
	}
	if input.Platform != "" {
		if !platformPattern.MatchString(input.Platform) {
			return nil, fmt.Errorf("The build platform %s isn't valid, use an os/arch pair like linux/amd64.", input.Platform)
		}
		env["BINFMT_IMAGE"] = Tools.BinfmtImage
		env["BUILD_PLATFORM"] = input.Platform
	}
	if len(input.BuildArgs) > 0 {
		names := make([]string, 0, len(input.BuildArgs))
		for name := range input.BuildArgs {
			if !BuildArgNamePattern.MatchString(name) {
				return nil, fmt.Errorf(
					"The build variable %s isn't valid, use letters, digits and underscores, not starting with a digit.", name,
				)
			}
			names = append(names, name)
		}
		slices.Sort(names)
		env["BUILD_ARGS"] = strings.Join(names, " ")
		for _, name := range names {
			env[buildArgEnvPrefix+name] = input.BuildArgs[name]
		}
	}
	switch input.Method {
	case "dockerfile":
		file, err := builderFilePath(input.RepoDir, buildDir, input.DockerfilePath, "Dockerfile")
		if err != nil {
			return nil, err
		}
		env["BUILD_FILE"] = file
		if stage := strings.TrimSpace(input.BuildTarget); stage != "" {
			if !bakeTargetPattern.MatchString(stage) {
				return nil, fmt.Errorf(
					"The build target %s isn't valid, use letters, digits, dashes and underscores.", stage,
				)
			}
			env["BUILD_TARGET"] = stage
		}
	case "bake":
		file, err := builderFilePath(input.RepoDir, buildDir, input.BakeFile, Tools.DefaultBakeFile)
		if err != nil {
			return nil, err
		}
		target, err := BakeTargetName(input.BuildTarget)
		if err != nil {
			return nil, err
		}
		env["BUILD_FILE"] = file
		env["BUILD_TARGET"] = target
	case "heroku", "paketo":
		env["PACK_BUILDER"] = Tools.PackBuilders[input.Method]
	}
	return orderedEnv(env), nil
}

// envOrder is the order BuilderEnv's variables are emitted in, matching the
// main app's own builderEnv so both produce byte-identical container configs.
var envOrder = []string{
	"BUILD_DIR", "BUILD_METHOD", "CACHE_PASSWORD", "CACHE_REF", "CACHE_REGISTRY",
	"CACHE_USERNAME", "IMAGE_TAG", "NIXPACKS_VERSION", "PACK_VERSION",
	"PACK_VOLUME_KEY", "RAILPACK_VERSION", "BUILD_FILE", "BUILD_TARGET", "PACK_BUILDER", "NO_CACHE",
	"BINFMT_IMAGE", "BUILD_PLATFORM", "BUILD_ARGS",
}

// orderedEnv renders env as KEY=value strings in envOrder, followed by the
// build-time variables sorted by name.
func orderedEnv(env map[string]string) []string {
	ordered := make([]string, 0, len(env))
	for _, key := range envOrder {
		if value, ok := env[key]; ok {
			ordered = append(ordered, key+"="+value)
		}
	}
	args := []string{}
	for key := range env {
		if strings.HasPrefix(key, buildArgEnvPrefix) {
			args = append(args, key)
		}
	}
	slices.Sort(args)
	for _, key := range args {
		ordered = append(ordered, key+"="+env[key])
	}
	return ordered
}

var (
	uppercaseError = regexp.MustCompile(`\bERROR\b`)
	anyError       = regexp.MustCompile(`(?i)error`)
)

// BuildFailureMessage is a failed build's error with its most telling output
// line: the last line shouting ERROR, else the last mentioning an error, else
// the last line at all.
func BuildFailureMessage(method string, exitCode int, recentLines []string) string {
	lines := make([]string, 0, len(recentLines))
	for _, line := range recentLines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	cause := lastMatching(lines, uppercaseError)
	if cause == "" {
		cause = lastMatching(lines, anyError)
	}
	if cause == "" && len(lines) > 0 {
		cause = lines[len(lines)-1]
	}
	summary := fmt.Sprintf("The %s build failed (exit code %d)", method, exitCode)
	if cause == "" {
		return summary + "."
	}
	return summary + ": " + TruncateRunes(cause, 1000)
}

// lastMatching returns the last line matching pattern, or "" when none do.
func lastMatching(lines []string, pattern *regexp.Regexp) string {
	for index := len(lines) - 1; index >= 0; index-- {
		if pattern.MatchString(lines[index]) {
			return lines[index]
		}
	}
	return ""
}

// TruncateRunes cuts s to at most n UTF-16-ish characters the way JavaScript's
// slice does for the ASCII build output this sees, without splitting a rune.
func TruncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
