import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
	ToolExecutionComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";

// pi-muse-msp: Muse via `muse serve` MSP (stdio JSON-RPC) as a Pi provider
// ("muse-msp"). Direct chat (no subagent handoff prompt). Long-lived host,
// true streaming, live token usage, image input. One MSP session per Pi chat
// and process; after a restart, a fresh session gets full Pi context.
// Approvals are automatic by default, with Pi UI as a fallback; Muse
// clarification prompts use Pi's native dialogs when available.

const PROVIDER_ID = "muse-msp";
const MSP_API = "muse-msp" as Api;
const API_PROVIDER_SOURCE = "local:muse-msp";
const MSP_FINGERPRINT = process.env.PI_MUSE_MSP_FINGERPRINT?.trim() ?? "";
const CLIENT_VERSION = "0.2.2";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface MspImage {
	mediaType: string;
	base64Data: string;
}

function uuid7(): string {
	// 48-bit millis | ver 7 + 12-bit rand | variant 10 + 14-bit rand | 48-bit rand
	const timeHex = Date.now().toString(16).padStart(12, "0");
	const rand = randomBytes(10).toString("hex"); // 20 hex chars
	const a = `7${rand.slice(1, 4)}`;
	const b = ((Number.parseInt(rand.slice(4, 8), 16) & 0x3fff) | 0x8000).toString(16).padStart(4, "0");
	const c = rand.slice(8, 20);
	return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-${a}-${b}-${c}`;
}

function museBinary(): string {
	return process.env.PI_MUSE_BINARY?.trim() || "muse";
}

function envSandboxed(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_MUSE_MSP_SANDBOXED?.trim() ?? "");
}

function mspSandboxed(pi: ExtensionAPI): boolean {
	if (pi.getFlag("muse-msp-sandboxed") === true) return true;
	return envSandboxed();
}

// Authoritative posture from the most recent turn. Pi applies CLI extension
// flags after the startup model refresh, so a flag read at refresh time may
// still be the default — the turn path records the real value here instead.
let lastMspSandboxed: boolean | null = null;

function reasoningEffort(level: ThinkingLevel | undefined): string | undefined {
	if (level === undefined) return undefined;
	if (level === "off") return "none";
	if (level === "max") return "ultra";
	return level;
}

// ---------------------------------------------------------------------------
// MSP host (one `muse serve` child per Pi process, lazy singleton)
// ---------------------------------------------------------------------------

type Pending = {
	generation: number;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
};

type NotificationHandler = (params: Record<string, unknown>) => void;

function debugLog(message: string): void {
	if (/^(1|true|yes)$/i.test(process.env.PI_MUSE_MSP_DEBUG?.trim() ?? "")) {
		process.stderr.write(`[muse-msp] ${message}\n`);
	}
}

class MspHost {
	private child: ChildProcess | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private buffer = "";
	private ready: { generation: number; promise: Promise<void> } | null = null;
	private generation = 0;
	private fingerprint: string | null = null;
	private sandboxed: boolean | null = null;
	private spawnError: string | null = null;

	onNotification(method: string, handler: NotificationHandler): () => void {
		let set = this.notificationHandlers.get(method);
		if (!set) {
			set = new Set();
			this.notificationHandlers.set(method, set);
		}
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	}

	async ensure(sandboxed: boolean): Promise<void> {
		// A dead or failed host must respawn: `child.killed` is only set by
		// kill(), so also check exitCode, and never reuse a spawn that
		// recorded spawnError (previously this retried the dead host forever).
		const alive =
			!!this.child && !this.child.killed && this.child.exitCode === null && !this.spawnError;
		if (this.child && (!alive || this.sandboxed !== sandboxed)) {
			// Sandbox posture is fixed for the host lifetime: respawn on change.
			this.dispose(!alive ? "ensure: dead or failed host" : "ensure: sandbox posture changed");
		}
		if (!this.ready) this.ready = this.spawn(sandboxed);
		const ready = this.ready;
		await ready.promise;
		// dispose() may replace a host while an older child's close/error event
		// is still queued. Follow the current generation rather than leaking an
		// old generation's result into this caller.
		if (ready !== this.ready || ready.generation !== this.generation) {
			return this.ensure(sandboxed);
		}
		if (this.spawnError) throw new Error(this.spawnError);
	}

	fingerprintInfo(): string | null {
		return this.fingerprint;
	}

	/** Posture of the current host, or null when no host exists. */
	currentSandboxed(): boolean | null {
		return this.sandboxed;
	}

	private spawn(sandboxed: boolean): { generation: number; promise: Promise<void> } {
		const generation = ++this.generation;
		this.spawnError = null;
		this.fingerprint = null;
		this.buffer = "";
		const promise = new Promise<void>((resolve) => {
			const args = ["serve", "--trust-workspace"];
			if (!sandboxed) args.push("--disable-sandbox");
			const child = spawn(museBinary(), args, {
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			});
			this.child = child;
			this.sandboxed = sandboxed;
			let stderr = "";
			const isCurrent = () => this.child === child && this.generation === generation;

			child.stderr?.on("data", (chunk) => {
				// The host lives for days but only the tail is ever read
				// (exit message), so don't retain the whole stream.
				stderr = `${stderr}${chunk.toString()}`.slice(-2000);
			});
			child.on("error", (error) => {
				if (!isCurrent()) {
					debugLog(`ignored stale host error (generation=${generation}): ${error.message}`);
					resolve();
					return;
				}
				this.spawnError =
					`Failed to spawn \`${museBinary()} serve\`: ${error.message}. Is Muse Code installed?`;
				this.rejectPendingGeneration(generation, new Error(this.spawnError));
				resolve();
			});
			child.on("close", (code) => {
				if (!isCurrent()) {
					debugLog(`ignored stale host close (generation=${generation}, code=${code ?? 1})`);
					resolve();
					return;
				}
				if (!this.spawnError) {
					this.spawnError = `muse serve exited with code ${code ?? 1}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`;
				}
				this.rejectPendingGeneration(generation, new Error(this.spawnError));
				resolve();
			});
			child.stdout?.on("data", (chunk) => {
				if (isCurrent()) this.onData(chunk.toString());
			});
			// A long-lived host must not keep `pi -p` alive after the turn
			// ends: release every handle from the event loop. Normal process
			// exit still kills the host via the module exit hook below.
			try {
				child.unref();
			} catch {
				// ignore
			}
			for (const stream of [child.stdin, child.stdout, child.stderr]) {
				try {
					(stream as unknown as { unref?: () => void } | null)?.unref?.();
				} catch {
					// ignore
				}
			}

			this.request("initialize", {
				clientInfo: { name: "pi_muse_msp", title: "Pi Muse MSP", version: CLIENT_VERSION },
			}).then(
				(result) => {
					if (!isCurrent()) {
						resolve();
						return;
					}
					const schema = (result["schema"] ?? {}) as Record<string, unknown>;
					if (typeof schema["fingerprint"] === "string") {
						this.fingerprint = schema["fingerprint"] as string;
					}
					this.notify("initialized", {});
					resolve();
				},
				(error) => {
					if (isCurrent()) this.spawnError = error instanceof Error ? error.message : String(error);
					resolve();
				},
			);
		});
		return { generation, promise };
	}

	private rejectPendingGeneration(generation: number, error: Error): void {
		for (const [id, pending] of this.pending) {
			if (pending.generation !== generation) continue;
			this.pending.delete(id);
			pending.reject(error);
		}
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			void this.onMessage(message);
		}
	}

	private onMessage(message: Record<string, unknown>): void {
		debugLog(
			`<- ${String(message["method"] ?? "")} ${typeof message["id"] !== "undefined" ? `(id=${String(message["id"])})` : "(notification)"} ${JSON.stringify(message).slice(0, 200)}`,
		);
		// Requests always carry numeric ids (see request()); anything else is a
		// notification or a foreign message and falls through below.
		if (typeof message["id"] === "number") {
			const pending = this.pending.get(message["id"]);
			if (!pending || pending.generation !== this.generation) return;
			this.pending.delete(message["id"]);
			if ("error" in message && message["error"] !== undefined) {
				const error = message["error"] as Record<string, unknown>;
				const data = error["data"] as Record<string, unknown> | undefined;
				pending.reject(
					new Error(
						`muse MSP error ${String(error["code"] ?? "")}: ${String(error["message"] ?? "unknown error")} ${String(data?.["kind"] ?? "")}`,
					),
				);
			} else {
				pending.resolve((message["result"] ?? {}) as Record<string, unknown>);
			}
			return;
		}
		const method = message["method"];
		if (typeof method !== "string") return;
		const params =
			message["params"] && typeof message["params"] === "object"
				? (message["params"] as Record<string, unknown>)
				: {};
		const handlers = this.notificationHandlers.get(method);
		if (!handlers) return;
		for (const handler of [...handlers]) {
			try {
				handler(params);
			} catch {
				// A failing observer must not break the RPC loop.
			}
		}
	}

	/** Hold the event loop while async MSP work is in flight. Without this
	 * the unref'd host (see spawn) lets `pi -p` exit mid-turn; when the
	 * count drops to zero the loop may drain and the exit hook reaps the
	 * host. */
	private holds = 0;

	hold(): () => void {
		this.holds++;
		this.applyRefs();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holds = Math.max(0, this.holds - 1);
			this.applyRefs();
		};
	}

	private applyRefs(): void {
		const child = this.child;
		if (!child) return;
		const streams = [child.stdin, child.stdout, child.stderr] as Array<{
			ref?: () => void;
			unref?: () => void;
		} | null>;
		if (this.holds > 0) {
			try {
				child.ref();
			} catch {
				// ignore
			}
			for (const stream of streams) {
				try {
					stream?.ref?.();
				} catch {
					// ignore
				}
			}
		} else {
			try {
				child.unref();
			} catch {
				// ignore
			}
			for (const stream of streams) {
				try {
					stream?.unref?.();
				} catch {
					// ignore
				}
			}
		}
	}

	request(
		method: string,
		params: Record<string, unknown>,
		timeout?: { ms: number; label: string },
	): Promise<Record<string, unknown>> {
		const child = this.child;
		if (!child || !child.stdin || child.killed) {
			return Promise.reject(new Error("muse serve host is not running"));
		}
		const id = this.nextId++;
		const generation = this.generation;
		debugLog(`-> ${method} (id=${id}, generation=${generation})`);
		const release = this.hold();
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const entry: Pending = {
				generation,
				resolve: (value) => {
					if (timer) clearTimeout(timer);
					release();
					resolve(value);
				},
				reject: (error) => {
					if (timer) clearTimeout(timer);
					release();
					reject(error);
				},
			};
			this.pending.set(id, entry);
			if (timeout) {
				// A timed-out call leaves the wire: drop its pending entry so
				// a late (or never) response can't resolve an abandoned turn,
				// and release the event-loop hold with it.
				timer = setTimeout(() => {
					if (this.pending.get(id) === entry) {
						this.pending.delete(id);
						entry.reject(new Error(`${timeout.label} timed out`));
					}
				}, timeout.ms);
				timer.unref();
			}
			child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
				if (error) {
					const pending = this.pending.get(id);
					if (pending) {
						this.pending.delete(id);
						pending.reject(error);
					}
				}
			});
		});
	}

	notify(method: string, params: Record<string, unknown>): void {
		// Swallow stream errors: a write racing host death must not surface
		// as an unhandled error from a fire-and-forget notification.
		this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, () => {});
	}

	dispose(reason = "dispose"): void {
		const child = this.child;
		const generation = this.generation;
		debugLog(`disposing host (generation=${generation}, reason=${reason})`);
		// Invalidate this generation before signaling it. Its asynchronous
		// close/error/stdout callbacks must not mutate a replacement host.
		this.generation++;
		this.child = null;
		this.ready = null;
		this.spawnError = null;
		this.fingerprint = null;
		this.sandboxed = null;
		this.buffer = "";
		this.holds = 0;
		for (const [, pending] of this.pending) pending.reject(new Error("muse serve host was restarted"));
		this.pending.clear();
		attached.clear();
		try {
			child?.kill();
			if (child && child.exitCode === null) {
				const reap = setTimeout(() => child.kill("SIGKILL"), 1_000);
				reap.unref();
				child.once("exit", () => clearTimeout(reap));
			}
		} catch {
			// ignore
		}
	}
}

const host = new MspHost();

// Reap the host on normal exit (its handles are unref'd, so without this it
// would be orphaned when the loop drains in `pi -p` mode).
process.once("exit", () => {
	host.dispose("process exit");
});

// ---------------------------------------------------------------------------
// Conversation mapping (no handoff prompt: direct chat)
// ---------------------------------------------------------------------------

function extractImageDataUrl(value: unknown): MspImage | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is.exec(value.trim());
	if (!match) return undefined;
	const mediaType = match[1].trim().toLowerCase();
	const base64Data = (match[2] ?? "").replace(/\s+/g, "");
	if (!mediaType.startsWith("image/") || !base64Data) return undefined;
	return { mediaType, base64Data };
}

function partImages(part: Record<string, unknown>, images: MspImage[]): void {
	const type = part["type"];
	if (type === "image") {
		const direct =
			typeof part["data"] === "string"
				? { mediaType: String(part["mimeType"] ?? ""), base64Data: part["data"] as string }
				: typeof part["base64Data"] === "string"
					? {
							mediaType: String(part["mediaType"] ?? part["mimeType"] ?? ""),
							base64Data: part["base64Data"] as string,
						}
					: undefined;
		if (direct && direct.mediaType.toLowerCase().startsWith("image/") && direct.base64Data) {
			images.push({ mediaType: direct.mediaType.toLowerCase(), base64Data: direct.base64Data });
			return;
		}
		const fromUrl = extractImageDataUrl(part["url"] ?? part["image_url"]);
		if (fromUrl) {
			images.push(fromUrl);
			return;
		}
		throw new Error("Muse MSP provider: unsupported image part shape (need data + mimeType or a data: URL)");
	}
	if (type === "image_url") {
		const nested = part["image_url"];
		const url =
			typeof nested === "string"
				? nested
				: nested && typeof nested === "object"
					? (nested as Record<string, unknown>)["url"]
					: undefined;
		const image = extractImageDataUrl(url);
		if (!image) {
			throw new Error(
				"Muse MSP provider: only inline data:image/...;base64,... URLs are supported (remote URLs are not)",
			);
		}
		images.push(image);
	}
}

function userMessageParts(
	message: Extract<Context["messages"][number], { role: "user" }>,
	images: MspImage[],
): string {
	if (typeof message.content === "string") return message.content;
	const textParts: string[] = [];
	for (const part of message.content) {
		const record = part as unknown as Record<string, unknown>;
		if (record["type"] === "text") textParts.push(String(record["text"] ?? ""));
		else partImages(record, images);
	}
	return textParts.join("\n");
}

function messageFingerprint(message: Context["messages"][number]): string {
	const record = message as unknown as Record<string, unknown>;
	const role = typeof record["role"] === "string" ? record["role"] : "unknown";
	const rawContent = record["content"];
	if (role === "user") {
		const images: MspImage[] = [];
		const text =
			typeof rawContent === "string" || Array.isArray(rawContent)
				? userMessageParts(message as Extract<Context["messages"][number], { role: "user" }>, images)
				: String(record["summary"] ?? "");
		const imageFp = images
			.map((image) => `${image.mediaType}:${createHash("sha256").update(image.base64Data).digest("hex")}`)
			.join(",");
		return `user:${text}\n${imageFp}`;
	}
	if (role === "toolResult") {
		const text = Array.isArray(rawContent)
			? rawContent
					.filter((part): part is { type: "text"; text: string } =>
						!!part && typeof part === "object" && (part as Record<string, unknown>)["type"] === "text",
					)
					.map((part) => String((part as Record<string, unknown>)["text"] ?? ""))
					.join("\n")
			: typeof rawContent === "string"
				? rawContent
				: "";
		return `tool:${String(record["toolName"] ?? "")}:${record["isError"] ? "1" : "0"}:${text}`;
	}
	const content = Array.isArray(rawContent)
		? rawContent
				.map((part) => {
					if (!part || typeof part !== "object") return "";
					const item = part as Record<string, unknown>;
					if (item["type"] === "text") return String(item["text"] ?? "");
					if (item["type"] === "toolCall") {
						return `Tool call: ${String(item["name"] ?? "")}(${JSON.stringify(item["arguments"])})`;
					}
					return "";
				})
				.filter(Boolean)
				.join("\n")
		: typeof rawContent === "string"
			? rawContent
			: String(record["summary"] ?? record["output"] ?? "");
	return `${role}:${content}`;
}

function fingerprintMessages(messages: Context["messages"]): string {
	const hash = createHash("sha256");
	for (const message of messages) hash.update(messageFingerprint(message));
	hash.update(String(messages.length));
	return hash.digest("hex");
}

function toTurnParts(texts: string[], images: MspImage[]): Array<Record<string, unknown>> {
	const parts: Array<Record<string, unknown>> = [{ type: "text", text: texts.join("\n\n").trim() }];
	for (const image of images) {
		parts.push({ type: "image", mediaType: image.mediaType, base64Data: image.base64Data });
	}
	const first = parts[0];
	if (!String((first as Record<string, unknown>)["text"] ?? "").trim() && images.length === 0) {
		throw new Error("Muse MSP provider received an empty conversation");
	}
	return parts;
}


function mimeFromPath(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	return "image/png";
}

function fileToMspImage(path: string, mediaType?: string): MspImage | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		const mime =
			mediaType && mediaType.toLowerCase().startsWith("image/")
				? mediaType.toLowerCase()
				: mimeFromPath(path);
		return { mediaType: mime, base64Data: readFileSync(path).toString("base64") };
	} catch {
		return undefined;
	}
}

function visibleContentImage(item: unknown): MspImage | undefined {
	if (!item || typeof item !== "object") return undefined;
	const rec = item as Record<string, unknown>;
	if (rec["kind"] !== "image" && rec["type"] !== "image") return undefined;
	const imagePath = typeof rec["path"] === "string" ? rec["path"] : "";
	const mediaType = String(rec["media_type"] ?? rec["mediaType"] ?? "");
	const fromFile = fileToMspImage(imagePath, mediaType || undefined);
	if (fromFile) return fromFile;
	const b64 = String(rec["base64_data"] ?? rec["base64Data"] ?? "");
	if (!b64) return undefined;
	const mime = mediaType.toLowerCase().startsWith("image/") ? mediaType.toLowerCase() : mimeFromPath(imagePath);
	return { mediaType: mime, base64Data: b64 };
}

function isRetainedMediaError(text: string): boolean {
	return /retained media history is unsupported/i.test(text);
}

/** Spark via `modelId` alone routes to provider `muse`, which rejects retained tool images. */
function sparkUsesMeta(model: string): boolean {
	return /^(muse-spark(?:-|$)|spark$)/i.test(model.trim());
}

function attachVisionImages(
	parts: Array<Record<string, unknown>>,
	images: MspImage[],
): Array<Record<string, unknown>> {
	const out = parts.map((part) => ({ ...part }));
	const hint =
		"These image files are attached as vision input. Analyze the attachments directly; there is no need to reread the same files.";
	const textPart = out.find((part) => part["type"] === "text");
	if (textPart) textPart["text"] = `${hint}\n\n${String(textPart["text"] ?? "")}`;
	else out.unshift({ type: "text", text: hint });
	const seen = new Set(
		out.filter((part) => part["type"] === "image").map((part) => String(part["base64Data"] ?? "")),
	);
	for (const image of images) {
		if (seen.has(image.base64Data)) continue;
		seen.add(image.base64Data);
		out.push({ type: "image", mediaType: image.mediaType, base64Data: image.base64Data });
	}
	return out;
}

/**
 * Pi builds the provider system prompt from the base coding prompt plus
 * Hermes persistent memory (standing instructions + memory context, injected
 * by pi-hermes-memory's before_agent_start). MSP turn/start carries no
 * system-prompt field, so fresh sessions would otherwise lose all of it.
 * Forward the Hermes blocks when present (exactly the user-specific bits);
 * without them, forward the whole prompt so explicit customizations
 * (--system-prompt, --append-system-prompt) are never silently dropped.
 * Reused sessions already hold this context: only fresh-session inputs
 * (conversationParts callers) include it, never deltaParts.
 */
function systemPromptBlock(systemPrompt: string | undefined): string | null {
	if (!systemPrompt || !systemPrompt.trim()) return null;
	const blocks: string[] = [];
	for (const tag of ["standing-instructions", "memory-context"]) {
		const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
		for (const match of systemPrompt.matchAll(re)) blocks.push(match[0]);
	}
	if (blocks.length > 0) return blocks.join("\n\n");
	return systemPrompt;
}

function toolResultBlock(
	message: Extract<Context["messages"][number], { role: "toolResult" }>,
	images: MspImage[],
): string {
	for (const part of message.content) {
		if (part.type === "image") images.push({ mediaType: part.mimeType, base64Data: part.data });
	}
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return `## Tool result: ${message.toolName}${message.isError ? " (error)" : ""}\n${text}`;
}

function conversationParts(context: Context): Array<Record<string, unknown>> {
	if (!context.messages.some((message) => message.role === "user")) {
		throw new Error("Muse MSP provider received no user task");
	}
	const texts: string[] = [];
	const images: MspImage[] = [];
	const system = systemPromptBlock(context.systemPrompt);
	if (system) texts.push(`## System instructions\n${system}`);
	const onlyUser = context.messages.length === 1 && context.messages[0]?.role === "user";
	for (const message of context.messages) {
		if (message.role === "user") {
			const text = userMessageParts(message, images);
			texts.push(onlyUser ? text : `## User\n${text}`);
		} else if (message.role === "toolResult") {
			texts.push(toolResultBlock(message, images));
		} else {
			const content = message.content
				.map((part) => {
					if (part.type === "text") return part.text;
					if (part.type === "toolCall") return `Tool call: ${part.name}(${JSON.stringify(part.arguments)})`;
					return "";
				})
				.filter(Boolean)
				.join("\n");
			texts.push(`## Assistant\n${content}`);
		}
	}
	const parts = toTurnParts(texts, images);
	return images.length ? attachVisionImages(parts, []) : parts;
}

function deltaParts(messages: Context["messages"]): Array<Record<string, unknown>> {
	const texts: string[] = [];
	const images: MspImage[] = [];
	for (const message of messages) {
		if (message.role === "user") texts.push(userMessageParts(message, images));
		else if (message.role === "toolResult") {
			texts.push(toolResultBlock(message, images));
		}
	}
	const parts = toTurnParts(texts, images);
	return images.length ? attachVisionImages(parts, []) : parts;
}

// ponytail: one live MSP session per Pi chat (cwd+model+first-message) and Pi
// process. Turns in different chats run concurrently against the shared host.
type LiveSession = {
	sessionId: string;
	cwd: string;
	model: string;
	sandboxed: boolean;
	messageCount: number;
	prefixFp: string;
};

const lives = new Map<string, LiveSession>();
const attached = new Set<string>();
/** One serialized turn queue per Pi chat (chatKey). Turns in different
 * chats run concurrently against the shared host; turns in the same chat
 * stay ordered so session-reuse deltas can't race. */
const turnChains = new Map<string, Promise<void>>();

function forgetMspSessions(): void {
	lives.clear();
	attached.clear();
	activeTurns.clear();
	turnChains.clear();
}

// ---------------------------------------------------------------------------
// Persistent live-session index (survives Pi restarts)
// ---------------------------------------------------------------------------
// `lives` is per-process; this index lets a new Pi process adopt a still-live
// Muse session instead of paying for a fresh session/start + full-history
// replay. Adoption is conservative: only when the current Pi conversation
// extends the exact prefix the session was saved with (i.e. the Pi session
// itself was continued). Anything else starts fresh, exactly as before.

const SESSION_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_INDEX_MAX = 50;

// How long the salvage poll waits after first seeing a durable terminal
// before concluding the live turn/completed notification is truly missing
// (rather than merely slow) and abandoning the session.
const SALVAGE_TERMINAL_GRACE_MS = 6_000;
// How long the live view may go silent before the salvage poll treats it as
// stalled and shows durable-log progress. While deltas flow, durable commits
// only duplicate what already streamed (pre-terminal assistant commits
// re-render the answer as thinking), so progress stays held. Three polls.
const SALVAGE_PROGRESS_STALL_MS = 6_000;
// Muse can durably accept and execute turn/start while its MSP view projector
// loses the JSON-RPC acknowledgement. Continue into durable-log monitoring
// instead of waiting forever before the salvage timer is installed.
const TURN_START_ACK_TIMEOUT_MS = 5_000;

type PersistedSession = LiveSession & { savedAt: number };

function homeDir(): string {
	return process.env.HOME?.trim() || homedir();
}

function agentDir(): string {
	const configured = (process.env.PI_CODING_AGENT_DIR || "").trim();
	if (configured) return configured;
	return join(homeDir(), ".pi", "agent");
}

function sessionIndexPath(): string {
	return join(agentDir(), "muse-msp-sessions.json");
}

function originPath(): string {
	return join(agentDir(), "muse-msp-origin.json");
}

/** Pi origin for the latest MSP session, read by the pi-session-context
 * Muse skill (env vars alone can't carry sessionId/model). Advisory:
 * never throws, never blocks a turn. */
function writeOriginFile(entry: { sessionId: string; cwd: string; model: string; sandboxed: boolean }): void {
	try {
		mkdirSync(agentDir(), { recursive: true });
		writeFileSync(
			originPath(),
			`${JSON.stringify({ provider: PROVIDER_ID, extensionVersion: CLIENT_VERSION, ...entry, savedAt: Date.now() })}\n`,
		);
	} catch {
		// ignore
	}
}

function latestOriginSessionId(): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(originPath(), "utf-8")) as Record<string, unknown>;
		return typeof parsed["sessionId"] === "string" && parsed["sessionId"]
			? (parsed["sessionId"] as string)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Read the index; corrupt/missing files yield an empty map (never throws). */
function loadPersistedSessions(): Map<string, PersistedSession> {
	const out = new Map<string, PersistedSession>();
	let raw: string;
	try {
		raw = readFileSync(sessionIndexPath(), "utf-8");
	} catch {
		return out;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		const entries = Array.isArray(parsed) ? parsed : [];
		for (const entry of entries) {
			if (!Array.isArray(entry) || entry.length < 2) continue;
			const key = entry[0];
			const value = entry[1] as Record<string, unknown>;
			if (typeof key !== "string" || !value || typeof value !== "object") continue;
			if (typeof value["sessionId"] !== "string" || !value["sessionId"]) continue;
			out.set(key, {
				sessionId: value["sessionId"] as string,
				cwd: typeof value["cwd"] === "string" ? (value["cwd"] as string) : "",
				model: typeof value["model"] === "string" ? (value["model"] as string) : "",
				sandboxed: value["sandboxed"] === true,
				messageCount: typeof value["messageCount"] === "number" ? (value["messageCount"] as number) : 0,
				prefixFp: typeof value["prefixFp"] === "string" ? (value["prefixFp"] as string) : "",
				savedAt: typeof value["savedAt"] === "number" ? (value["savedAt"] as number) : 0,
			});
		}
	} catch {
		// Corrupt index: start empty; the next save overwrites it.
		return new Map();
	}
	return out;
}

function removePersistedSession(key: string): void {
	try {
		const kept = [...loadPersistedSessions().entries()].filter(([entryKey]) => entryKey !== key);
		writeFileSync(sessionIndexPath(), `${JSON.stringify(kept)}\n`);
	} catch {
		// Persistence is advisory; a turn must never fail over it.
	}
}

/** Merge in-memory lives over the on-disk index, evict expired, cap size. */
function savePersistedSessions(): void {
	try {
		const now = Date.now();
		const merged = new Map<string, PersistedSession>();
		for (const [key, value] of loadPersistedSessions()) {
			if (now - value.savedAt <= SESSION_INDEX_TTL_MS) merged.set(key, value);
		}
		for (const [key, live] of lives) merged.set(key, { ...live, savedAt: now });
		const sorted = [...merged.entries()]
			.sort((a, b) => b[1].savedAt - a[1].savedAt)
			.slice(0, SESSION_INDEX_MAX);
		mkdirSync(agentDir(), { recursive: true });
		writeFileSync(sessionIndexPath(), `${JSON.stringify(sorted)}\n`);
	} catch {
		// Persistence is advisory; a turn must never fail over it.
	}
}

/** Validate a persisted entry against the live host, reporting how many late-joiner
 * requests (missed approvals/clarifications) came back with it. Never throws. */
async function resumePersistedSession(
	entry: PersistedSession,
): Promise<{ live: LiveSession; pending: number } | null> {
	try {
		await host.ensure(entry.sandboxed);
		const result = await host.request("session/resume", {
			commandId: uuid7(),
			sessionId: entry.sessionId,
		}, { ms: HOST_RPC_TIMEOUT_MS, label: "session/resume" });
		const session = result["session"] as Record<string, unknown> | undefined;
		const id = session ? String(session["sessionId"] ?? "") : "";
		if (!id) return null;
		attached.add(id);
		writeOriginFile({ sessionId: id, cwd: entry.cwd, model: entry.model, sandboxed: entry.sandboxed });
		return {
			live: {
				sessionId: id,
				cwd: entry.cwd,
				model: entry.model,
				sandboxed: entry.sandboxed,
				messageCount: entry.messageCount,
				prefixFp: entry.prefixFp,
			},
			pending: Array.isArray(result["pendingRequests"]) ? (result["pendingRequests"] as unknown[]).length : 0,
		};
	} catch {
		return null;
	}
}

/** Working directory for session identity. The provider stream has no ctx,
 * so every session key (turn chain, live/persisted entry, UI bridge, steer
 * and fork lookup) uses the process cwd — never ctx.cwd, which would fork
 * the key space if it ever differed (silently dropping UI bridging and
 * steering). Pi runs one cwd per process, so these are equal in practice. */
function sessionCwd(): string {
	return process.cwd();
}

function chatKey(cwd: string, model: string, messages: Context["messages"]): string {
	const first = messages[0];
	return `${cwd}\0${model}\0${first ? messageFingerprint(first) : ""}`;
}

/** A reuse suffix must be fresh user-side traffic only: no assistant turns
 * (already in the session) and at least one user message. */
function validUserSuffix(messages: Context["messages"]): Context["messages"] | null {
	if (messages.length === 0 || messages.some((message) => message.role === "assistant")) return null;
	if (!messages.some((message) => message.role === "user")) return null;
	return messages;
}

function suffixForLive(
	live: LiveSession,
	context: Context,
	cwd: string,
	model: string,
	sandboxed: boolean,
): Context["messages"] | null {
	if (live.cwd !== cwd || live.model !== model || live.sandboxed !== sandboxed) return null;
	if (context.messages.length <= live.messageCount) return null;
	if (fingerprintMessages(context.messages.slice(0, live.messageCount)) !== live.prefixFp) return null;
	let rest = context.messages.slice(live.messageCount);
	if (rest[0]?.role === "assistant") rest = rest.slice(1);
	return validUserSuffix(rest);
}

function latestUserSuffix(messages: Context["messages"]): Context["messages"] | null {
	let end = messages.length - 1;
	while (end >= 0 && messages[end]?.role === "assistant") end--;
	let start = end;
	while (start >= 0 && messages[start]?.role !== "assistant") start--;
	return validUserSuffix(messages.slice(start + 1, end + 1));
}

type CrossModelCandidate =
	| { key: string; live: LiveSession }
	| { key: string; persisted: PersistedSession };

/** Same conversation under a different model (a mid-chat /model switch):
 * prefix rules mirror adoption. Provider jumps are excluded — a session
 * started for one provider cannot serve another. */
function crossModelCandidate(
	context: Context,
	cwd: string,
	bareModel: string,
	sandboxed: boolean,
): CrossModelCandidate | null {
	for (const [key, live] of lives) {
		if (live.model === bareModel || live.cwd !== cwd || live.sandboxed !== sandboxed) continue;
		if (sparkUsesMeta(live.model) !== sparkUsesMeta(bareModel)) continue;
		if (live.messageCount <= 0 || context.messages.length <= live.messageCount) continue;
		if (fingerprintMessages(context.messages.slice(0, live.messageCount)) !== live.prefixFp) continue;
		return { key, live };
	}
	const now = Date.now();
	let best: { key: string; persisted: PersistedSession } | null = null;
	for (const [key, entry] of loadPersistedSessions()) {
		if (entry.model === bareModel || entry.cwd !== cwd || entry.sandboxed !== sandboxed) continue;
		if (sparkUsesMeta(entry.model) !== sparkUsesMeta(bareModel)) continue;
		if (now - entry.savedAt > SESSION_INDEX_TTL_MS) continue;
		if (entry.messageCount <= 0 || context.messages.length <= entry.messageCount) continue;
		if (fingerprintMessages(context.messages.slice(0, entry.messageCount)) !== entry.prefixFp) continue;
		if (!best || entry.messageCount > best.persisted.messageCount) best = { key, persisted: entry };
	}
	return best;
}

/** Adopt a cross-model candidate onto the live session: resume when cold,
 * setModel to the new model, and retire the old key (the session no longer
 * matches it). Returns the adopted entry, or null to start fresh. Never throws. */
async function switchSessionModel(
	candidate: CrossModelCandidate,
	bareModel: string,
): Promise<{ live: LiveSession; pending: number } | null> {
	try {
		let live: LiveSession;
		let pending = 0;
		if ("live" in candidate) {
			if (!attached.has(candidate.live.sessionId)) return null;
			live = candidate.live;
		} else {
			const resumed = await resumePersistedSession(candidate.persisted);
			if (!resumed) {
				removePersistedSession(candidate.key);
				return null;
			}
			live = resumed.live;
			pending = resumed.pending;
		}
		await host.request("session/setModel", {
			commandId: uuid7(),
			sessionId: live.sessionId,
			model: {
				modelId: bareModel,
				...(sparkUsesMeta(bareModel) ? { providerId: "meta" } : {}),
			},
		}, { ms: HOST_RPC_TIMEOUT_MS, label: "session/setModel" });
		live.model = bareModel;
		lives.delete(candidate.key);
		removePersistedSession(candidate.key);
		writeOriginFile({ sessionId: live.sessionId, cwd: live.cwd, model: bareModel, sandboxed: live.sandboxed });
		debugLog(`switched session ${live.sessionId} to model ${bareModel}`);
		return { live, pending };
	} catch {
		return null;
	}
}

function enqueueTurn<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prior = turnChains.get(key) ?? Promise.resolve();
	const run = prior.then(fn, fn);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	turnChains.set(key, tail);
	// Evict idle chains so a long-lived process doesn't retain one entry per
	// chat. A newer tail means another turn chained behind us: keep that one.
	void tail.then(() => {
		if (turnChains.get(key) === tail) turnChains.delete(key);
	});
	return run;
}

async function startMspSession(cwd: string, model: string, sandboxed: boolean): Promise<LiveSession> {
	const baseStartParams = {
		commandId: uuid7(),
		workspaceRoot: cwd,
		approvalMode: sandboxed ? "onRequest" : "allowAll",
		// Pi origin metadata: ignored by servers that don't understand it;
		// read by the pi-session-context Muse skill via the params log.
		piOrigin: {
			provider: PROVIDER_ID,
			extensionVersion: CLIENT_VERSION,
			cwd,
			model,
			sandboxed,
		},
		...(sparkUsesMeta(model) ? { providerId: "meta" } : {}),
		...(!["muse-spark", "spark", ""].includes(model.trim().toLowerCase()) ? { modelId: model } : {}),
	};
	let startResult: Record<string, unknown>;
	try {
		startResult = await host.request("session/start", baseStartParams, { ms: HOST_RPC_TIMEOUT_MS, label: "session/start" });
	} catch (error) {
		// A strict server may reject unknown metadata: retry bare once.
		debugLog(`session/start with piOrigin failed, retrying bare: ${error instanceof Error ? error.message : String(error)}`);
		const { piOrigin: _dropped, ...bareStartParams } = baseStartParams;
		startResult = await host.request("session/start", bareStartParams, { ms: HOST_RPC_TIMEOUT_MS, label: "session/start" });
	}
	const session = startResult["session"] as Record<string, unknown>;
	const sessionId = String(session["sessionId"]);
	attached.add(sessionId);
	writeOriginFile({ sessionId, cwd, model, sandboxed });
	return { sessionId, cwd, model, sandboxed, messageCount: 0, prefixFp: "" };
}

// ---------------------------------------------------------------------------
// Conversation steering (turn/steer into the live MSP turn)
// ---------------------------------------------------------------------------

type ActiveTurn = {
	liveKey: string;
	cwd: string;
	model: string;
	sessionId: string;
	turnId: string;
	mark: (text: string) => void;
};

/** Exactly one entry per Pi chat with a turn in flight; cleared in finish(). */
const activeTurns = new Map<string, ActiveTurn>();

/** Drill-down targets for /muse-msp-subagent and /muse-msp-output: itemId to
 * the session plus whichever durable handles the item carried. Bounded. */
type ItemTarget = {
	sessionId: string;
	subagentId?: string;
	childSessionId?: string;
	outputRefId?: string;
};
const itemTargets = new Map<string, ItemTarget>();
const ITEM_TARGETS_MAX = 100;

function rememberItemTarget(sessionId: string, item: Record<string, unknown>): void {
	const itemId = strField(item, "itemId");
	if (!itemId) return;
	const outputRef = item["outputRef"];
	const outputRefId =
		outputRef && typeof outputRef === "object" ? strField(outputRef as Record<string, unknown>, "id") : "";
	const target: ItemTarget = { sessionId };
	const subagentId = strField(item, "subagentId");
	const childSessionId = strField(item, "childSessionId");
	if (subagentId) target.subagentId = subagentId;
	if (childSessionId) target.childSessionId = childSessionId;
	if (outputRefId) target.outputRefId = outputRefId;
	if (!target.subagentId && !target.outputRefId) return;
	itemTargets.set(itemId, target);
	while (itemTargets.size > ITEM_TARGETS_MAX) {
		const oldest = itemTargets.keys().next();
		if (oldest.done) break;
		itemTargets.delete(oldest.value);
	}
}

function bareModelId(id: string): string {
	return id.includes("/") ? id.split("/").slice(1).join("/") : id;
}

/** Steer the running turn, if exactly one is active in this cwd. Never throws. */
async function steerRunningTurn(
	cwd: string,
	model: string,
	text: string,
	images: ImageContent[] = [],
): Promise<{ ok: true; turnId: string } | { ok: false; reason: string }> {
	// Model is a hint, not a filter: a /model switch mid-turn must not hide
	// the running turn. cwd (one live session per Pi chat) scopes the match.
	const inCwd = [...activeTurns.values()].filter((entry) => entry.cwd === cwd);
	if (inCwd.length === 0) return { ok: false, reason: "no active muse-msp turn for this chat" };
	const sameModel = inCwd.filter((entry) => entry.model === model);
	const cands = sameModel.length > 0 ? sameModel : inCwd;
	if (cands.length > 1) return { ok: false, reason: "multiple active turns; steering is ambiguous" };
	const target = cands[0]!;
	try {
		const result = await host.request("turn/steer", {
			commandId: uuid7(),
			sessionId: target.sessionId,
			expectedTurnId: target.turnId,
			input: [
				{ type: "text", text },
				...images.map((image) => ({
					type: "image",
					mediaType: image.mimeType,
					base64Data: image.data,
				})),
			],
		}, { ms: HOST_RPC_TIMEOUT_MS, label: "turn/steer" });
		target.mark(`\n\n[muse-msp: steered running turn: ${oneLine(text, 120)}]`);
		return { ok: true, turnId: String(result["turnId"] ?? target.turnId) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// The `muse` route rejects retained image history. If a steer carrying
		// images failed for that reason, fall back to Pi's queue: do NOT mask
		// other errors as steerable, and never retry images on this session —
		// the session's history already holds them.
		if (images.length > 0 && isRetainedMediaError(message)) {
			return { ok: false, reason: `steer with images unsupported by Muse route: ${message}` };
		}
		return { ok: false, reason: message };
	}
}

// ---------------------------------------------------------------------------
// Streaming turn over MSP
// ---------------------------------------------------------------------------

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function applyTokenUsage(output: AssistantMessage, usage: unknown): void {
	if (!usage || typeof usage !== "object") return;
	const record = usage as Record<string, unknown>;
	const input = num(record["inputTokens"]);
	const out = num(record["outputTokens"]);
	const cacheRead = num(record["cachedTokens"]) + num(record["cacheReadTokens"]);
	const cacheWrite = num(record["cacheWriteTokens"]);
	if (input) output.usage.input = input;
	if (out) output.usage.output = out;
	if (cacheRead) output.usage.cacheRead = cacheRead;
	if (cacheWrite) output.usage.cacheWrite = cacheWrite;
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

function itemText(item: unknown): string {
	if (!item || typeof item !== "object") return "";
	const record = item as Record<string, unknown>;
	return typeof record["text"] === "string" ? (record["text"] as string) : "";
}

/** Muse streams visible reasoning as `item/delta` field `summary.n`, not raw `text` (never streamed in MSP v1). */
function reasoningSnapshot(item: Record<string, unknown>): string {
	const parts = item["summary"];
	if (Array.isArray(parts)) {
		const texts = parts.filter((part): part is string => typeof part === "string");
		if (texts.length > 0) return texts.join("\n");
	}
	return itemText(item);
}

function isSummaryField(field: string): boolean {
	return /^summary\.\d+$/.test(field);
}

function uuid7UnixMs(id: string): number | undefined {
	const hex = id.replace(/-/g, "").slice(0, 12);
	if (!/^[0-9a-f]{12}$/i.test(hex)) return undefined;
	const ms = Number.parseInt(hex, 16);
	return Number.isFinite(ms) ? ms : undefined;
}

function recordedAtMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	if (value > 1e18) return value / 1e6;
	if (value > 1e15) return value / 1e3;
	if (value > 1e12) return value;
	return value;
}

/** Bound for host RPCs that must never hang a turn or command when the projector dies. */
const HOST_RPC_TIMEOUT_MS = 5_000;

function museSessionJsonl(sessionId: string): string | undefined {
	const root = join(homeDir(), ".local/share/muse/sessions");
	const ms = uuid7UnixMs(sessionId);
	if (ms === undefined) return undefined;
	const date = new Date(ms);
	// Muse partitions sessions by the machine's local calendar date. UTC can
	// differ near midnight (and older/test installations may use UTC), so try
	// both rather than silently disabling durable recovery for those sessions.
	const stamps = [
		[
			String(date.getFullYear()),
			String(date.getMonth() + 1).padStart(2, "0"),
			String(date.getDate()).padStart(2, "0"),
		].join("/"),
		[
			String(date.getUTCFullYear()),
			String(date.getUTCMonth() + 1).padStart(2, "0"),
			String(date.getUTCDate()).padStart(2, "0"),
		].join("/"),
	];
	for (const stamp of new Set(stamps)) {
		const path = join(root, stamp, sessionId, "session.jsonl");
		if (existsSync(path)) return path;
	}
	return undefined;
}

function tailJsonlLines(path: string, maxBytes = 256_000): string[] {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const buf = Buffer.alloc(size - start);
		let offset = 0;
		while (offset < buf.length) {
			const read = readSync(fd, buf, offset, buf.length - offset, start + offset);
			if (read === 0) break; // EOF: file shrank under us; parse what we got.
			offset += read;
		}
		const lines = buf.subarray(0, offset).toString("utf8").split("\n");
		if (start > 0) lines.shift();
		return lines.filter((line) => line.trim());
	} finally {
		closeSync(fd);
	}
}

/** Meta encrypted reasoning blobs are opaque; never paint them. */
function looksEncrypted(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.startsWith("Q-Pa")) return true;
	return trimmed.length > 80 && !/\s/.test(trimmed) && /^[A-Za-z0-9+/=_-]+$/.test(trimmed);
}

function payloadEvent(record: Record<string, unknown>): {
	kind: unknown;
	runId: string | undefined;
	event: Record<string, unknown>;
} | undefined {
	const payload = record["payload"];
	if (!payload || typeof payload !== "object") return undefined;
	const body = payload as Record<string, unknown>;
	const event = body["event"];
	if (!event || typeof event !== "object") return undefined;
	return {
		kind: (event as Record<string, unknown>)["kind"],
		runId: typeof body["run_id"] === "string" ? (body["run_id"] as string) : undefined,
		event: event as Record<string, unknown>,
	};
}

function committedPlaintext(event: Record<string, unknown>): string | undefined {
	const text = event["text"];
	if (typeof text !== "string" || !text.trim() || looksEncrypted(text)) return undefined;
	return text;
}

/** Wide scan window for answer recovery: the terminal marker and its committed
 * messages can sit far apart in a long session log. */
const RECOVERY_SCAN_MAX_BYTES = 4_000_000;

/** Durable Muse log: reasoning-summary progress, a finished reply after completed `terminal`, or a failed terminal plus tool-read images. Ignores `encrypted_content`. */
function scanSessionLog(
	sessionId: string,
	afterMs: number,
	seen: Set<string>,
): { progress: string[]; recovered?: string; failedReason?: string; images: MspImage[] } {
	const path = museSessionJsonl(sessionId);
	if (!path) return { progress: [], images: [] };
	let terminalRun: string | undefined;
	let terminalOk = false;
	let failedReason: string | undefined;
	let recovered: string | undefined;
	let recoveredKey: string | undefined;
	const progress: string[] = [];
	const images: MspImage[] = [];
	const seenImage = new Set<string>();
	for (const line of tailJsonlLines(path, RECOVERY_SCAN_MAX_BYTES).reverse()) {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof record["recorded_at"] === "number" && recordedAtMs(record["recorded_at"]) + 1000 < afterMs) break;
		const parsed = payloadEvent(record);
		if (!parsed) continue;
		if (!terminalRun && parsed.kind === "terminal") {
			const terminal = parsed.event["terminal"];
			if (terminal === "completed" || terminal === "failed") {
				terminalRun = parsed.runId;
				terminalOk = terminal === "completed";
				if (!terminalOk) {
					failedReason = String(parsed.event["reason"] ?? "Muse turn failed");
				}
			}
			continue;
		}
		if (
			parsed.kind === "tool_result_model_visible_content" &&
			parsed.runId === terminalRun
		) {
			const content = parsed.event["content"];
			const items = Array.isArray(content) ? content : [content];
			for (const item of items) {
				const image = visibleContentImage(item);
				if (!image || seenImage.has(image.base64Data)) continue;
				seenImage.add(image.base64Data);
				images.push(image);
			}
			continue;
		}
		if (parsed.kind !== "assistant_message_committed" && parsed.kind !== "reasoning_summary_committed") {
			continue;
		}
		const text = committedPlaintext(parsed.event);
		if (!text) continue;
		const key =
			typeof parsed.event["message_id"] === "string"
				? `${String(parsed.kind)}:${parsed.event["message_id"] as string}`
				: `${String(parsed.kind)}:${text}`;
		if (parsed.kind === "assistant_message_committed") {
			// Assistant commits are terminal answers, never interim progress:
			// every run commits exactly one (the final reply), so routing one
			// to thinking can only duplicate it. Only the terminal run's
			// answer is kept, as the text-channel recovery.
			if (terminalOk && terminalRun && parsed.runId === terminalRun && recovered === undefined) {
				recovered = text;
				recoveredKey = key;
			}
			continue;
		}
		if (seen.has(key) || key === recoveredKey) continue;
		seen.add(key);
		progress.push(text);
	}
	progress.reverse();
	images.reverse();
	return { progress, recovered, failedReason, images };
}

/** Recover the newest completed plaintext answer even if a later interrupt
 * appended an aborted terminal while releasing a stuck Pi turn. */
function latestCompletedAnswerFromLog(sessionId: string): string | undefined {
	const path = museSessionJsonl(sessionId);
	if (!path) return undefined;
	const completedRuns = new Set<string>();
	for (const line of tailJsonlLines(path, RECOVERY_SCAN_MAX_BYTES).reverse()) {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const parsed = payloadEvent(record);
		if (!parsed?.runId) continue;
		if (parsed.kind === "terminal" && parsed.event["terminal"] === "completed") {
			completedRuns.add(parsed.runId);
			continue;
		}
		if (parsed.kind !== "assistant_message_committed" || !completedRuns.has(parsed.runId)) continue;
		const text = committedPlaintext(parsed.event);
		if (text) return text;
	}
	return undefined;
}

/** Approvals sitting in the durable log with no decision — view notifications may never arrive. */
function pendingApprovalsFromLog(
	sessionId: string,
	afterMs: number,
): Array<Record<string, unknown>> {
	const path = museSessionJsonl(sessionId);
	if (!path) return [];
	const open = new Map<string, Record<string, unknown>>();
	const closed = new Set<string>();
	for (const line of tailJsonlLines(path)) {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (recordedAtMs(record["recorded_at"]) + 1000 < afterMs) continue;
		const payload = record["payload"];
		if (!payload || typeof payload !== "object") continue;
		const body = payload as Record<string, unknown>;
		const kind = body["kind"];
		if (kind === "approval") {
			const event = body["event"];
			if (!event || typeof event !== "object") continue;
			const ev = event as Record<string, unknown>;
			const id = typeof ev["pending_action_id"] === "string" ? (ev["pending_action_id"] as string) : "";
			if (!id) continue;
			if (ev["kind"] === "requested") {
				open.set(id, {
					sessionId,
					approvalId: id,
					toolName: typeof ev["tool_name"] === "string" ? ev["tool_name"] : "tool",
					currentRequirementId: { approvalId: id, sourceIndex: 0 },
					availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
				});
			} else if (ev["kind"] === "decision_applied") {
				closed.add(id);
			}
		} else if (kind === "approval_wait_effect" || kind === "approval_command_intake_received") {
			const rec = body["record"];
			if (!rec || typeof rec !== "object") continue;
			const row = rec as Record<string, unknown>;
			const id =
				(typeof row["pending_action_id"] === "string" && (row["pending_action_id"] as string)) ||
				(typeof row["approval_id"] === "string" && (row["approval_id"] as string)) ||
				"";
			if (!id) continue;
			if (kind === "approval_command_intake_received") closed.add(id);
			else if (row["kind"] === "terminal") closed.add(id);
		}
	}
	const pending: Array<Record<string, unknown>> = [];
	for (const [id, row] of open) {
		if (!closed.has(id)) pending.push(row);
	}
	return pending;
}

function strField(item: Record<string, unknown>, key: string): string {
	const value = item[key];
	return typeof value === "string" ? value : "";
}

function oneLine(value: string, max = 160): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** First 8 chars of a session id for compact listings. */
function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

/** Compact age ("5m", "3h", "2d") for session listings. */
function ageLabel(ageMs: number): string {
	if (ageMs < 60_000) return `${Math.max(0, Math.floor(ageMs / 1000))}s`;
	if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
	if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
	return `${Math.floor(ageMs / 86_400_000)}d`;
}

/** Pick the most telling value out of a toolCall's verbatim args JSON. */
function summarizeArgs(args: string): string {
	if (!args.trim()) return "";
	try {
		const parsed: unknown = JSON.parse(args);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return oneLine(args, 120);
		const record = parsed as Record<string, unknown>;
		const preferred = [
			"command",
			"path",
			"file_path",
			"file",
			"filePath",
			"pattern",
			"query",
			"url",
			"prompt",
			"objective",
			"description",
			"text",
			"content",
		];
		for (const key of preferred) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return oneLine(value, 160);
		}
		const entries = Object.entries(record).filter(
			([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean",
		);
		if (entries.length === 0) return "";
		return oneLine(
			entries
				.slice(0, 2)
				.map(([key, value]) => `${key}=${String(value)}`)
				.join(" "),
			160,
		);
	} catch {
		return oneLine(args, 120);
	}
}

const PI_TOOL_ALIASES: Record<string, string> = {
	read_file: "read",
	write_file: "write",
	edit_file: "edit",
	search: "grep",
};

function piToolName(name: string): string {
	return PI_TOOL_ALIASES[name] ?? name;
}

/** Specific activity label, e.g. "bash: echo hi" instead of "shell". */
function activityLabel(item: Record<string, unknown>, kind: string): string {
	if (kind === "toolCall") {
		// NOTE: the wire field is `tool`, not `toolName`.
		const tool = piToolName(strField(item, "tool") || "tool");
		const detail = summarizeArgs(strField(item, "args"));
		const failed =
			item["status"] !== undefined && item["status"] !== "completed"
				? ` (${oneLine(strField(item, "failureReason") || String(item["status"]), 80)})`
				: "";
		return detail ? `${tool}: ${detail}${failed}` : `${tool}${failed}`;
	}
	if (kind === "userShell") {
		const command = oneLine(strField(item, "commandText"));
		return command ? `shell: ${command}` : "shell";
	}
	if (kind === "subagent") {
		const agent = strField(item, "agentPath");
		const objective = oneLine(strField(item, "objective"), 120);
		const label = agent ? `subagent ${agent}` : "subagent";
		return objective ? `${label}: ${objective}` : label;
	}
	if (kind === "workflow") {
		const children = Array.isArray(item["children"])
			? (item["children"] as Array<Record<string, unknown>>)
			: [];
		const done = children.filter((child) => child["terminal"] === "completed").length;
		const base = oneLine(strField(item, "fallbackText"));
		const progress = children.length ? `${done}/${children.length} children` : "";
		return [progress, base].filter(Boolean).join(" · ") || kind;
	}
	return oneLine(strField(item, "fallbackText")) || kind;
}

interface MuseActivity {
	label: string;
	rawArgs?: string;
	tool?: string;
	args?: Record<string, unknown>;
	cwd?: string;
	itemId?: string;
	failed: boolean;
}

type UiBridge = {
	ui: ExtensionUIContext;
	hasUI: boolean;
	recordActivity: (activity: MuseActivity) => void;
};

export function streamMuseMsp(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	sandboxed = false,
	bridge?: UiBridge,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = emptyMessage(model);

	// Key the queue before the body runs: the first message never changes
	// within a chat, so every turn of one chat shares a chain while
	// different chats run concurrently.
	const streamCwd = sessionCwd();
	const streamBareModel = bareModelId(model.id);
	const chainKey = chatKey(streamCwd, streamBareModel, context.messages);

	void enqueueTurn(chainKey, async () => {
		let done = (): void => {};
		const finished = new Promise<void>((resolve) => {
			done = resolve;
		});
		const off: Array<() => void> = [];
		let activeIndex: number | undefined;
		let settled = false;
		let sessionId: string | null = null;
		let turnId: string | null = null;
		let keepLive = false;
		let sentImages = false;
		let mediaRetry: "no" | "inflight" | "done" = "no";
		let salvageAfterMs = Date.now();
	let viewUnhealthy = false;
	let todoCompleteNoted = false;
	let lastPressure = "";
	const backgroundNoted = new Set<string>();
		const seenThoughts = new Set<string>();
		let queueVisionRetry = (_images: MspImage[]): void => {};
		let liveEntry: LiveSession | null = null;
		let liveKeyStr = "";
		// Bytes per itemId already emitted via item/delta, so item/completed
		// (full snapshot) only appends the unseen tail instead of duplicating.
		const streamedByItem = new Map<string, number>();
		const lastSummaryField = new Map<string, string>();

		const finishActive = () => {
			if (activeIndex === undefined) return;
			const block = output.content[activeIndex];
			if (block?.type === "text") {
				stream.push({ type: "text_end", contentIndex: activeIndex, content: block.text, partial: output });
			} else if (block?.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: activeIndex,
					content: block.thinking,
					partial: output,
				});
			}
			activeIndex = undefined;
		};

		const append = (channel: "text" | "thinking", delta: string) => {
			if (!delta || settled) return;
			const active = activeIndex === undefined ? undefined : output.content[activeIndex];
			if (active?.type !== channel) {
				finishActive();
				output.content.push(
					channel === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
				);
				activeIndex = output.content.length - 1;
				stream.push({
					type: channel === "text" ? "text_start" : "thinking_start",
					contentIndex: activeIndex,
					partial: output,
				});
			}
			const block = output.content[activeIndex!];
			if (block?.type === "text") {
				block.text += delta;
				stream.push({ type: "text_delta", contentIndex: activeIndex!, delta, partial: output });
			} else if (block?.type === "thinking") {
				block.thinking += delta;
				stream.push({ type: "thinking_delta", contentIndex: activeIndex!, delta, partial: output });
			}
		};

		let releaseTurn: (() => void) | null = null;
		const finish = (reason: "stop" | "error" | "aborted", errorMessage?: string) => {
			if (settled) return;
			debugLog(`finish(${reason})${errorMessage ? `: ${errorMessage.slice(0, 200)}` : ""}`);
			settled = true;
			bridge?.ui.setWorkingMessage();
			// The turn is no longer steerable once it settles (terminal →
			// already_terminal on steer; cancelled → steer would leak).
			if (liveKeyStr) activeTurns.delete(liveKeyStr);
			releaseTurn?.();
			releaseTurn = null;
			for (const remove of off) remove();
			off.length = 0;
			finishActive();
			output.stopReason = reason;
			if (reason === "stop" && keepLive && liveEntry && sessionId && liveKeyStr) {
				liveEntry.sessionId = sessionId;
				liveEntry.messageCount = context.messages.length;
				liveEntry.prefixFp = fingerprintMessages(context.messages);
				lives.set(liveKeyStr, liveEntry);
				savePersistedSessions();
			} else if (liveKeyStr) {
				lives.delete(liveKeyStr);
				// The next turn's context event re-registers its bridge, so a
				// dropped session can shed its UI entry instead of pinning it.
				uiBridges.delete(liveKeyStr);
				if (sessionId) attached.delete(sessionId);
				// A session refused for reuse must not stay adoptable: the
				// on-disk index would otherwise resurrect it on the next turn
				// (same process after reload, or a new one), ping-ponging on
				// a dead projector forever. Removal must precede the save,
				// which merges surviving disk entries back.
				removePersistedSession(liveKeyStr);
				savePersistedSessions();
			}
			if (reason === "error" || reason === "aborted") {
				output.errorMessage = errorMessage ?? "Muse MSP turn failed";
				stream.push({ type: "error", reason, error: output });
			} else {
				stream.push({ type: "done", reason: "stop", message: output });
			}
			stream.end();
			done();
		};

		// A declined/unanswerable prompt finishes as an error: a clean stop
		// would bury the actionable notice in a thinking block.
		const cancelTurn = (note: string) => {
			append("thinking", `\n\n[muse-msp: ${note}]`);
			if (sessionId) {
				host
					.request("turn/cancel", {
						commandId: uuid7(),
						sessionId,
						...(turnId ? { turnId } : {}),
					})
					.catch(() => undefined);
			}
			finish("error", note);
		};

		const approvalsHandling = new Set<string>();
		// One decision per approval: requested + updated + salvage rows for the
		// same approvalId must not decide (or dialog) twice. The first handler
		// owns it; late duplicates return instead of double-deciding (the
		// second decide would throw already-resolved and kill an approved turn).
		const approvalsInFlight = new Map<string, Promise<void>>();
		// Approvals fully handled (decided or declined): a later re-feed with a
		// differently-shaped requirement must not re-dialog for the same approval.
		const approvalsCompleted = new Set<string>();
		const handleApproval = (params: Record<string, unknown>) => {
			if (params["sessionId"] !== sessionId || settled) return;
			const choices = Array.isArray(params["availableChoices"])
				? (params["availableChoices"] as Array<Record<string, unknown>>)
				: [];
			const approvalId = strField(params, "approvalId");
			const requirementId = params["currentRequirementId"];
			if (!sessionId || !approvalId || !requirementId) {
				cancelTurn("Muse requested an invalid approval");
				return;
			}
			const flightKey = `${sessionId}:${approvalId}`;
			if (approvalsInFlight.has(flightKey) || approvalsCompleted.has(flightKey)) return;
			const decisionKey = `${flightKey}:${JSON.stringify(requirementId)}`;
			if (approvalsHandling.has(decisionKey)) return;
			approvalsHandling.add(decisionKey);
			const run = (async () => {
				let choice = choices.find(
					(item) => item["decision"] === "approved" || item["decision"] === "approvedForSession",
				);
				let automaticError = "no automatic approval choice was offered";
				if (choice) {
					try {
						await host.request("approval/decide", {
							commandId: uuid7(), sessionId, approvalId,
							choiceId: strField(choice, "choiceId"), requirementId,
						}, { ms: HOST_RPC_TIMEOUT_MS, label: "approval/decide" });
						// Audit trail: unsandboxed runs auto-approve everything,
						// so each automatic decision gets a visible activity row
						// (label-only renders as a generic entry row).
						bridge?.recordActivity({
							label: `auto-approved: ${strField(params, "toolName") || "tool"} (${strField(choice, "choiceId") || "approved"})`,
							cwd: streamCwd,
							failed: false,
						});
						return;
					} catch (error) {
						automaticError = error instanceof Error ? error.message : String(error);
						if (/already[\s_-]*resolved/i.test(automaticError)) return;
					}
				}
				if (settled || params["sessionId"] !== sessionId) return;
				if (!bridge?.hasUI) {
					cancelTurn(`automatic approval failed: ${automaticError}`);
					return;
				}
				const baseLabels = choices.map((item, index) =>
					strField(item, "label") || strField(item, "decision") || strField(item, "choiceId") || `choice ${index + 1}`,
				);
				// Duplicate labels would make indexOf ambiguous and risk deciding
				// the wrong choice: qualify repeats with their choice id.
				const labelCounts = new Map<string, number>();
				const labels = baseLabels.map((label, index) => {
					const seen = labelCounts.get(label) ?? 0;
					labelCounts.set(label, seen + 1);
					return seen === 0 && baseLabels.indexOf(label) === baseLabels.lastIndexOf(label)
						? label
						: `${label} (${strField(choices[index], "choiceId") || `option ${index + 1}`})`;
				});
				const selected = await bridge.ui.select(
					`Muse approval: ${strField(params, "toolName") || "tool"}`,
					labels,
				);
				choice = choices[labels.indexOf(selected ?? "")];
				if (!choice || settled) {
					cancelTurn("Muse approval was declined");
					return;
				}
				const choiceId = strField(choice, "choiceId");
				if (!choiceId) {
					cancelTurn("Muse offered an approval choice without an id");
					return;
				}
				try {
					await host.request("approval/decide", {
						commandId: uuid7(), sessionId, approvalId,
						choiceId, requirementId,
					}, { ms: HOST_RPC_TIMEOUT_MS, label: "approval/decide" });
					bridge?.recordActivity({
						label: `approved via Pi: ${strField(params, "toolName") || "tool"} (${choiceId})`,
						cwd: streamCwd,
						failed: false,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					// A duplicate handler may have landed this decision first: the
					// approval went through, so continue the turn instead of killing it.
					if (/already[\s_-]*resolved/i.test(message)) {
						bridge?.recordActivity({
							label: `approved via Pi: ${strField(params, "toolName") || "tool"} (${choiceId}, duplicate decide suppressed)`,
							cwd: streamCwd,
							failed: false,
						});
						return;
					}
					cancelTurn(`approval failed: ${message}`);
				}
			})();
			approvalsInFlight.set(flightKey, run);
			void run.finally(() => {
				if (approvalsInFlight.get(flightKey) === run) approvalsInFlight.delete(flightKey);
				approvalsCompleted.add(flightKey);
			}).catch((error: unknown) => {
				// Pi UI failures (dialog torn down mid-approval) must fail the
				// turn, never escape as an unhandled rejection that kills Pi.
				if (!settled) cancelTurn(`approval failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		};

		const userInputsHandling = new Set<string>();
		const handleUserInput = (params: Record<string, unknown>) => {
			if (params["sessionId"] !== sessionId || settled) return;
			const userInputId = strField(params, "userInputId");
			if (!sessionId || !userInputId || userInputsHandling.has(userInputId)) return;
			userInputsHandling.add(userInputId);
			void (async () => {
				if (!bridge?.hasUI) {
					await host.request("userInput/cancel", {
						commandId: uuid7(), sessionId, userInputId, reason: "Pi has no interactive UI",
					}, { ms: HOST_RPC_TIMEOUT_MS, label: "userInput/cancel" }).catch(() => undefined);
					cancelTurn("Muse asked a clarifying question; answer it in chat and retry");
					return;
				}
				const questions = Array.isArray(params["questions"])
					? (params["questions"] as Array<Record<string, unknown>>)
					: [];
				const answers: Array<Record<string, unknown>> = [];
				for (const question of questions) {
					const questionId = strField(question, "id");
					const prompt = strField(question, "question") || strField(question, "header") || "Muse question";
					const options = Array.isArray(question["options"])
						? (question["options"] as Array<Record<string, unknown>>).map((item) => strField(item, "label")).filter(Boolean)
						: [];
					const mode = (question["selection"] as Record<string, unknown> | undefined)?.["mode"];
					if (options.length && mode === "single") {
						const selected = await bridge.ui.select(prompt, [...options, "Let me explain…"]);
						if (!selected) throw new Error("cancelled");
						if (selected === "Let me explain…") {
							const content = await bridge.ui.input(prompt, "Type your clarification");
							if (!content) throw new Error("cancelled");
							await host.request("userInput/clarify", {
								commandId: uuid7(), sessionId, userInputId,
								clarification: { format: "text", content: content.slice(0, 500) },
							}, { ms: HOST_RPC_TIMEOUT_MS, label: "userInput/clarify" });
							return;
						}
						answers.push({ questionId, selectedLabel: selected });
					} else {
						const hint = options.length ? `Choose comma-separated: ${options.join(", ")}` : "Type your answer";
						const value = await bridge.ui.input(prompt, hint);
						if (!value) throw new Error("cancelled");
						answers.push(mode === "multiple"
							? { questionId, selectedLabels: value.split(",").map((item) => item.trim()).filter(Boolean) }
							: { questionId, freeText: value.slice(0, 500) });
					}
				}
				await host.request("userInput/answer", { commandId: uuid7(), sessionId, userInputId, answers }, { ms: HOST_RPC_TIMEOUT_MS, label: "userInput/answer" });
			})().catch(async (error) => {
				if (settled) return;
				await host.request("userInput/cancel", {
					commandId: uuid7(), sessionId, userInputId, reason: error instanceof Error ? error.message : String(error),
				}, { ms: HOST_RPC_TIMEOUT_MS, label: "userInput/cancel" }).catch(() => undefined);
				cancelTurn("Muse clarification was cancelled");
			});
		};

		try {
			stream.push({ type: "start", partial: output });
			await host.ensure(sandboxed);
			const fingerprint = host.fingerprintInfo();
			if (MSP_FINGERPRINT && fingerprint && fingerprint !== MSP_FINGERPRINT) {
				output.diagnostics = [
					{
						type: "muse-msp",
						timestamp: Date.now(),
						error: {
							message:
								`Muse MSP schema fingerprint changed (host: ${fingerprint}). ` +
								`Expected ${MSP_FINGERPRINT} (PI_MUSE_MSP_FINGERPRINT); update the extension if turns misbehave.`,
						},
					},
				];
			}

			const cwd = sessionCwd();
			const bareModel = bareModelId(model.id);
			liveKeyStr = chatKey(cwd, bareModel, context.messages);
			let existing = lives.get(liveKeyStr) ?? null;
			let resumePending = 0;
			if (!existing) {
				// A previous Pi process may have left a live Muse session behind.
				// Adopt it only when this Pi conversation extends the exact
				// prefix it was saved with; otherwise start fresh below.
				const persisted = loadPersistedSessions().get(liveKeyStr);
				if (
					persisted &&
					persisted.cwd === cwd &&
					persisted.model === bareModel &&
					persisted.sandboxed === sandboxed &&
					Date.now() - persisted.savedAt <= SESSION_INDEX_TTL_MS &&
					persisted.messageCount > 0 &&
					context.messages.length > persisted.messageCount &&
					fingerprintMessages(context.messages.slice(0, persisted.messageCount)) === persisted.prefixFp
				) {
					const resumed = await resumePersistedSession(persisted);
					if (resumed) {
						debugLog(`adopted persisted session ${resumed.live.sessionId}`);
						existing = resumed.live;
						resumePending = resumed.pending;
					} else {
						removePersistedSession(liveKeyStr);
					}
				}
			}
			if (!existing) {
				// Mid-chat /model switch: move the same conversation's session
				// to the new model instead of replaying full history.
				const candidate = crossModelCandidate(context, cwd, bareModel, sandboxed);
				if (candidate) {
					const switched = await switchSessionModel(candidate, bareModel);
					if (switched) {
						existing = switched.live;
						resumePending = switched.pending;
					}
				}
			}
			const suffix = existing ? suffixForLive(existing, context, cwd, bareModel, sandboxed) : null;
			let parts: Array<Record<string, unknown>>;
			let reused = false;
			// Muse 1.0.3 cannot safely replay provider-private reasoning across
			// host restarts; restore the visible Pi conversation into a fresh session.
			if (existing && attached.has(existing.sessionId)) {
				sessionId = existing.sessionId;
				liveEntry = existing;
				const delta = suffix ?? latestUserSuffix(context.messages);
				if (delta) {
					parts = deltaParts(delta);
					reused = true;

				} else {
					parts = conversationParts(context);
				}
			} else {
				liveEntry = await startMspSession(cwd, bareModel, sandboxed);
				sessionId = liveEntry.sessionId;
				parts = conversationParts(context);
			}
			sentImages = parts.some((part) => part["type"] === "image");
			let mySession = sessionId;
			// Durable-log progress is a dead-projector fallback: it must only
			// display while the live view is silent (or reported a gap), never
			// while deltas are flowing. lastLiveEventMs starts at zero (stalled)
			// and is stamped by the turn ack plus every live notification below.
			let lastLiveEventMs = 0;
			let viewGapSeen = false;
			const markLive = () => {
				lastLiveEventMs = Date.now();
			};
			const markLiveIfMine = (params: Record<string, unknown>) => {
				if (params["sessionId"] === mySession && !settled) markLive();
			};
			salvageAfterMs = Date.now();
			// Keep the loop alive while the turn runs (no request is in
			// flight between deltas); released in finish().
			releaseTurn = host.hold();

			off.push(
				host.onNotification("item/delta", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					if (typeof params["delta"] !== "string") return;
					markLive();
					const delta = params["delta"];
					const field = String(params["field"] ?? "text");
					const itemId = String(params["itemId"] ?? "");
					if (field === "text") {
						if (itemId) streamedByItem.set(itemId, (streamedByItem.get(itemId) ?? 0) + delta.length);
						append("text", delta);
					} else if (isSummaryField(field)) {
						const prev = lastSummaryField.get(itemId);
						const piece = prev && prev !== field ? `\n${delta}` : delta;
						lastSummaryField.set(itemId, field);
						if (itemId) streamedByItem.set(itemId, (streamedByItem.get(itemId) ?? 0) + piece.length);
						append("thinking", piece);
					}
				}),
				host.onNotification("item/started", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					markLive();
					const item = params["item"] as Record<string, unknown> | undefined;
					if (!item || item["turnId"] !== turnId) return;
					const kind = String(item["kind"] ?? "");
					if (["toolCall", "subagent", "userShell", "workflow"].includes(kind)) {
						bridge?.ui.setWorkingMessage(`Muse ${activityLabel(item, kind)}`);
					}
				}),
				host.onNotification("item/updated", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					markLive();
					const item = params["item"] as Record<string, unknown> | undefined;
					if (!item || item["turnId"] !== turnId) return;
					rememberItemTarget(mySession, item);
					const itemId = strField(item, "itemId");
					if (item["kind"] === "toolCall" && item["background"] === true && !backgroundNoted.has(itemId)) {
						backgroundNoted.add(itemId);
						bridge?.recordActivity({
							label: `backgrounded: ${activityLabel(item, "toolCall")}`,
							cwd,
							itemId,
							failed: false,
						});
					}
				}),
				host.onNotification("item/completed", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					markLive();
					const item = params["item"] as Record<string, unknown> | undefined;
					if (!item || item["turnId"] !== turnId) return;
					const kind = item["kind"];
					const text = itemText(item);
					rememberItemTarget(mySession, item);
					if (kind === "agentMessage") {
						// Full snapshot: emit only the tail not already streamed
						// via item/delta (missing deltas => whole text, the
						// fallback this path exists for).
						const seen = streamedByItem.get(String(item["itemId"] ?? "")) ?? 0;
						if (text.length > seen) append("text", text.slice(seen));
						streamedByItem.delete(String(item["itemId"] ?? ""));
					} else if (kind === "reasoning") {
						const snapshot = reasoningSnapshot(item);
						const seen = streamedByItem.get(String(item["itemId"] ?? "")) ?? 0;
						if (snapshot.length > seen) append("thinking", snapshot.slice(seen));
						streamedByItem.delete(String(item["itemId"] ?? ""));
					} else if (
						kind === "toolCall" ||
						kind === "subagent" ||
						kind === "userShell" ||
						kind === "workflow" ||
						kind === "compaction"
					) {
						bridge?.ui.setWorkingMessage();
						const rawArgs = kind === "toolCall" ? strField(item, "args") : "";
						let args: Record<string, unknown> | undefined;
						try {
							const parsed: unknown = JSON.parse(rawArgs);
							if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
								args = parsed as Record<string, unknown>;
							}
						} catch {
							// The MSP contract preserves malformed model-authored JSON verbatim.
						}
						bridge?.recordActivity({
							label: activityLabel(item, String(kind)),
							rawArgs: rawArgs || undefined,
							tool: kind === "toolCall" ? piToolName(strField(item, "tool")) : undefined,
							args,
							cwd,
							itemId: strField(item, "itemId"),
							failed: item["status"] !== undefined && item["status"] !== "completed",
						});
					} else if (kind !== "userMessage") {
						// The schema requires unknown kinds to render generically;
						// only our own user echo (which we already show) is skipped.
						bridge?.ui.setWorkingMessage();
						bridge?.recordActivity({
							label: `${String(kind) || "item"}: ${oneLine(strField(item, "fallbackText")) || strField(item, "itemId") || "update"}`,
							cwd,
							itemId: strField(item, "itemId"),
							failed: item["status"] !== undefined && item["status"] !== "completed",
						});
					}
				}),
				host.onNotification("session/tokenUsage", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					markLive();
					applyTokenUsage(output, params["usage"]);
					if (model) calculateCost(model, output.usage);
				}),
				host.onNotification("approval/requested", (params) => {
					markLiveIfMine(params);
					handleApproval(params);
				}),
				host.onNotification("approval/updated", (params) => {
					markLiveIfMine(params);
					handleApproval(params);
				}),
				host.onNotification("userInput/requested", (params) => {
					markLiveIfMine(params);
					handleUserInput(params);
				}),
				host.onNotification("turn/completed", (params) => {
					if (params["sessionId"] !== mySession) return;
					if (settled) {
						// Lag-vs-death evidence: a notification arriving after we
						// gave up means the projector was slow, not dead. Visible
						// with PI_MUSE_MSP_DEBUG=1.
						if (salvageAbandonedAtMs) {
							debugLog(
								`late turn/completed ignored (settled): turn=${String(params["turnId"] ?? "")} ` +
									`terminal=${String(params["terminal"] ?? "")} ` +
									`${((Date.now() - salvageAbandonedAtMs) / 1000).toFixed(1)}s after salvage abandon`,
							);
						}
						return;
					}
					if (params["turnId"] !== turnId) return;
					// Terminal usage is authoritative: tokenUsage notifications
					// may have been lost with a dying projector.
					applyTokenUsage(output, params["usage"]);
					if (model) calculateCost(model, output.usage);
					if (params["terminal"] === "failed") {
						const error = params["error"] as Record<string, unknown> | undefined;
						const message = String(error?.["message"] ?? params["reason"] ?? "Muse turn failed");
						if (isRetainedMediaError(message) && mediaRetry === "no" && sessionId) {
							const { images } = scanSessionLog(sessionId, salvageAfterMs, seenThoughts);
							queueVisionRetry(images);
							return;
						}
						finish("error", message);
					} else if (params["terminal"] === "completed" || params["terminal"] === undefined) {
						keepLive = !sentImages || sparkUsesMeta(bareModel);
						finish("stop");
					} else if (params["terminal"] === "cancelled") {
						// Our own abort settles first, so this is server-initiated.
						finish("aborted", String(params["reason"] ?? "Muse turn was cancelled"));
					} else {
						finish("error", `Muse turn ended with unknown terminal "${String(params["terminal"])}"${params["reason"] ? `: ${String(params["reason"])}` : ""}`);
					}
				}),
				host.onNotification("turn/retryScheduled", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					if (params["turnId"] !== undefined && params["turnId"] !== turnId) return;
					const attempt = typeof params["attempt"] === "number" ? params["attempt"] : "?";
					const maxAttempts = typeof params["maxAttempts"] === "number" ? params["maxAttempts"] : "?";
					const delayMs = typeof params["retryDelayMs"] === "number" ? params["retryDelayMs"] : undefined;
					const when = delayMs === undefined ? "shortly" : `in ${(delayMs / 1000).toFixed(delayMs < 10000 ? 1 : 0)}s`;
					append("thinking", `[muse-msp: attempt ${attempt}/${maxAttempts} failed (${strField(params, "reason") || "transient error"}); retrying ${when}]\n`);
				}),
				host.onNotification("view/gap", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					// The projector admits it dropped events: durable progress
					// fills the gap even while other live events still flow.
					viewGapSeen = true;
					debugLog("view/gap; durable-log progress unblocked for this turn");
				}),
				host.onNotification("session/todoListChanged", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					markLive();
					const items = Array.isArray(params["items"])
						? (params["items"] as Array<Record<string, unknown>>)
						: [];
					if (items.length === 0) return;
					const done = items.filter(
						(item) => item["status"] === "completed" || item["status"] === "cancelled",
					).length;
					const active = items.find((item) => item["status"] === "inProgress");
					const activeText = active ? strField(active, "activeForm") || strField(active, "text") : "";
					bridge?.ui.setWorkingMessage(
						`Muse todos ${done}/${items.length}${activeText ? `: ${oneLine(activeText, 100)}` : ""}`,
					);
					if (!todoCompleteNoted && done === items.length) {
						todoCompleteNoted = true;
						append("thinking", `[muse-msp: todos complete (${done}/${items.length})]\n`);
					}
				}),
				host.onNotification("session/contextUsage", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					markLive();
					const pressure = strField(params, "pressure");
					if (pressure !== "warning" && pressure !== "blocked") return;
					if (pressure === lastPressure) return;
					lastPressure = pressure;
					const used = typeof params["usedTokens"] === "number" ? params["usedTokens"] : "?";
					const window = typeof params["windowTokens"] === "number" ? params["windowTokens"] : "?";
					append("thinking", `[muse-msp: context pressure ${pressure}: ${used}/${window} tokens]\n`);
				}),
				host.onNotification("session/viewHealthChanged", (params) => {
					if (params["sessionId"] !== mySession || settled) return;
					if (params["health"] !== "unavailable" || viewUnhealthy) return;
					viewUnhealthy = true;
					append("thinking", `[muse-msp: view projector reported unavailable (${strField(params, "noneReason") || "unknown reason"}); salvaging from the durable log]\n`);
					salvage();
				}),
			);

			if (resumePending > 0 && sessionId) {
				// Adopted sessions may carry requests raised while detached;
				// their re-issued notifications raced our handlers, so pull.
				const sid = sessionId;
				void host.request("approval/listPending", { sessionId: sid }, { ms: HOST_RPC_TIMEOUT_MS, label: "approval/listPending" })
					.then((listed) => {
						if (settled || sid !== sessionId) return;
						const rows = Array.isArray(listed["approvals"])
							? (listed["approvals"] as Array<Record<string, unknown>>)
							: [];
						for (const row of rows) handleApproval(row);
						const userInputs = Array.isArray(listed["userInputs"])
							? (listed["userInputs"] as Array<Record<string, unknown>>)
							: [];
						for (const row of userInputs) handleUserInput(row);
					})
					.catch(() => undefined);
			}

			const abort = () => {
				if (settled || !sessionId) return;
				host
					.request("turn/interrupt", {
						commandId: uuid7(),
						sessionId,
						...(turnId ? { turnId } : {}),
						retract: false,
					})
					.catch(() => undefined);
				finish("aborted", "Muse MSP turn was aborted");
			};
			if (options?.signal?.aborted) {
				finish("aborted", "Muse MSP turn was aborted");
				return;
			}
			options?.signal?.addEventListener("abort", abort, { once: true });
			off.push(() => options?.signal?.removeEventListener("abort", abort));

			const turnParams = (): Record<string, unknown> => {
				const commandId = uuid7();
				// Fresh turn ids derive from commandId. Publish it before awaiting
				// the ack so an immediate notification cannot race past our filter.
				turnId = commandId;
				return {
					commandId,
					sessionId,
				input: parts,
					...(reasoningEffort(options?.reasoning as ThinkingLevel | undefined)
						? { reasoningEffort: reasoningEffort(options?.reasoning as ThinkingLevel | undefined) }
						: {}),
				};
			};
			queueVisionRetry = (images: MspImage[]) => {
				if (mediaRetry !== "no" || settled) return;
				mediaRetry = "inflight";
				const oldSession = sessionId;
				if (oldSession) attached.delete(oldSession);
				lives.delete(liveKeyStr);
				activeTurns.delete(liveKeyStr);
				// Ignore late notifications and salvage while switching sessions.
				sessionId = null;
				mySession = "";
				void (async () => {
					try {
						append("thinking", "\n[muse-msp: Muse cannot retain tool-read images; retrying once in a fresh session with current-turn vision input]\n");
						const fresh = await startMspSession(cwd, bareModel, sandboxed);
						if (settled) { attached.delete(fresh.sessionId); return; }
						liveEntry = fresh;
						sessionId = fresh.sessionId;
						mySession = sessionId;
						parts = attachVisionImages(conversationParts(context), images);
						// Preserve completed tool progress so recovery does not blindly repeat work.
						parts.unshift({ type: "text", text: "Recovery: continue the latest user request. Check existing outputs before repeating actions.\n" +
							output.content.map((block) => block.type === "text" ? block.text : "").join("\n") });
						sentImages = parts.some((part) => part["type"] === "image");
						salvageAfterMs = Date.now();
						viewUnhealthy = false;
						viewGapSeen = false;
						markLive();
						todoCompleteNoted = false;
						lastPressure = "";
						mediaRetry = "done";
						const retryResult = await startTurn();
						if (settled) return;
						turnId = String(retryResult["turnId"] ?? "");
						if (!turnId) throw new Error("Muse MSP vision retry returned no turnId");
						activeTurns.set(liveKeyStr, {
							liveKey: liveKeyStr, cwd, model: bareModel, sessionId, turnId,
							mark: (note: string) => append("thinking", note),
						});
					} catch (error) {
						finish("error", error instanceof Error ? error.message : String(error));
					}
				})();
			};
			const startTurn = async (): Promise<Record<string, unknown>> => {
				const params = turnParams();
				const provisionalTurnId = turnId;
				try {
					return await host.request("turn/start", params, { ms: TURN_START_ACK_TIMEOUT_MS, label: "turn/start acknowledgement" });
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "turn/start acknowledgement timed out" &&
						provisionalTurnId
					) {
						debugLog(
							`turn/start acknowledgement timed out; monitoring durable log ` +
							`session=${sessionId} turn=${provisionalTurnId}`,
						);
						append(
							"thinking",
							"[muse-msp: turn accepted without a live acknowledgement; monitoring the durable Muse session log]\n",
						);
						return { turnId: provisionalTurnId, disposition: "acknowledgementTimedOut" };
					}
					throw error;
				}
			};
			let turnResult: Record<string, unknown>;
			try {
				turnResult = await startTurn();
			} catch (error) {
				if (!reused) throw error;
				debugLog(`session reuse failed, starting fresh: ${error instanceof Error ? error.message : String(error)}`);
				liveEntry = await startMspSession(cwd, bareModel, sandboxed);
				sessionId = liveEntry.sessionId;
				mySession = sessionId;
				parts = conversationParts(context);
				sentImages = parts.some((part) => part["type"] === "image");
				reused = false;
				turnResult = await startTurn();
			}
			turnId = String(turnResult["turnId"] ?? turnId ?? "");
			// A live acknowledgement proves the view is up; a timed-out ack
			// leaves the stamp at zero so durable progress flows immediately.
			if (turnResult["disposition"] !== "acknowledgementTimedOut") markLive();
			debugLog(`turn started: session=${sessionId} turn=${turnId} reused=${reused}`);
			if (!turnId) throw new Error("Muse MSP turn/start returned no turnId");
			// Publish the running turn so native Pi steering can exact-target it
			// via turn/steer. finish() (above) revokes it on settle, so a
			// steer can never land on a terminal or cancelled turn. The ack
			// can land after an early terminal already settled the turn, in
			// which case publishing would leak a stale steer/fork target.
			if (liveKeyStr && sessionId && !settled) {
				const entry: ActiveTurn = {
					liveKey: liveKeyStr,
					cwd,
					model: bareModel,
					sessionId,
					turnId,
					mark: (note: string) => append("thinking", note),
				};
				activeTurns.set(liveKeyStr, entry);
			}
			// ponytail: MSP turn/completed is durable-sourced and never arrives if
			// the view projector dies; the session jsonl still gets a terminal.
			const alreadyShown = (text: string) =>
				output.content.some(
					(block) =>
						(block.type === "text" && block.text.includes(text)) ||
						(block.type === "thinking" && block.thinking.includes(text)),
				);
			let listPendingInFlight = false;
			let terminalFirstSeenMs = 0;
			let salvageAbandonedAtMs = 0;
			// The live view is gone but the server-side run may still be
			// executing (and billing): stop it before closing the turn, or it
			// keeps running orphaned. Mirrors abort's interrupt (never
			// turn/cancel: the abort contract owns that distinction).
			const stopOrphanedRun = () => {
				if (sessionId) {
					host
						.request("turn/interrupt", {
							commandId: uuid7(),
							sessionId,
							...(turnId ? { turnId } : {}),
							retract: false,
						})
						.catch(() => undefined);
				}
			};
			const salvage = () => {
				if (settled || !sessionId) return;
				// While live view events flow, durable progress only duplicates
				// what already streamed — hold it. A silent view (or a reported
				// gap / confirmed-unhealthy projector) means the durable log is
				// the only signal left: show durable progress. Approvals and
				// terminal recovery below stay ungated.
				const liveStalled =
					viewGapSeen || viewUnhealthy || Date.now() - lastLiveEventMs >= SALVAGE_PROGRESS_STALL_MS;
				const { progress, recovered, failedReason, images } = scanSessionLog(
					sessionId,
					salvageAfterMs,
					// Held-back thoughts must not burn their seen keys: if the
					// view dies later, they still need to display.
					liveStalled ? seenThoughts : new Set<string>(),
				);
				if (liveStalled) {
					for (const thought of progress) {
						if (!alreadyShown(thought)) append("thinking", thought.endsWith("\n") ? thought : `${thought}\n`);
					}
				} else if (progress.length > 0) {
					debugLog(`salvage progress held (${progress.length} item(s); live view active)`);
				}
				if (!sandboxed) {
					const sid = sessionId;
					// jsonl first: live-host listPending can hang forever after the
					// view projector dies, and `.finally` never ran the fallback.
					for (const row of pendingApprovalsFromLog(sid, salvageAfterMs)) handleApproval(row);
					if (!listPendingInFlight) {
						listPendingInFlight = true;
						void host.request("approval/listPending", { sessionId: sid }, { ms: 1_500, label: "approval/listPending" })
							.then((listed) => {
								if (settled) return;
								const rows = Array.isArray(listed["approvals"])
									? (listed["approvals"] as Array<Record<string, unknown>>)
									: [];
								for (const row of rows) handleApproval(row);
								const userInputs = Array.isArray(listed["userInputs"])
									? (listed["userInputs"] as Array<Record<string, unknown>>)
									: [];
								for (const row of userInputs) handleUserInput(row);
							})
							.catch(() => undefined)
							.finally(() => {
								listPendingInFlight = false;
							});
					}
				}
				// The durable terminal can precede its live notification by a
				// couple of seconds on a healthy host; acting on first sight
				// would cry "projector died" on every slow turn. Wait out the
				// grace so only a truly missing notification abandons the turn
				// below (progress and approvals above keep flowing meanwhile).
				// A server-confirmed dead projector skips the grace: the live
				// notification isn't merely slow, it's never coming.
				if (!viewUnhealthy && (failedReason || recovered)) {
					if (!terminalFirstSeenMs) {
						terminalFirstSeenMs = Date.now();
						return;
					}
					if (Date.now() - terminalFirstSeenMs < SALVAGE_TERMINAL_GRACE_MS) return;
				}
				if (failedReason) {
					if (isRetainedMediaError(failedReason) && mediaRetry === "no") {
						queueVisionRetry(images);
						return;
					}
					salvageAbandonedAtMs = Date.now();
					stopOrphanedRun();
					finish("error", failedReason);
					return;
				}
				if (!recovered) return;
				const have = output.content.reduce(
					(text, block) => text + (block.type === "text" ? block.text : ""),
					"",
				);
				const extra = recovered.startsWith(have) ? recovered.slice(have.length) : have ? "" : recovered;
				if (extra) append("text", extra);
				append(
					"thinking",
					`\n[muse-msp: recovered from Muse session log; MSP view projector died ` +
						`(no turn event ${SALVAGE_TERMINAL_GRACE_MS / 1000}s after durable terminal; orphaned run stopped); ` +
						`starting a fresh Muse session next turn]\n`,
				);
				// A projector that missed terminal may miss later events too. Never
				// reuse this session after salvaging its durable result.
				keepLive = false;
				salvageAbandonedAtMs = Date.now();
				stopOrphanedRun();
				finish("stop");
			};
			const salvageTimer = setInterval(salvage, 2000);
			salvageTimer.unref();
			off.push(() => clearInterval(salvageTimer));
		} catch (error) {
			finish(options?.signal?.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
		}
		await finished;
	}).catch((error: unknown) => {
		// Unreachable insurance: the body funnels everything to finish(), but
		// an extension must never take its host down with an unhandled rejection.
		debugLog(`turn body escaped: ${error instanceof Error ? error.message : String(error)}`);
	});

	return stream;
}

// ---------------------------------------------------------------------------
// Models (live model/list, static fallback)
// ---------------------------------------------------------------------------

const FALLBACK_MODELS = [
	{ id: "muse-spark", name: "Muse Spark (server default)", modelId: undefined as string | undefined },
	{ id: "muse-spark-1.3", name: "muse-spark-1.3", modelId: "muse-spark-1.3" },
	{ id: "muse-spark-1.3-contributor", name: "muse-spark-1.3-contributor", modelId: "muse-spark-1.3-contributor" },
	{ id: "muse-spark-1.2", name: "muse-spark-1.2", modelId: "muse-spark-1.2" },
	{ id: "muse-spark-1.2-contributor", name: "muse-spark-1.2-contributor", modelId: "muse-spark-1.2-contributor" },
];

function modelDefinition(id: string, name: string) {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: {
			off: "off",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text", "image"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

/** Posture for model refresh: reuse any existing host (listing models must
 * never respawn — that would kill live sessions); otherwise prefer what is
 * actually known (env, then the last turn's posture) and default to
 * sandboxed, since CLI flags may not have landed yet at startup refresh. */
function refreshPosture(): boolean {
	return host.currentSandboxed() ?? (envSandboxed() || lastMspSandboxed) ?? true;
}

async function refreshMuseMspModels(sandboxed: boolean) {
	const models = FALLBACK_MODELS.map((model) => modelDefinition(model.id, model.name));
	try {
		await host.ensure(sandboxed);
		const result = await host.request("model/list", {}, { ms: HOST_RPC_TIMEOUT_MS, label: "model/list" });
		const rows = Array.isArray(result["models"]) ? (result["models"] as Array<Record<string, unknown>>) : [];
		if (rows.length > 0) {
			const live = rows.map((row) =>
				modelDefinition(
					String(row["modelId"] ?? ""),
					String(row["displayLabel"] ?? row["modelId"] ?? ""),
				),
			);
			const defaultRow = rows.find((row) => row["isDefault"] === true);
			if (defaultRow) live.unshift(modelDefinition("muse-spark", "Muse Spark (server default)"));
			return live.filter((model) => model.id);
		}
	} catch {
		// Fall through to the static list; execution surfaces the host error.
	}
	return models;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const uiBridges = new Map<string, UiBridge>();

function piToolActivity(activity: MuseActivity, expanded: boolean) {
	if (!activity.tool || !activity.args || !activity.cwd) return undefined;
	const args = { ...activity.args };
	if (args["path"] === undefined && typeof args["file_path"] === "string") args["path"] = args["file_path"];
	if (activity.tool === "grep" && args["pattern"] === undefined) args["pattern"] = args["query"] ?? "";
	// Muse's edit has already run. Suppress Pi's asynchronous pre-execution
	// diff calculation, then mark the native row successful with an empty diff.
	if (activity.tool === "edit") delete args["edits"];
	const definition = ({
		bash: createBashToolDefinition,
		read: createReadToolDefinition,
		write: createWriteToolDefinition,
		edit: createEditToolDefinition,
		grep: createGrepToolDefinition,
		find: createFindToolDefinition,
		ls: createLsToolDefinition,
	} as Record<string, (cwd: string) => any>)[activity.tool]?.(activity.cwd);
	if (!definition) return undefined;
	const component = new ToolExecutionComponent(
		activity.tool,
		activity.itemId || uuid7(),
		args,
		undefined,
		definition,
		{ requestRender: () => {} } as never,
		activity.cwd,
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult({
		content: activity.failed && activity.label ? [{ type: "text", text: activity.label }] : [],
		details: activity.tool === "edit" && !activity.failed ? { diff: "" } : undefined,
		isError: activity.failed,
	});
	component.setExpanded(expanded);
	return component;
}

/** Resolve an item-id prefix to a drill-down target, or an error message. */
function findItemTarget(prefix: string, need: "subagentId" | "outputRefId"): [string, ItemTarget] | string {
	if (!prefix) return "muse-msp: pass an item id prefix (see the activity row)";
	const matches = [...itemTargets.entries()].filter(([itemId]) => itemId.startsWith(prefix));
	if (matches.length === 0) return `muse-msp: no recorded item starts with ${prefix}`;
	if (matches.length > 1) {
		return `muse-msp: prefix ${prefix} is ambiguous (${matches.map(([itemId]) => shortId(itemId)).join(", ")})`;
	}
	const [itemId, target] = matches[0]!;
	if (!target[need]) {
		return `muse-msp: item ${shortId(itemId)} has no ${need === "subagentId" ? "subagent result" : "stored output"}`;
	}
	return [itemId, target];
}

/** Server-side session inventory (id to model/updated), or null when the list
 * call fails. Never throws. */
async function mspServerSessions(
	sandboxed: boolean,
	workspaceRoot?: string,
): Promise<Map<string, { model: string; updatedAt: string }> | null> {
	try {
		await host.ensure(sandboxed);
		const result = await host.request("session/list", { limit: 200, ...(workspaceRoot ? { workspaceRoot } : {}) }, { ms: HOST_RPC_TIMEOUT_MS, label: "session/list" });
		const rows = Array.isArray(result["sessions"])
			? (result["sessions"] as Array<Record<string, unknown>>)
			: [];
		const out = new Map<string, { model: string; updatedAt: string }>();
		for (const row of rows) {
			const id = strField(row, "sessionId");
			if (id) out.set(id, { model: strField(row, "modelId"), updatedAt: strField(row, "updatedAt") });
		}
		return out;
	} catch {
		return null;
	}
}

/** One-line skill inventory for doctor ("-" without a session, "?" on failure). Never throws. */
async function mspSkillSummary(preferredSessionId?: string): Promise<string> {
	const sessionId = preferredSessionId ?? latestOriginSessionId() ?? [...lives.values()][0]?.sessionId;
	if (!sessionId) return "-";
	try {
		const result = await host.request("skill/list", { sessionId }, { ms: HOST_RPC_TIMEOUT_MS, label: "skill/list" });
		const rows = Array.isArray(result["skills"]) ? (result["skills"] as Array<Record<string, unknown>>) : [];
		const names = rows.map((row) => strField(row, "selector")).filter(Boolean);
		return `${names.length}${names.length ? `(${names.slice(0, 8).join(",")}${names.length > 8 ? ",…" : ""})` : ""}`;
	} catch {
		return "?";
	}
}

export default function museMsp(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<MuseActivity>("muse-msp-activity", (entry, { expanded }, theme) => {
		const activity = entry.data;
		if (!activity) return new Text("", 0, 0);
		const native = piToolActivity(activity, expanded);
		if (native) return native;
		const icon = activity.failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		let text = `${icon} ${theme.fg("toolTitle", activity.label)}`;
		if (expanded && activity.rawArgs) text += `\n${theme.fg("toolOutput", activity.rawArgs)}`;
		const box = new Box(1, 1, (content) =>
			theme.bg(activity.failed ? "toolErrorBg" : "toolSuccessBg", content),
		);
		box.addChild(new Text(text, 0, 0));
		return box;
	});
	const bridgeFor = (model: Model<Api>, context: Context) =>
		uiBridges.get(chatKey(sessionCwd(), bareModelId(model.id), context.messages));
	// Flags are applied by turn time, so each turn records the authoritative
	// posture for later refreshes (see refreshPosture).
	const turnSandboxed = (): boolean => {
		lastMspSandboxed = mspSandboxed(pi);
		return lastMspSandboxed;
	};
	const stream = (model: Model<Api>, context: Context, options?: StreamOptions) =>
		streamMuseMsp(model, context, options, turnSandboxed(), bridgeFor(model, context));
	const streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
		streamMuseMsp(model, context, options, turnSandboxed(), bridgeFor(model, context));

	registerApiProvider({ api: MSP_API, stream, streamSimple }, API_PROVIDER_SOURCE);
	pi.registerFlag("muse-msp-sandboxed", {
		description: "Run Muse MSP host with its sandbox enabled (default: sandbox disabled, approvals allow-all)",
		type: "boolean",
		default: false,
	});
	pi.registerProvider(PROVIDER_ID, {
		name: "Muse MSP",
		baseUrl: "http://localhost",
		apiKey: "muse-msp-local",
		api: MSP_API,
		models: FALLBACK_MODELS.map((model) => modelDefinition(model.id, model.name)),
		refreshModels: () => refreshMuseMspModels(refreshPosture()),
		streamSimple,
	});
	// Capture the native UI against the same stable chat key used by the
	// provider. Direct completeSimple callers (for example Hermes) simply
	// have no bridge and retain non-interactive behavior.
	pi.on("context", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		// Context hooks receive Pi AgentMessages (including compactionSummary,
		// branchSummary, custom, and bashExecution), while providers receive
		// LLM Messages. Normalize here so this key exactly matches bridgeFor()
		// and never assumes every raw AgentMessage has a content array.
		const messages = convertToLlm(event.messages) as Context["messages"];
		uiBridges.set(chatKey(sessionCwd(), bareModelId(ctx.model.id), messages), {
			ui: ctx.ui,
			hasUI: ctx.hasUI,
			recordActivity: (activity) => pi.appendEntry("muse-msp-activity", activity),
		});
	});
	// Fresh Pi session (/reset, /new) means a fresh Muse session too.
	pi.on("session_shutdown", (event) => {
		if (event.reason === "new") forgetMspSessions();
		uiBridges.clear();
		// /reload creates a new extension module instance. Always reap this
		// instance's provider and host so neither can retain stale state.
		unregisterApiProviders(API_PROVIDER_SOURCE);
		host.dispose(`session shutdown: ${event.reason}`);
	});
	pi.on("input", async (event, ctx) => {
		if (
			event.streamingBehavior !== "steer" ||
			!ctx.model ||
			ctx.model.provider !== PROVIDER_ID
		) {
			return { action: "continue" };
		}
		const outcome = await steerRunningTurn(
			sessionCwd(),
			bareModelId(ctx.model.id),
			event.text,
			event.images,
		);
		if (!outcome.ok) {
			debugLog(`native steer fell back to Pi queue: ${outcome.reason}`);
			return { action: "continue" };
		}
		return { action: "handled" };
	});
	pi.registerCommand("muse-msp-doctor", {
		description: "Check the Muse MSP host (binary, handshake, schema fingerprint, loaded skills)",
		handler: async (_args, ctx) => {
			try {
				await host.ensure(mspSandboxed(pi));
				const fingerprint = host.fingerprintInfo();
				// Prefer this chat's live session for the skill inventory; the
				// origin file is process-global and may belong to another chat.
				const chatModel = ctx.model?.provider === PROVIDER_ID ? bareModelId(ctx.model.id) : undefined;
				const chatSession = chatModel
					? [...lives.values()].find((live) => live.cwd === sessionCwd() && live.model === chatModel)?.sessionId
					: undefined;
				const skills = await mspSkillSummary(chatSession);
				ctx.ui.notify(
					`muse-msp ok: host running (sandboxed=${mspSandboxed(pi)}, fingerprint=${fingerprint ?? "unknown"}${MSP_FINGERPRINT && fingerprint && fingerprint !== MSP_FINGERPRINT ? " — MISMATCH vs PI_MUSE_MSP_FINGERPRINT, update extension" : ""}, liveSessions=${lives.size}, persistedSessions=${loadPersistedSessions().size}, skills=${skills})`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerCommand("muse-msp-recover-completed", {
		description: "Recover the newest completed assistant answer from a Muse durable session log",
		handler: async (args, ctx) => {
			const sessionId = args.trim() || latestOriginSessionId();
			if (!sessionId) {
				ctx.ui.notify("muse-msp: no session id supplied and no origin session is available", "error");
				return;
			}
			const recovered = latestCompletedAnswerFromLog(sessionId);
			if (!recovered) {
				ctx.ui.notify(`muse-msp: no completed plaintext answer exists for ${sessionId}`, "error");
				return;
			}
			pi.sendMessage({
				customType: "muse-msp-recovered",
				content: recovered,
				display: true,
				details: { sessionId },
			});
			ctx.ui.notify(`Recovered completed Muse answer from ${sessionId}`, "info");
		},
	});
	pi.registerCommand("muse-msp-subagent", {
		description: "Show a finished subagent's result (pass an item id prefix from its activity row)",
		handler: async (args, ctx) => {
			const target = findItemTarget(args.trim(), "subagentId");
			if (typeof target === "string") {
				ctx.ui.notify(target, "error");
				return;
			}
			const [itemId, found] = target;
			try {
				await host.ensure(mspSandboxed(pi));
				const result = await host.request("subagent/readResult", {
					commandId: uuid7(),
					sessionId: found.sessionId,
					subagentId: found.subagentId!,
				}, { ms: HOST_RPC_TIMEOUT_MS, label: "subagent/readResult" });
				const summary = strField(result, "summary");
				const text = strField(result, "text");
				const body = [summary, text].filter(Boolean).join("\n\n") || "(no result text)";
				pi.sendMessage({
					customType: "muse-msp-subagent",
					content: body,
					display: true,
					details: { itemId, subagentId: found.subagentId },
				});
				ctx.ui.notify(`subagent ${shortId(itemId)}: ${oneLine(summary || text, 120) || "result posted"}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerCommand("muse-msp-output", {
		description: "Show a tool's stored output (pass an item id prefix from its activity row)",
		handler: async (args, ctx) => {
			const target = findItemTarget(args.trim(), "outputRefId");
			if (typeof target === "string") {
				ctx.ui.notify(target, "error");
				return;
			}
			const [itemId, found] = target;
			try {
				await host.ensure(mspSandboxed(pi));
				const result = await host.request("item/readOutput", {
					sessionId: found.sessionId,
					itemId,
					outputRef: found.outputRefId,
					lengthBytes: 32768,
				}, { ms: HOST_RPC_TIMEOUT_MS, label: "item/readOutput" });
				const content = strField(result, "content");
				pi.sendMessage({
					customType: "muse-msp-output",
					content: content || "(no stored output)",
					display: true,
					details: { itemId, mediaType: strField(result, "mediaType") },
				});
				ctx.ui.notify(
					`output ${shortId(itemId)}: ${content.length} chars${result["eof"] === false ? " (truncated, first page)" : ""}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerCommand("muse-msp-fork", {
		description: "Fork this chat's live Muse session (whole history) and continue on the fork",
		handler: async (_args, ctx) => {
			if (!ctx.model || ctx.model.provider !== PROVIDER_ID) {
				ctx.ui.notify("muse-msp: no Muse session for this chat", "error");
				return;
			}
			const cwd = sessionCwd();
			const model = bareModelId(ctx.model.id);
			if ([...activeTurns.values()].some((turn) => turn.cwd === cwd && turn.model === model)) {
				ctx.ui.notify("muse-msp: a turn is in flight; wait for it to finish before forking", "error");
				return;
			}
			const matches = [...lives.entries()].filter(([, live]) => live.cwd === cwd && live.model === model);
			if (matches.length === 0) {
				ctx.ui.notify("muse-msp: no live session for this chat to fork", "error");
				return;
			}
			if (matches.length > 1) {
				ctx.ui.notify("muse-msp: several live sessions match this directory; fork needs an unambiguous target", "error");
				return;
			}
			const [key, live] = matches[0]!;
			try {
				await host.ensure(live.sandboxed);
				const result = await host.request("session/fork", { commandId: uuid7(), sessionId: live.sessionId }, { ms: HOST_RPC_TIMEOUT_MS, label: "session/fork" });
				const session = result["session"] as Record<string, unknown> | undefined;
				const id = session ? String(session["sessionId"] ?? "") : "";
				if (!id) throw new Error("muse fork returned no session");
				const from = live.sessionId;
				attached.add(id);
				live.sessionId = id;
				lives.set(key, live);
				savePersistedSessions();
				writeOriginFile({ sessionId: id, cwd: live.cwd, model: live.model, sandboxed: live.sandboxed });
				ctx.ui.notify(`muse-msp: forked ${shortId(from)} → ${shortId(id)} (whole history); this chat continues on the fork`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerCommand("muse-msp-sessions", {
		description: "List Muse MSP sessions kept for Pi chats (pass 'prune' to drop expired or dead entries)",
		handler: async (args, ctx) => {
			const now = Date.now();
			const cwd = sessionCwd();
			const rows = new Map<
				string,
				{ sessionId: string; cwd: string; model: string; sandboxed: boolean; messageCount: number; age: string; live: boolean }
			>();
			for (const [key, value] of loadPersistedSessions()) {
				rows.set(key, {
					sessionId: value.sessionId,
					cwd: value.cwd,
					model: value.model,
					sandboxed: value.sandboxed,
					messageCount: value.messageCount,
					age: ageLabel(now - value.savedAt),
					live: lives.has(key),
				});
			}
			for (const [key, live] of lives) {
				rows.set(key, {
					sessionId: live.sessionId,
					cwd: live.cwd,
					model: live.model,
					sandboxed: live.sandboxed,
					messageCount: live.messageCount,
					age: "now",
					live: true,
				});
			}
			if (args.trim().toLowerCase() === "prune") {
				// One session/list join beats N resume probes; per-row probing
				// remains as the fallback when the list call fails.
				const listed = await mspServerSessions(mspSandboxed(pi));
				let dropped = 0;
				let kept = 0;
				for (const [key, row] of rows) {
					if (row.live) {
						kept++;
						continue;
					}
					let dead: boolean;
					if (listed) {
						dead = !listed.has(row.sessionId);
					} else {
						dead = false;
						try {
							await host.ensure(row.sandboxed);
							await host.request("session/resume", { commandId: uuid7(), sessionId: row.sessionId }, { ms: HOST_RPC_TIMEOUT_MS, label: "session/resume" });
						} catch {
							dead = true;
						}
					}
					if (dead) {
						removePersistedSession(key);
						dropped++;
					} else kept++;
				}
				ctx.ui.notify(`muse-msp sessions pruned: dropped=${dropped} kept=${kept}`, "info");
				return;
			}
			if (rows.size === 0) {
				ctx.ui.notify("muse-msp: no sessions (live or persisted)", "info");
				return;
			}
			const server = await mspServerSessions(mspSandboxed(pi), cwd);
			const known = new Set([...rows.values()].map((row) => row.sessionId));
			const lines = [...rows.values()].map(
				(row) =>
					`${row.live ? "*" : " "} ${shortId(row.sessionId)} ${row.model || "?"} @ ${row.cwd || "?"} ` +
					`(msgs=${row.messageCount}, age=${row.age}${row.sandboxed ? ", sandboxed" : ""}` +
					`${server && !server.has(row.sessionId) ? ", not on server" : ""})`,
			);
			if (server) {
				for (const [id, meta] of server) {
					if (known.has(id)) continue;
					const ms = Date.parse(meta.updatedAt);
					lines.push(
						`  ${shortId(id)} ${meta.model || "?"} (server only${Number.isFinite(ms) ? `, updated ${ageLabel(now - ms)} ago` : ""})`,
					);
				}
			} else {
				lines.push("(server session list unavailable)");
			}
			ctx.ui.notify(`muse-msp sessions (*live):\n${lines.join("\n")}`, "info");
		},
	});
}
