import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { encodeEventStreamMessage, EventStreamDecoder, type EventStreamMessage } from "../src/eventstream";
import { KiroApiError, KiroResponseTranslator, usageFrom } from "../src/stream";

function emptyOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "kiro-generate-assistant-response",
		provider: "kiro",
		model: "claude-sonnet-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

interface WireFrame {
	event: string;
	payload?: Record<string, unknown>;
}

/** Frames are encoded to the real wire format and decoded back, as the live response does. */
function decodeFrames(frames: readonly WireFrame[]): EventStreamMessage[] {
	const decoder = new EventStreamDecoder();
	const messages: EventStreamMessage[] = [];
	for (const frame of frames) {
		const bytes = encodeEventStreamMessage(
			{ ":message-type": "event", ":event-type": frame.event, ":content-type": "application/json" },
			JSON.stringify(frame.payload ?? {}),
		);
		messages.push(...decoder.push(bytes));
	}
	expect(decoder.pendingBytes).toBe(0);
	return messages;
}

function exceptionFrame(type: string, message: string): EventStreamMessage {
	return {
		headers: { ":message-type": "exception", ":exception-type": type },
		payload: new TextEncoder().encode(JSON.stringify({ message })),
	};
}

async function run(
	frames: readonly WireFrame[],
	toolNames: ReadonlyMap<string, string> = new Map(),
	terminate: (translator: KiroResponseTranslator) => void = translator => translator.finish(),
): Promise<{ events: AssistantMessageEvent[]; output: AssistantMessage; translator: KiroResponseTranslator }> {
	const output = emptyOutput();
	const stream = new AssistantMessageEventStream();
	const translator = new KiroResponseTranslator(stream, output, toolNames);
	for (const message of decodeFrames(frames)) translator.handle(message);
	terminate(translator);
	stream.end(output);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, output, translator };
}

const eventTypes = (events: readonly AssistantMessageEvent[]): string[] => events.map(event => event.type);

describe("KiroResponseTranslator text", () => {
	test("consecutive deltas accumulate into a single text block", async () => {
		const { events, output } = await run([
			{ event: "assistantResponseEvent", payload: { content: "Hello" } },
			{ event: "assistantResponseEvent", payload: { content: ", " } },
			{ event: "assistantResponseEvent", payload: { content: "world" } },
			{ event: "metadataEvent", payload: { stopReason: "END_TURN" } },
		]);
		expect(eventTypes(events)).toEqual(["text_start", "text_delta", "text_delta", "text_delta", "text_end"]);
		expect(output.content).toEqual([{ type: "text", text: "Hello, world" }]);
		const end = events.at(-1);
		expect(end?.type === "text_end" ? end.content : undefined).toBe("Hello, world");
	});

	test("text arriving after a tool call opens a new block instead of merging", async () => {
		const { output } = await run([
			{ event: "toolUseEvent", payload: { toolUseId: "t1", name: "read", input: "{}", stop: true } },
			{ event: "assistantResponseEvent", payload: { content: "done" } },
		]);
		expect(output.content.map(block => block.type)).toEqual(["toolCall", "text"]);
	});
});

describe("KiroResponseTranslator reasoning", () => {
	test("reasoning text plus a later signature yields one signed thinking block closed before the text", async () => {
		const { events, output } = await run([
			{ event: "reasoningContentEvent", payload: { text: "let me " } },
			{ event: "reasoningContentEvent", payload: { text: "think" } },
			{ event: "reasoningContentEvent", payload: { signature: "sig-1" } },
			{ event: "assistantResponseEvent", payload: { content: "answer" } },
		]);
		expect(output.content).toEqual([
			{ type: "thinking", thinking: "let me think", thinkingSignature: "sig-1" },
			{ type: "text", text: "answer" },
		]);
		const types = eventTypes(events);
		expect(types).toEqual([
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
		]);
	});

	test("a lone signature with no reasoning text still produces a signed block that can be replayed", async () => {
		// With display "omitted" Kiro sends only the signature; dropping it would break the
		// signed-replay contract on the next request.
		const { events, output } = await run([
			{ event: "reasoningContentEvent", payload: { signature: "sig-omitted" } },
			{ event: "assistantResponseEvent", payload: { content: "answer" } },
		]);
		expect(output.content).toEqual([
			{ type: "thinking", thinking: "", thinkingSignature: "sig-omitted" },
			{ type: "text", text: "answer" },
		]);
		expect(eventTypes(events)).toEqual([
			"thinking_start",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
		]);
	});
});

describe("KiroResponseTranslator tool calls", () => {
	test("a call split across frames parses its arguments and reports the wire name's real name", async () => {
		const { events, output } = await run(
			[
				{ event: "toolUseEvent", payload: { toolUseId: "t1", name: "my_read_tool" } },
				{ event: "toolUseEvent", payload: { toolUseId: "t1", input: '{"path":' } },
				{ event: "toolUseEvent", payload: { toolUseId: "t1", input: '"/tmp/a b.txt"}', stop: true } },
				{ event: "metadataEvent", payload: { stopReason: "TOOL_USE" } },
			],
			new Map([["my_read_tool", "read:file"]]),
		);
		expect(eventTypes(events)).toEqual(["toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end"]);
		expect(output.content).toEqual([
			{ type: "toolCall", id: "t1", name: "read:file", arguments: { path: "/tmp/a b.txt" } },
		]);
		const end = events.at(-1);
		expect(end?.type === "toolcall_end" ? end.toolCall.arguments : undefined).toEqual({ path: "/tmp/a b.txt" });
	});

	test("a truncated argument stream still closes with the best-effort object", async () => {
		const { output } = await run([
			{ event: "toolUseEvent", payload: { toolUseId: "t1", name: "read", input: '{"a":1,"b":' } },
		]);
		const block = output.content[0];
		expect(block?.type === "toolCall" ? block.arguments : undefined).toMatchObject({ a: 1 });
	});

	test("two consecutive calls produce two separate blocks", async () => {
		const { output } = await run([
			{ event: "toolUseEvent", payload: { toolUseId: "t1", name: "read", input: '{"x":1}', stop: true } },
			{ event: "toolUseEvent", payload: { toolUseId: "t2", name: "write", input: '{"y":2}', stop: true } },
		]);
		expect(output.content).toEqual([
			{ type: "toolCall", id: "t1", name: "read", arguments: { x: 1 } },
			{ type: "toolCall", id: "t2", name: "write", arguments: { y: 2 } },
		]);
	});

	test("a frame without an input is not counted as a delta", async () => {
		const { events } = await run([{ event: "toolUseEvent", payload: { toolUseId: "t1", name: "read" } }]);
		expect(eventTypes(events)).toEqual(["toolcall_start", "toolcall_end"]);
	});

	test("a repeated frame for an already-stopped call is ignored instead of starting a second call", async () => {
		const { events, output } = await run([
			{ event: "toolUseEvent", payload: { toolUseId: "t1", name: "read", input: '{"x":1}', stop: true } },
			{ event: "toolUseEvent", payload: { toolUseId: "t1", name: "read", input: '{"x":2}' } },
		]);
		// A second toolCall block with the same id would make OMP execute the tool twice.
		expect(eventTypes(events)).toEqual(["toolcall_start", "toolcall_delta", "toolcall_end"]);
		expect(output.content).toEqual([{ type: "toolCall", id: "t1", name: "read", arguments: { x: 1 } }]);
	});

	test("abandon drops an unfinished tool call instead of handing truncated arguments to execution", async () => {
		const { events, output, translator } = await run(
			[
				{ event: "assistantResponseEvent", payload: { content: "working" } },
				{ event: "toolUseEvent", payload: { toolUseId: "t1", name: "write", input: '{"path":"/tmp/x"' } },
			],
			new Map(),
			t => t.abandon(),
		);
		expect(eventTypes(events)).toEqual(["text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta"]);
		expect(output.content).toEqual([{ type: "text", text: "working" }]);
		expect(translator.toolCallCount).toBe(0);
	});

	test("abandon closes an open text block rather than dropping it", async () => {
		const { events, output } = await run(
			[{ event: "assistantResponseEvent", payload: { content: "partial answer" } }],
			new Map(),
			t => t.abandon(),
		);
		expect(eventTypes(events)).toEqual(["text_start", "text_delta", "text_end"]);
		expect(output.content).toEqual([{ type: "text", text: "partial answer" }]);
	});
});

describe("KiroResponseTranslator errors", () => {
	test("an exception frame throws a KiroApiError carrying the service message", () => {
		const stream = new AssistantMessageEventStream();
		const translator = new KiroResponseTranslator(stream, emptyOutput(), new Map());
		let thrown: unknown;
		try {
			translator.handle(exceptionFrame("ThrottlingException", "Too many requests"));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(KiroApiError);
		expect((thrown as Error).message).toContain("ThrottlingException");
		expect((thrown as Error).message).toContain("Too many requests");
	});

	test("an error frame reads its code and message from the event-stream headers", () => {
		const stream = new AssistantMessageEventStream();
		const translator = new KiroResponseTranslator(stream, emptyOutput(), new Map());
		// AWS `error` frames carry no payload, so only the headers describe the failure.
		expect(() =>
			translator.handle({
				headers: {
					":message-type": "error",
					":error-code": "ThrottlingException",
					":error-message": "Rate exceeded",
				},
				payload: new Uint8Array(0),
			}),
		).toThrow(/ThrottlingException: Rate exceeded/);
	});

	test("an invalidStateEvent reports Kiro's own reason", () => {
		const stream = new AssistantMessageEventStream();
		const translator = new KiroResponseTranslator(stream, emptyOutput(), new Map());
		expect(() =>
			translator.handle({
				headers: { ":message-type": "event", ":event-type": "invalidStateEvent" },
				payload: new TextEncoder().encode(JSON.stringify({ message: "tool result mismatch" })),
			}),
		).toThrow(/tool result mismatch/);
	});
});

describe("usageFrom", () => {
	test("estimates input from the context-usage percentage when Kiro reports no tokenUsage", async () => {
		const { translator } = await run([
			{ event: "assistantResponseEvent", payload: { content: "abcdefgh" } },
			{ event: "contextUsageEvent", payload: { contextUsagePercentage: 10 } },
		]);
		const usage = usageFrom(translator, 1000);
		expect(usage.output).toBe(2);
		expect(usage.contextTokens).toBe(100);
		expect(usage.input).toBe(98);
		expect(usage.totalTokens).toBe(100);
	});

	test("uses the reported tokenUsage when Kiro provides one", async () => {
		const { translator } = await run([
			{ event: "assistantResponseEvent", payload: { content: "abcdefgh" } },
			{
				event: "metadataEvent",
				payload: {
					stopReason: "END_TURN",
					tokenUsage: { inputTokens: 900, uncachedInputTokens: 11, cacheReadInputTokens: 3, cacheWriteInputTokens: 1, outputTokens: 5 },
				},
			},
		]);
		const usage = usageFrom(translator, 1000);
		expect(usage.input).toBe(11);
		expect(usage.cacheRead).toBe(3);
		expect(usage.cacheWrite).toBe(1);
		expect(usage.output).toBe(5);
		expect(usage.totalTokens).toBe(20);
		expect(usage.contextTokens).toBeUndefined();
	});

	test("an empty tokenUsage object falls back to the estimate", async () => {
		const { translator } = await run([
			{ event: "assistantResponseEvent", payload: { content: "abcd" } },
			{ event: "metadataEvent", payload: { stopReason: "END_TURN", tokenUsage: {} } },
		]);
		const usage = usageFrom(translator, 1000);
		expect(usage.output).toBe(1);
		expect(usage.input).toBe(0);
	});
});
