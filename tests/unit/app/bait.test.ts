import { describe, expect, test } from "bun:test";
import { baitFor, JUNK_BYTES } from "../../../src/lib/bait";

const INSULT_RE =
	/fuckyou|nice_try_dipshit|go_touch_grass|skill_issue|get_a_real_job|not_today_script_kiddie|your_mom_called|cope_harder/;

describe("baitFor", () => {
	test("a .env gets realistic-looking fake secrets", () => {
		const bait = baitFor("/.env", false);
		expect(bait?.contentType).toStartWith("text/plain");
		expect(String(bait?.body)).toMatch(/^AWS_ACCESS_KEY_ID=AKIA[A-Z2-7]{16}$/m);
		expect(String(bait?.body)).toMatch(/^STRIPE_SECRET_KEY=sk_live_\w{24}$/m);
		expect(String(bait?.body)).not.toMatch(INSULT_RE);
	});

	test("disrespect turns every secret into an insult", () => {
		const body = String(baitFor("/app/.env.production", true)?.body);
		expect(body).toMatch(
			new RegExp(`^PROD_API_KEY=(${INSULT_RE.source})$`, "m"),
		);
		expect(body).toContain("APP_ENV=production");
	});

	test("recognises the usual scanner targets, case-insensitively", () => {
		for (const path of [
			"/.git/config",
			"/blog/wp-config.php",
			"/wp-config.php.bak",
			"/.aws/credentials",
			"/.ssh/id_rsa",
			"/backup.sql",
			"/site.ZIP",
			"/db.tar.gz",
		]) {
			expect(baitFor(path, false)).not.toBeNull();
		}
		expect(baitFor("/wp-login.php", false)).toBeNull();
		expect(baitFor("/.envoy", false)).toBeNull();
	});

	test("an archive is junk bytes, spelling an insult under disrespect", () => {
		const junk = baitFor("/backup.zip", false);
		const rude = baitFor("/backup.zip", true);
		if (!junk || !rude) {
			throw new Error("an archive should get bait");
		}
		expect(junk.contentType).toBe("application/octet-stream");
		expect((junk.body as Uint8Array).length).toBe(JUNK_BYTES);
		expect(
			new TextDecoder().decode((rude.body as Uint8Array).slice(0, 64)),
		).toMatch(INSULT_RE);
	});
});
