```markdown
# GitNexus Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to contribute to the GitNexus codebase, a TypeScript project focused on Move language support, code ingestion, and schema mapping. You'll learn the project's coding conventions, how to implement and update Move language features, ingestion pipelines, compiler client logic, and documentation. The guide also covers testing strategies and provides ready-to-use commands for common workflows.

---

## Coding Conventions

**File Naming:**  
- Use camelCase for file names.  
  _Example:_ `factsMapper.ts`, `moveClient.ts`

**Import Style:**  
- Use relative imports.  
  _Example:_
  ```typescript
  import { parseMoveSignature } from './signatureParser';
  ```

**Export Style:**  
- Use named exports.  
  _Example:_
  ```typescript
  export function mapFactsToSchema(facts: MoveFacts): SchemaNode { ... }
  ```

**Commit Messages:**  
- Follow [Conventional Commits](https://www.conventionalcommits.org/).
- Prefixes: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`
- Example:
  ```
  feat(move): add support for new schema mapping in v1.66 (closes #123)
  ```

---

## Workflows

### Add or Update Move Schema and Mapper
**Trigger:** When supporting new Move language features or fixing schema/mapping bugs  
**Command:** `/new-move-schema-mapping`

1. Edit Move schema definition files:  
   - `src/core/lbug/schema.ts`
   - `src/core/lbug/schema-constants.ts`
2. Update facts-mapper logic:  
   - `src/core/move/facts-mapper.ts`
3. Update CSV generator or lbug adapter if needed:  
   - `src/core/lbug/csv-generator.ts`
   - `src/core/lbug/lbug-adapter.ts`
4. Update or add relevant tests:  
   - `test/unit/move/facts-mapper.test.ts`
   - `test/unit/schema.test.ts`

_Example:_
```typescript
// src/core/move/facts-mapper.ts
export function mapMoveFacts(facts: MoveFacts): SchemaNode {
  // mapping logic here
}
```

---

### Implement or Update Move Ingestion Pipeline
**Trigger:** When adding new ingestion phases or adjusting Move file processing  
**Command:** `/update-move-ingestion`

1. Edit or add ingestion pipeline phase files:  
   - `src/core/ingestion/pipeline-phases/*.ts`
   - `src/core/ingestion/pipeline.ts`
2. Update or add Move-specific ingestion logic:  
   - `src/core/ingestion/languages/move.ts`
   - `src/core/ingestion/model/registration-table.ts`
3. Update or add tests if needed

_Example:_
```typescript
// src/core/ingestion/pipeline-phases/parse.ts
export function parseMoveFile(file: SourceFile): ParsedMove {
  // parsing logic
}
```

---

### Extend Move Compiler Facts and Client
**Trigger:** When supporting new facts from the Move compiler or enhancing the client interface  
**Command:** `/update-move-compiler-client`

1. Edit or add compiler facts extraction logic:  
   - `src/core/move/compiler-facts.ts`
   - `src/core/move/signature-parser.ts`
   - `src/core/move/symbol-id.ts`
2. Update or add client logic:  
   - `src/core/move/mcp-client.ts`
3. Update or add relevant tests:  
   - `test/unit/move/mcp-client.test.ts`
   - `test/unit/move/signature-parser.test.ts`

_Example:_
```typescript
// src/core/move/mcp-client.ts
export async function fetchMoveFacts(): Promise<MoveFacts[]> {
  // client logic
}
```

---

### Add or Update Move-Related Tests
**Trigger:** When adding or changing Move language support or ingestion logic  
**Command:** `/add-move-tests`

1. Add or update test files for Move features:  
   - `test/unit/move/*.test.ts`
   - `test/integration/move-live.test.ts`
2. Adjust test assertions as needed for new schema or ingestion logic

_Example:_
```typescript
// test/unit/move/facts-mapper.test.ts
import { describe, it, expect } from 'vitest';
import { mapMoveFacts } from '../../../src/core/move/facts-mapper';

describe('mapMoveFacts', () => {
  it('maps facts correctly', () => {
    expect(mapMoveFacts(sampleFacts)).toMatchObject(expectedSchema);
  });
});
```

---

### Document Move Language Support
**Trigger:** When documenting new Move features, plans, or audit findings  
**Command:** `/document-move-support`

1. Add or update Move-related documentation files:  
   - `docs/code-indexing/move/*.md`
   - `docs/superpowers/plans/*.md`
   - `docs/superpowers/specs/*.md`

_Example:_
```markdown
# Move v1.66 Schema Mapping

This document describes the mapping of Move compiler facts to the internal schema for v1.66.
```

---

## Testing Patterns

- **Framework:** [Vitest](https://vitest.dev/)
- **Test File Pattern:** `*.test.ts`
- **Test Organization:**  
  - Unit tests: `test/unit/move/*.test.ts`, `test/unit/schema.test.ts`
  - Integration tests: `test/integration/move-live.test.ts`
- **Example:**
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { parseMoveSignature } from '../../../src/core/move/signature-parser';

  describe('parseMoveSignature', () => {
    it('parses valid signature', () => {
      expect(parseMoveSignature('fn foo(u64): bool')).toEqual({ name: 'foo', params: ['u64'], returns: 'bool' });
    });
  });
  ```

---

## Commands

| Command                      | Purpose                                                        |
|------------------------------|----------------------------------------------------------------|
| /new-move-schema-mapping     | Add or update Move schema and mapping logic                    |
| /update-move-ingestion       | Implement or update Move ingestion pipeline                    |
| /update-move-compiler-client | Extend Move compiler facts extraction and client interface      |
| /add-move-tests              | Add or update tests for Move language features or ingestion    |
| /document-move-support       | Add or update documentation for Move language support          |
```
