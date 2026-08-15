# Use only public catalog metadata for reasoning

## Decision

The authenticated public `/v1/models` response is the sole model and capability authority. The extension enables reasoning only from explicit `capabilities.reasoning`, `capabilities.thinking`, or recognized `capabilities.effort_tiers` values.

Recognized efforts are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A reported effort maps only to the corresponding Pi level; unsupported levels are `null`. Unknown values remain ignored. Model-name suffixes are not folded and no base model is synthesized.

## Rationale

Earlier implementations made an undocumented VS Code metadata route a mandatory atomic participant and folded suffix variants. That increased failure surface and could change the routing ID sent to OmniRoute. Current Pi can expose each exact catalog ID directly, while explicit primary metadata is sufficient for conservative controls.

## Consequences

Some models without explicit reasoning metadata appear as non-reasoning even if their names imply otherwise. This fails closed and keeps discovery independent from OpenCode/VS Code implementation details. Future enrichment must be optional, soft-failing, and must never create or rename models.
