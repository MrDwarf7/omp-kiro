import { describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { isEffort, type EffortLevel, type KiroModelInfo } from "../src/models";
import { buildKiroRequest, reasoningFields, type KiroRequest, type KiroTurn } from "../src/request";

// OMP's Effort is an ambient const enum, so its members cannot be written as string literals in
// a typed position; isEffort is the same guard src uses to narrow a parsed schema enum.
const efforts = (...values: string[]): EffortLevel[] => values.filter(isEffort);

// Model is a provider-conditional type keyed on `api`, and Kiro's api id is not one of OMP's
// KnownApi values, so a fixture can only be built through a single widening cast.
const MODEL = {
	id: "claude-sonnet-5.5",
	name: "claude-sonnet-5.5",
	api: "kiro-generate-assistant-response",
	provider: "kiro",
	baseUrl: "https://kiro.invalid",
	reasoning: true,
	input: ["text"],
	identity: { class: "unknown" },
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
	compat: {},
} as unknown as Model;

const IMAGE_MODEL = { ...MODEL, input: ["text", "image"] } as Model;

const now = 1_700_000_000_000;

function text(content: string): TextContent {
	return { type: "text", text: content };
}

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: now };
}

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: now,
		...overrides,
	};
}

function toolResult(toolCallId: string, content: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [text(content)],
		isError,
		timestamp: now,
	};
}

function tool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: { type: "object", properties: {}, required: [] } };
}

function build(context: Context, options?: SimpleStreamOptions, model: Model = MODEL): KiroRequest {
	return buildKiroRequest(model, context, options, undefined, undefined);
}

function historyOf(request: KiroRequest): KiroTurn[] {
	return request.body.conversationState.history ?? [];
}

function turnsAreValid(turns: readonly KiroTurn[]): boolean {
	// Kiro requires strict user/assistant alternation starting with a user turn.
	return turns.every((turn, index) => ("userInputMessage" in turn) === (index % 2 === 0));
}

describe("buildKiroRequest conversation shape", () => {
	test("system prompt leads the first user turn and the last user turn becomes currentMessage", () => {
		const request = build({
			systemPrompt: ["You are terse.", ""],
			messages: [user("first"), assistant([text("answer")]), user("second")],
		});
		const history = historyOf(request);
		expect(history).toHaveLength(2);
		expect(history[0]).toEqual({
			userInputMessage: expect.objectContaining({ content: "You are terse.\n\nfirst" }),
		});
		expect(history[1]).toHaveProperty("assistantResponseMessage");
		expect(request.body.conversationState.currentMessage.userInputMessage.content).toBe("second");
		// Kiro rejects a top-level systemPrompt field, so it must never appear on the wire.
		expect(JSON.stringify(request.body)).not.toContain('"systemPrompt"');
	});

	test("every transcript yields history that alternates and starts with a user turn", () => {
		const transcripts: Message[][] = [
			[],
			[assistant([text("unprompted")])],
			[user("only user")],
			[user("a"), user("b"), user("c")],
			[assistant([text("x")]), user("after assistant")],
			[user("hi"), assistant([text("a"), { type: "toolCall", id: "t1", name: "read", arguments: {} }], { stopReason: "toolUse" }), toolResult("t1", "ok")],
			[user("hi"), assistant([text("a"), { type: "toolCall", id: "t1", name: "read", arguments: {} }], { stopReason: "toolUse" }), toolResult("t1", "ok"), assistant([text("done")]), user("more")],
		];
		for (const messages of transcripts) {
			const request = build({ messages });
			expect(turnsAreValid(historyOf(request))).toBe(true);
			expect("userInputMessage" in request.body.conversationState.currentMessage).toBe(true);
		}
	});

	test("consecutive user and tool-result messages merge into one turn", () => {
		const request = build({
			messages: [
				user("a"),
				user("b"),
				assistant([text("reply"), { type: "toolCall", id: "t1", name: "read", arguments: {} }], { stopReason: "toolUse" }),
				toolResult("t1", "first result"),
				toolResult("t1", "second result"),
				user("c"),
			],
		});
		const history = historyOf(request);
		expect(history.map(turn => ("userInputMessage" in turn ? "user" : "assistant"))).toEqual(["user", "assistant"]);
		expect("userInputMessage" in history[0] && history[0].userInputMessage.content).toBe("a\n\nb");
		// The tool result and the following user message share the single turn after the assistant.
		const current = request.body.conversationState.currentMessage.userInputMessage;
		expect(current.content).toBe("c");
		expect(current.userInputMessageContext?.toolResults).toEqual([
			{ toolUseId: "t1", content: [{ text: "first result" }], status: "success" },
		]);
	});

	test("every tool call of the preceding assistant turn is answered, unanswered ones as errors", () => {
		const unanswered = build({
			messages: [
				user("go"),
				assistant([{ type: "toolCall", id: "t9", name: "read", arguments: { path: "/x" } }], { stopReason: "toolUse" }),
			],
		}).body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults;
		expect(unanswered).toHaveLength(1);
		expect(unanswered?.[0]?.toolUseId).toBe("t9");
		expect(unanswered?.[0]?.status).toBe("error");
		expect(unanswered?.[0]?.content[0]?.text.length).toBeGreaterThan(0);

		const partial = build({
			messages: [
				user("go"),
				assistant(
					[
						{ type: "toolCall", id: "t1", name: "read", arguments: {} },
						{ type: "toolCall", id: "t2", name: "write", arguments: {} },
					],
					{ stopReason: "toolUse" },
				),
				toolResult("t1", "answered"),
			],
		}).body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults;
		expect(partial?.map(result => [result.toolUseId, result.status])).toEqual([
			["t1", "success"],
			["t2", "error"],
		]);
	});

	test("a tool result with no matching call in the preceding assistant turn stays plain text", () => {
		const request = build({
			messages: [user("look"), toolResult("unknown-call", "the file said hello")],
		});
		const current = request.body.conversationState.currentMessage.userInputMessage;
		expect(current.userInputMessageContext?.toolResults).toBeUndefined();
		expect(current.content).toContain("the file said hello");
	});

	test("an assistant-final transcript still sends a non-empty current message", () => {
		const request = build({ messages: [user("hi"), assistant([text("hello")])] });
		expect(request.body.conversationState.currentMessage.userInputMessage.content).toBe("Continue.");
		expect(historyOf(request)).toHaveLength(2);
	});
});

describe("buildKiroRequest reasoning replay", () => {
	test("signed thinking from the same model is replayed as reasoningContent", () => {
		const request = build({
			messages: [
				user("hi"),
				assistant(
					[
						{ type: "thinking", thinking: "step one", thinkingSignature: "sig-abc" },
						{ type: "toolCall", id: "t1", name: "read", arguments: {} },
					],
					{ stopReason: "toolUse" },
				),
				toolResult("t1", "ok"),
			],
		});
		const assistantTurn = historyOf(request).find(turn => "assistantResponseMessage" in turn);
		expect(assistantTurn && "assistantResponseMessage" in assistantTurn ? assistantTurn.assistantResponseMessage.reasoningContent : undefined).toEqual({
			reasoningText: { text: "step one", signature: "sig-abc" },
		});
	});

	test("thinking recorded by a different model is not replayed", () => {
		const request = build({
			messages: [
				user("hi"),
				assistant(
					[
						{ type: "thinking", thinking: "other model thoughts", thinkingSignature: "sig-xyz" },
						{ type: "toolCall", id: "t1", name: "read", arguments: {} },
					],
					{ stopReason: "toolUse", model: "claude-opus-4.6" },
				),
				toolResult("t1", "ok"),
			],
		});
		const assistantTurn = historyOf(request).find(turn => "assistantResponseMessage" in turn);
		const message = assistantTurn && "assistantResponseMessage" in assistantTurn ? assistantTurn.assistantResponseMessage : undefined;
		expect(message?.reasoningContent).toBeUndefined();
		// The reasoning is still carried into the turn as text, so nothing is lost from the context.
		expect(message?.content).toContain("other model thoughts");
	});
});

describe("buildKiroRequest tool declarations", () => {
	test("illegal characters are stripped from wire names and mapped back", () => {
		const request = build({
			messages: [user("hi")],
			tools: [tool("my.tool/name!"), tool("Read")],
		});
		const specs = request.body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools ?? [];
		expect(specs).toHaveLength(2);
		for (const spec of specs) expect(spec.toolSpecification.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		const mapped = specs.map(spec => request.toolNames.get(spec.toolSpecification.name));
		expect(mapped).toEqual(["my.tool/name!", "Read"]);
	});

	test("two tools colliding after sanitisation stay distinct", () => {
		const request = build({ messages: [user("hi")], tools: [tool("a.b"), tool("a-b")] });
		const specs = request.body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools ?? [];
		expect(specs.map(spec => spec.toolSpecification.name)).toEqual(["a_b", "a-b"]);
		expect(new Set(specs.map(spec => spec.toolSpecification.name)).size).toBe(2);
	});

	test("a tool used in history but no longer declared still gets a placeholder spec", () => {
		const request = build({
			messages: [
				user("hi"),
				assistant([{ type: "toolCall", id: "t1", name: "gone_tool", arguments: {} }], { stopReason: "toolUse" }),
				toolResult("t1", "ok"),
			],
			tools: [tool("read")],
		});
		const specs = request.body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools ?? [];
		const placeholder = specs.find(spec => spec.toolSpecification.name === "gone_tool");
		expect(placeholder).toBeDefined();
		expect(placeholder?.toolSpecification.description).toContain("no longer available");
	});
});

describe("buildKiroRequest images", () => {
	const withImage: Message = {
		role: "user",
		content: [text("what is this?"), { type: "image", data: "QUJD", mimeType: "image/png" }],
		timestamp: now,
	};

	test("an image model receives the image bytes", () => {
		const current = build({ messages: [withImage] }, undefined, IMAGE_MODEL).body.conversationState.currentMessage
			.userInputMessage;
		expect(current.images).toEqual([{ format: "png", source: { bytes: "QUJD" } }]);
		expect(current.content).not.toContain("omitted");
	});

	test("a text-only model gets an omission note instead of the bytes", () => {
		const current = build({ messages: [withImage] }, undefined, MODEL).body.conversationState.currentMessage
			.userInputMessage;
		expect(current.images).toBeUndefined();
		expect(current.content).toContain("1 image(s) omitted");
		expect(current.content).toContain(MODEL.id);
	});
});

describe("buildKiroRequest conversationId", () => {
	test("is stable per session and differs across sessions", () => {
		const first = build({ messages: [user("hi")] }, { sessionId: "session-a" });
		const again = build({ messages: [user("hi")] }, { sessionId: "session-a" });
		const other = build({ messages: [user("hi")] }, { sessionId: "session-b" });
		expect(first.body.conversationState.conversationId).toBe(again.body.conversationState.conversationId);
		expect(first.body.conversationState.conversationId).not.toBe(other.body.conversationState.conversationId);
	});

	test("falls back to a fresh id when no session is known", () => {
		const a = build({ messages: [user("hi")] });
		const b = build({ messages: [user("hi")] });
		expect(a.body.conversationState.conversationId).not.toBe(b.body.conversationState.conversationId);
	});
});

function anthropicInfo(control: NonNullable<KiroModelInfo["reasoning"]>, maxTokensRange?: { min: number; max: number }): KiroModelInfo {
	return {
		id: "claude-opus-5.5",
		name: "claude-opus-5.5",
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		images: true,
		reasoning: control,
		maxTokensRange,
	};
}

describe("reasoningFields", () => {
	test("returns undefined when the model has no published schema", () => {
		expect(reasoningFields(undefined, { reasoning: efforts("high")[0], maxTokens: 4096 })).toBeUndefined();
	});

	test("anthropic: a request below the lowest supported effort clamps up to it", () => {
		const info = anthropicInfo({
			style: "anthropic",
			efforts: efforts("low", "medium", "high", "xhigh", "max"),
			thinkingTypes: ["adaptive"],
			displays: ["summarized", "omitted"],
		});
		expect(reasoningFields(info, { reasoning: efforts("minimal")[0] })).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "low" },
		});
	});

	test("anthropic: a request above the highest supported effort clamps down to it", () => {
		const info = anthropicInfo({
			style: "anthropic",
			efforts: efforts("low", "medium", "high", "xhigh"),
			thinkingTypes: ["adaptive"],
			displays: ["summarized", "omitted"],
		});
		expect(reasoningFields(info, { reasoning: efforts("max")[0] })).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "xhigh" },
		});
	});

	test("anthropic: turning reasoning off only works when the schema allows disabled thinking", () => {
		const disableAllowed = anthropicInfo({
			style: "anthropic",
			efforts: efforts("low", "high"),
			thinkingTypes: ["adaptive", "disabled"],
			displays: ["summarized"],
		});
		const disableUnsupported = anthropicInfo({
			style: "anthropic",
			efforts: efforts("low", "high"),
			thinkingTypes: ["adaptive"],
			displays: ["summarized"],
		});
		expect(reasoningFields(disableAllowed, { disableReasoning: true })).toEqual({ thinking: { type: "disabled" } });
		expect(reasoningFields(disableUnsupported, { disableReasoning: true })).toBeUndefined();
	});

	test("anthropic: hiding the thinking summary switches display to omitted", () => {
		const info = anthropicInfo({
			style: "anthropic",
			efforts: efforts("low", "high"),
			thinkingTypes: ["adaptive"],
			displays: ["summarized", "omitted"],
		});
		expect(reasoningFields(info, { reasoning: efforts("high")[0], hideThinkingSummary: true })).toEqual({
			thinking: { type: "adaptive", display: "omitted" },
			output_config: { effort: "high" },
		});
	});

	test("openai: turning reasoning off asks for the none effort", () => {
		const info: KiroModelInfo = {
			id: "gpt-5.6-sol",
			name: "gpt-5.6-sol",
			contextWindow: 1_000_000,
			maxOutputTokens: 128_000,
			images: true,
			reasoning: { style: "openai", efforts: efforts("low", "medium", "high", "xhigh", "max"), canDisable: true },
		};
		expect(reasoningFields(info, { disableReasoning: true })).toEqual({ reasoning: { effort: "none" } });
		expect(reasoningFields(info, { reasoning: efforts("minimal")[0] })).toEqual({ reasoning: { effort: "low" } });
	});

	test("max_tokens is clamped into the schema range and omitted when unset", () => {
		const info = anthropicInfo(
			{ style: "anthropic", efforts: efforts("high"), thinkingTypes: ["adaptive"], displays: ["summarized"] },
			{ min: 1024, max: 128_000 },
		);
		expect(reasoningFields(info, { maxTokens: 999_999 })).toEqual({ max_tokens: 128_000 });
		expect(reasoningFields(info, { maxTokens: 10 })).toEqual({ max_tokens: 1024 });
		expect(reasoningFields(info, {})).toBeUndefined();
	});
});
