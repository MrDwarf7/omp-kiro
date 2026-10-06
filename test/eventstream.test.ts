import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
	encodeEventStreamMessage,
	EventStreamDecoder,
	EventStreamError,
	type EventStreamHeaderValue,
	type EventStreamMessage,
} from "../src/eventstream";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function crc32(bytes: Uint8Array): number {
	return zlibCrc32(bytes) >>> 0;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!
	) >>> 0;
}


function be32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function be16(value: number): number[] {
	return [(value >>> 8) & 0xff, value & 0xff];
}

function bytesForValue(value: EventStreamHeaderValue, type: number): number[] {
	switch (type) {
		case 0:
		case 1:
			return [];
		case 2: {
			const b = new Uint8Array(1);
			b[0] = Number(value) & 0xff;
			return [b[0]!];
		}
		case 3: {
			const out = be16(Number(value));
			return out;
		}
		case 4:
			return be32(Number(value));
		case 5:
		case 8: {
			let v = typeof value === "bigint" ? value : BigInt(Number(value));
			const out: number[] = [];
			for (let i = 7; i >= 0; i--) {
				out.push(Number((v >> BigInt(i * 8)) & 0xffn));
			}
			return out;
		}
		case 6:
			return [...be16((value as Uint8Array).length), ...(value as Uint8Array)];
		case 7:
			return [...be16(encoder.encode(value as string).length), ...encoder.encode(value as string)];
		case 9: {
			const hex = (value as string).replace(/-/g, "");
			const out: number[] = [];
			for (let i = 0; i < 16; i++) out.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
			return out;
		}
	}
	throw new Error(`unsupported type ${type}`);
}

/** Hand-rolled frame builder so the decoder is validated against independent wire-format math. */
function buildFrame(entries: Array<{ name: string; type: number; value: EventStreamHeaderValue }>, payload: Uint8Array | string): Uint8Array {
	const payloadBytes = typeof payload === "string" ? encoder.encode(payload) : payload;
	const headerBlocks: number[] = [];
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		headerBlocks.push(name.length, ...name, entry.type, ...bytesForValue(entry.value, entry.type));
	}
	const headersLength = headerBlocks.length;
	const totalLength = 16 + headersLength + payloadBytes.length;

	const prelude = [...be32(totalLength), ...be32(headersLength)];
	const preludeCrc = crc32(new Uint8Array(prelude));
	const withoutMessageCrc = new Uint8Array([...prelude, ...be32(preludeCrc), ...headerBlocks, ...payloadBytes]);
	const messageCrc = crc32(withoutMessageCrc);

	return new Uint8Array([...withoutMessageCrc, ...be32(messageCrc)]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let cursor = 0;
	for (const c of chunks) {
		out.set(c, cursor);
		cursor += c.length;
	}
	return out;
}

const text = (bytes: Uint8Array): string => decoder.decode(bytes);

describe("encodeEventStreamMessage", () => {
	test("produces a frame with correct prelude and message CRCs", () => {
		const frame = encodeEventStreamMessage({ ":event-type": "assistantResponseEvent", ":content-type": "application/json" }, '{"a":1}');
		expect(frame.length).toBeGreaterThan(16);
		expect(readU32BE(frame, 8)).toBe(crc32(frame.subarray(0, 8)));
		expect(readU32BE(frame, frame.length - 4)).toBe(crc32(frame.subarray(0, frame.length - 4)));
	});

	test("handles empty headers and empty payload", () => {
		const frame = encodeEventStreamMessage({}, "");
		expect(frame.length).toBe(16);
		const messages = new EventStreamDecoder().push(frame);
		expect(messages).toHaveLength(1);
		expect(messages[0]!.headers).toEqual({});
		expect(messages[0]!.payload.length).toBe(0);
	});
});

describe("EventStreamDecoder", () => {
	test("round-trips an encoded frame", () => {
		const frame = encodeEventStreamMessage({ ":event-type": "assistantResponseEvent", ":message-type": "event" }, "hello");
		const stream = new EventStreamDecoder();
		expect(stream.pendingBytes).toBe(0);
		const messages = stream.push(frame);
		expect(messages).toHaveLength(1);
		expect(messages[0]!.headers).toEqual({ ":event-type": "assistantResponseEvent", ":message-type": "event" });
		expect(text(messages[0]!.payload)).toBe("hello");
		expect(stream.pendingBytes).toBe(0);
	});

	test("decodes several frames delivered in one chunk", () => {
		const first = encodeEventStreamMessage({ ":event-type": "a" }, "one");
		const second = encodeEventStreamMessage({ ":event-type": "b" }, "two");
		const third = encodeEventStreamMessage({ ":event-type": "c" }, "three");
		const stream = new EventStreamDecoder();
		const messages = stream.push(concat([first, second, third]));
		expect(messages.map(m => m.headers[":event-type"])).toEqual(["a", "b", "c"]);
		expect(messages.map(m => text(m.payload))).toEqual(["one", "two", "three"]);
		expect(stream.pendingBytes).toBe(0);
	});

	test("decodes identically no matter where the stream is split", () => {
		const first = encodeEventStreamMessage({ ":event-type": "assistantResponseEvent", ":content-type": "application/json" }, '{"content":"Hey"}');
		const second = encodeEventStreamMessage({ ":event-type": "metadataEvent" }, '{"stopReason":"END_TURN"}');
		const streamBytes = concat([first, second]);
		const expected: Array<{ headers: Record<string, string>; body: string }> = [
			{ headers: { ":event-type": "assistantResponseEvent", ":content-type": "application/json" }, body: '{"content":"Hey"}' },
			{ headers: { ":event-type": "metadataEvent" }, body: '{"stopReason":"END_TURN"}' },
		];

		for (let split = 0; split <= streamBytes.length; split++) {
			const stream = new EventStreamDecoder();
			const messages = [
				...stream.push(streamBytes.subarray(0, split)),
				...stream.push(streamBytes.subarray(split)),
			];
			expect(messages.map(m => m.headers)).toEqual(expected.map(e => e.headers));
			expect(messages.map(m => text(m.payload))).toEqual(expected.map(e => e.body));
			expect(stream.pendingBytes).toBe(0);
		}
	});

	test("decodes a frame delivered one byte at a time", () => {
		const frame = encodeEventStreamMessage({ ":event-type": "pulse" }, "x".repeat(300));
		const stream = new EventStreamDecoder();
		const messages: EventStreamMessage[] = [];
		for (let i = 0; i < frame.length; i++) {
			messages.push(...stream.push(frame.subarray(i, i + 1)));
			if (i < frame.length - 1) expect(messages).toHaveLength(0);
		}
		expect(messages).toHaveLength(1);
		expect(messages[0]!.headers[":event-type"]).toBe("pulse");
		expect(messages[0]!.payload.length).toBe(300);
	});

	test("returned payloads do not alias the caller's buffer", () => {
		const frame = encodeEventStreamMessage({ ":event-type": "alias" }, "ORIGINAL");
		const stream = new EventStreamDecoder();
		const messages = stream.push(frame);
		frame.fill(0xff);
		expect(text(messages[0]!.payload)).toBe("ORIGINAL");
	});

	test("decodes every non-string header type", () => {
		const frame = buildFrame(
			[
				{ name: "b0", type: 0, value: true },
				{ name: "b1", type: 1, value: false },
				{ name: "i8", type: 2, value: -2 },
				{ name: "i16", type: 3, value: -300 },
				{ name: "i32", type: 4, value: -70000 },
				{ name: "i64", type: 5, value: 1234567890123n },
				{ name: "neg64", type: 5, value: -2n },
				{ name: "bytes", type: 6, value: new Uint8Array([1, 2, 3]) },
				{ name: "str", type: 7, value: "héllo" },
				{ name: "ts", type: 8, value: 1700000000123 },
				{ name: "uuid", type: 9, value: "123e4567-e89b-12d3-a456-426614174000" },
			],
			"payload",
		);
		const messages = new EventStreamDecoder().push(frame);
		expect(messages).toHaveLength(1);
		expect(messages[0]!.headers).toEqual({
			b0: true,
			b1: false,
			i8: -2,
			i16: -300,
			i32: -70000,
			i64: 1234567890123n,
			neg64: -2n,
			bytes: new Uint8Array([1, 2, 3]),
			str: "héllo",
			ts: 1700000000123,
			uuid: "123e4567-e89b-12d3-a456-426614174000",
		});
		expect(text(messages[0]!.payload)).toBe("payload");
	});

	test("throws on a corrupted prelude CRC", () => {
		const frame = encodeEventStreamMessage({ ":event-type": "corrupt" }, "body");
		frame[8] ^= 0xff;
		expect(() => new EventStreamDecoder().push(frame)).toThrow(EventStreamError);
		expect(() => new EventStreamDecoder().push(frame)).toThrow(/prelude CRC mismatch/);
	});

	test("throws on a corrupted message CRC", () => {
		const frame = encodeEventStreamMessage({ ":event-type": "corrupt" }, "body");
		frame[frame.length - 5] ^= 0xff;
		expect(() => new EventStreamDecoder().push(frame)).toThrow(/message CRC mismatch/);
	});

	test("throws on a truncated total_length and an oversize one", () => {
		const frame = encodeEventStreamMessage({ ":event-type": "x" }, "y");
		const tooSmall = frame.slice();
		tooSmall.set(be32(8), 0);
		tooSmall.set(be32(0), 8);
		expect(() => new EventStreamDecoder().push(tooSmall)).toThrow(/total_length 8/);

		const tooLarge = frame.slice();
		tooLarge.set(be32(32 * 1024 * 1024), 0);
		tooLarge.set(be32(0), 8);
		expect(() => new EventStreamDecoder().push(tooLarge)).toThrow(/exceeds/);
	});

	test("throws when headers_length does not fit the frame", () => {
		const frame = encodeEventStreamMessage({ ":event-type": "x" }, "y");
		frame.set(be32(frame.length + 10), 4);
		frame.set(be32(crc32(frame.subarray(0, 8))), 8);
		expect(() => new EventStreamDecoder().push(frame)).toThrow(/headers_length/);
	});

	test("throws when a header runs past the header block", () => {
		const frame = buildFrame([{ name: "ok", type: 7, value: "v" }], "p");
		// Shrink headers_length by 3 so the declared header block cuts the value short.
		frame[7] -= 3;
		frame.set(be32(crc32(frame.subarray(0, 8))), 8);
		frame.set(be32(crc32(frame.subarray(0, frame.length - 4))), frame.length - 4);
		expect(() => new EventStreamDecoder().push(frame)).toThrow(EventStreamError);
	});

	test("truncated input buffers without yielding messages", () => {
		const frame = encodeEventStreamMessage({ ":event-type": "trunc" }, "cut me off");
		const stream = new EventStreamDecoder();
		for (let i = 1; i < frame.length; i++) {
			expect(stream.push(frame.subarray(i - 1, i))).toHaveLength(0);
			expect(stream.pendingBytes).toBe(i);
		}
		expect(stream.push(frame.subarray(frame.length - 1))).toHaveLength(1);
		expect(stream.pendingBytes).toBe(0);
	});

	test("decodes a frame arriving across a trailing partial frame", () => {
		const first = encodeEventStreamMessage({ ":event-type": "first" }, "1");
		const second = encodeEventStreamMessage({ ":event-type": "second" }, "2");
		const stream = new EventStreamDecoder();
		const all = concat([first, second]);
		const messages = stream.push(all.subarray(0, first.length + 3));
		expect(messages).toHaveLength(1);
		expect(text(messages[0]!.payload)).toBe("1");
		expect(stream.pendingBytes).toBe(3);
		expect(stream.push(all.subarray(first.length + 3))).toHaveLength(1);
		expect(stream.pendingBytes).toBe(0);
	});

	test("decodes the captured Kiro assistantResponseEvent/metadataEvent stream in 7-byte chunks", () => {
		const captured = concat([
			encodeEventStreamMessage(
				{
					":event-type": "assistantResponseEvent",
					":content-type": "application/json",
					":message-type": "event",
				},
				'{"content":"Hey","modelId":"claude-haiku-4.5"}',
			),
			encodeEventStreamMessage(
				{
					":event-type": "metadataEvent",
					":content-type": "application/json",
					":message-type": "event",
				},
				'{"stopReason":"END_TURN"}',
			),
		]);

		const stream = new EventStreamDecoder();
		const decoded: Array<{ type: unknown; body: unknown }> = [];
		for (let i = 0; i < captured.length; i += 7) {
			for (const message of stream.push(captured.subarray(i, i + 7))) {
				expect(message.headers[":content-type"]).toBe("application/json");
				expect(message.headers[":message-type"]).toBe("event");
				decoded.push({ type: message.headers[":event-type"], body: JSON.parse(text(message.payload)) });
			}
		}

		expect(decoded).toEqual([
			{ type: "assistantResponseEvent", body: { content: "Hey", modelId: "claude-haiku-4.5" } },
			{ type: "metadataEvent", body: { stopReason: "END_TURN" } },
		]);
		expect(stream.pendingBytes).toBe(0);
	});
});