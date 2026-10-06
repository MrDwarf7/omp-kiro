import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { getCredentials, type KiroCredentials, kiroHeaders } from "./auth.ts";
import { managementEndpoint, ORIGIN } from "./constants.ts";
import { isRecord, numberField, parseRecord, stringField } from "./guards.ts";

/** Effort ladder shared by OMP and Kiro, least to most intensive. */
export const EFFORT_ORDER: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export type EffortLevel = Effort;

/**
 * How a model takes reasoning controls in `additionalModelRequestFields`. Kiro publishes a
 * JSON schema per model; Claude models follow Anthropic's `thinking` + `output_config`
 * shape and GPT models OpenAI's `reasoning.effort`.
 */
export type ReasoningControl =
	| {
			style: "anthropic";
			efforts: EffortLevel[];
			defaultEffort?: EffortLevel;
			thinkingTypes: string[];
			displays: string[];
	  }
	| { style: "openai"; efforts: EffortLevel[]; defaultEffort?: EffortLevel; canDisable: boolean };

export interface KiroModelInfo {
	id: string;
	name: string;
	rateMultiplier?: number;
	contextWindow: number;
	maxOutputTokens: number;
	images: boolean;
	reasoning?: ReasoningControl;
	maxTokensRange?: { min: number; max: number };
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_OUTPUT = 64_000;
const MAX_PAGES = 10;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// OMP's Effort is a const enum, so it has no runtime values to compare against; its members
// are exactly these strings.
export function isEffort(value: unknown): value is EffortLevel {
	return typeof value === "string" && EFFORT_ORDER.includes(value);
}

function nodeAt(schema: Record<string, unknown>, ...path: string[]): Record<string, unknown> | undefined {
	let node: unknown = schema;
	for (const key of path) {
		if (!isRecord(node)) return undefined;
		node = node[key];
	}
	return isRecord(node) ? node : undefined;
}

function stringEnum(node: Record<string, unknown> | undefined): string[] | undefined {
	return Array.isArray(node?.enum) ? node.enum.filter(value => typeof value === "string") : undefined;
}

export function parseReasoningControl(rawSchema: unknown): {
	reasoning?: ReasoningControl;
	maxTokensRange?: { min: number; max: number };
} {
	const schema = typeof rawSchema === "string" ? parseRecord(rawSchema) : isRecord(rawSchema) ? rawSchema : undefined;
	if (!schema) return {};
	const maxTokens = nodeAt(schema, "properties", "max_tokens");
	const maxTokensRange =
		maxTokens && typeof maxTokens.maximum === "number"
			? { min: typeof maxTokens.minimum === "number" ? maxTokens.minimum : 1, max: maxTokens.maximum }
			: undefined;

	const thinkingTypes = stringEnum(nodeAt(schema, "properties", "thinking", "properties", "type"));
	if (thinkingTypes) {
		const effortNode = nodeAt(schema, "properties", "output_config", "properties", "effort");
		return {
			maxTokensRange,
			reasoning: {
				style: "anthropic",
				efforts: (stringEnum(effortNode) ?? []).filter(isEffort),
				defaultEffort: isEffort(effortNode?.default) ? effortNode.default : undefined,
				thinkingTypes,
				displays: stringEnum(nodeAt(schema, "properties", "thinking", "properties", "display")) ?? [],
			},
		};
	}

	const reasoningEffort = nodeAt(schema, "properties", "reasoning", "properties", "effort");
	const reasoningEfforts = stringEnum(reasoningEffort);
	if (reasoningEfforts) {
		return {
			maxTokensRange,
			reasoning: {
				style: "openai",
				efforts: reasoningEfforts.filter(isEffort),
				defaultEffort: isEffort(reasoningEffort?.default) ? reasoningEffort.default : undefined,
				canDisable: reasoningEfforts.includes("none"),
			},
		};
	}
	return { maxTokensRange };
}

const NAME_TOKENS: Record<string, string> = { gpt: "GPT", glm: "GLM", deepseek: "DeepSeek", minimax: "MiniMax" };

/** kiro-cli's origin returns bare ids as names; the IDE's spelling is reproduced from the id. */
function displayName(id: string, apiName: string | undefined): string {
	if (apiName && apiName !== id) return apiName;
	return id
		.split("-")
		.map(token => NAME_TOKENS[token] ?? token.charAt(0).toUpperCase() + token.slice(1))
		.join(" ");
}

export function parseModel(raw: unknown): KiroModelInfo | undefined {
	if (!isRecord(raw)) return undefined;
	const id = stringField(raw, "modelId");
	if (!id) return undefined;
	const limits = isRecord(raw.tokenLimits) ? raw.tokenLimits : {};
	const inputs = Array.isArray(raw.supportedInputTypes) ? raw.supportedInputTypes : ["TEXT"];
	return {
		id,
		name: displayName(id, stringField(raw, "modelName")),
		rateMultiplier: numberField(raw, "rateMultiplier"),
		contextWindow: numberField(limits, "maxInputTokens") ?? DEFAULT_CONTEXT_WINDOW,
		maxOutputTokens: numberField(limits, "maxOutputTokens") ?? DEFAULT_MAX_OUTPUT,
		images: inputs.some(value => value === "IMAGE"),
		...parseReasoningControl(raw.additionalModelRequestFieldsSchema),
	};
}

export async function fetchKiroModels(creds: KiroCredentials, signal?: AbortSignal): Promise<KiroModelInfo[]> {
	const models: KiroModelInfo[] = [];
	let nextToken: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const url = new URL("/ListAvailableModels", managementEndpoint(creds.serviceRegion));
		url.searchParams.set("origin", ORIGIN);
		if (creds.profileArn) url.searchParams.set("profileArn", creds.profileArn);
		if (nextToken) url.searchParams.set("nextToken", nextToken);
		const response = await fetch(url, {
			headers: { ...kiroHeaders(creds), Accept: "application/json" },
			signal: signal ?? AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Kiro ListAvailableModels failed (${response.status}): ${text.slice(0, 300)}`);
		}
		const body: unknown = await response.json();
		if (!isRecord(body)) throw new Error("Kiro ListAvailableModels returned a non-object body");
		for (const raw of Array.isArray(body.models) ? body.models : []) {
			const model = parseModel(raw);
			if (model) models.push(model);
		}
		nextToken = stringField(body, "nextToken");
		if (!nextToken) break;
	}
	return models;
}

let catalog: Map<string, KiroModelInfo> | undefined;
let catalogLoad: Promise<Map<string, KiroModelInfo>> | undefined;

/** Fetches the live catalog and remembers it for request-time lookups of each model's reasoning schema. */
export function loadCatalog(force = false): Promise<Map<string, KiroModelInfo>> {
	if (catalog && !force) return Promise.resolve(catalog);
	catalogLoad ??= (async () => {
		const models = await fetchKiroModels(await getCredentials());
		catalog = new Map(models.map(model => [model.id, model]));
		return catalog;
	})().finally(() => {
		catalogLoad = undefined;
	});
	return catalogLoad;
}

/**
 * OMP caches discovered models across restarts, so a request can arrive before this process
 * has listed models itself; the schema is fetched lazily then.
 */
export async function getModelInfo(id: string): Promise<KiroModelInfo | undefined> {
	try {
		return (await loadCatalog()).get(id);
	} catch {
		return undefined;
	}
}

export function toProviderModel(info: KiroModelInfo): ProviderModelConfig {
	const efforts = info.reasoning?.efforts ?? [];
	const name = info.rateMultiplier === undefined ? info.name : `${info.name} (${info.rateMultiplier}x credits)`;
	return {
		id: info.id,
		name,
		reasoning: info.reasoning !== undefined,
		thinking:
			efforts.length > 0
				? { mode: "effort", efforts, defaultLevel: info.reasoning?.defaultEffort }
				: undefined,
		input: info.images ? ["text", "image"] : ["text"],
		cost: ZERO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxOutputTokens,
	};
}
