---
name: implement-or-update-move-ingestion-pipeline
description: Workflow command scaffold for implement-or-update-move-ingestion-pipeline in GitNexus.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /implement-or-update-move-ingestion-pipeline

Use this workflow when working on **implement-or-update-move-ingestion-pipeline** in `GitNexus`.

## Goal

Implements or updates the Move ingestion pipeline, including registering new phases or excluding files from parsing.

## Common Files

- `gitnexus/src/core/ingestion/pipeline-phases/parse.ts`
- `gitnexus/src/core/ingestion/pipeline.ts`
- `gitnexus/src/core/ingestion/languages/move.ts`
- `gitnexus/src/core/ingestion/model/registration-table.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit or add ingestion pipeline phase files (core/ingestion/pipeline-phases/*.ts, core/ingestion/pipeline.ts)
- Update or add Move-specific ingestion logic (core/ingestion/languages/move.ts, core/ingestion/model/registration-table.ts)
- Update or add tests if needed

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.