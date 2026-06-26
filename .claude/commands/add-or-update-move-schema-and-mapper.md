---
name: add-or-update-move-schema-and-mapper
description: Workflow command scaffold for add-or-update-move-schema-and-mapper in GitNexus.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-or-update-move-schema-and-mapper

Use this workflow when working on **add-or-update-move-schema-and-mapper** in `GitNexus`.

## Goal

Adds or updates Move language schema and the mapping logic from compiler facts to internal graph representation.

## Common Files

- `gitnexus/src/core/lbug/schema.ts`
- `gitnexus/src/core/lbug/schema-constants.ts`
- `gitnexus/src/core/move/facts-mapper.ts`
- `gitnexus/src/core/lbug/csv-generator.ts`
- `gitnexus/src/core/lbug/lbug-adapter.ts`
- `gitnexus/test/unit/move/facts-mapper.test.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit Move schema definition files (e.g., lbug/schema.ts, lbug/schema-constants.ts)
- Update facts-mapper logic (core/move/facts-mapper.ts)
- Update CSV generator or lbug adapter if needed (core/lbug/csv-generator.ts, core/lbug/lbug-adapter.ts)
- Update or add relevant tests (test/unit/move/facts-mapper.test.ts, test/unit/schema.test.ts)

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.