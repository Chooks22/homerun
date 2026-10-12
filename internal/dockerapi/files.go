package dockerapi

import (
	"context"
	"fmt"
	"path"
	"strings"
)

const fileEnvPrefix = "HOMERUN_FILE_"

// File is a text file a one-off container gets written before its own
// process starts.
type File struct {
	Content string `json:"content"`
	Path    string `json:"path"`
}

// WithFiles rewrites config so its container writes config.Files before
// running what it would have run: the entrypoint becomes a /bin/sh script that
// creates each file from its own HOMERUN_FILE_<n> variable, unsets them and
// execs the original argv (the configured or image entrypoint, then the
// configured or image command). Docker's archive API is avoided on purpose: on
// a never-started container it has hung the daemon. The image needs /bin/sh.
func WithFiles(config OneOffConfig, image ImageConfig) OneOffConfig {
	if len(config.Files) == 0 {
		return config
	}
	entrypoint, cmd := config.Entrypoint, config.Cmd
	if len(entrypoint) == 0 {
		entrypoint = image.Entrypoint
		if len(cmd) == 0 {
			cmd = image.Cmd
		}
	}
	argv := append(append([]string{}, entrypoint...), cmd...)
	env := append([]string{}, config.Env...)
	for i, file := range config.Files {
		env = append(env, fmt.Sprintf("%s%d=%s", fileEnvPrefix, i, file.Content))
	}
	config.Entrypoint = []string{"/bin/sh", "-c", FilesScript(config.Files), "homerun-files"}
	config.Cmd = argv
	config.Env = env
	return config
}

// FilesScript is the sh script WithFiles runs ahead of the container's own
// process: it fails on the first file it can't write.
func FilesScript(files []File) string {
	var script strings.Builder
	script.WriteString("set -e\n")
	for i, file := range files {
		variable := fmt.Sprintf("%s%d", fileEnvPrefix, i)
		fmt.Fprintf(&script, "mkdir -p %s\n", shellQuote(path.Dir(file.Path)))
		fmt.Fprintf(&script, "printf '%%s' \"$%s\" > %s\n", variable, shellQuote(file.Path))
		fmt.Fprintf(&script, "unset %s\n", variable)
	}
	script.WriteString("exec \"$@\"\n")
	return script.String()
}

// shellQuote single-quotes value for sh.
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// withImageFiles applies WithFiles against config.Image's own entrypoint and
// command, inspecting the image only when there are files to write.
func (c *Client) withImageFiles(ctx context.Context, config OneOffConfig) (OneOffConfig, error) {
	if len(config.Files) == 0 {
		return config, nil
	}
	inspected, err := c.InspectImage(ctx, config.Image)
	if err != nil {
		return config, err
	}
	return WithFiles(config, inspected.Config.ImageConfig), nil
}
