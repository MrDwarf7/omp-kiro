import type { AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import { getCredentials, type KiroCredentials, kiroHeaders } from "./auth.ts";
import { runtimeEndpoint } from "./constants.ts";
import { EventStreamDecoder, type EventStreamMessage } from "./eventstream.ts";
import { isRecord, numberField, stringField } from "./guards.ts";
import { getModelInfo } from "./models.ts";
import { buildKiroRequest } from "./request.ts";

export class KiroApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

/** True when Kiro rejected the bearer token itself, which a refresh can fix. */
export function isTokenRejection(status: number, body: string): boolean {
	if (status === 401) return true;
	return status === 403 && /expired|invalid.*(bearer|access|token)|token.*(invalid|revoked|expired)/i.test(body);
}

export function describeKiroError(status: number, body: string): string {
	let message = body.trim() || "no details";
	let reason: string | undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		if (isRecord(parsed)) {
			message = stringField(parsed, "message", "Message") ?? message;
			reason = stringField(parsed, "reason", "__type");
		}
	} catch {}
	const detail = reason ? `${message} (${reason})` : message;
	// OMP recognises context overflow by wording; Kiro's own sentence matches none of its patterns.
	if (reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD" || /exceeds threshold|input is too long/i.test(detail)) {
		return `prompt is too long: Kiro rejected the request as larger than the model's context window. Kiro ${status}: ${detail}`;
	}
	if (isTokenRejection(status, body)) {
		return `Kiro ${status}: ${detail}. The Kiro login was rejected; run \`kiro-cli login\` and retry.`;
	}
	return `Kiro ${status}: ${detail}`;
}

type OpenBlock =
	| { kind: "text"; index: number }
	| { kind: "thinking"; index: number }
	| { kind: "toolCall"; index: number; toolUseId: string; json: string; parsedLength: number };

const FIRST_EVENT_TIMEOUT_MS = 180_000;
const IDLE_TIMEOUT_MS = 120_000;

/** Translates Kiro's stream events into OMP's block lifecycle on one assistant message. */
export class KiroResponseTranslator {
	readonly #stream: AssistantMessageEventStream;
	readonly #output: AssistantMessage;
	readonly #toolNames: ReadonlyMap<string, string>;
	#open: OpenBlock | undefined;
	#outputChars = 0;
	#toolCalls = 0;
	readonly #finishedToolUses = new Set<string>();
	stopReason: string | undefined;
	refusal: string | undefined;
	contextPercent: number | undefined;
	tokenUsage: Record<string, unknown> | undefined;
	firstContentAt: number | undefined;

	constructor(stream: AssistantMessageEventStream, output: AssistantMessage, toolNames: ReadonlyMap<string, string>) {
		this.#stream = stream;
		this.#output = output;
		this.#toolNames = toolNames;
	}

	get toolCallCount(): number {
		return this.#toolCalls;
	}

	get outputChars(): number {
		return this.#outputChars;
	}

	handle(message: EventStreamMessage): void {
		const messageType = message.headers[":message-type"];
		const eventType = message.headers[":event-type"] ?? message.headers[":exception-type"];
		let data: Record<string, unknown> = {};
		if (message.payload.length > 0) {
			try {
				const parsed: unknown = JSON.parse(new TextDecoder().decode(message.payload));
				if (isRecord(parsed)) data = parsed;
			} catch {}
		}
		if (messageType === "exception" || messageType === "error") {
			// AWS `error` frames carry their code and text in headers and leave the payload empty.
			const code = message.headers[":error-code"] ?? eventType ?? "error";
			const text =
				message.headers[":error-message"] ?? stringField(data, "message", "Message") ?? JSON.stringify(data);
			throw new KiroApiError(`Kiro stream ${String(code)}: ${String(text)}`);
		}
		switch (eventType) {
			case "assistantResponseEvent": {
				const content = stringField(data, "content");
				if (content) this.#appendText(content);
				return;
			}
			case "reasoningContentEvent":
				this.#handleReasoning(data);
				return;
			case "toolUseEvent":
				this.#handleToolUse(data);
				return;
			case "metadataEvent":
			case "messageMetadataEvent": {
				this.stopReason = stringField(data, "stopReason") ?? this.stopReason;
				if (isRecord(data.tokenUsage)) this.tokenUsage = data.tokenUsage;
				const refusal = isRecord(data.stopDetails) && isRecord(data.stopDetails.refusal) ? data.stopDetails.refusal : undefined;
				if (refusal) {
					const category = stringField(refusal, "category") ?? "REFUSAL";
					const explanation = stringField(refusal, "explanation");
					this.refusal = explanation ? `${category}: ${explanation}` : category;
				}
				return;
			}
			case "contextUsageEvent":
				this.contextPercent = numberField(data, "contextUsagePercentage") ?? this.contextPercent;
				return;
			case "invalidStateEvent":
				throw new KiroApiError(
					`Kiro rejected the conversation state: ${stringField(data, "message", "reason") ?? "invalid state"}`,
				);
			default:
				return;
		}
	}

	finish(): void {
		this.#close();
	}

	/**
	 * Ends the message after a failure. A tool call whose `stop` frame never arrived is dropped
	 * rather than closed, because closing it would hand OMP truncated arguments to execute.
	 */
	abandon(): void {
		const open = this.#open;
		if (open?.kind === "toolCall") {
			this.#open = undefined;
			this.#output.content.splice(open.index, 1);
			this.#toolCalls--;
			return;
		}
		this.#close();
	}

	#markContent(): void {
		this.firstContentAt ??= Date.now();
	}

	#appendText(delta: string): void {
		this.#markContent();
		this.#outputChars += delta.length;
		if (this.#open?.kind !== "text") {
			this.#close();
			const index = this.#output.content.push({ type: "text", text: "" }) - 1;
			this.#open = { kind: "text", index };
			this.#stream.push({ type: "text_start", contentIndex: index, partial: this.#output });
		}
		const block = this.#output.content[this.#open.index];
		if (block?.type === "text") block.text += delta;
		this.#stream.push({ type: "text_delta", contentIndex: this.#open.index, delta, partial: this.#output });
	}

	#handleReasoning(data: Record<string, unknown>): void {
		const text = stringField(data, "text");
		const signature = stringField(data, "signature");
		const redacted = stringField(data, "redactedContent");
		if (text) {
			this.#markContent();
			this.#outputChars += text.length;
			if (this.#open?.kind !== "thinking") {
				this.#close();
				const index = this.#output.content.push({ type: "thinking", thinking: "" }) - 1;
				this.#open = { kind: "thinking", index };
				this.#stream.push({ type: "thinking_start", contentIndex: index, partial: this.#output });
			}
			const block = this.#output.content[this.#open.index];
			if (block?.type === "thinking") block.thinking += text;
			this.#stream.push({ type: "thinking_delta", contentIndex: this.#open.index, delta: text, partial: this.#output });
		}
		if (signature) {
			// The signature arrives after the reasoning text. With `display: "omitted"` it arrives
			// alone, and still has to be kept so the signed (empty) block can be replayed.
			const target = this.#open?.kind === "thinking" ? this.#output.content[this.#open.index] : this.#lastThinking();
			if (target?.type === "thinking") target.thinkingSignature = signature;
			else {
				this.#markContent();
				this.#close();
				const index = this.#output.content.push({ type: "thinking", thinking: "", thinkingSignature: signature }) - 1;
				this.#stream.push({ type: "thinking_start", contentIndex: index, partial: this.#output });
				this.#stream.push({ type: "thinking_end", contentIndex: index, content: "", partial: this.#output });
			}
		}
		if (redacted) {
			this.#markContent();
			this.#close();
			this.#output.content.push({ type: "redactedThinking", data: redacted });
		}
	}

	#lastThinking() {
		return this.#output.content.findLast(block => block.type === "thinking");
	}

	#handleToolUse(data: Record<string, unknown>): void {
		const toolUseId = stringField(data, "toolUseId");
		// A frame for an already-stopped call must not start a second call with the same id,
		// which OMP would execute twice.
		if (!toolUseId || this.#finishedToolUses.has(toolUseId)) return;
		this.#markContent();
		if (this.#open?.kind !== "toolCall" || this.#open.toolUseId !== toolUseId) {
			this.#close();
			const wireName = stringField(data, "name") ?? "tool";
			const toolCall: ToolCall = {
				type: "toolCall",
				id: toolUseId,
				name: this.#toolNames.get(wireName) ?? wireName,
				arguments: {},
			};
			const index = this.#output.content.push(toolCall) - 1;
			this.#open = { kind: "toolCall", index, toolUseId, json: "", parsedLength: 0 };
			this.#toolCalls++;
			this.#stream.push({ type: "toolcall_start", contentIndex: index, partial: this.#output });
		}
		const open = this.#open;
		const input = data.input;
		const delta = typeof input === "string" ? input : isRecord(input) ? JSON.stringify(input) : "";
		if (delta) {
			open.json += delta;
			this.#outputChars += delta.length;
			const block = this.#output.content[open.index];
			// Full re-parses per fragment are quadratic for large arguments such as file writes.
			const parsed = parseStreamingJsonThrottled(open.json, open.parsedLength);
			if (parsed && block?.type === "toolCall") {
				block.arguments = parsed.value;
				open.parsedLength = parsed.parsedLen;
			}
			this.#stream.push({ type: "toolcall_delta", contentIndex: open.index, delta, partial: this.#output });
		}
		if (data.stop === true) this.#close();
	}

	#close(): void {
		const open = this.#open;
		if (!open) return;
		this.#open = undefined;
		const block = this.#output.content[open.index];
		if (open.kind === "text" && block?.type === "text") {
			this.#stream.push({ type: "text_end", contentIndex: open.index, content: block.text, partial: this.#output });
		} else if (open.kind === "thinking" && block?.type === "thinking") {
			this.#stream.push({ type: "thinking_end", contentIndex: open.index, content: block.thinking, partial: this.#output });
		} else if (open.kind === "toolCall" && block?.type === "toolCall") {
			this.#finishedToolUses.add(open.toolUseId);
			block.arguments = open.json.trim() ? parseStreamingJson(open.json) : {};
			this.#stream.push({ type: "toolcall_end", contentIndex: open.index, toolCall: block, partial: this.#output });
		}
	}
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Kiro's metadata event defines a tokenUsage structure but currently leaves it empty, so when
 * it is missing the prompt size comes from the context-usage percentage of the model window and
 * the output size from a characters-per-token estimate.
 */
export function usageFrom(translator: KiroResponseTranslator, contextWindow: number): AssistantMessage["usage"] {
	const usage = emptyUsage();
	const reported = translator.tokenUsage;
	const output = reported ? numberField(reported, "outputTokens") : undefined;
	if (reported && output !== undefined) {
		usage.input = numberField(reported, "uncachedInputTokens") ?? numberField(reported, "inputTokens") ?? 0;
		usage.cacheRead = numberField(reported, "cacheReadInputTokens") ?? 0;
		usage.cacheWrite = numberField(reported, "cacheWriteInputTokens") ?? 0;
		usage.output = output;
	} else {
		usage.output = Math.ceil(translator.outputChars / 4);
		if (translator.contextPercent !== undefined) {
			const occupied = Math.round((contextWindow * translator.contextPercent) / 100);
			usage.contextTokens = occupied;
			usage.input = Math.max(0, occupied - usage.output);
		}
	}
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return usage;
}

async function postGenerate(
	creds: KiroCredentials,
	body: unknown,
	attempt: number,
	signal: AbortSignal | undefined,
): Promise<Response> {
	return fetch(`${runtimeEndpoint(creds.serviceRegion)}/generateAssistantResponse`, {
		method: "POST",
		headers: {
			...kiroHeaders(creds),
			"Content-Type": "application/json",
			Accept: "application/vnd.amazon.eventstream",
			"x-amzn-kiro-agent-mode": "vibe",
			"amz-sdk-invocation-id": crypto.randomUUID(),
			"amz-sdk-request": `attempt=${attempt}; max=2`,
		},
		body: JSON.stringify(body),
		signal,
	});
}

export function streamKiro(model: Model, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const started = Date.now();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: started,
	};

	// OMP only applies its stream watchdog to built-in providers, so a silent Kiro socket would
	// otherwise hang the turn until the user aborts it.
	const watchdog = new AbortController();
	const signal = options?.signal ? AbortSignal.any([options.signal, watchdog.signal]) : watchdog.signal;
	let stall: string | undefined;
	let timer: Timer | undefined;
	const arm = (ms: number, what: string) => {
		clearTimeout(timer);
		if (ms <= 0) return;
		timer = setTimeout(() => {
			stall = `Kiro stream stalled: ${what} for ${ms / 1000}s (timed out)`;
			watchdog.abort();
		}, ms);
	};

	void (async () => {
		let translator: KiroResponseTranslator | undefined;
		try {
			stream.push({ type: "start", partial: output });
			let creds = await getCredentials();
			const info = await getModelInfo(model.id);
			const request = buildKiroRequest(model, context, options, info, creds.profileArn);
			const replaced: unknown = await options?.onPayload?.(request.body, model, options.signal);
			const body = replaced ?? request.body;

			arm(options?.streamFirstEventTimeoutMs ?? FIRST_EVENT_TIMEOUT_MS, "no response");
			let response = await postGenerate(creds, body, 1, signal);
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				if (!isTokenRejection(response.status, text)) throw new KiroApiError(describeKiroError(response.status, text), response.status);
				creds = await getCredentials(true);
				response = await postGenerate(creds, body, 2, signal);
			}
			await options?.onResponse?.(
				{
					status: response.status,
					headers: Object.fromEntries(response.headers),
					requestId: response.headers.get("x-amzn-requestid"),
				},
				model,
				options.signal,
			);
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new KiroApiError(describeKiroError(response.status, text), response.status);
			}
			if (!response.body) throw new KiroApiError("Kiro returned no response body");

			translator = new KiroResponseTranslator(stream, output, request.toolNames);
			const decoder = new EventStreamDecoder();
			const idleMs = options?.streamIdleTimeoutMs ?? IDLE_TIMEOUT_MS;
			for await (const chunk of response.body) {
				arm(idleMs, "no data");
				for (const message of decoder.push(chunk)) translator.handle(message);
			}
			clearTimeout(timer);
			if (decoder.pendingBytes > 0) throw new KiroApiError("Kiro response stream ended mid-frame");
			translator.finish();

			output.usage = usageFrom(translator, model.contextWindow ?? info?.contextWindow ?? 0);
			output.duration = Date.now() - started;
			if (translator.firstContentAt) output.ttft = translator.firstContentAt - started;

			if (translator.refusal) throw new KiroApiError(`Kiro refused the request (${translator.refusal})`);
			if (translator.stopReason === "CONTENT_FILTERED") throw new KiroApiError("Kiro filtered the response (CONTENT_FILTERED)");
			// An empty `stop` is passed through on purpose: OMP retries empty turns itself.
			output.stopReason =
				translator.stopReason === "MAX_TOKENS" ? "length" : translator.toolCallCount > 0 ? "toolUse" : "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			translator?.abandon();
			const aborted = options?.signal?.aborted === true;
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = aborted
				? "Request was aborted"
				: (stall ?? (error instanceof Error ? error.message : String(error)));
			if (error instanceof KiroApiError && error.status !== undefined) output.errorStatus = error.status;
			output.duration = Date.now() - started;
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
		} finally {
			clearTimeout(timer);
			// Releases the connection if the body was not fully read.
			watchdog.abort();
		}
	})();
	return stream;
}
