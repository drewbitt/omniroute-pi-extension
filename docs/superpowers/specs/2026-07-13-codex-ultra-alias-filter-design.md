# Codex ultra alias filter design

## Goal

Hide OmniRoute's synthetic Sol and Terra ultra aliases from Pi without changing OmniRoute's catalog or affecting other clients. Keep the real Sol and Terra base models available with Pi's independent `max` thinking level when those efforts are discovered from ordinary sources.

## Scope

The filter belongs only to the OmniRoute Pi extension's catalog ingestion paths: live model normalization and cached/store restore. Exclusion uses an **exact normalized complete ID allowlist** of four IDs only:

- `codex/gpt-5.6-sol-ultra`
- `cx/gpt-5.6-sol-ultra`
- `codex/gpt-5.6-terra-ultra`
- `cx/gpt-5.6-terra-ultra`

There are **no** `owned_by`, `root`, or prefix heuristics. Same-root models under a different provider (for example `openai/gpt-5.6-sol-ultra`) remain. Other Codex or non-Codex `-ultra` IDs remain independently routable. `ultra` is ignored as a Pi reasoning effort and is never mapped to `max`.

The same exact-ID filter applies across live discovery, the provider model store, and legacy cache restore so offline and headless paths cannot reintroduce the four synthetic aliases.

## Behavior

The four aliases are omitted rather than folded into a base model. Pi has no `ultra` thinking level, and this extension does not invent one or rewrite `ultra` into `max`.

All ordinary reasoning suffix folding remains unchanged. In particular, verified `-max` variants continue contributing the `max` effort to their exact text base. Other unknown suffixes remain independently routable.

## Tests

Regression coverage uses the normalized provider catalog as the public behavior boundary. It verifies that:

- the four exact synthetic ultra alias IDs are absent from live, store, and legacy restore paths;
- ordinary bases and verified `-max` folding still work;
- a different Codex ultra ID remains present;
- another provider's model with the same Sol ultra root remains present;
- unrelated cached IDs remain present under offline restore.

## Non-goals

This change does not modify OmniRoute, its persisted model catalog, upstream PRs, request transport, or Pi's thinking-level type. It does not attempt to implement Codex Ultra's task-delegation behavior, and it does not claim transport maps ultra to max.
