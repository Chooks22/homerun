# Required status checks

A git-mode service can refuse to build until its CI agrees. In the service's
**Environments & Deployments → Source** section, tick **Require status checks to
pass before building** and pick the checks that must pass. The picker lists
every check name reported on the latest commits of the service's branch, read
live from the git provider: GitHub check runs and commit statuses, GitLab job
statuses plus the pipeline itself (as `pipeline`), Gitea/Forgejo commit
statuses, and Bitbucket build statuses (by key). A check that hasn't run
recently can be added by name.

![Environments & Deployments → Source's status checks, with the checks reported on the branch to pick from](images/status-checks-picker.webp)

On every deploy of that service, whatever triggered it (Deploy, the API or CLI,
a scheduled redeploy, a stack or template deploy), Homerun first resolves the
branch to a commit through the provider API and reads the checks for that exact
commit:

- every selected check passed (neutral and skipped count as passed): the build
  goes ahead, pinned to that commit even if the branch moved in the meantime,
  whether it builds on this host, a Docker connection or a Homerun Agent;
- any selected check failed or was cancelled: the deploy stops before cloning;
- checks still running: the deploy waits in the queue, looking again every 20
  seconds and logging changes into the deployment log, for up to 30 minutes,
  then gives up. It doesn't take a build server's build slot until they pass;
- a selected check that never reports, once everything else on the commit has
  finished, is treated as failed after a 3 minute grace period.

A stopped build is a failed deployment with the reason in its log, the running
revision is left untouched, and a **Status checks failed** notification goes to
the bell and to every notification channel subscribed to it, saying which checks
failed and that the build won't carry on. The provider API is called with your
connected git provider account, a token embedded in the clone URL, or
unauthenticated for a public repository on github.com, gitlab.com or
bitbucket.org. A self-hosted instance needs to be configured under Git
Providers. Agent build servers clone the branch head themselves, so a build
there isn't pinned to the checked commit.
