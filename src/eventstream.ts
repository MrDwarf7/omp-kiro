import { TextDecoder, TextEncoder } from "node:util";

export type EventStreamHeaderValue = boolean | number | bigint | string | Uint8Array;

export interface EventStreamMessage {
	headers: Record<string, EventStreamHeaderValue>;
	payload: Uint8Array;
}

export class EventStreamError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EventStreamError";
	}
}

const PRELUDE_BYTES = 8;
const PRELUDE_CRC_BYTES = 4;
const MESSAGE_CRC_BYTES = 4;
const MIN_FRAME_BYTES = PRELUDE_BYTES + PRELUDE_CRC_BYTES + MESSAGE_CRC_BYTES;
const HEADER_OVERHEAD = 1;

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

// Built on first use so module load does no work before a stream arrives.
let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
	if (crcTable) return crcTable;
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	crcTable = table;
	return table;
}

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
	const table = getCrcTable();
	let crc = 0xffffffff;
	for (let i = start; i < end; i++) crc = table[(crc ^ bytes[i]) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

const view = new DataView(new ArrayBuffer(8));

function readUint32BE(bytes: Uint8Array, offset: number): number {
	view.setUint8(0, bytes[offset]!);
	view.setUint8(1, bytes[offset + 1]!);
	view.setUint8(2, bytes[offset + 2]!);
	view.setUint8(3, bytes[offset + 3]!);
	return view.getUint32(0);
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
	view.setUint8(0, bytes[offset]!);
	view.setUint8(1, bytes[offset + 1]!);
	return view.getUint16(0);
}

function readIntBE(bytes: Uint8Array, offset: number, byteLength: 1 | 2 | 4 | 8): number | bigint {
	let value = 0n;
	for (let i = 0; i < byteLength; i++) value = (value << 8n) | BigInt(bytes[offset + i]!);
	const bits = BigInt(byteLength * 8);
	if (value >= 1n << (bits - 1n)) value -= 1n << bits;
	if (byteLength === 8) return value;
	return Number(value);
}

function formatUuid(bytes: Uint8Array, offset: number): string {
	let out = "";
	for (let i = 0; i < 16; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
		out += bytes[offset + i]!.toString(16).padStart(2, "0");
	}
	return out;
}

function decodeHeaderValue(type: number, bytes: Uint8Array, offset: number, length: number): EventStreamHeaderValue {
	switch (type) {
		case 0:
			return true;
		case 1:
			return false;
		case 2:
			return readIntBE(bytes, offset, 1) as number;
		case 3:
			return readIntBE(bytes, offset, 2) as number;
		case 4:
			return readIntBE(bytes, offset, 4) as number;
		case 5:
			return readIntBE(bytes, offset, 8) as bigint;
		case 6:
			return bytes.slice(offset, offset + length);
		case 7:
			return utf8Decoder.decode(bytes.subarray(offset, offset + length));
		case 8:
			return Number(readIntBE(bytes, offset, 8));
		case 9:
			return formatUuid(bytes, offset);
		default:
			throw new EventStreamError(`unsupported header value type ${type}`);
	}
}

function headerValueLength(type: number, bytes: Uint8Array, offset: number): number {
	switch (type) {
		case 0:
		case 1:
			return 0;
		case 2:
			return 1;
		case 3:
			return 2;
		case 4:
			return 4;
		case 5:
		case 8:
			return 8;
		case 6:
		case 7:
			return 2 + readUint16BE(bytes, offset);
		case 9:
			return 16;
		default:
			throw new EventStreamError(`unsupported header value type ${type}`);
	}
}

function decodeHeaders(block: Uint8Array, headersLength: number): Record<string, EventStreamHeaderValue> {
	const headers: Record<string, EventStreamHeaderValue> = {};
	let cursor = 0;
	while (cursor < headersLength) {
		if (cursor + HEADER_OVERHEAD > headersLength)
			throw new EventStreamError(`header name length overruns header block at offset ${cursor}`);
		const nameLength = block[cursor]!;
		cursor += HEADER_OVERHEAD;
		if (cursor + nameLength + HEADER_OVERHEAD > headersLength)
			throw new EventStreamError(`header name overruns header block at offset ${cursor}`);
		const name = utf8Decoder.decode(block.subarray(cursor, cursor + nameLength));
		cursor += nameLength;
		const type = block[cursor]!;
		cursor += HEADER_OVERHEAD;
		// Only length-prefixed value types carry the two leading length bytes inside `occupied`.
		const lengthPrefix = type === 6 || type === 7 ? 2 : 0;
		const occupied = headerValueLength(type, block, cursor);
		if (cursor + occupied > headersLength)
			throw new EventStreamError(`header value overruns header block for header "${name}"`);
		headers[name] = decodeHeaderValue(type, block, cursor + lengthPrefix, occupied - lengthPrefix);
		cursor += occupied;
	}
	return headers;
}

const HEADER_TYPE_STRING = 7;


/**
 * Encodes one frame with string-typed (type 7) headers. Used by tests and fixtures.
 */
export function encodeEventStreamMessage(
	headers: Record<string, string>,
	payload: Uint8Array | string,
): Uint8Array {
	const payloadBytes = typeof payload === "string" ? utf8Encoder.encode(payload) : payload;
	const names = Object.keys(headers);
	const headerBlocks = names.map(name => {
		const nameBytes = utf8Encoder.encode(name);
		const valueBytes = utf8Encoder.encode(headers[name]!);
		const block = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
		let cursor = 0;
		block[cursor++] = nameBytes.length;
		block.set(nameBytes, cursor);
		cursor += nameBytes.length;
		block[cursor++] = HEADER_TYPE_STRING;
		block[cursor++] = (valueBytes.length >>> 8) & 0xff;
		block[cursor++] = valueBytes.length & 0xff;
		block.set(valueBytes, cursor);
		return block;
	});
	const headersLength = headerBlocks.reduce((total, block) => total + block.length, 0);
	const totalLength = MIN_FRAME_BYTES + headersLength + payloadBytes.length;

	const frame = new Uint8Array(totalLength);
	frame[0] = (totalLength >>> 24) & 0xff;
	frame[1] = (totalLength >>> 16) & 0xff;
	frame[2] = (totalLength >>> 8) & 0xff;
	frame[3] = totalLength & 0xff;
	frame[4] = (headersLength >>> 24) & 0xff;
	frame[5] = (headersLength >>> 16) & 0xff;
	frame[6] = (headersLength >>> 8) & 0xff;
	frame[7] = headersLength & 0xff;

	const preludeCrc = crc32(frame, 0, PRELUDE_BYTES);
	frame[8] = (preludeCrc >>> 24) & 0xff;
	frame[9] = (preludeCrc >>> 16) & 0xff;
	frame[10] = (preludeCrc >>> 8) & 0xff;
	frame[11] = preludeCrc & 0xff;

	let cursor = 12;
	for (const block of headerBlocks) {
		frame.set(block, cursor);
		cursor += block.length;
	}
	frame.set(payloadBytes, cursor);

	const messageCrc = crc32(frame, 0, totalLength - MESSAGE_CRC_BYTES);
	const crcOffset = totalLength - MESSAGE_CRC_BYTES;
	frame[crcOffset] = (messageCrc >>> 24) & 0xff;
	frame[crcOffset + 1] = (messageCrc >>> 16) & 0xff;
	frame[crcOffset + 2] = (messageCrc >>> 8) & 0xff;
	frame[crcOffset + 3] = messageCrc & 0xff;
	return frame;
}

function concatChunks(chunks: readonly Uint8Array[], offset: number, length: number): Uint8Array {
	const out = new Uint8Array(length);
	let cursor = 0;
	let skipped = offset;
	for (const chunk of chunks) {
		if (skipped >= chunk.length) {
			skipped -= chunk.length;
			continue;
		}
		const take = Math.min(chunk.length - skipped, length - cursor);
		out.set(chunk.subarray(skipped, skipped + take), cursor);
		cursor += take;
		skipped = 0;
		if (cursor === length) break;
	}
	return out;
}

export class EventStreamDecoder {
	private chunks: Uint8Array[] = [];
	private buffered = 0;
	private frameCursor = 0;

	get pendingBytes(): number {
		return this.buffered - this.frameCursor;
	}

	push(chunk: Uint8Array): EventStreamMessage[] {
		if (chunk.length > 0) {
			this.chunks.push(chunk);
			this.buffered += chunk.length;
		}
		const messages: EventStreamMessage[] = [];
		try {
			for (;;) {
				const frame = this.nextFrame();
				if (!frame) break;
				messages.push(frame);
			}
		} finally {
			this.compact();
		}
		return messages;
	}

	/**
	 * Returns the next decodable frame, or null while the buffered bytes are
	 * still incomplete. `frame` may alias `this.chunks`; only its payload is copied.
	 */
	private nextFrame(): EventStreamMessage | null {
		const available = this.pendingBytes;
		if (available < MIN_FRAME_BYTES) return null;

		const prelude = this.peek(PRELUDE_BYTES + PRELUDE_CRC_BYTES);
		const totalLength = readUint32BE(prelude, 0);
		const headersLength = readUint32BE(prelude, 4);
		if (totalLength < MIN_FRAME_BYTES)
			throw new EventStreamError(`frame total_length ${totalLength} is below the ${MIN_FRAME_BYTES}-byte minimum`);
		if (totalLength > MAX_FRAME_BYTES)
			throw new EventStreamError(`frame total_length ${totalLength} exceeds the ${MAX_FRAME_BYTES}-byte limit`);
		if (headersLength > totalLength - MIN_FRAME_BYTES)
			throw new EventStreamError(`frame headers_length ${headersLength} does not fit in total_length ${totalLength}`);
		if (available < totalLength) return null;

		const frame = this.take(totalLength);
		const expectedPreludeCrc = readUint32BE(frame, PRELUDE_BYTES);
		const actualPreludeCrc = crc32(frame, 0, PRELUDE_BYTES);
		if (expectedPreludeCrc !== actualPreludeCrc)
			throw new EventStreamError(
				`prelude CRC mismatch: expected ${expectedPreludeCrc}, computed ${actualPreludeCrc}`,
			);

		const crcOffset = totalLength - MESSAGE_CRC_BYTES;
		const expectedMessageCrc = readUint32BE(frame, crcOffset);
		const actualMessageCrc = crc32(frame, 0, crcOffset);
		if (expectedMessageCrc !== actualMessageCrc)
			throw new EventStreamError(
				`message CRC mismatch: expected ${expectedMessageCrc}, computed ${actualMessageCrc}`,
			);

		const headers = decodeHeaders(frame.subarray(12, 12 + headersLength), headersLength);
		const payloadStart = 12 + headersLength;
		// Copy: `frame` may be a view over a chunk the caller or a later frame reuses.
		const payload = new Uint8Array(crcOffset - payloadStart);
		payload.set(frame.subarray(payloadStart, crcOffset));
		return { headers, payload };
	}

	/** Copies `length` bytes at the current frame cursor without consuming them. */
	private peek(length: number): Uint8Array {
		const head = this.chunks[0];
		if (head && head.length - this.frameCursor >= length) return head.subarray(this.frameCursor, this.frameCursor + length);
		return concatChunks(this.chunks, this.frameCursor, length);
	}

	/** Consumes `length` bytes, returning them as a possibly-aliased view. */
	private take(length: number): Uint8Array {
		const head = this.chunks[0];
		if (head && head.length - this.frameCursor >= length) {
			const out = head.subarray(this.frameCursor, this.frameCursor + length);
			this.frameCursor += length;
			return out;
		}
		const out = concatChunks(this.chunks, this.frameCursor, length);
		this.frameCursor += length;
		return out;
	}

	/**
	 * Drops fully consumed chunks and copies any partial head into owned storage, so a
	 * long stream neither re-copies itself nor aliases caller buffers.
	 */
	private compact(): void {
		if (this.frameCursor === 0) return;
		this.buffered -= this.frameCursor;
		while (this.chunks.length > 0 && this.frameCursor >= this.chunks[0]!.length) {
			this.frameCursor -= this.chunks.shift()!.length;
		}
		if (this.chunks.length === 0) {
			this.frameCursor = 0;
			return;
		}
		const head = this.chunks[0]!;
		const remainder = new Uint8Array(head.length - this.frameCursor);
		remainder.set(head.subarray(this.frameCursor));
		this.chunks[0] = remainder;
		this.frameCursor = 0;
	}
}
