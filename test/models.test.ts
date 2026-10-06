import { describe, expect, test } from "bun:test";
import { isEffort, parseModel, toProviderModel, type EffortLevel, type KiroModelInfo } from "../src/models";

// OMP's Effort is an ambient const enum, so its members cannot be written as string literals in
// a typed position; isEffort is the same guard src uses to narrow a parsed schema enum.
const efforts = (...values: string[]): EffortLevel[] => values.filter(isEffort);

const catalog: unknown = await Bun.file(new URL("./fixtures/list-available-models.json", import.meta.url)).json();

function entry(modelId: string): Record<string, unknown> {
	if (typeof catalog !== "object" || catalog === null || !("models" in catalog) || !Array.isArray(catalog.models)) {
		throw new Error("fixture has no models array");
	}
	const found = catalog.models.find(
		(model): model is Record<string, unknown> =>
			typeof model === "object" && model !== null && "modelId" in model && model.modelId === modelId,
	);
	if (!found) throw new Error(`fixture has no model ${modelId}`);
	return found;
}

function info(modelId: string): KiroModelInfo {
	const parsed = parseModel(entry(modelId));
	if (!parsed) throw new Error(`parseModel dropped ${modelId}`);
	return parsed;
}

describe("parseModel anthropic schemas", () => {
	test("claude-opus-5.5 exposes adaptive thinking, the full effort ladder and a max_tokens range", () => {
		const model = info("claude-opus-5.5");
		expect(model.reasoning).toEqual({
			style: "anthropic",
			efforts: efforts("low", "medium", "high", "xhigh", "max"),
			defaultEffort: efforts("medium")[0],
			thinkingTypes: ["adaptive"],
			displays: ["summarized", "omitted"],
		});
		expect(model.maxTokensRange).toEqual({ min: 1024, max: 128_000 });
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxOutputTokens).toBe(128_000);
		expect(model.images).toBe(true);
		expect(model.name).toBe("Claude Opus 5.5");
	});

	test("a schema without a disabled thinking type cannot turn reasoning off", () => {
		const opus = info("claude-opus-5.5").reasoning;
		expect(opus?.style === "anthropic" ? opus.thinkingTypes : undefined).not.toContain("disabled");
		expect(info("claude-opus-5").reasoning).toMatchObject({
			style: "anthropic",
			thinkingTypes: ["adaptive", "disabled"],
		});
	});

	test("effort ladders are read per model, not assumed", () => {
		expect(info("claude-opus-4.6").reasoning).toMatchObject({ efforts: efforts("low", "medium", "high", "max") });
		expect(info("claude-sonnet-5.5").reasoning).toMatchObject({
			thinkingTypes: ["adaptive", "between_tools"],
			defaultEffort: efforts("high")[0],
		});
	});
});

describe("parseModel openai schemas", () => {
	test("gpt-5.6 models are openai-style and exclude none from the effort ladder", () => {
		for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
			expect(info(id).reasoning).toEqual({
				style: "openai",
				efforts: efforts("low", "medium", "high", "xhigh", "max"),
				defaultEffort: efforts("high")[0],
				canDisable: true,
			});
			// The openai schemas publish no max_tokens bound.
			expect(info(id).maxTokensRange).toBeUndefined();
		}
		expect(info("gpt-5.6-sol").name).toBe("GPT 5.6 Sol");
	});
});

describe("parseModel without a reasoning schema", () => {
	test("deepseek and haiku report no reasoning control", () => {
		for (const id of ["deepseek-3.2", "claude-haiku-4.5"]) {
			expect(info(id).reasoning).toBeUndefined();
			expect(info(id).maxTokensRange).toBeUndefined();
		}
	});

	test("image support comes from supportedInputTypes", () => {
		expect(info("deepseek-3.2").images).toBe(false);
		expect(info("claude-haiku-4.5").images).toBe(true);
	});

	test("vendor names are spelled out of the id when the API returns none", () => {
		expect(info("deepseek-3.2").name).toBe("DeepSeek 3.2");
		expect(info("glm-5").name).toBe("GLM 5");
	});
});

describe("toProviderModel", () => {
	test("a null-schema model reports reasoning:false and no thinking config", () => {
		const model = toProviderModel(info("deepseek-3.2"));
		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(164_000);
		expect(model.maxTokens).toBe(64_000);
		expect(model.name).toBe("DeepSeek 3.2 (0.25x credits)");
	});

	test("an anthropic model exposes its effort ladder and image input", () => {
		const model = toProviderModel(info("claude-opus-5.5"));
		expect(model.reasoning).toBe(true);
		expect(model.thinking?.mode).toBe("effort");
		expect(model.thinking?.efforts).toEqual(efforts("low", "medium", "high", "xhigh", "max"));
		expect(model.thinking?.defaultLevel).toBe(efforts("medium")[0]);
		expect(model.input).toEqual(["text", "image"]);
	});

	test("an openai model keeps its effort ladder and defaults", () => {
		const thinking = toProviderModel(info("gpt-5.6-sol")).thinking;
		expect(thinking?.mode).toBe("effort");
		expect(thinking?.efforts).toEqual(efforts("low", "medium", "high", "xhigh", "max"));
		expect(thinking?.defaultLevel).toBe(efforts("high")[0]);
	});

	test("a model without a rate multiplier is listed under its bare name", () => {
		const info: KiroModelInfo = {
			id: "custom",
			name: "Custom",
			contextWindow: 1000,
			maxOutputTokens: 100,
			images: false,
		};
		expect(toProviderModel(info).name).toBe("Custom");
	});
});
