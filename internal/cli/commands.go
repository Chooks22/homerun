package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/orochibraru/homerun/internal/homerun"
)

const (
	defaultPollInterval        = 2 * time.Second
	defaultScanTimeout         = 30 * time.Minute
	defaultUpdatePollInterval  = 3 * time.Second
	defaultInstanceUpdateAfter = 10 * time.Minute
)

// failOnLevels are the severities --fail-on accepts, most severe first.
var failOnLevels = []string{"critical", "high", "medium", "low"}

var finishedJobStatuses = map[string]bool{
	"succeeded": true,
	"failed":    true,
	"cancelled": true,
}

// ListArgs are the shared --json/--page/--per-page/--search options of every list command.
type ListArgs struct {
	JSON    bool
	Page    int
	PerPage int
	Search  string
}

// ScanArgs are the options of `services scan`.
type ScanArgs struct {
	FailOn  string
	JSON    bool
	Timeout time.Duration
	Wait    bool
}

// SeverityCounts is one scan's findings tallied by severity.
type SeverityCounts struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Low      int `json:"low"`
	Medium   int `json:"medium"`
	Unknown  int `json:"unknown"`
}

// ImageScan is one vulnerability scan of a service's deployed image.
type ImageScan struct {
	Counts        SeverityCounts `json:"counts"`
	Digest        string         `json:"digest"`
	Error         string         `json:"error"`
	Findings      []ScanFinding  `json:"findings"`
	ID            string         `json:"id"`
	ImageRef      string         `json:"imageRef"`
	ScannedAt     string         `json:"scannedAt"`
	Status        string         `json:"status"`
	TotalFindings int            `json:"totalFindings"`
}

// ScanFinding is one vulnerability in a scan.
type ScanFinding struct {
	FixedVersion     string `json:"fixedVersion"`
	ID               string `json:"id"`
	InstalledVersion string `json:"installedVersion"`
	Pkg              string `json:"pkg"`
	Severity         string `json:"severity"`
	Title            string `json:"title"`
}

// Revision is one deployed revision of a service.
type Revision struct {
	CreatedAt      string `json:"createdAt"`
	Current        bool   `json:"current"`
	GitCommit      string `json:"gitCommit"`
	Health         string `json:"health"`
	HealthReason   string `json:"healthReason"`
	ID             string `json:"id"`
	ImageDigest    string `json:"imageDigest"`
	ImageRef       string `json:"imageRef"`
	LastDeployedAt string `json:"lastDeployedAt"`
	Previous       bool   `json:"previous"`
	Retained       bool   `json:"retained"`
}

// InstanceUpdateStatus is what the instance reports about its own version.
type InstanceUpdateStatus struct {
	Channel string `json:"channel"`
	Current string `json:"current"`
	Latest  *struct {
		Version string `json:"version"`
	} `json:"latest"`
	Preflight struct {
		Blockers []JobSummary `json:"blockers"`
		Ready    bool         `json:"ready"`
		Reason   string       `json:"reason"`
	} `json:"preflight"`
	UpdateAvailable bool `json:"updateAvailable"`
}

// JobSummary is one job as GET /jobs and an update's blockers list it.
type JobSummary struct {
	Attempts    int    `json:"attempts"`
	CreatedAt   string `json:"createdAt"`
	HeartbeatAt string `json:"heartbeatAt"`
	ID          string `json:"id"`
	ServiceID   string `json:"serviceId"`
	ServiceName string `json:"serviceName"`
	Stage       string `json:"stage"`
	Stale       bool   `json:"stale"`
	StartedAt   string `json:"startedAt"`
	Status      string `json:"status"`
	Title       string `json:"title"`
	Type        string `json:"type"`
	WorkerID    string `json:"workerId"`
}

// InstanceUpdateProgress is the update helper container's state and output.
type InstanceUpdateProgress struct {
	ExitCode *int     `json:"exitCode"`
	Log      []string `json:"log"`
	State    string   `json:"state"`
	Version  string   `json:"version"`
}

// ListQuery turns the shared list options into the API's query parameters.
func ListQuery(args ListArgs) url.Values {
	query := url.Values{}
	if args.Page > 0 {
		query.Set("page", strconv.Itoa(args.Page))
	}
	if args.PerPage > 0 {
		query.Set("perPage", strconv.Itoa(args.PerPage))
	}
	if args.Search != "" {
		query.Set("q", args.Search)
	}
	return query
}

// FindingsAtOrAbove counts scan findings at level or any more severe level,
// which is what --fail-on gates on. An "unknown" severity never counts.
func FindingsAtOrAbove(counts SeverityCounts, level string) int {
	byLevel := map[string]int{
		"critical": counts.Critical,
		"high":     counts.High,
		"medium":   counts.Medium,
		"low":      counts.Low,
	}
	total := 0
	for _, ranked := range failOnLevels {
		total += byLevel[ranked]
		if ranked == level {
			break
		}
	}
	return total
}

// countsLine renders counts as a single "N critical, N high, ..." line.
func countsLine(counts SeverityCounts) string {
	return fmt.Sprintf(
		"%d critical, %d high, %d medium, %d low, %d unknown",
		counts.Critical, counts.High, counts.Medium, counts.Low, counts.Unknown,
	)
}

// Shorten truncates value to length runes.
func Shorten(value string, length int) string {
	runes := []rune(value)
	if len(runes) <= length {
		return value
	}
	return string(runes[:length])
}

// RevisionRow flattens a revision into a table row, shortening the commit and
// digest, adding when it last went live, marking it current/previous and
// whether its image is still retained, and why it was judged unhealthy.
func RevisionRow(revision Revision) map[string]string {
	marker := ""
	if revision.Current {
		marker = "current"
	} else if revision.Previous {
		marker = "previous"
	}
	if !revision.Retained {
		marker = strings.TrimSpace(marker + " (not retained)")
	}
	return map[string]string{
		"commit":         Shorten(revision.GitCommit, 7),
		"createdAt":      revision.CreatedAt,
		"digest":         Shorten(revision.ImageDigest, 19),
		"health":         revision.Health,
		"id":             revision.ID,
		"image":          revision.ImageRef,
		"lastDeployedAt": revision.LastDeployedAt,
		"marker":         marker,
		"reason":         revision.HealthReason,
	}
}

// InstanceStatusText summarises an instance update status in a few lines: the
// running version, the channel and its latest version, then whether an update
// can start and why not.
func InstanceStatusText(status InstanceUpdateStatus) string {
	lines := []string{fmt.Sprintf("Running:  v%s", status.Current)}
	if status.Channel != "" {
		lines = append(lines, fmt.Sprintf("Channel:  %s", status.Channel))
	}
	if status.Latest == nil {
		lines = append(lines, "Latest:   unknown (couldn't reach GitHub)")
		return strings.Join(lines, "\n")
	}
	lines = append(lines, fmt.Sprintf("Latest:   v%s", status.Latest.Version))
	switch {
	case !status.UpdateAvailable:
		lines = append(lines, "Up to date.")
	case status.Preflight.Ready:
		lines = append(lines, "Update available: run `homerun instance update`.")
	default:
		reason := status.Preflight.Reason
		if reason == "" {
			reason = "unknown reason"
		}
		lines = append(lines, fmt.Sprintf("Update available, but it can't start now: %s", reason))
		if len(status.Preflight.Blockers) > 0 {
			lines = append(lines, "In the way:")
			for _, job := range status.Preflight.Blockers {
				lines = append(lines, "  "+BlockerLine(job))
			}
			lines = append(lines, "Run `homerun instance update --force` to update anyway: they resume or run again after the restart.")
		}
	}
	return strings.Join(lines, "\n")
}

// BlockerLine renders one job keeping an update from starting: STUCK first
// when no live worker is on it, then its title, service, status and stage,
// when it started and last heartbeated, and its id.
func BlockerLine(job JobSummary) string {
	parts := []string{}
	if job.Stale {
		parts = append(parts, "STUCK")
	}
	parts = append(parts, job.Title)
	if job.ServiceName != "" {
		parts = append(parts, "(service "+job.ServiceName+")")
	}
	state := job.Status
	if job.Stage != "" {
		state += "/" + job.Stage
	}
	parts = append(parts, "["+job.Type+", "+state+"]")
	if job.StartedAt != "" {
		parts = append(parts, "started "+job.StartedAt)
	}
	if job.HeartbeatAt != "" {
		parts = append(parts, "last heartbeat "+job.HeartbeatAt)
	}
	parts = append(parts, "job "+job.ID)
	return strings.Join(parts, " ")
}

// ServicesList lists services as JSON or a table, with a footer when the page is truncated.
func ServicesList(client *Client, args ListArgs) {
	var services []struct {
		CurrentStatus string `json:"currentStatus"`
		ID            string `json:"id"`
		Image         string `json:"image"`
		Name          string `json:"name"`
		Slug          string `json:"slug"`
		Tag           string `json:"tag"`
	}
	body, header := client.do("GET", "/services", ListQuery(args))
	if args.JSON {
		PrintJSON(body)
		return
	}
	if err := json.Unmarshal(body, &services); err != nil {
		Fail(err.Error())
	}
	rows := make([]map[string]string, 0, len(services))
	for _, service := range services {
		rows = append(rows, map[string]string{
			"id":     service.ID,
			"image":  fmt.Sprintf("%s:%s", service.Image, service.Tag),
			"name":   service.Name,
			"slug":   service.Slug,
			"status": service.CurrentStatus,
		})
	}
	PrintTable(rows, []string{"id", "name", "slug", "status", "image"})
	PrintPageFooter(header, len(services))
}

// ServiceGet fetches one service and prints it as JSON.
func ServiceGet(client *Client, id string) {
	body, _ := client.do("GET", "/services/"+url.PathEscape(id), nil)
	PrintJSON(body)
}

// ServiceConfig prints a service's settings as JSON, grouped the way the
// dashboard's tabs group them, with secrets left out.
func ServiceConfig(client *Client, id string) {
	body, _ := client.do("GET", "/services/"+url.PathEscape(id)+"/config", nil)
	PrintJSON(body)
}

// ServiceAction triggers a deploy, start, stop or restart on a service and prints the API's result as JSON.
func ServiceAction(client *Client, action, id string) {
	body, _ := client.do("POST", fmt.Sprintf("/services/%s/%s", url.PathEscape(id), action), nil)
	PrintJSON(body)
}

// ServiceDeploy deploys a service and waits for it, first switching an
// image-based service to tag when tag isn't empty, and prints the API's result
// as JSON. Exits non-zero when the deploy fails, which is what a CI job needs.
func ServiceDeploy(client *Client, id, tag string) {
	if tag == "" {
		ServiceAction(client, "deploy", id)
		return
	}
	var result map[string]any
	client.decodeJSON("POST", fmt.Sprintf("/services/%s/deploy", url.PathEscape(id)), map[string]string{"tag": tag}, &result)
	PrintValue(result)
}

// ServiceDelete deletes a service, the same danger-zone action as the Settings
// tab's Delete button. Exits on an API error, including the 409 the API answers
// (without force) when a job is still queued or running for the service or its
// container or swarm service couldn't be removed.
// With volumes, the volumes no other service mounts go too.
func ServiceDelete(client *Client, id string, force, volumes bool) {
	query := url.Values{}
	if force {
		query.Set("force", "true")
	}
	if volumes {
		query.Set("deleteVolumes", "true")
	}
	client.do("DELETE", "/services/"+url.PathEscape(id), query)
	PrintValue(map[string]any{"deleted": true, "id": id})
}

// ServiceWebhook fetches a service's push-to-deploy webhook URL and secret and
// prints it as JSON. Exits on an API error, including the 404 when deploy on
// push isn't turned on.
func ServiceWebhook(client *Client, id string) {
	body, _ := client.do("GET", fmt.Sprintf("/services/%s/webhook", url.PathEscape(id)), nil)
	PrintJSON(body)
}

// RevisionsList lists a service's deployed revisions, one row per revision with
// redeploys folded in, as JSON or a table.
func RevisionsList(client *Client, serviceID string, asJSON bool) {
	body, _ := client.do("GET", fmt.Sprintf("/services/%s/revisions", url.PathEscape(serviceID)), nil)
	if asJSON {
		PrintJSON(body)
		return
	}
	var revisions []Revision
	if err := json.Unmarshal(body, &revisions); err != nil {
		Fail(err.Error())
	}
	rows := make([]map[string]string, 0, len(revisions))
	for _, revision := range revisions {
		rows = append(rows, RevisionRow(revision))
	}
	PrintTable(rows, []string{
		"id", "createdAt", "lastDeployedAt", "marker", "health", "image", "commit", "digest", "reason",
	})
}

// ServiceLogs writes a service's logs to stdout: the last tail lines, or with
// follow a live stream that only ends when the connection does. Exits on an API
// error, including the 400 for a service that was never deployed.
func ServiceLogs(client *Client, id string, follow bool, tail int) {
	query := url.Values{}
	if tail > 0 {
		query.Set("tail", strconv.Itoa(tail))
	}
	if follow {
		query.Set("follow", "true")
	}
	response, err := client.send("GET", fmt.Sprintf("/services/%s/logs", url.PathEscape(id)), query)
	if err != nil {
		Fail(err.Error())
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(response.Body)
		Fail(homerun.APIErrorMessage(response.StatusCode, body))
	}
	if _, err := io.Copy(os.Stdout, response.Body); err != nil {
		Fail(err.Error())
	}
}

// ServiceRollback redeploys a service from one of its revisions, the previous
// one when revisionID is empty. With restoreConfig it also puts back the env
// vars, resources and networking that revision ran with.
func ServiceRollback(client *Client, serviceID, revisionID string, restoreConfig bool) {
	if revisionID == "" {
		revisionID = "previous"
	}
	query := url.Values{}
	if restoreConfig {
		query.Set("restoreConfig", "true")
	}
	path := fmt.Sprintf(
		"/services/%s/revisions/%s/deploy",
		url.PathEscape(serviceID), url.PathEscape(revisionID),
	)
	body, _ := client.do("POST", path, query)
	PrintJSON(body)
}

// ScansList lists a service's image scans with per-severity counts, as JSON or a table.
func ScansList(client *Client, serviceID string, args ListArgs) {
	body, header := client.do(
		"GET", fmt.Sprintf("/services/%s/scans", url.PathEscape(serviceID)), ListQuery(args),
	)
	if args.JSON {
		PrintJSON(body)
		return
	}
	var scans []ImageScan
	if err := json.Unmarshal(body, &scans); err != nil {
		Fail(err.Error())
	}
	rows := make([]map[string]string, 0, len(scans))
	for _, scan := range scans {
		rows = append(rows, map[string]string{
			"critical":  strconv.Itoa(scan.Counts.Critical),
			"high":      strconv.Itoa(scan.Counts.High),
			"id":        scan.ID,
			"image":     scan.ImageRef,
			"low":       strconv.Itoa(scan.Counts.Low),
			"medium":    strconv.Itoa(scan.Counts.Medium),
			"scannedAt": scan.ScannedAt,
			"status":    scan.Status,
		})
	}
	PrintTable(rows, []string{"id", "scannedAt", "status", "critical", "high", "medium", "low", "image"})
	PrintPageFooter(header, len(scans))
}

// ScanGet fetches and prints one scan, its summary and findings table or raw
// JSON, and returns it so serviceScan can check it against --fail-on.
func ScanGet(client *Client, serviceID, scanID string, asJSON bool) ImageScan {
	path := fmt.Sprintf("/services/%s/scans/%s", url.PathEscape(serviceID), url.PathEscape(scanID))
	body, _ := client.do("GET", path, nil)
	var scan ImageScan
	if err := json.Unmarshal(body, &scan); err != nil {
		Fail(err.Error())
	}
	if asJSON {
		PrintJSON(body)
		return scan
	}
	PrintScan(scan)
	return scan
}

// PrintScan prints a scan as a summary header followed by its findings table
// and a note when the API truncated the list.
func PrintScan(scan ImageScan) {
	fmt.Printf("Scan %s (%s, %s)\n", scan.ID, scan.Status, scan.ScannedAt)
	fmt.Printf("Image:    %s\n", scan.ImageRef)
	if scan.Digest != "" {
		fmt.Printf("Digest:   %s\n", scan.Digest)
	}
	fmt.Printf("Findings: %s\n", countsLine(scan.Counts))
	if scan.Error != "" {
		fmt.Printf("Error:    %s\n", scan.Error)
	}
	fmt.Println("")
	rows := make([]map[string]string, 0, len(scan.Findings))
	for _, finding := range scan.Findings {
		rows = append(rows, map[string]string{
			"fixed":     finding.FixedVersion,
			"id":        finding.ID,
			"installed": finding.InstalledVersion,
			"package":   finding.Pkg,
			"severity":  finding.Severity,
			"title":     finding.Title,
		})
	}
	PrintTable(rows, []string{"severity", "id", "package", "installed", "fixed", "title"})
	if scan.TotalFindings > len(scan.Findings) {
		fmt.Printf(
			"\nShowing %d of %d findings, most severe first.\n",
			len(scan.Findings), scan.TotalFindings,
		)
	}
}

// QueueScan asks the API to queue a scan job and returns the job id to poll.
// With wait, a 409 for a scan already in flight is accepted and that job is
// reused instead of failing.
func QueueScan(client *Client, serviceID string, wait bool) string {
	response, err := client.send("POST", fmt.Sprintf("/services/%s/scans", url.PathEscape(serviceID)), nil)
	if err != nil {
		Fail(err.Error())
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	var queued struct {
		JobID string `json:"jobId"`
	}
	_ = json.Unmarshal(body, &queued)
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return queued.JobID
	}
	if wait && response.StatusCode == http.StatusConflict && queued.JobID != "" {
		return queued.JobID
	}
	Fail(homerun.APIErrorMessage(response.StatusCode, body))
	return ""
}

// WaitForJob polls a job every pollEvery until it reaches a terminal status,
// exiting the process once timeout has passed.
func WaitForJob(client *Client, jobID string, pollEvery, timeout time.Duration) (string, string) {
	deadline := time.Now().Add(timeout)
	for {
		var job struct {
			Error  string `json:"error"`
			Status string `json:"status"`
		}
		client.decode("GET", "/jobs/"+url.PathEscape(jobID), nil, &job)
		if finishedJobStatuses[job.Status] {
			return job.Status, job.Error
		}
		if time.Now().After(deadline) {
			Fail(fmt.Sprintf("Timed out waiting for job %s (still %s).", jobID, job.Status))
		}
		Sleep(pollEvery)
	}
}

// ServiceScan queues an image scan. Without Wait it prints the job id and
// returns; with it, polls the job to completion, prints the latest scan and
// exits non-zero when the job didn't succeed, it timed out, or FailOn findings
// were found.
func ServiceScan(client *Client, serviceID string, args ScanArgs) {
	jobID := QueueScan(client, serviceID, args.Wait)
	if !args.Wait {
		PrintValue(map[string]any{"jobId": jobID, "status": "queued"})
		return
	}
	timeout := args.Timeout
	if timeout <= 0 {
		timeout = defaultScanTimeout
	}
	status, jobError := WaitForJob(client, jobID, defaultPollInterval, timeout)
	if status != "succeeded" {
		if jobError == "" {
			jobError = "no reason given"
		}
		Fail(fmt.Sprintf("Scan %s: %s", status, jobError))
	}
	scan := ScanGet(client, serviceID, "latest", args.JSON)
	if args.FailOn == "" {
		return
	}
	found := FindingsAtOrAbove(scan.Counts, args.FailOn)
	if found > 0 {
		noun := "findings"
		if found == 1 {
			noun = "finding"
		}
		Fail(fmt.Sprintf(
			"%d %s at or above %s (--fail-on %s).",
			found, noun, strings.ToUpper(args.FailOn), args.FailOn,
		))
	}
}

// InstanceStatus prints the instance's running version, the latest release and
// whether an update could start now, as JSON or a short summary.
func InstanceStatus(client *Client, asJSON bool) {
	body, _ := client.do("GET", "/instance/update", nil)
	if asJSON {
		PrintJSON(body)
		return
	}
	var status InstanceUpdateStatus
	if err := json.Unmarshal(body, &status); err != nil {
		Fail(err.Error())
	}
	fmt.Println(InstanceStatusText(status))
}

// InstanceChannel sets the release channel the instance updates from, "stable",
// "canary" or "nightly", and prints what it's now on. Exits on an unknown channel before
// calling the API, or on an API error.
func InstanceChannel(client *Client, channel string) {
	if channel != "stable" && channel != "canary" && channel != "nightly" {
		Fail(fmt.Sprintf("unknown channel %q: use stable, canary or nightly.", channel))
	}
	var saved struct {
		Channel string `json:"channel"`
	}
	client.decodeJSON("PATCH", "/instance/update/channel", map[string]string{"channel": channel}, &saved)
	fmt.Printf("Channel set to %s.\n", saved.Channel)
	if saved.Channel != "nightly" {
		fmt.Printf("Running a less stable build? Updates resume once a %s release is newer.\n", saved.Channel)
	}
}

// InstanceUpdate starts a self-update of the instance, the same as the
// sidebar's Update now; with force, even over queued deploys and running
// jobs, which the restart interrupts and the new version resumes. With wait, follows the update helper's output from
// GET /instance/update/progress until the instance answers with the new
// version, treating failed requests as the restart in progress. Exits on an
// API error (a 409 carries why it can't update), when the helper exits
// non-zero, or once the wait times out.
func InstanceUpdate(client *Client, wait bool, timeout time.Duration, force bool) {
	var started struct {
		Version string `json:"version"`
	}
	client.decodeJSON("POST", "/instance/update", map[string]bool{"force": force}, &started)
	if started.Version == "" {
		Fail("The instance didn't say which version it's updating to.")
		return
	}
	fmt.Printf("Updating to v%s.\n", started.Version)
	if !wait {
		return
	}
	if timeout <= 0 {
		timeout = defaultInstanceUpdateAfter
	}
	deadline := time.Now().Add(timeout)
	printed := 0
	restarting := false
	for {
		Sleep(defaultUpdatePollInterval)
		var progress InstanceUpdateProgress
		if getOrFalse(client, "/instance/update/progress", &progress) {
			restarting = false
			if progress.Version == started.Version {
				printed = printNewLines(progress.Log, printed)
				if progress.State == "exited" && progress.ExitCode != nil && *progress.ExitCode != 0 {
					Fail(fmt.Sprintf(
						"The update helper failed (exit %d). Check `docker logs homerun-updater` on the host.",
						*progress.ExitCode,
					))
				}
			}
		} else if !restarting {
			restarting = true
			fmt.Println("Waiting for Homerun to come back...")
		}
		if current := CurrentVersionOrEmpty(client); current == started.Version {
			fmt.Printf("Homerun is now on v%s.\n", started.Version)
			return
		}
		if time.Now().After(deadline) {
			Fail(fmt.Sprintf(
				"Timed out waiting for v%s. Check `docker logs homerun-updater` on the host.",
				started.Version,
			))
		}
	}
}

// printNewLines prints the lines of log past the first printed ones and
// returns how many have been printed now.
func printNewLines(log []string, printed int) int {
	for _, line := range log[min(printed, len(log)):] {
		fmt.Println("  " + line)
	}
	return max(printed, len(log))
}

// CurrentVersionOrEmpty reads the instance's running version, treating any
// failure as the restart still being in progress.
func CurrentVersionOrEmpty(client *Client) string {
	var status InstanceUpdateStatus
	if !getOrFalse(client, "/instance/update", &status) {
		return ""
	}
	return status.Current
}

// getOrFalse GETs path and decodes its JSON body into out, reporting false
// instead of exiting on any failure, for polling an instance that may be
// restarting.
func getOrFalse(client *Client, path string, out any) bool {
	response, err := client.send("GET", path, nil)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		return false
	}
	return json.Unmarshal(body, out) == nil
}

// StacksList lists stacks as JSON or a table, with a footer when the page is truncated.
func StacksList(client *Client, args ListArgs) {
	body, header := client.do("GET", "/stacks", ListQuery(args))
	if args.JSON {
		PrintJSON(body)
		return
	}
	var stacks []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Slug string `json:"slug"`
	}
	if err := json.Unmarshal(body, &stacks); err != nil {
		Fail(err.Error())
	}
	rows := make([]map[string]string, 0, len(stacks))
	for _, stack := range stacks {
		rows = append(rows, map[string]string{"id": stack.ID, "name": stack.Name, "slug": stack.Slug})
	}
	PrintTable(rows, []string{"id", "name", "slug"})
	PrintPageFooter(header, len(stacks))
}

// TemplatesList lists templates as JSON or a table, with a footer when the page is truncated.
func TemplatesList(client *Client, args ListArgs) {
	body, header := client.do("GET", "/templates", ListQuery(args))
	if args.JSON {
		PrintJSON(body)
		return
	}
	var templates []struct {
		ID    string `json:"id"`
		Image string `json:"image"`
		Name  string `json:"name"`
		Tag   string `json:"tag"`
	}
	if err := json.Unmarshal(body, &templates); err != nil {
		Fail(err.Error())
	}
	rows := make([]map[string]string, 0, len(templates))
	for _, template := range templates {
		rows = append(rows, map[string]string{
			"id":    template.ID,
			"image": fmt.Sprintf("%s:%s", template.Image, template.Tag),
			"name":  template.Name,
		})
	}
	PrintTable(rows, []string{"id", "name", "image"})
	PrintPageFooter(header, len(templates))
}

// Sleep pauses between polls. A variable so tests can make polling instant.
var Sleep = func(d time.Duration) {
	time.Sleep(d)
}
