import { createHash } from "node:crypto";
import {
	type Context,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	toolWireSchema,
} from "@oh-my-pi/pi-ai";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { ORIGIN } from "./constants.ts";
import { EFFORT_ORDER, type EffortLevel, type KiroModelInfo } from "./models.ts";

export interface KiroImage {
	format: "png" | "jpeg" | "gif" | "webp";
	source: { bytes: string };
}

export interface KiroToolResult {
	toolUseId: string;
	content: { text: string }[];
	status: "success" | "error";
}

export interface KiroToolUse {
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
}

export interface KiroToolSpec {
	toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}

export interface KiroUserInputMessage {
	content: string;
	modelId: string;
	origin: string;
	images?: KiroImage[];
	userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}

export interface KiroAssistantResponseMessage {
	content: string;
	toolUses?: KiroToolUse[];
	reasoningContent?: { reasoningText: { text: string; signature: string } };
}

export type KiroTurn = { userInputMessage: KiroUserInputMessage } | { assistantResponseMessage: KiroAssistantResponseMessage };

export interface KiroRequestBody {
	conversationState: {
		chatTriggerType: "MANUAL";
		conversationId: string;
		currentMessage: { userInputMessage: KiroUserInputMessage };
		history?: KiroTurn[];
	};
	profileArn?: string;
	additionalModelRequestFields?: Record<string, unknown>;
}

export interface KiroRequest {
	body: KiroRequestBody;
	/** Wire tool name → OMP tool name, for mapping streamed tool calls back. */
	toolNames: Map<string, string>;
}

const TOOL_NAME_MAX = 64;
const TOOL_USE_ID_MAX = 64;
// The current message is the only place Kiro rejects empty content; history entries may be empty.
const CONTINUE_TEXT = "Continue.";
const INTERRUPTED_TOOL_TEXT = "Tool execution was interrupted before it produced a result.";
const IMAGE_FORMATS: Record<string, KiroImage["format"]> = {
	"image/png": "png",
	"image/jpeg": "jpeg",
	"image/jpg": "jpeg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Kiro, like Bedrock, accepts tool names and tool-use ids matching [a-zA-Z0-9_-]{1,64}. */
function toWireIdentifier(value: string, max: number): string {
	const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, max);
	return cleaned.length > 0 ? cleaned : "tool";
}

class ToolNameMap {
	readonly fromWire = new Map<string, string>();
	readonly #toWire = new Map<string, string>();

	wire(name: string): string {
		const known = this.#toWire.get(name);
		if (known) return known;
		const base = toWireIdentifier(name, TOOL_NAME_MAX);
		let candidate = base;
		for (let suffix = 1; this.fromWire.has(candidate); suffix++) {
			const tag = `_${suffix}`;
			candidate = base.slice(0, TOOL_NAME_MAX - tag.length) + tag;
		}
		this.#toWire.set(name, candidate);
		this.fromWire.set(candidate, name);
		return candidate;
	}
}

function textOf(content: string | ReadonlyArray<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content.flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

function imagesOf(
	content: string | ReadonlyArray<TextContent | ImageContent>,
	allowed: boolean,
): { images: KiroImage[]; omitted: number } {
	const images: KiroImage[] = [];
	let omitted = 0;
	if (typeof content === "string") return { images, omitted };
	for (const block of content) {
		if (block.type !== "image") continue;
		const format = IMAGE_FORMATS[block.mimeType.toLowerCase()];
		if (allowed && format) images.push({ format, source: { bytes: block.data } });
		else omitted++;
	}
	return { images, omitted };
}

function joinText(...parts: string[]): string {
	return parts.filter(part => part.length > 0).join("\n\n");
}

function isUserTurn(turn: KiroTurn): turn is { userInputMessage: KiroUserInputMessage } {
	return "userInputMessage" in turn;
}

function clampEffort(requested: EffortLevel, supported: readonly EffortLevel[]): EffortLevel | undefined {
	if (supported.length === 0) return undefined;
	const rank = (effort: EffortLevel) => EFFORT_ORDER.indexOf(effort);
	const sorted = [...supported].sort((a, b) => rank(a) - rank(b));
	return sorted.filter(effort => rank(effort) <= rank(requested)).at(-1) ?? sorted[0];
}

export function reasoningFields(
	info: KiroModelInfo | undefined,
	options: Pick<SimpleStreamOptions, "reasoning" | "disableReasoning" | "hideThinkingSummary" | "maxTokens"> | undefined,
): Record<string, unknown> | undefined {
	if (!info) return undefined;
	const fields: Record<string, unknown> = {};
	const control = info.reasoning;
	const requested = options?.disableReasoning ? undefined : (options?.reasoning as EffortLevel | undefined);
	if (control?.style === "anthropic") {
		if (!requested) {
			if (control.thinkingTypes.includes("disabled")) fields.thinking = { type: "disabled" };
		} else {
			const type = control.thinkingTypes.includes("adaptive")
				? "adaptive"
				: control.thinkingTypes.find(candidate => candidate !== "disabled");
			if (type) {
				const display = options?.hideThinkingSummary ? "omitted" : "summarized";
				fields.thinking = control.displays.includes(display) ? { type, display } : { type };
			}
			const effort = clampEffort(requested, control.efforts);
			if (effort) fields.output_config = { effort };
		}
	} else if (control?.style === "openai") {
		if (!requested) {
			if (control.canDisable) fields.reasoning = { effort: "none" };
		} else {
			const effort = clampEffort(requested, control.efforts);
			if (effort) fields.reasoning = { effort };
		}
	}
	if (info.maxTokensRange && options?.maxTokens) {
		fields.max_tokens = Math.min(info.maxTokensRange.max, Math.max(info.maxTokensRange.min, options.maxTokens));
	}
	return Object.keys(fields).length > 0 ? fields : undefined;
}

/** A stable id per OMP session lets Kiro associate the requests of one conversation. */
function conversationIdFor(sessionId: string | undefined): string {
	if (!sessionId) return crypto.randomUUID();
	const hex = createHash("sha256").update(`omp-kiro:${sessionId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function buildKiroRequest(
	model: Model,
	context: Context,
	options: SimpleStreamOptions | undefined,
	info: KiroModelInfo | undefined,
	profileArn: string | undefined,
): KiroRequest {
	const names = new ToolNameMap();
	const user = (content: string, extra?: Partial<KiroUserInputMessage>): { userInputMessage: KiroUserInputMessage } => ({
		userInputMessage: { content, modelId: model.id, origin: ORIGIN, ...extra },
	});
	const imagesAllowed = model.input.includes("image");
	const messages = transformMessages(context.messages, model, id => toWireIdentifier(id, TOOL_USE_ID_MAX));

	const turns: KiroTurn[] = [];
	for (const message of messages) {
		const last = turns.at(-1);
		if (message.role === "assistant") {
			let content = "";
			const toolUses: KiroToolUse[] = [];
			let reasoningContent: KiroAssistantResponseMessage["reasoningContent"];
			const sameModel = message.provider === model.provider && message.model === model.id;
			for (const block of message.content) {
				if (block.type === "text") content = joinText(content, block.text);
				else if (block.type === "toolCall") {
					toolUses.push({ toolUseId: block.id, name: names.wire(block.name), input: block.arguments });
				} else if (block.type === "thinking" && sameModel && block.thinkingSignature && !reasoningContent) {
					// Replaying the signed block keeps the model's reasoning chain across tool turns.
					reasoningContent = { reasoningText: { text: block.thinking, signature: block.thinkingSignature } };
				}
			}
			if (last && !isUserTurn(last)) {
				const previous = last.assistantResponseMessage;
				previous.content = joinText(previous.content, content);
				if (toolUses.length > 0) previous.toolUses = [...(previous.toolUses ?? []), ...toolUses];
			} else {
				turns.push({
					assistantResponseMessage: {
						content,
						...(toolUses.length > 0 ? { toolUses } : {}),
						...(reasoningContent ? { reasoningContent } : {}),
					},
				});
			}
			continue;
		}

		let text: string;
		let images: KiroImage[];
		let omitted: number;
		const toolResults: KiroToolResult[] = [];
		if (message.role === "toolResult") {
			({ images, omitted } = imagesOf(message.content, imagesAllowed));
			text = "";
			toolResults.push({
				toolUseId: message.toolCallId,
				content: [{ text: textOf(message.content) || "(no output)" }],
				status: message.isError ? "error" : "success",
			});
		} else {
			({ images, omitted } = imagesOf(message.content, imagesAllowed));
			text = textOf(message.content);
		}
		if (omitted > 0) text = joinText(text, `[${omitted} image(s) omitted: ${model.id} does not accept images]`);

		if (last && isUserTurn(last)) {
			const previous = last.userInputMessage;
			previous.content = joinText(previous.content, text);
			if (images.length > 0) previous.images = [...(previous.images ?? []), ...images];
			if (toolResults.length > 0) {
				previous.userInputMessageContext ??= {};
				previous.userInputMessageContext.toolResults = [
					...(previous.userInputMessageContext.toolResults ?? []),
					...toolResults,
				];
			}
		} else {
			turns.push(
				user(text, {
					...(images.length > 0 ? { images } : {}),
					...(toolResults.length > 0 ? { userInputMessageContext: { toolResults } } : {}),
				}),
			);
		}
	}

	// Kiro requires strict user/assistant alternation that starts and ends with a user turn.
	if (turns.length === 0 || !isUserTurn(turns[0])) turns.unshift(user(""));
	if (!isUserTurn(turns.at(-1)!)) turns.push(user(""));

	for (let index = 0; index < turns.length; index++) {
		const turn = turns[index];
		if (!isUserTurn(turn)) continue;
		pairToolResults(turn.userInputMessage, index > 0 ? turns[index - 1] : undefined);
	}

	const system = (context.systemPrompt ?? []).filter(part => part.length > 0).join("\n\n");
	const first = turns[0];
	const tail = turns.pop();
	if (!first || !tail || !isUserTurn(first) || !isUserTurn(tail)) {
		throw new Error("Kiro request must start and end with a user turn");
	}
	// generateAssistantResponse has no usable system field (it rejects `systemPrompt` as
	// malformed), so the system prompt leads the first user turn, which also keeps it in the
	// stable cached prefix.
	if (system) first.userInputMessage.content = joinText(system, first.userInputMessage.content);

	const current = tail.userInputMessage;
	if (!current.content.trim() && !current.userInputMessageContext?.toolResults?.length && !current.images?.length) {
		current.content = CONTINUE_TEXT;
	}

	const specs: KiroToolSpec[] = [];
	const declared = new Set<string>();
	for (const tool of context.tools ?? []) {
		const name = names.wire(tool.name);
		if (declared.has(name)) continue;
		declared.add(name);
		specs.push({
			toolSpecification: {
				name,
				description: tool.description.trim() || tool.name,
				inputSchema: { json: toolWireSchema(tool) },
			},
		});
	}
	// Kiro rejects history that calls a tool the request does not declare, which happens when
	// a tool was deactivated after it ran.
	for (const turn of turns) {
		if (isUserTurn(turn)) continue;
		for (const use of turn.assistantResponseMessage.toolUses ?? []) {
			if (declared.has(use.name)) continue;
			declared.add(use.name);
			specs.push({
				toolSpecification: {
					name: use.name,
					description: `${names.fromWire.get(use.name) ?? use.name} (no longer available)`,
					inputSchema: { json: { type: "object", properties: {} } },
				},
			});
		}
	}
	if (specs.length > 0) current.userInputMessageContext = { ...current.userInputMessageContext, tools: specs };

	const additionalModelRequestFields = reasoningFields(info, options);
	return {
		body: {
			conversationState: {
				chatTriggerType: "MANUAL",
				conversationId: conversationIdFor(options?.sessionId),
				currentMessage: { userInputMessage: current },
				...(turns.length > 0 ? { history: turns } : {}),
			},
			...(profileArn ? { profileArn } : {}),
			...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
		},
		toolNames: names.fromWire,
	};
}

/**
 * Kiro rejects a turn whose tool results do not answer exactly the tool uses of the assistant
 * turn right before it. Unanswered uses get an error result; results with no matching use are
 * kept as plain text so their content still reaches the model.
 */
function pairToolResults(message: KiroUserInputMessage, previous: KiroTurn | undefined): void {
	const uses = previous && !isUserTurn(previous) ? (previous.assistantResponseMessage.toolUses ?? []) : [];
	const expected = new Set(uses.map(use => use.toolUseId));
	const results = message.userInputMessageContext?.toolResults ?? [];
	const kept: KiroToolResult[] = [];
	const answered = new Set<string>();
	const orphans: string[] = [];
	for (const result of results) {
		if (expected.has(result.toolUseId) && !answered.has(result.toolUseId)) {
			answered.add(result.toolUseId);
			kept.push(result);
		} else {
			orphans.push(`[result of tool call ${result.toolUseId}]\n${result.content.map(part => part.text).join("\n")}`);
		}
	}
	for (const use of uses) {
		if (!answered.has(use.toolUseId)) {
			kept.push({ toolUseId: use.toolUseId, content: [{ text: INTERRUPTED_TOOL_TEXT }], status: "error" });
		}
	}
	if (orphans.length > 0) message.content = joinText(message.content, ...orphans);
	if (kept.length > 0) {
		message.userInputMessageContext = { ...message.userInputMessageContext, toolResults: kept };
	} else if (message.userInputMessageContext) {
		delete message.userInputMessageContext.toolResults;
		if (Object.keys(message.userInputMessageContext).length === 0) delete message.userInputMessageContext;
	}
}
