/**
 * dsh-time-context — temporal grounding for DSH models.
 *
 * Injects, into every prompt assembly, a dynamic runtime-context block with:
 *  - the exact current local time (date, clock, weekday, timezone, day-part),
 *  - the timestamp, day relation and recency gap of the user's PREVIOUS message
 *    (across sessions), so "last night -> this morning" continuity is factual,
 * plus a stable system-prompt section teaching the model how to use those facts.
 *
 * Mechanism: the native `systemPrompt.context()` / `systemPrompt.section()`
 * registries. The harness renders dynamic contexts into the runtime-context
 * snapshot that supersedes earlier snapshots, so no message surgery and no
 * per-step duplication is needed.
 *
 * Ground truth for "previous message": `agent/inbox/inserted` (live user
 * messages entering an agent inbox) cross-checked with `api-session/activity`
 * (durable user-message timestamps). A ledger persisted at
 * ~/.dsh/time-context/state.json survives restarts, so a morning session knows
 * about last night's chat even after the app was closed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const inject = ["systemPrompt", "commands"];

const STATE_DIR = join(homedir(), ".dsh", "time-context");
const STATE_FILE = join(STATE_DIR, "state.json");
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n) => String(n).padStart(2, "0");
const fmtClock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtStamp = (ms) => {
	const d = new Date(ms);
	return `${fmtDate(d)} ${fmtClock(d)} ${WEEKDAYS[d.getDay()]}`;
};

function dayPart(d) {
	const h = d.getHours();
	if (h >= 5 && h < 12) return "morning";
	if (h >= 12 && h < 17) return "afternoon";
	if (h >= 17 && h < 21) return "evening";
	if (h >= 21) return "night";
	return "late night / small hours";
}

function dayRelation(earlier, now) {
	const a = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate()).getTime();
	const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const diff = Math.round((b - a) / 86400000);
	if (diff === 0) return "today";
	if (diff === 1) return "yesterday";
	if (diff === -1) return "tomorrow";
	return `${diff} days ago`;
}

function gapPhrase(ms) {
	const m = Math.max(0, Math.round(ms / 60000));
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	if (h < 48) return rm > 0 ? `${h}h ${rm}m ago` : `${h}h ago`;
	const d = Math.floor(h / 24);
	const rh = h % 24;
	return rh > 0 ? `${d}d ${rh}h ago` : `${d}d ago`;
}

function tzLabel() {
	let zone = "local time";
	try {
		zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone;
	} catch { /* keep fallback */ }
	const off = -new Date().getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const abs = Math.abs(off);
	return `${zone}, UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function loadState() {
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function saveState(state) {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(state));
	} catch { /* state is best-effort; never break a prompt over it */ }
}

const RULES = [
	"Temporal grounding: the runtime context carries a `time-context` block with the exact current local time",
	"(date, clock, weekday, timezone, day-part) and the timestamp, day relation and recency gap of the user's",
	"previous message. Use it whenever time matters: resolve relative words (\"yesterday\", \"last night\",",
	"\"this morning\", \"earlier\", \"a while ago\") against those stamps, and never invent a current time or a",
	"date for earlier conversation. When the gap since the previous user message spans a day boundary or",
	"exceeds a few hours, acknowledge the break naturally once (for example \"good morning - picking up from",
	"last night\") instead of ignoring it or reciting raw timestamps."
].join(" ");

export function apply(ctx) {
	const state = Object.assign(
		{ lastUserAt: null, prevUserAt: null, lastSessionId: null, prevSessionId: null, userMessages: 0 },
		loadState()
	);

	const noteUserMessage = (sessionId, at) => {
		const when = typeof at === "number" && Number.isFinite(at) ? at : Date.now();
		// The same durable message reports through both channels; collapse duplicates.
		if (state.lastUserAt !== null && sessionId === state.lastSessionId && Math.abs(when - state.lastUserAt) < 5000) return;
		state.prevUserAt = state.lastUserAt;
		state.prevSessionId = state.lastSessionId;
		state.lastUserAt = when;
		if (sessionId) state.lastSessionId = sessionId;
		state.userMessages += 1;
		saveState(state);
	};

	const buildText = () => {
		const now = new Date();
		const lines = [`- now: ${fmtDate(now)} ${fmtClock(now)} ${WEEKDAYS[now.getDay()]} (${tzLabel()}) - ${dayPart(now)}`];
		if (state.prevUserAt) {
			const prev = new Date(state.prevUserAt);
			const crossSession = state.prevSessionId !== null && state.prevSessionId !== state.lastSessionId;
			lines.push(
				`- previous user message: ${fmtStamp(state.prevUserAt)} (${dayRelation(prev, now)}, ${dayPart(prev)}) - ` +
				`${gapPhrase(now.getTime() - state.prevUserAt)}${crossSession ? `; in another session (${String(state.prevSessionId).slice(-8)})` : ""}`
			);
		} else if (state.lastUserAt) {
			lines.push(`- previous user message: none before the current one (first tracked message: ${fmtStamp(state.lastUserAt)})`);
		} else {
			lines.push("- previous user message: none recorded yet");
		}
		lines.push(`- tracked user messages since install: ${state.userMessages}`);
		return `time-context (dsh-time-context):\n${lines.join("\n")}`;
	};

	ctx.effect(() => {
		const disposers = [];
		if (ctx.systemPrompt && typeof ctx.systemPrompt.context === "function") {
			disposers.push(ctx.systemPrompt.context({ name: "time-context", order: 130, text: buildText }));
		}
		if (ctx.systemPrompt && typeof ctx.systemPrompt.section === "function") {
			disposers.push(ctx.systemPrompt.section({ name: "time-context-rules", order: 450, text: RULES }));
		}
		disposers.push(ctx.on("agent/inbox/inserted", (payload) => {
			const message = payload && payload.message;
			if (!message || !message.source || message.source.kind !== "user") return;
			noteUserMessage(payload.agent ? payload.agent.id : undefined, Date.now());
		}));
		disposers.push(ctx.on("api-session/activity", (sessionId, updatedAt) => {
			noteUserMessage(sessionId, updatedAt);
		}));
		return () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch { /* disposer already gone */ }
			}
		};
	});

	if (ctx.commands && typeof ctx.commands.register === "function") {
		ctx.effect(() => ctx.commands.register({
			name: "time",
			description: "Show the temporal context dsh-time-context injects into every model request",
			async handler() {
				return { kind: "success", text: buildText() };
			}
		}));
	}
}
