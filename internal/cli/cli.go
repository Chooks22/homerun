// Package cli is the homerun command-line client for the Homerun REST API.
package cli

import (
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	"github.com/orochibraru/homerun/internal/buildinfo"
)

// GlobalFlags are the --base-url/--api-key overrides every command accepts,
// before or after the subcommand.
type GlobalFlags struct {
	APIKey  string
	BaseURL string
}

// Env is what a command runs against: the global flags and a lazy client, so
// a command that fails on its arguments never needs a login.
type Env struct {
	Client func() *Client
	Global GlobalFlags
}

// Runner runs a command with its positional arguments, already checked
// against the command's Args.
type Runner func(env Env, args []string)

// Command is one CLI command. Everything the CLI prints about it (the
// top-level usage, `--help`, a missing-argument error) is generated from it:
// Name is the full command ("services deploy"), Aliases other full names it
// answers to, Args its positional synopsis (<required>, then [optional], then
// one last [variadic...]), Summary one line saying what it does, and Setup
// registers its flags and returns the Runner reading them.
type Command struct {
	Aliases []string
	Args    string
	Name    string
	Setup   func(set *flag.FlagSet) Runner
	Summary string
}

// Arg is one positional argument parsed from a Command's Args.
type Arg struct {
	Name     string
	Required bool
	Variadic bool
}

type option struct {
	description string
	name        string
}

var groupAliases = map[string]string{"backup": "backups", "job": "jobs", "service": "services", "service-account": "service-accounts"}

// Exit ends the process with a status code; tests swap it to observe a help exit.
var Exit = os.Exit

// Main runs homerun-cli with the process's own arguments, exiting non-zero on failure.
func Main() {
	global, rest := SplitGlobalFlags(os.Args[1:])
	if len(rest) == 0 || IsHelp(rest[0]) {
		fmt.Print(Usage())
		return
	}
	Execute(NewEnv(global), rest)
}

// NewEnv is the Env of a real run: its client comes from the global flags or the saved login.
func NewEnv(global GlobalFlags) Env {
	return Env{Client: func() *Client { return RequireClient(global.BaseURL, global.APIKey) }, Global: global}
}

// Execute resolves a command from args and runs it, printing its help instead
// when --help is anywhere in its arguments, or a group's help after a group.
// It fails on an unknown command, a bad flag or a missing argument.
func Execute(env Env, args []string) {
	args = slices.Clone(args)
	if alias, found := groupAliases[args[0]]; found {
		args[0] = alias
	}
	if len(args) >= 3 && args[0] == "services" && args[2] == "config" {
		args[1], args[2] = args[2], args[1]
	}

	command, rest := Lookup(args)
	if command == nil {
		runGroup(args)
		return
	}
	if slices.ContainsFunc(rest, IsHelp) {
		fmt.Print(CommandHelp(*command))
		Exit(0)
		return
	}
	set := NewFlagSet(command.Name)
	run := command.Setup(set)
	positionals := Parse(set, rest)
	checkArgs(*command, positionals)
	run(env, positionals)
}

// Lookup finds the command the leading words of args name, the longest match
// first, and returns it with the arguments after its name, nil when none does.
func Lookup(args []string) (*Command, []string) {
	words := 0
	for words < len(args) && words < 3 && !strings.HasPrefix(args[words], "-") {
		words++
	}
	for count := words; count > 0; count-- {
		name := strings.Join(args[:count], " ")
		for index := range Commands {
			if Commands[index].Name == name || slices.Contains(Commands[index].Aliases, name) {
				return &Commands[index], args[count:]
			}
		}
	}
	return nil, args
}

func runGroup(args []string) {
	group := ""
	for count := 1; count <= len(args) && !strings.HasPrefix(args[count-1], "-"); count++ {
		if name := strings.Join(args[:count], " "); len(groupCommands(name)) > 0 {
			group = name
		}
	}
	if group == "" {
		Fail(fmt.Sprintf("unknown command %q. Run `homerun --help` to see what's available.", args[0]))
		return
	}
	next := ""
	if words := len(strings.Fields(group)); words < len(args) {
		next = args[words]
	}
	switch {
	case IsHelp(next):
		fmt.Print(GroupHelp(group))
		Exit(0)
	case next == "":
		Fail(fmt.Sprintf("missing %s subcommand. Run `homerun %s --help` to see what's available.", group, group))
	default:
		Fail(fmt.Sprintf("unknown %s subcommand %q. Run `homerun %s --help` to see what's available.", group, next, group))
	}
}

func groupCommands(group string) []Command {
	commands := []Command{}
	for _, command := range Commands {
		if strings.HasPrefix(command.Name, group+" ") {
			commands = append(commands, command)
		}
	}
	return commands
}

// ParseArgs parses a Command's Args synopsis, failing on anything but
// <required> names, then [optional] ones, then at most one last [variadic...].
func ParseArgs(synopsis string) ([]Arg, error) {
	args := []Arg{}
	for _, token := range strings.Fields(synopsis) {
		var arg Arg
		switch {
		case strings.HasPrefix(token, "<") && strings.HasSuffix(token, ">"):
			arg = Arg{Name: token[1 : len(token)-1], Required: true}
		case strings.HasPrefix(token, "[") && strings.HasSuffix(token, "...]"):
			arg = Arg{Name: token[1 : len(token)-4], Variadic: true}
		case strings.HasPrefix(token, "[") && strings.HasSuffix(token, "]"):
			arg = Arg{Name: token[1 : len(token)-1]}
		default:
			return nil, fmt.Errorf("%q is neither <required>, [optional] nor [variadic...]", token)
		}
		if arg.Name == "" {
			return nil, fmt.Errorf("%q has no name", token)
		}
		if len(args) > 0 {
			last := args[len(args)-1]
			if last.Variadic {
				return nil, fmt.Errorf("%q comes after the variadic [%s...]", token, last.Name)
			}
			if arg.Required && !last.Required {
				return nil, fmt.Errorf("required %q comes after an optional argument", token)
			}
		}
		args = append(args, arg)
	}
	return args, nil
}

func checkArgs(command Command, positionals []string) {
	args, err := ParseArgs(command.Args)
	if err != nil {
		Fail(fmt.Sprintf("%s: %s", command.Name, err))
		return
	}
	for index, arg := range args {
		if arg.Required && (index >= len(positionals) || positionals[index] == "") {
			Fail(fmt.Sprintf("missing <%s>. Run `homerun %s --help` to see the usage.", arg.Name, command.Name))
			return
		}
	}
	if len(positionals) > len(args) && (len(args) == 0 || !args[len(args)-1].Variadic) {
		Fail(fmt.Sprintf("unexpected argument %q. Run `homerun %s --help` to see the usage.", positionals[len(args)], command.Name))
	}
}

// Synopsis is a command's name and arguments, then every flag it accepts.
func Synopsis(command Command) string {
	parts := []string{command.Name}
	if command.Args != "" {
		parts = append(parts, command.Args)
	}
	for _, option := range options(command) {
		parts = append(parts, "["+option.name+"]")
	}
	return strings.Join(parts, " ")
}

func options(command Command) []option {
	set := NewFlagSet(command.Name)
	command.Setup(set)
	all := []option{}
	set.VisitAll(func(f *flag.Flag) {
		kind, description := flag.UnquoteUsage(f)
		name := "--" + f.Name
		if len(f.Name) == 1 {
			name = "-" + f.Name
		}
		if kind != "" {
			name += " <" + kind + ">"
		}
		if !slices.Contains([]string{"", "0", "false", "0s"}, f.DefValue) {
			description += fmt.Sprintf(" (default %s)", f.DefValue)
		}
		all = append(all, option{description: description, name: name})
	})
	return all
}

// CommandHelp is what `<command> --help` prints: the synopsis, the summary,
// the aliases and every flag with its description and default.
func CommandHelp(command Command) string {
	var builder strings.Builder
	builder.WriteString("Usage: homerun " + Synopsis(command) + "\n\n" + command.Summary + "\n")
	if len(command.Aliases) > 0 {
		builder.WriteString("\nAlso: homerun " + strings.Join(command.Aliases, ", homerun ") + "\n")
	}
	if all := options(command); len(all) > 0 {
		builder.WriteString("\nOptions:\n")
		for _, option := range all {
			builder.WriteString(helpLine(option.name, option.description))
		}
	}
	builder.WriteString("\nRun `homerun --help` for the global options and every command.\n")
	return builder.String()
}

// GroupHelp is what `<group> --help` prints: every command in the group.
func GroupHelp(group string) string {
	var builder strings.Builder
	builder.WriteString("Usage: homerun " + group + " <command> [options]\n\nCommands:\n")
	for _, command := range groupCommands(group) {
		builder.WriteString(commandLine(command))
	}
	builder.WriteString("\nRun `homerun " + group + " <command> --help` for a command's options.\n")
	return builder.String()
}

func commandLine(command Command) string {
	name := strings.TrimSpace(command.Name + " " + command.Args)
	if len(options(command)) > 0 {
		name += " [options]"
	}
	summary := command.Summary
	if len(command.Aliases) > 0 {
		summary += " (also: " + strings.Join(command.Aliases, ", ") + ")"
	}
	return helpLine(name, summary)
}

func helpLine(name, description string) string {
	if len(name) > 31 {
		return fmt.Sprintf("  %s\n  %-31s %s\n", name, "", description)
	}
	return fmt.Sprintf("  %-31s %s\n", name, description)
}

// Usage is the CLI's top-level help, printed with no arguments or --help:
// the ungrouped commands, then one line per group naming its subcommands.
func Usage() string {
	var builder strings.Builder
	builder.WriteString("homerun - CLI for the Homerun REST API.\n\n" +
		"Usage: homerun [--base-url <url>] [--api-key <key>] <command> [options]\n\nCommands:\n")
	seen := map[string]bool{}
	for _, command := range Commands {
		group, _, grouped := strings.Cut(command.Name, " ")
		if !grouped {
			builder.WriteString(commandLine(command))
			continue
		}
		if seen[group] {
			continue
		}
		seen[group] = true
		names := []string{}
		for _, sub := range groupCommands(group) {
			name, _, _ := strings.Cut(strings.TrimPrefix(sub.Name, group+" "), " ")
			if !slices.Contains(names, name) {
				names = append(names, name)
			}
		}
		builder.WriteString(helpLine(group+" <command>", strings.Join(names, ", ")))
	}
	builder.WriteString("\nGlobal options:\n" +
		helpLine("--base-url <url>", "instance URL, overrides the saved login (or HOMERUN_BASE_URL)") +
		helpLine("--api-key <key>", "API key, overrides the saved login (or HOMERUN_API_KEY)") +
		helpLine("-v, --version", "print the CLI version") +
		helpLine("-h, --help", "print this help, or a command's or group's own after it") +
		"\nRun `homerun <command> --help` for a command's or group's own help.\n\n" +
		"Auth/target: run `homerun login` once (stores your instance URL and a\n" +
		"CLI-scoped API key in ~/.config/homerun/config.json), or override per-call\n" +
		"with --base-url/--api-key above or their HOMERUN_BASE_URL/HOMERUN_API_KEY\n" +
		"env var equivalents.\n")
	return builder.String()
}

// SplitGlobalFlags pulls --base-url/--api-key (and --version) out of the
// argument list wherever they appear, so they work before or after the
// subcommand, and returns everything else in order. --help stays in, so the
// command it follows prints its own help.
func SplitGlobalFlags(args []string) (GlobalFlags, []string) {
	global := GlobalFlags{}
	rest := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		value := ""
		inline := false
		name := arg
		if equals := strings.Index(arg, "="); strings.HasPrefix(arg, "--") && equals != -1 {
			name, value, inline = arg[:equals], arg[equals+1:], true
		}
		takeValue := func() string {
			if inline {
				return value
			}
			if index+1 < len(args) {
				index++
				return args[index]
			}
			Fail(fmt.Sprintf("%s needs a value", name))
			return ""
		}
		switch name {
		case "--base-url":
			global.BaseURL = takeValue()
		case "--api-key":
			global.APIKey = takeValue()
		case "-v", "--version":
			fmt.Println(buildinfo.Version)
			os.Exit(0)
		default:
			rest = append(rest, arg)
		}
	}
	return global, rest
}

// IsHelp reports whether an argument asks for help.
func IsHelp(arg string) bool {
	return arg == "-h" || arg == "--help" || arg == "-help"
}

// NewFlagSet builds a flag set that reports a bad flag the same way every other
// CLI error is reported, rather than dumping Go's own usage block.
func NewFlagSet(name string) *flag.FlagSet {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.SetOutput(io.Discard)
	set.Usage = func() {}
	return set
}

// Parse parses one subcommand's flags and returns its positional arguments.
// Go's flag package stops at the first non-flag argument, so this resumes after
// each positional: `services scans list <id> --json` has to work, not just
// `--json <id>`.
func Parse(set *flag.FlagSet, args []string) []string {
	positionals := []string{}
	for len(args) > 0 {
		if err := set.Parse(args); err != nil {
			Fail(err.Error())
		}
		rest := set.Args()
		if len(rest) == 0 {
			break
		}
		positionals = append(positionals, rest[0])
		args = rest[1:]
	}
	return positionals
}

// ListFlags registers the shared list options on a flag set.
func ListFlags(set *flag.FlagSet) *ListArgs {
	args := &ListArgs{}
	set.BoolVar(&args.JSON, "json", false, "print raw JSON instead of a table")
	set.IntVar(&args.Page, "page", 0, "1-based page `number` (default 1)")
	set.IntVar(&args.PerPage, "per-page", 0, "items per page, at most 100 (default 100)")
	set.StringVar(&args.Search, "search", "", "only rows matching this `term`")
	return args
}

// RequirePositiveTimeout rejects a negative --timeout, which would otherwise
// silently fall back to the default wait rather than failing.
func RequirePositiveTimeout(seconds int) {
	if seconds < 0 {
		Fail("--timeout can't be negative.")
	}
}

// RequireOneOf fails unless value is empty or one of allowed, naming the flag it came from.
func RequireOneOf(flagName, value string, allowed []string) {
	if value != "" && !slices.Contains(allowed, value) {
		Fail(fmt.Sprintf("--%s must be one of %s", flagName, strings.Join(allowed, ", ")))
	}
}
