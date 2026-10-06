import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { AMZ_USER_AGENT, USER_AGENT } from "./constants.ts";
import { isRecord, parseRecord, stringField as field } from "./guards.ts";

export type AuthKind = "idc" | "social" | "external-idp";
export type CredentialSource = "kiro-cli" | "kiro-ide";

export interface KiroCredentials {
	source: CredentialSource;
	kind: AuthKind;
	accessToken: string;
	refreshToken?: string;
	/** Epoch milliseconds. */
	expiresAt: number;
	/** Region of the service that issued the token (OIDC or Kiro auth). */
	authRegion: string;
	/** Region of the Kiro runtime, taken from the profile ARN. */
	serviceRegion: string;
	profileArn?: string;
	clientId?: string;
	clientSecret?: string;
	/** Where the token came from, so a refresh can be written back in the same shape. */
	origin: { kind: "sqlite"; path: string; key: string; raw: Record<string, unknown> } | { kind: "json"; path: string; raw: Record<string, unknown> };
}

export class KiroAuthError extends Error {}

const CLI_TOKEN_KEYS: ReadonlyArray<[AuthKind, string]> = [
	["idc", "kirocli:odic:token"],
	["external-idp", "kirocli:external-idp:token"],
	["social", "kirocli:social:token"],
];
const CLI_DEVICE_REGISTRATION_KEY = "kirocli:odic:device-registration";
const CLI_PROFILE_STATE_KEY = "api.codewhisperer.profile";
const DEFAULT_REGION = "us-east-1";
// Refreshing a few minutes early keeps a long streaming request from outliving its token.
const REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

export function kiroCliDbPath(): string {
	const override = process.env.KIRO_CLI_DB;
	if (override) return override;
	const home = homedir();
	switch (platform()) {
		case "darwin":
			return join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3");
		case "win32":
			return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "kiro-cli", "data.sqlite3");
		default:
			return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "kiro-cli", "data.sqlite3");
	}
}

export function kiroIdeTokenPath(): string {
	return process.env.KIRO_IDE_TOKEN ?? join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");
}

function parseExpiry(value: unknown): number {
	if (typeof value === "number") return value < 1e11 ? value * 1000 : value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return 0;
}

export function regionFromArn(arn: string | undefined): string | undefined {
	const region = arn?.split(":")[3];
	return region && /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region) ? region : undefined;
}

function readKiroCli(): KiroCredentials | undefined {
	const path = kiroCliDbPath();
	if (!existsSync(path)) return undefined;
	const db = new Database(path, { readonly: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM auth_kv").all();
		const byKey = new Map(rows.map(row => [row.key, row.value]));
		const stateRow = db
			.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?")
			.get(CLI_PROFILE_STATE_KEY);
		const profileArn = (() => {
			const profile = parseRecord(stateRow?.value);
			return profile ? field(profile, "arn", "profileArn") : undefined;
		})();

		for (const [kind, key] of CLI_TOKEN_KEYS) {
			const raw = parseRecord(byKey.get(key));
			if (!raw) continue;
			const accessToken = field(raw, "access_token", "accessToken");
			if (!accessToken) continue;
			const registration = kind === "idc" ? parseRecord(byKey.get(CLI_DEVICE_REGISTRATION_KEY)) : undefined;
			const authRegion = field(raw, "region", "region") ?? DEFAULT_REGION;
			const arn = field(raw, "profile_arn", "profileArn") ?? profileArn;
			return {
				source: "kiro-cli",
				kind,
				accessToken,
				refreshToken: field(raw, "refresh_token", "refreshToken"),
				expiresAt: parseExpiry(raw.expires_at ?? raw.expiresAt),
				authRegion,
				serviceRegion: regionFromArn(arn) ?? DEFAULT_REGION,
				profileArn: arn,
				clientId: registration ? field(registration, "client_id", "clientId") : undefined,
				clientSecret: registration ? field(registration, "client_secret", "clientSecret") : undefined,
				origin: { kind: "sqlite", path, key, raw },
			};
		}
		return undefined;
	} finally {
		db.close();
	}
}

async function readKiroIde(): Promise<KiroCredentials | undefined> {
	const path = kiroIdeTokenPath();
	const file = Bun.file(path);
	if (!(await file.exists())) return undefined;
	const raw = parseRecord(await file.text());
	if (!raw) return undefined;
	const accessToken = field(raw, "access_token", "accessToken");
	if (!accessToken) return undefined;
	const method = field(raw, "auth_method", "authMethod")?.toLowerCase();
	const kind: AuthKind = method === "idc" ? "idc" : method === "external_idp" ? "external-idp" : "social";
	let clientId: string | undefined;
	let clientSecret: string | undefined;
	const clientIdHash = field(raw, "client_id_hash", "clientIdHash");
	if (kind === "idc" && clientIdHash) {
		const registration = Bun.file(join(homedir(), ".aws", "sso", "cache", `${clientIdHash}.json`));
		const parsed = (await registration.exists()) ? parseRecord(await registration.text()) : undefined;
		if (parsed) {
			clientId = field(parsed, "client_id", "clientId");
			clientSecret = field(parsed, "client_secret", "clientSecret");
		}
	}
	const profileArn = field(raw, "profile_arn", "profileArn");
	return {
		source: "kiro-ide",
		kind,
		accessToken,
		refreshToken: field(raw, "refresh_token", "refreshToken"),
		expiresAt: parseExpiry(raw.expires_at ?? raw.expiresAt),
		authRegion: field(raw, "region", "region") ?? DEFAULT_REGION,
		serviceRegion: regionFromArn(profileArn) ?? DEFAULT_REGION,
		profileArn,
		clientId,
		clientSecret,
		origin: { kind: "json", path, raw },
	};
}

/**
 * Reads the active login. kiro-cli wins over the Kiro IDE because it is the client this
 * plugin piggybacks on; `KIRO_AUTH_SOURCE=kiro-ide` flips that.
 */
export async function readStoredCredentials(): Promise<KiroCredentials | undefined> {
	const preferred = process.env.KIRO_AUTH_SOURCE;
	if (preferred === "kiro-ide") return (await readKiroIde()) ?? readKiroCli();
	if (preferred === "kiro-cli") return readKiroCli();
	return readKiroCli() ?? (await readKiroIde());
}

interface RefreshResult {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	profileArn?: string;
}

function parseRefreshResponse(body: unknown): RefreshResult {
	if (!isRecord(body)) throw new KiroAuthError("token refresh returned a non-object body");
	const accessToken = field(body, "access_token", "accessToken");
	if (!accessToken) throw new KiroAuthError("token refresh response has no access token");
	const expiresIn = body.expiresIn ?? body.expires_in;
	return {
		accessToken,
		refreshToken: field(body, "refresh_token", "refreshToken"),
		expiresAt: Date.now() + (typeof expiresIn === "number" ? expiresIn : 3600) * 1000,
		profileArn: field(body, "profile_arn", "profileArn"),
	};
}

async function postRefresh(url: string, payload: Record<string, string>): Promise<RefreshResult> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "user-agent": USER_AGENT, "x-amz-user-agent": AMZ_USER_AGENT },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new KiroAuthError(`token refresh failed (${response.status}): ${text.slice(0, 300)}`);
	}
	return parseRefreshResponse(await response.json());
}

function refreshDirect(creds: KiroCredentials): Promise<RefreshResult> {
	if (!creds.refreshToken) throw new KiroAuthError("stored login has no refresh token");
	if (creds.kind === "idc") {
		if (!creds.clientId || !creds.clientSecret) throw new KiroAuthError("missing OIDC client registration");
		return postRefresh(`https://oidc.${creds.authRegion}.amazonaws.com/token`, {
			clientId: creds.clientId,
			clientSecret: creds.clientSecret,
			grantType: "refresh_token",
			refreshToken: creds.refreshToken,
		});
	}
	if (creds.kind === "social") {
		return postRefresh(`https://prod.${creds.authRegion}.auth.desktop.kiro.dev/refreshToken`, {
			refreshToken: creds.refreshToken,
		});
	}
	throw new KiroAuthError(`no direct refresh flow for ${creds.kind} logins`);
}

/** Writes the rotated token back in the store's own shape so kiro-cli / the IDE keep working. */
async function writeBack(creds: KiroCredentials, result: RefreshResult): Promise<void> {
	const raw = { ...creds.origin.raw };
	const set = (snake: string, camel: string, value: unknown) => {
		if (camel in raw && !(snake in raw)) raw[camel] = value;
		else raw[snake] = value;
	};
	set("access_token", "accessToken", result.accessToken);
	if (result.refreshToken) set("refresh_token", "refreshToken", result.refreshToken);
	const previousExpiry = raw.expires_at ?? raw.expiresAt;
	set(
		"expires_at",
		"expiresAt",
		typeof previousExpiry === "number"
			? previousExpiry < 1e11
				? Math.floor(result.expiresAt / 1000)
				: result.expiresAt
			: new Date(result.expiresAt).toISOString(),
	);
	if (creds.origin.kind === "sqlite") {
		const db = new Database(creds.origin.path, { readwrite: true });
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			db.query("UPDATE auth_kv SET value = ? WHERE key = ?").run(JSON.stringify(raw), creds.origin.key);
		} finally {
			db.close();
		}
		return;
	}
	// Rename over the original so a crash mid-write cannot leave the IDE a truncated token file.
	const temp = `${creds.origin.path}.omp-kiro-${process.pid}.tmp`;
	await writeFile(temp, JSON.stringify(raw, null, 2), { mode: 0o600 });
	await rename(temp, creds.origin.path);
}

/** Lets kiro-cli refresh its own login, for flows this plugin cannot refresh itself. */
async function refreshViaKiroCli(): Promise<void> {
	const proc = Bun.spawn([process.env.KIRO_CLI_BIN ?? "kiro-cli", "whoami"], {
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	const timer = setTimeout(() => proc.kill(), 30_000);
	try {
		await proc.exited;
	} finally {
		clearTimeout(timer);
	}
}

const LOGIN_HINT = "Run `kiro-cli login` (or sign in to the Kiro IDE), then retry.";
let inflight: { promise: Promise<KiroCredentials>; forced: boolean } | undefined;

/**
 * Returns a usable login, refreshing it when it is about to expire. The token store is
 * re-read every call because kiro-cli may have logged in, out, or refreshed on its own.
 */
export async function getCredentials(forceRefresh = false): Promise<KiroCredentials> {
	const pending = inflight;
	if (pending && (pending.forced || !forceRefresh)) return pending.promise;
	if (pending) {
		// A plain read in flight would hand back the very token the caller just saw rejected.
		await pending.promise.catch(() => {});
		return getCredentials(forceRefresh);
	}
	const promise = loadCredentials(forceRefresh).finally(() => {
		if (inflight?.promise === promise) inflight = undefined;
	});
	inflight = { promise, forced: forceRefresh };
	return promise;
}

async function loadCredentials(forceRefresh: boolean): Promise<KiroCredentials> {
	const current = await readStoredCredentials();
	if (!current) throw new KiroAuthError(`No Kiro login found. ${LOGIN_HINT}`);
	if (!forceRefresh && current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current;

	let directError: unknown;
	try {
		const result = await refreshDirect(current);
		await writeBack(current, result);
		const profileArn = result.profileArn ?? current.profileArn;
		return {
			...current,
			accessToken: result.accessToken,
			refreshToken: result.refreshToken ?? current.refreshToken,
			expiresAt: result.expiresAt,
			profileArn,
			serviceRegion: regionFromArn(profileArn) ?? current.serviceRegion,
		};
	} catch (error) {
		directError = error;
	}
	if (current.source === "kiro-cli") {
		await refreshViaKiroCli().catch(() => {});
		const reread = await readStoredCredentials();
		if (reread && reread.accessToken !== current.accessToken && reread.expiresAt > Date.now()) return reread;
	}
	// An early refresh that failed (e.g. a brief network blip) must not block a token that still works.
	if (!forceRefresh && current.expiresAt > Date.now()) return current;
	const reason = directError instanceof Error ? directError.message : String(directError);
	throw new KiroAuthError(`Kiro login expired and could not be refreshed (${reason}). ${LOGIN_HINT}`);
}

export function kiroHeaders(creds: KiroCredentials): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${creds.accessToken}`,
		// Kiro answers 403 to Bun's default user agent, so one is always set explicitly.
		"user-agent": USER_AGENT,
		"x-amz-user-agent": AMZ_USER_AGENT,
	};
	// Mirrors the IDE's TokenType middleware; the service routes IdC tokens by it.
	if (creds.kind === "idc") headers.TokenType = "SSO_OIDC";
	if (creds.kind === "external-idp") headers.TokenType = "EXTERNAL_IDP";
	return headers;
}
