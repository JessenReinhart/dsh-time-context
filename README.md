# dsh-time-context

Temporal grounding for DSH models. Every prompt assembly receives a dynamic
runtime-context block with the exact current local time (date, clock, weekday,
timezone, day-part) and the timestamp, day relation and recency gap of the
user's previous message — including messages from earlier sessions and from
before an app restart. A stable system-prompt section teaches the model to
resolve relative time words ("last night", "this morning", "a while ago")
against those facts instead of guessing.

## Why a plugin, not a skill

A skill only works when the model remembers to invoke it, and an LLM has no
clock of its own. This plugin registers into the native
`systemPrompt.context()` / `systemPrompt.section()` registries, so the facts
arrive automatically with every request, rendered inside the harness's own
runtime-context snapshot (which supersedes older snapshots — no duplication).

## Ground truth

- `agent/inbox/inserted` — live user messages entering an agent inbox.
- `api-session/activity(sessionId, updatedAt)` — durable user-message timestamps.
- Ledger at `~/.dsh/time-context/state.json` survives restarts, so a morning
  session knows the last chat was last night.

## Commands

- `/time` — print the exact block currently injected into prompts.

## Install

Already wired into the desktop profile (`dsh.profile.bundles`). After cloning
or editing, restart DSH Desktop so the bundle row loads.
