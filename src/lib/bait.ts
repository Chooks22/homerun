export interface BaitResponse {
	body: string | Uint8Array<ArrayBuffer>;
	contentType: string;
}

export const JUNK_BYTES = 512 * 1024;

const INSULTS = [
	"fuckyou",
	"nice_try_dipshit",
	"go_touch_grass",
	"skill_issue",
	"get_a_real_job",
	"not_today_script_kiddie",
	"your_mom_called",
	"cope_harder",
];

const ALPHANUMERIC =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

type Value = (fake: string) => string;

function pick<T>(items: T[]): T {
	return items[Math.floor(Math.random() * items.length)] as T;
}

function random(length: number, alphabet = ALPHANUMERIC): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/** A random insult from the list Disrespect mode uses. */
export function insult(): string {
	return pick(INSULTS);
}

function envFile(value: Value): string {
	return [
		"APP_ENV=production",
		"APP_DEBUG=false",
		`APP_KEY=${value(`base64:${btoa(random(32))}`)}`,
		"DB_HOST=10.0.3.12",
		"DB_USERNAME=prod_admin",
		`DB_PASSWORD=${value(random(20))}`,
		`AWS_ACCESS_KEY_ID=${value(`AKIA${random(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`)}`,
		`AWS_SECRET_ACCESS_KEY=${value(random(40))}`,
		`STRIPE_SECRET_KEY=${value(`sk_live_${random(24)}`)}`,
		`PROD_API_KEY=${value(random(32))}`,
		"",
	].join("\n");
}

function gitConfig(value: Value): string {
	return [
		"[core]",
		"\trepositoryformatversion = 0",
		"\tfilemode = true",
		"\tbare = false",
		'[remote "origin"]',
		`\turl = https://deploy:${value(`ghp_${random(36)}`)}@github.com/acme/platform.git`,
		"\tfetch = +refs/heads/*:refs/remotes/origin/*",
		'[branch "main"]',
		"\tremote = origin",
		"\tmerge = refs/heads/main",
		"",
	].join("\n");
}

function phpConfig(value: Value): string {
	return [
		"<?php",
		"define( 'DB_NAME', 'wp_prod' );",
		"define( 'DB_USER', 'wp_admin' );",
		`define( 'DB_PASSWORD', '${value(random(20))}' );`,
		"define( 'DB_HOST', 'localhost' );",
		`define( 'AUTH_KEY', '${value(random(64))}' );`,
		`define( 'SECURE_AUTH_KEY', '${value(random(64))}' );`,
		"$table_prefix = 'wp_';",
		"",
	].join("\n");
}

function awsCredentials(value: Value): string {
	return [
		"[default]",
		`aws_access_key_id = ${value(`AKIA${random(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`)}`,
		`aws_secret_access_key = ${value(random(40))}`,
		"region = eu-west-1",
		"",
	].join("\n");
}

function privateKey(disrespect: boolean): string {
	const body = disrespect
		? btoa(`${insult()} `.repeat(120))
		: btoa(random(1200));
	const lines = body.match(/.{1,64}/g) ?? [];
	return [
		"-----BEGIN OPENSSH PRIVATE KEY-----",
		...lines,
		"-----END OPENSSH PRIVATE KEY-----",
		"",
	].join("\n");
}

function sqlDump(value: Value): string {
	const rows = Array.from(
		{ length: 50 },
		(_, i) =>
			`(${i + 1},'user${i + 1}@example.com','$2y$10$${value(random(53))}')`,
	);
	return [
		"-- MySQL dump 10.13  Distrib 8.0.36",
		"CREATE TABLE `users` (`id` int NOT NULL, `email` varchar(255), `password` varchar(255));",
		`INSERT INTO \`users\` VALUES ${rows.join(",")};`,
		"",
	].join("\n");
}

function junk(disrespect: boolean): Uint8Array<ArrayBuffer> {
	if (!disrespect) {
		return crypto.getRandomValues(new Uint8Array(JUNK_BYTES));
	}
	const text = new TextEncoder().encode(`${insult()} `);
	const bytes = new Uint8Array(JUNK_BYTES);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = text[i % text.length] as number;
	}
	return bytes;
}

const TEXT = "text/plain; charset=utf-8";

const BAITS: {
	pattern: RegExp;
	respond: (value: Value, disrespect: boolean) => BaitResponse;
}[] = [
	{
		pattern: /(?:^|\/)\.env(?:\.[\w.-]+)?$/i,
		respond: (value) => ({ body: envFile(value), contentType: TEXT }),
	},
	{
		pattern: /(?:^|\/)\.git\/config$/i,
		respond: (value) => ({ body: gitConfig(value), contentType: TEXT }),
	},
	{
		pattern: /(?:^|\/)(?:wp-config|config|settings|database)\.php(?:\.\w+)?$/i,
		respond: (value) => ({ body: phpConfig(value), contentType: TEXT }),
	},
	{
		pattern: /(?:^|\/)\.aws\/credentials$/i,
		respond: (value) => ({ body: awsCredentials(value), contentType: TEXT }),
	},
	{
		pattern: /(?:^|\/)id_(?:rsa|ed25519|ecdsa|dsa)$/i,
		respond: (_value, disrespect) => ({
			body: privateKey(disrespect),
			contentType: TEXT,
		}),
	},
	{
		pattern: /\.sql$/i,
		respond: (value) => ({ body: sqlDump(value), contentType: TEXT }),
	},
	{
		pattern: /\.(?:zip|tar|tgz|gz|bz2|7z|rar|bak|backup|dump|old)$/i,
		respond: (_value, disrespect) => ({
			body: junk(disrespect),
			contentType: "application/octet-stream",
		}),
	},
];

/**
 * A fake file for a scanner asking for a secret-shaped `path` (an `.env`, a
 * `.git/config`, a WordPress config, AWS credentials, an SSH key, a database
 * dump or an archive), null when `path` isn't one. The secrets look real but
 * are random; with `disrespect` every one of them is an insult instead, and an
 * archive's junk bytes spell one out.
 */
export function baitFor(
	path: string,
	disrespect: boolean,
): BaitResponse | null {
	const bait = BAITS.find((entry) => entry.pattern.test(path));
	if (!bait) {
		return null;
	}
	const value: Value = disrespect ? () => insult() : (fake) => fake;
	return bait.respond(value, disrespect);
}
