package cli

import (
	"flag"
	"slices"
	"time"
)

var instanceChannels = []string{"stable", "canary", "nightly"}

var deployEnvironments = []string{"canary", "stable"}

// Commands is every command the CLI has, in the order the top-level usage lists them.
var Commands = slices.Concat(baseCommands, ResourceCommands(resources), resourceExtras, redirectCommands, serviceAccountCommands, gateCommands, manifestCommands, iacCommands, adminCommands)

var baseCommands = []Command{
	{
		Name:    "login",
		Summary: "log in via a device-code flow and save the resulting API key (pass --base-url for the instance)",
		Setup: noFlags(func(env Env, _ []string) {
			Login(env.Global.BaseURL)
		}),
	},
	{
		Name:    "logout",
		Summary: "clear the saved login",
		Setup:   noFlags(func(Env, []string) { Logout() }),
	},
	{
		Name:    "update",
		Summary: "self-update the installed CLI to the newest release on a channel, never downgrading (not the instance, see `homerun instance update`)",
		Setup: func(set *flag.FlagSet) Runner {
			channel := set.String("channel", "stable", "release `channel` to update from: stable, canary or nightly")
			return func(Env, []string) {
				RequireOneOf("channel", *channel, instanceChannels)
				SelfUpdate(*channel)
			}
		},
	},

	{
		Name:    "services list",
		Summary: "list services",
		Setup: func(set *flag.FlagSet) Runner {
			options := ListFlags(set)
			return func(env Env, _ []string) { ServicesList(env.Client(), *options) }
		},
	},
	{
		Args:    "<id>",
		Name:    "services get",
		Summary: "get a service by id",
		Setup:   noFlags(func(env Env, args []string) { ServiceGet(env.Client(), serviceID(env, args[0])) }),
	},
	{
		Args:    "<id>",
		Name:    "services config",
		Summary: "print a service's settings as JSON, grouped by dashboard tab (also: services <id> config)",
		Setup:   noFlags(func(env Env, args []string) { ServiceConfig(env.Client(), serviceID(env, args[0])) }),
	},
	{
		Aliases: []string{"deploy"},
		Args:    "<id>",
		Name:    "services deploy",
		Summary: "deploy a service and wait for it, optionally switching its image tag or picking a release channel first",
		Setup: func(set *flag.FlagSet) Runner {
			tag := set.String("tag", "", "switch an image-based service to this image `tag` before deploying")
			environment := set.String("environment", "", "with release channels on, deploy the `canary|stable` one")
			return func(env Env, args []string) {
				RequireOneOf("environment", *environment, deployEnvironments)
				if *environment != "" && *tag != "" {
					Fail("--tag and --environment can't be combined.")
				}
				if *environment != "" {
					ServiceDeployEnvironment(env.Client(), serviceID(env, args[0]), *environment)
					return
				}
				ServiceDeploy(env.Client(), serviceID(env, args[0]), *tag)
			}
		},
	},
	serviceAction("start"),
	serviceAction("stop"),
	serviceAction("restart"),
	{
		Args:    "<id>",
		Name:    "services delete",
		Summary: "delete a service",
		Setup: func(set *flag.FlagSet) Runner {
			force := set.Bool("force", false, "delete Homerun's record even if the workload couldn't be removed")
			volumes := set.Bool("volumes", false, "also delete the volumes no other service mounts")
			return func(env Env, args []string) { ServiceDelete(env.Client(), serviceID(env, args[0]), *force, *volumes) }
		},
	},
	{
		Args:    "<id>",
		Name:    "services webhook",
		Summary: "show a service's push-to-deploy webhook URL and secret",
		Setup:   noFlags(func(env Env, args []string) { ServiceWebhook(env.Client(), serviceID(env, args[0])) }),
	},
	{
		Args:    "<id>",
		Name:    "services channels enable",
		Summary: "turn release channels on or change them: branch pushes deploy a <slug>-canary service, matching tags deploy this one",
		Setup: func(set *flag.FlagSet) Runner {
			branch := set.String("branch", "", "the `branch` whose pushes deploy the canary (default: the service's branch)")
			tags := set.String("tags", "", "`glob` a pushed tag must match to deploy stable (default v*)")
			canaryDomain := set.String("canary-domain", "", "a custom `domain` for the canary, empty to clear it")
			return func(env Env, args []string) {
				ChannelsConfigure(env.Client(), serviceID(env, args[0]), true, ChannelArgs{
					Branch:          *branch,
					CanaryDomain:    *canaryDomain,
					CanaryDomainSet: flagSet(set, "canary-domain"),
					TagPattern:      *tags,
				})
			}
		},
	},
	{
		Args:    "<id>",
		Name:    "services channels disable",
		Summary: "turn release channels off and delete the canary",
		Setup: noFlags(func(env Env, args []string) {
			ChannelsConfigure(env.Client(), serviceID(env, args[0]), false, ChannelArgs{})
		}),
	},
	{
		Args:    "<id>",
		Name:    "services channels status",
		Summary: "show a service's release channel settings and canary",
		Setup:   noFlags(func(env Env, args []string) { ChannelsStatus(env.Client(), serviceID(env, args[0])) }),
	},
	{
		Args:    "<id> [name]",
		Name:    "services environment",
		Summary: "name the environment its deployments are recorded under, e.g. staging; no name resets it to production",
		Setup: noFlags(func(env Env, args []string) {
			name := ""
			if len(args) > 1 {
				name = args[1]
			}
			ServiceSetEnvironment(env.Client(), serviceID(env, args[0]), name)
		}),
	},
	{
		Args:    "<id>",
		Name:    "services dependencies",
		Summary: "list what a service depends on and what depends on it (recorded, env or both)",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a table")
			return func(env Env, args []string) { DependenciesList(env.Client(), serviceID(env, args[0]), *asJSON) }
		},
	},
	{
		Args:    "<id> [dependsOnId...]",
		Name:    "services dependencies set",
		Summary: "replace the services it depends on, started before it (none clears them)",
		Setup: noFlags(func(env Env, args []string) {
			DependenciesSet(env.Client(), serviceID(env, args[0]), args[1:])
		}),
	},
	{
		Args:    "<id>",
		Name:    "services errors",
		Summary: "list the error issues its apps reported through a Sentry SDK, most recently seen first",
		Setup: func(set *flag.FlagSet) Runner {
			options := ListFlags(set)
			status := set.String("status", "", "`unresolved|resolved|ignored|all` (default unresolved)")
			return func(env Env, args []string) {
				RequireOneOf("status", *status, errorStatuses)
				ErrorsList(env.Client(), serviceID(env, args[0]), *status, *options)
			}
		},
	},
	{
		Args:    "<id> <issueId>",
		Name:    "services errors get",
		Summary: "show one error issue with its latest event and stack trace",
		Setup: func(set *flag.FlagSet) Runner {
			event := set.String("event", "", "show this retained event `id` instead of the latest")
			return func(env Env, args []string) { ErrorGet(env.Client(), serviceID(env, args[0]), args[1], *event) }
		},
	},
	{
		Args:    "<id> <issueId>",
		Name:    "services errors resolve",
		Summary: "mark an error issue resolved (a new event reopens it as a regression), or ignored or unresolved with --status",
		Setup: func(set *flag.FlagSet) Runner {
			status := set.String("status", "resolved", "`resolved|ignored|unresolved`")
			return func(env Env, args []string) {
				if *status == "" {
					Fail("--status can't be empty.")
				}
				RequireOneOf("status", *status, errorStatuses[:3])
				ErrorSetStatus(env.Client(), serviceID(env, args[0]), args[1], *status)
			}
		},
	},
	{
		Args:    "<id>",
		Name:    "services deployments",
		Summary: "list a service's latest deploy attempts, newest first: status, trigger, image, commit, error",
		Setup: func(set *flag.FlagSet) Runner {
			limit := set.Int("limit", 0, "how many `deployments`, 1 to 50 (default 10)")
			asJSON := set.Bool("json", false, "print raw JSON instead of a table")
			return func(env Env, args []string) {
				DeploymentsList(env.Client(), serviceID(env, args[0]), *limit, *asJSON)
			}
		},
	},
	{
		Args:    "<id>",
		Name:    "services revisions",
		Summary: "list a service's revisions, newest first by first deploy",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a table")
			return func(env Env, args []string) { RevisionsList(env.Client(), serviceID(env, args[0]), *asJSON) }
		},
	},
	{
		Args:    "<id>",
		Name:    "services logs",
		Summary: "print a service's logs",
		Setup: func(set *flag.FlagSet) Runner {
			tail := set.Int("tail", 0, "how many `lines` of backlog to print, 1 to 10000 (default 200)")
			follow := set.Bool("follow", false, "keep streaming new lines until interrupted")
			set.BoolVar(follow, "f", false, "shorthand for --follow")
			return func(env Env, args []string) { ServiceLogs(env.Client(), serviceID(env, args[0]), *follow, *tail) }
		},
	},
	{
		Args:    "<id> [revisionId]",
		Name:    "services rollback",
		Summary: "redeploy a revision's exact image and wait for it (default: the previous one)",
		Setup: func(set *flag.FlagSet) Runner {
			restoreConfig := set.Bool("restore-config", false, "also restore that revision's env vars, resources and networking")
			return func(env Env, args []string) {
				revisionID := ""
				if len(args) > 1 {
					revisionID = args[1]
				}
				ServiceRollback(env.Client(), serviceID(env, args[0]), revisionID, *restoreConfig)
			}
		},
	},
	{
		Args:    "<id>",
		Name:    "services scan",
		Summary: "queue a vulnerability scan of a service's deployed image",
		Setup: func(set *flag.FlagSet) Runner {
			wait := set.Bool("wait", false, "wait for the scan to finish and print its findings")
			failOn := set.String("fail-on", "", "exit non-zero at or above this `critical|high|medium|low` severity (implies --wait)")
			timeout := set.Int("timeout", 0, "give up waiting after this many `seconds`")
			asJSON := set.Bool("json", false, "print raw JSON instead of a summary")
			return func(env Env, args []string) {
				RequireOneOf("fail-on", *failOn, failOnLevels)
				RequirePositiveTimeout(*timeout)
				ServiceScan(env.Client(), serviceID(env, args[0]), ScanArgs{
					FailOn:  *failOn,
					JSON:    *asJSON,
					Timeout: time.Duration(*timeout) * time.Second,
					Wait:    *wait || *failOn != "",
				})
			}
		},
	},
	{
		Aliases: []string{"services scans"},
		Args:    "<id>",
		Name:    "services scans list",
		Summary: "list a service's image scans, newest first",
		Setup: func(set *flag.FlagSet) Runner {
			options := ListFlags(set)
			return func(env Env, args []string) { ScansList(env.Client(), serviceID(env, args[0]), *options) }
		},
	},
	{
		Args:    "<id> [scanId]",
		Name:    "services scans get",
		Summary: "show one scan's counts and findings (default: the latest)",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a summary")
			return func(env Env, args []string) {
				scanID := "latest"
				if len(args) > 1 {
					scanID = args[1]
				}
				ScanGet(env.Client(), serviceID(env, args[0]), scanID, *asJSON)
			}
		},
	},

	{
		Args:    "<id> <dir>",
		Name:    "services sourcemaps upload",
		Summary: "upload every .map file under a build directory as a release's source maps, so its browser errors show the original source",
		Setup: func(set *flag.FlagSet) Runner {
			release := set.String("release", "", "the `release` the maps belong to, the SENTRY_RELEASE the app reports (a git service's commit SHA)")
			return func(env Env, args []string) {
				if *release == "" {
					Fail("--release is required: the release the app reports its errors under.")
				}
				SourceMapsUpload(env.Client(), serviceID(env, args[0]), args[1], *release)
			}
		},
	},
	{
		Aliases: []string{"services sourcemaps"},
		Args:    "<id>",
		Name:    "services sourcemaps list",
		Summary: "list the releases a service has source maps for (the 10 most recent are kept)",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a table")
			return func(env Env, args []string) { SourceMapsList(env.Client(), serviceID(env, args[0]), *asJSON) }
		},
	},
	{
		Args:    "<id> <release>",
		Name:    "services sourcemaps delete",
		Summary: "delete one release's source maps",
		Setup:   noFlags(func(env Env, args []string) { SourceMapsDelete(env.Client(), serviceID(env, args[0]), args[1]) }),
	},

	{
		Args:    "<service>",
		Name:    "previews list",
		Summary: "list a service's open pull request previews",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a table")
			return func(env Env, args []string) { PreviewsList(env.Client(), serviceID(env, args[0]), *asJSON) }
		},
	},
	{
		Args:    "<service> <pr>",
		Name:    "previews get",
		Summary: "show one preview: URL, the revision it runs, its latest deploy",
		Setup: noFlags(func(env Env, args []string) {
			pr := RequirePR(args[1])
			PreviewGet(env.Client(), serviceID(env, args[0]), pr)
		}),
	},
	{
		Args:    "<service> <pr>",
		Name:    "previews wait",
		Summary: "wait until the preview runs that commit and is healthy, then print its URL (non-zero on failure or timeout)",
		Setup: func(set *flag.FlagSet) Runner {
			commit := set.String("commit", "", "wait until the preview runs this commit `sha`")
			timeout := set.Duration("timeout", defaultPreviewWait, "give up after this long, e.g. 20m")
			asJSON := set.Bool("json", false, "print the preview as JSON instead of its URL")
			return func(env Env, args []string) {
				pr := RequirePR(args[1])
				requireCommit(*commit)
				PreviewWait(env.Client(), serviceID(env, args[0]), pr, PreviewWaitArgs{Commit: *commit, JSON: *asJSON, Timeout: *timeout})
			}
		},
	},
	{
		Args:    "<service> <pr>",
		Name:    "previews deploy",
		Summary: "create or update an image-based service's preview at the tag CI pushed, wait until it's healthy, then print its URL (non-zero on failure or timeout)",
		Setup: func(set *flag.FlagSet) Runner {
			tag := set.String("tag", "", "the `tag` of the service's image the preview runs (required)")
			commit := set.String("commit", "", "the commit `sha` the image was built from, recorded and waited for")
			branch := set.String("branch", "", "the pull request's head `branch`, checked against the preview branch filter")
			title := set.String("title", "", "the pull request's `title`")
			timeout := set.Duration("timeout", defaultPreviewWait, "give up after this long, e.g. 20m")
			return func(env Env, args []string) {
				pr := RequirePR(args[1])
				if *tag == "" {
					Fail("--tag is required: the image tag CI pushed for the pull request.")
					return
				}
				requireCommit(*commit)
				PreviewDeploy(env.Client(), serviceID(env, args[0]), pr, PreviewDeployArgs{
					Branch: *branch, Commit: *commit, Tag: *tag, Timeout: *timeout, Title: *title,
				})
			}
		},
	},
	{
		Args:    "<service> <pr>",
		Name:    "previews delete",
		Summary: "delete a preview (a git service's next push to the pull request recreates it)",
		Setup: noFlags(func(env Env, args []string) {
			pr := RequirePR(args[1])
			PreviewDelete(env.Client(), serviceID(env, args[0]), pr)
		}),
	},
	{
		Args:    "<service> <pr>",
		Name:    "previews promote",
		Summary: "deploy the preview's exact image to <service>, no rebuild",
		Setup: func(set *flag.FlagSet) Runner {
			commit := set.String("commit", "", "refuse unless the preview runs this commit `sha`")
			wait := set.Bool("wait", false, "wait for the deploy to finish")
			timeout := set.Duration("timeout", defaultPromoteWait, "with --wait, give up after this long")
			return func(env Env, args []string) {
				pr := RequirePR(args[1])
				requireCommit(*commit)
				PreviewPromote(env.Client(), serviceID(env, args[0]), pr, PreviewPromoteArgs{Commit: *commit, Timeout: *timeout, Wait: *wait})
			}
		},
	},

	{
		Name:    "stacks list",
		Summary: "list stacks",
		Setup: func(set *flag.FlagSet) Runner {
			options := ListFlags(set)
			return func(env Env, _ []string) { StacksList(env.Client(), *options) }
		},
	},

	{
		Name:    "templates list",
		Summary: "list templates",
		Setup: func(set *flag.FlagSet) Runner {
			options := ListFlags(set)
			return func(env Env, _ []string) { TemplatesList(env.Client(), *options) }
		},
	},

	{
		Name:    "backups list",
		Summary: "list backup and restore runs, newest first: outcome, duration, size, error and, while running, the job's last progress",
		Setup: func(set *flag.FlagSet) Runner {
			options := ListFlags(set)
			volume := set.String("volume", "", "only this volume's runs, by `id|name`")
			outcome := set.String("outcome", "", "only `running|success|failed` runs")
			return func(env Env, _ []string) {
				RequireOneOf("outcome", *outcome, backupOutcomes)
				client := env.Client()
				volumeID := ""
				if *volume != "" {
					volumeID = ResolveVolume(client, *volume).ID
				}
				BackupsList(client, volumeID, *outcome, *options)
			}
		},
	},
	{
		Name:    "backups volumes",
		Summary: "list storage volumes with their backup schedule, last and next run",
		Setup: func(set *flag.FlagSet) Runner {
			options := ListFlags(set)
			return func(env Env, _ []string) { VolumesList(env.Client(), *options) }
		},
	},
	{
		Args:    "<id|name>",
		Name:    "backups run",
		Summary: "back up a volume now",
		Setup:   backupRunSetup,
	},
}

var resourceExtras = []Command{
	{
		Args:    "<id|name>",
		Name:    "volumes backup",
		Summary: "back up a volume now (same as backups run)",
		Setup:   backupRunSetup,
	},
	{
		Name:    "system stats",
		Summary: "show the host's CPU, memory, disk and GPU usage",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a summary")
			return func(env Env, _ []string) { SystemStatsShow(env.Client(), *asJSON) }
		},
	},
}

var adminCommands = []Command{
	{
		Name:    "jobs list",
		Summary: "list queue jobs (deploys, backups, cron jobs...), running first (admins only)",
		Setup: func(set *flag.FlagSet) Runner {
			options := ListFlags(set)
			status := set.String("status", "", "comma-separated `statuses`: queued, running, succeeded, failed, cancelled")
			return func(env Env, _ []string) { JobsList(env.Client(), *status, *options) }
		},
	},
	{
		Args:    "<id>",
		Name:    "jobs get",
		Summary: "show a job's status, attempts, heartbeat, last progress, error and full log",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a summary")
			return func(env Env, args []string) { JobGet(env.Client(), args[0], *asJSON) }
		},
	},

	{
		Name:    "instance status",
		Summary: "show the running version, the release channel, its latest release and whether an update can start",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a summary")
			return func(env Env, _ []string) { InstanceStatus(env.Client(), *asJSON) }
		},
	},
	{
		Name:    "instance update",
		Summary: "update the instance to the latest release on its channel (see it with `homerun instance status`, change it with `homerun instance channel`), not the CLI itself (see `homerun update`)",
		Setup: func(set *flag.FlagSet) Runner {
			wait := set.Bool("wait", true, "follow the update until the instance is back on the new version, --wait=false to return once it starts")
			timeout := set.Int("timeout", 0, "with --wait, give up after this many `seconds`")
			force := set.Bool("force", false, "update even while deploys are queued or jobs are running (homerun instance status lists them); the restart interrupts them and the new version resumes or re-runs them")
			return func(env Env, _ []string) {
				RequirePositiveTimeout(*timeout)
				InstanceUpdate(env.Client(), *wait, time.Duration(*timeout)*time.Second, *force)
			}
		},
	},
	{
		Args:    "<stable|canary|nightly>",
		Name:    "instance channel",
		Summary: "set the release channel the instance updates from (switching to a more stable one never downgrades)",
		Setup:   noFlags(func(env Env, args []string) { InstanceChannel(env.Client(), args[0]) }),
	},
}

func noFlags(run Runner) func(*flag.FlagSet) Runner {
	return func(*flag.FlagSet) Runner { return run }
}

func backupRunSetup(set *flag.FlagSet) Runner {
	wait := set.Bool("wait", false, "follow the backup's log until it finishes, non-zero exit unless it succeeded")
	timeout := set.Int("timeout", 0, "with --wait, give up after this many `seconds` (default 6h)")
	return func(env Env, args []string) {
		RequirePositiveTimeout(*timeout)
		limit := defaultBackupTimeout
		if *timeout > 0 {
			limit = time.Duration(*timeout) * time.Second
		}
		BackupRunNow(env.Client(), args[0], *wait, limit)
	}
}

func serviceID(env Env, ref string) string {
	return ResolveSlug(env.Client(), "/services", ref)
}

func serviceAction(action string) Command {
	return Command{
		Args:    "<id>",
		Name:    "services " + action,
		Summary: action + " a service",
		Setup: noFlags(func(env Env, args []string) {
			ServiceAction(env.Client(), action, serviceID(env, args[0]))
		}),
	}
}
