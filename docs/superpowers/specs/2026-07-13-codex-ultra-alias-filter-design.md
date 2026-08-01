# Codex ultra alias filter design

## Goal

Hide OmniRoute's synthetic Sol and Terra ultra aliases from Pi without changing OmniRoute's catalog or affecting other clients. Keep the real Sol and Terra base models available with Pi's independent `max` thinking level when those efforts are discovered from ordinary sources.

## Scope

The filter belongs to fresh OmniRoute catalog normalization before Pi persists the resulting provider snapshot. Exclusion uses an **exact normalized complete ID allowlist** of four IDs only:

- `codex/gpt-5.6-sol-ultra`
- `cx/gpt-5.6-sol-ultra`
- `codex/gpt-5.6-terra-ultra`
- `cx/gpt-5.6-terra-ultra`

There are **no** `owned_by`, `root`, or prefix heuristics. Same-root models under a different provider (for example `openai/gpt-5.6-sol-ultra`) remain. Other Codex or non-Codex `-ultra` IDs remain independently routable. `ultra` is ignored as a Pi reasoning effort and is never mapped to `max`.

Pi's public `createProvider` lifecycle persists and restores only the already-normalized provider snapshot, so the extension does not need separate store or legacy-cache filtering paths.

## Behavior

The four aliases are omitted rather than folded into a base model. Pi has no `ultra` thinking level, and this extension does not invent one or rewrite `ultra` into `max`.

All ordinary reasoning suffix folding remains unchanged. In particular, verified `-max` variants continue contributing the `max` effort to their exact text base. Other unknown suffixes remain independently routable.

## Tests

Regression coverage uses the normalized provider catalog as the public behavior boundary. It verifies that:

- the four exact synthetic ultra alias IDs are absent from the normalized fresh snapshot that Pi persists;
- ordinary bases and verified `-max` folding still work;
- a different Codex ultra ID remains present;
- another provider's model with the same Sol ultra root remains present;
- Pi restores that already-normalized snapshot through its standard provider lifecycle.

## Non-goals

This change does not modify OmniRoute, its persisted model catalog, upstream PRs, request transport, or Pi's thinking-level type. It does not attempt to implement Codex Ultra's task-delegation behavior, and it does not claim transport maps ultra to max.
