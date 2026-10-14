export const REDACTED = "[redacted]";

const ENV_MAP_KEYS = new Set(["envVars", "vars"]);
const ARGV_KEYS = new Set(["command", "entrypoint"]);
const TEXT_KEYS = new Set([
	"command",
	"data",
	"log",
	"message",
	"metadata",
	"output",
	"trialMessage",
	"url",
]);
const SECRET_LIST_KEYS = ["secretEnvKeys", "secretKeys"];

const SECRET_NAME_PARTS = new Set([
	"APIKEY",
	"AUTH",
	"AUTHORIZATION",
	"COOKIE",
	"CREDENTIAL",
	"CREDENTIALS",
	"KEY",
	"PASS",
	"PASSPHRASE",
	"PASSWD",
	"PASSWORD",
	"PRIVATE",
	"PWD",
	"SALT",
	"SECRET",
	"SIGNING",
	"TOKEN",
]);

const NON_SECRET_LAST_PARTS = new Set([
	"DIR",
	"DISABLE",
	"DISABLED",
	"DOMAIN",
	"ENABLE",
	"ENABLED",
	"ENDPOINT",
	"FILE",
	"HEADER",
	"HOST",
	"ISSUER",
	"METHOD",
	"MODE",
	"PATH",
	"PORT",
	"PROVIDER",
	"REALM",
	"SCOPE",
	"SCOPES",
	"TYPE",
	"URI",
	"URL",
]);

const SENSITIVE_FIELDS = new Set([
	"access_token",
	"api_key",
	"apikey",
	"authorization",
	"client_secret",
	"cookie",
	"id_token",
	"passwd",
	"password",
	"private_key",
	"pwd",
	"refresh_token",
	"secret",
	"token",
]);

const SENSITIVE_QUERY_PARAMS = [
	"access_token",
	"api_key",
	"apikey",
	"auth",
	"auth_token",
	"client_secret",
	"code",
	"id_token",
	"jwt",
	"key",
	"passwd",
	"password",
	"pwd",
	"refresh_token",
	"secret",
	"session",
	"session_id",
	"sessionid",
	"sig",
	"signature",
	"state",
	"token",
	"x-amz-credential",
	"x-amz-security-token",
	"x-amz-signature",
	"x-goog-credential",
	"x-goog-signature",
];

const URL_PASSWORD_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/]+)@/gi;
const BARE_CREDENTIAL_RE =
	/(^|[\s"'(=])([\w.-]+:)([^\s:@/"']{8,})@(?=[\w-]+(?:\.[\w-]+)*\.[a-z]{2,})/gim;
const SECRET_FLAG_RE =
	/(--(?:requirepass|password|pass|masterauth)(?:=|\s+))('[^']*'|"[^"]*"|\S+)/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)(\s+)(?=[\w.~+/-]*\d)[\w.~+/-]{8,}=*/gi;
const QUERY_PARAM_RE = new RegExp(
	`([?&](?:${SENSITIVE_QUERY_PARAMS.join("|")})=)[^&#\\s"']+`,
	"gi",
);
const BARE_ASSIGNMENT_RE =
	/\b((?:access_|refresh_|id_)?token|api_?key|apikey|secret|password|passwd)=[^&\s"']+/gi;
const SECRET_FLAGS = new Set([
	"--masterauth",
	"--pass",
	"--password",
	"--requirepass",
]);
const ASSIGNMENT_RE =
	/^(\s*(?:export\s+|const\s+|let\s+|var\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*)(\S.*)$/;
const PLAIN_SCALAR_RE =
	/^["']?(?:true|false|yes|no|on|off|-?\d+(?:\.\d+)?)["']?[;,]?$/i;
const USER_TOKEN_RE = /^([^\s:/@]+):([\w~+=-]{16,})$/;
const DIGEST_PREFIX_RE = /^(?:sha\d+|md5)$/i;
const VERSION_RE = /^v?\d+(?:\.\d+)+/i;
const HOSTNAME_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,63}$/i;

/** The upper-cased parts of a name, split on `_`, `-`, `.` and camelCase. */
function nameParts(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toUpperCase()
		.split(/[^A-Z0-9]+/)
		.filter(Boolean);
}

/**
 * Whether an env var's name says it holds a secret: one of its `_`/`-`/`.`
 * separated parts (or its camelCase words) is PASS, PASSWORD, SECRET, TOKEN,
 * KEY, AUTH, COOKIE, SIGNING, CREDENTIAL, PRIVATE, SALT or the like, and its
 * last part doesn't say it only configures one (`*_AUTH_URL`,
 * `*_TOKEN_ENABLED`, `*_KEY_FILE`). `TZ`, `PORT`, `SSH_PORT` and `LOG_LEVEL`
 * stay readable, which diagnosing a service needs.
 */
export function isSecretName(name: string): boolean {
	const parts = nameParts(name);
	const last = parts.at(-1);
	if (last && NON_SECRET_LAST_PARTS.has(last)) {
		return false;
	}
	return parts.some((part) => SECRET_NAME_PARTS.has(part));
}

/** Whether a value mixes upper and lower case letters and digits. */
function mixesCaseAndDigits(value: string): boolean {
	return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

/** Whether a value looks like a random token: 24+ characters with no whitespace, mixing cases and digits, and not a URL, path, image, hostname, version, list or assignment. */
function looksLikeToken(value: string): boolean {
	return (
		value.length >= 24 &&
		!/[\s:,;]/.test(value) &&
		!/^[~./]/.test(value) &&
		!(value.includes("/") && value.includes(".")) &&
		!/=[^=]/.test(value) &&
		!VERSION_RE.test(value) &&
		!HOSTNAME_RE.test(value) &&
		mixesCaseAndDigits(value)
	);
}

/**
 * Whether a value looks like a credential whatever the name it sits under:
 * `user:<16+ letters and digits>` (basic auth, an API's id:secret pair) or a
 * standalone random-looking token.
 */
export function looksLikeCredential(value: string): boolean {
	const trimmed = value.trim();
	const pair = USER_TOKEN_RE.exec(trimmed);
	if (pair?.[1] && pair[2] && !DIGEST_PREFIX_RE.test(pair[1])) {
		return /[a-z]/i.test(pair[2]) && /\d/.test(pair[2]);
	}
	return looksLikeToken(trimmed);
}

/** Whether a name says its value is secret and the value isn't a plain boolean or number, which never hides anything. */
function secretByName(name: string, value: string): boolean {
	return isSecretName(name) && !PLAIN_SCALAR_RE.test(value.trim());
}

/**
 * A value with its inline secrets masked, the rest left readable: a URL's
 * password (`scheme://user:pass@`, or `user:token@host` without a scheme),
 * a `--requirepass`/`--password` argument, a `Bearer`/`Basic` credential, a
 * sensitive query parameter (`?code=`, `&token=`, `?X-Amz-Signature=`…) and
 * a bare `token=`/`password=`/`api_key=` assignment.
 */
export function maskInlineSecrets(value: string): string {
	return value
		.replace(URL_PASSWORD_RE, `$1${REDACTED}@`)
		.replace(BARE_CREDENTIAL_RE, `$1$2${REDACTED}@`)
		.replace(SECRET_FLAG_RE, `$1${REDACTED}`)
		.replace(AUTH_SCHEME_RE, `$1$2${REDACTED}`)
		.replace(QUERY_PARAM_RE, `$1${REDACTED}`)
		.replace(BARE_ASSIGNMENT_RE, (match) => {
			const name = match.slice(0, match.indexOf("="));
			return `${name}=${REDACTED}`;
		});
}

/**
 * A script's source or a file's content as an agent sees it: a line assigning
 * a value to a secret-looking name (`API_TOKEN=…`, `export DB_PASSWORD=…`,
 * `password: …`, `const apiKey = …`) has that value masked like an env var,
 * every other line only its inline secrets.
 */
export function maskFileText(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const match = ASSIGNMENT_RE.exec(line);
			return match?.[1] &&
				match[2] &&
				match[3] &&
				secretByName(match[2], match[3])
				? `${match[1]}${REDACTED}`
				: maskInlineSecrets(line);
		})
		.join("\n");
}

/** A cron job's files with each one's content masked by `maskFileText`. */
function redactFiles(files: unknown[]): unknown[] {
	return files.map((file) => {
		if (!file || typeof file !== "object") {
			return redactSecrets(file);
		}
		const { content, ...rest } = file as Record<string, unknown>;
		return {
			...(redactSecrets(rest) as Record<string, unknown>),
			...(typeof content === "string"
				? { content: maskFileText(content) }
				: {}),
		};
	});
}

/**
 * One env var's value as an agent sees it, fully masked when the owner marked
 * it secret, when its name says it's secret (unless the value is a plain
 * boolean or number) or when the value itself looks like a credential;
 * otherwise only its inline secrets.
 */
export function redactEnvValue(
	name: string,
	value: string,
	secretKeys: ReadonlySet<string> = new Set(),
): string {
	return secretKeys.has(name) ||
		secretByName(name, value) ||
		looksLikeCredential(value)
		? REDACTED
		: maskInlineSecrets(value);
}

/** The env var names an object marks secret, from its `secretEnvKeys` (a service, a cron job) or `secretKeys` (a config's env group). */
function markedSecret(value: Record<string, unknown>): Set<string> {
	return new Set(
		SECRET_LIST_KEYS.flatMap((key) => {
			const list = value[key];
			return Array.isArray(list)
				? list.filter((item): item is string => typeof item === "string")
				: [];
		}),
	);
}

/** An argv with the argument after a password flag, and every inline secret, masked. */
function redactArgv(argv: unknown[]): unknown[] {
	return argv.map((arg, i) => {
		if (typeof arg !== "string") {
			return arg;
		}
		const previous = argv[i - 1];
		return typeof previous === "string" &&
			SECRET_FLAGS.has(previous.toLowerCase())
			? REDACTED
			: maskInlineSecrets(arg);
	});
}

/** Whether a header, cookie or form field name carries a credential. */
function isSensitiveField(name: string): boolean {
	const lower = name.toLowerCase();
	return SENSITIVE_FIELDS.has(lower) || isSecretName(name);
}

/** Request headers, as an object or as `[name, value]` pairs, with every credential-carrying one masked. */
function redactHeaders(headers: unknown): unknown {
	if (Array.isArray(headers)) {
		return headers.map((pair) =>
			Array.isArray(pair) &&
			typeof pair[0] === "string" &&
			isSensitiveField(pair[0])
				? [pair[0], REDACTED]
				: redactSecrets(pair),
		);
	}
	if (!headers || typeof headers !== "object") {
		return redactSecrets(headers);
	}
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [
			name,
			isSensitiveField(name) ? REDACTED : redactSecrets(value),
		]),
	);
}

/** A request's query string without the leading `?`, its sensitive parameters masked. */
function redactQueryString(query: unknown): unknown {
	if (typeof query === "string") {
		return maskInlineSecrets(`?${query}`).slice(1);
	}
	return redactHeaders(query);
}

/** An env map with each value masked by `redactEnvValue`. */
function redactEnvMap(
	vars: object,
	secretKeys: ReadonlySet<string>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(vars).map(([name, envValue]) => [
			name,
			typeof envValue === "string"
				? redactEnvValue(name, envValue, secretKeys)
				: envValue,
		]),
	);
}

/** One field of an object as an agent sees it, by what its key says it holds. */
function redactField(
	key: string,
	inner: unknown,
	secretKeys: ReadonlySet<string>,
): unknown {
	if (ENV_MAP_KEYS.has(key) && inner && typeof inner === "object") {
		return redactEnvMap(inner, secretKeys);
	}
	if (ARGV_KEYS.has(key) && Array.isArray(inner)) {
		return redactArgv(inner);
	}
	if (typeof inner === "string") {
		if (SENSITIVE_FIELDS.has(key.toLowerCase()) && inner !== "") {
			return REDACTED;
		}
		if (key === "icon" && inner.startsWith("data:")) {
			return "uploaded";
		}
		if (key === "source") {
			return maskFileText(inner);
		}
		if (TEXT_KEYS.has(key)) {
			return maskInlineSecrets(inner);
		}
	}
	if (key === "headers") {
		return redactHeaders(inner);
	}
	if (key === "query_string") {
		return redactQueryString(inner);
	}
	if (key === "cookies" && inner) {
		return REDACTED;
	}
	if (key === "files" && Array.isArray(inner)) {
		return redactFiles(inner);
	}
	return redactSecrets(inner);
}

/**
 * A copy of an API body safe to hand an agent: env values masked (see
 * `redactEnvValue`, with the names marked secret next to them), password
 * arguments masked in commands, inline secrets (URL passwords, password
 * flags, bearer credentials, sensitive query parameters) masked in a shell
 * command, a URL, a log, a log message or a run's output, a script's `source`
 * and a cron job's `files` masked by `maskFileText`, an error event's
 * credential-carrying request headers, cookies and query parameters masked,
 * a `token`/`password`/`secret`-named field masked, an uploaded `data:` icon
 * replaced by "uploaded", and every encrypted `…Enc` field dropped, however
 * deep they sit.
 */
export function redactSecrets(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redactSecrets);
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	const out: Record<string, unknown> = {};
	const secretKeys = markedSecret(value as Record<string, unknown>);
	for (const [key, inner] of Object.entries(value)) {
		if (!key.endsWith("Enc")) {
			out[key] = redactField(key, inner, secretKeys);
		}
	}
	return out;
}

/** A body's text with its secrets redacted when it's JSON, only its inline secrets masked otherwise. */
export function redactText(text: string): string {
	try {
		return JSON.stringify(redactSecrets(JSON.parse(text)));
	} catch {
		return maskInlineSecrets(text);
	}
}

/**
 * The env vars `update_service` writes: the stored map with the agent's
 * changes merged in (a `null` value deletes a var), where a value the agent
 * only ever saw redacted (the whole placeholder, or a URL with its password
 * masked) keeps the stored one. Merging instead of replacing means an agent
 * that sends just the var it changes can't wipe the others.
 *
 * @throws Error when a redacted value doesn't match what's stored, rather
 *   than writing the placeholder into the service.
 */
export function mergeEnvChanges(
	sent: Record<string, unknown>,
	stored: Record<string, string>,
	secretKeys: ReadonlySet<string> = new Set(),
): Record<string, string> {
	const merged = { ...stored };
	for (const [name, value] of Object.entries(sent)) {
		if (value === null) {
			delete merged[name];
			continue;
		}
		const text = String(value);
		if (!text.includes(REDACTED)) {
			merged[name] = text;
			continue;
		}
		const current = stored[name];
		if (
			current === undefined ||
			redactEnvValue(name, current, secretKeys) !== text
		) {
			throw new Error(
				`${name} still contains "${REDACTED}": send its real value, or leave it out to keep the stored one.`,
			);
		}
	}
	return merged;
}

/**
 * A command or entrypoint `update_service` writes: an argument the agent sent
 * back redacted keeps the stored one at that position.
 *
 * @throws Error when a redacted argument has no stored one to restore.
 */
export function restoreArgv(
	sent: unknown[],
	stored: string[] | null,
): unknown[] {
	const redactedStored = stored ? redactArgv(stored) : [];
	return sent.map((arg, i) => {
		if (typeof arg !== "string" || !arg.includes(REDACTED)) {
			return arg;
		}
		if (stored && redactedStored[i] === arg) {
			return stored[i];
		}
		throw new Error(
			`Argument ${i + 1} still contains "${REDACTED}": send its real value, or send the command unchanged.`,
		);
	});
}

/**
 * A text field `update_cron_job` writes (a shell command with the default
 * `mask`, a script's source with `maskFileText`): sent back exactly as the
 * agent read it, masked parts included, it keeps the stored value.
 *
 * @throws Error when it still holds a placeholder that doesn't match what's
 *   stored, rather than writing the placeholder.
 */
export function restoreMaskedText(
	name: string,
	sent: string,
	stored: string | null,
	mask: (text: string) => string = maskInlineSecrets,
): string {
	if (!sent.includes(REDACTED)) {
		return sent;
	}
	if (stored !== null && mask(stored) === sent) {
		return stored;
	}
	throw new Error(
		`${name} still contains "${REDACTED}": send its real value, or leave it out to keep the stored one.`,
	);
}

/**
 * The files `update_cron_job` writes: a file whose content came back masked
 * keeps the stored content of the file at the same path.
 *
 * @throws Error when a masked content has no stored file at that path it
 *   matches.
 */
export function restoreFiles(
	sent: unknown[],
	stored: { content: string; path: string }[] | null,
): unknown[] {
	return sent.map((file) => {
		if (!file || typeof file !== "object") {
			return file;
		}
		const entry = file as Record<string, unknown>;
		if (typeof entry.content !== "string") {
			return file;
		}
		const previous =
			stored?.find((candidate) => candidate.path === entry.path)?.content ??
			null;
		return {
			...entry,
			content: restoreMaskedText(
				`The content of ${String(entry.path)}`,
				entry.content,
				previous,
				maskFileText,
			),
		};
	});
}
