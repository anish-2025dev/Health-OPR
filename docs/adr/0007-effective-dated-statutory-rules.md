# 0007: Effective-dated, versioned statutory payroll rules

**Status:** Accepted (implemented in Phases 10–11)

## Context

EPF, EPS, ESI, professional tax (per state), labour welfare fund, TDS and gratuity rules change over
time and vary by jurisdiction. Hardcoded values become silently wrong.

## Decision

- **No statutory rate, ceiling, slab, eligibility threshold or date appears as a constant in code.**
- Rules are stored in `statutory_rules` with `jurisdiction`, `rule_type`, `effective_from`, `effective_to`,
  `configuration_json`, `source_reference` and `approval_status`. An exclusion constraint prevents
  overlapping active versions.
- Only approved rules are used. Rule values are entered and approved by an authorized person from an
  authoritative source, and are never invented by developers or agents.
- Every payroll run stores the rule versions and inputs it used (`rule_set_version`,
  `calculation_snapshot`), so it can be reproduced exactly.
- Finalized runs are immutable. Corrections are adjustment or reversal entries.

## Consequences

Payroll stays correct when rules change, and every calculation can be audited. Professional payroll
validation is still required before production.
