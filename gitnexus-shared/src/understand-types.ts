/**
 * Understand-* artefact types — shared between CLI and Web.
 *
 * These types are persisted to `.gitnexus/understand/*.json` by the
 * understand pipeline phases and consumed by:
 *   - The MCP `gitnexus://repo/{name}/understand/*` resources.
 *   - The `gitnexus-understand-*` Claude/Cursor skills.
 *   - The `gitnexus-web` UI (planned).
 *
 * The interfaces below are ported verbatim from Understand-Aptos
 * (`packages/core/src/types.ts` and `components/ports-types.ts`) with two
 * gitnexus-specific extensions documented inline (`Layer.relatedCommunityIds`
 * and `DiffOverlay`).
 *
 * gitnexus-shared must remain dependency-free; runtime validators live in
 * `gitnexus/src/core/understand/validators.ts`.
 */

// ── Layers ────────────────────────────────────────────────────────────────

/** Architectural layer (e.g. API / Service / Data). */
export interface Layer {
  /** `layer:<kebab-case>` (e.g. `layer:api`). */
  id: string;
  /** Human-readable name (e.g. `API Layer`). */
  name: string;
  /** One-sentence description of the layer's responsibility. */
  description: string;
  /** Graph node IDs (gitnexus format: `File:path`, `Module:...`). */
  nodeIds: string[];
  /**
   * gitnexus extension — Community IDs that significantly overlap with this
   * layer (>50% of layer files share the community). Lets consumers pivot
   * between human-named layers and statistical communities.
   */
  relatedCommunityIds?: string[];
}

// ── Tour ──────────────────────────────────────────────────────────────────

export interface TourStep {
  order: number;
  title: string;
  description: string;
  /** Graph node IDs the reader should look at for this step. */
  nodeIds: string[];
  /** Optional teaching note about the file's language idioms. */
  languageLesson?: string;
}

// ── Components (manifest-based packaging) ────────────────────────────────

export type ManifestKind = 'move' | 'cargo' | 'npm' | 'python' | 'go' | 'root' | 'node' | 'rust';

export interface Component {
  /** `component:<kebab-case-name>`. */
  id: string;
  /** Display name (from `[package].name`, `name`, or directory basename). */
  name: string;
  /** Repo-relative path to the manifest (`Move.toml`, `Cargo.toml`, …). */
  manifestPath?: string;
  manifestKind: ManifestKind;
  /** Logical primary language (`move`, `rust`, `typescript`, …). */
  language?: string;
  /** Absolute path to the directory the component lives in. */
  fileRoot?: string;
  rootDir?: string;
  description?: string;
  /** `file:<path>` entries assigned to this component (longest-prefix match). */
  nodeIds: string[];
  fileCount?: number;
  /** Path to the per-component port file under `.gitnexus/understand/ports/`. */
  portsManifestPath?: string;
}

// ── Ports & cross-component graph ────────────────────────────────────────

export type PortKind =
  | 'move-entry'
  | 'move-view'
  | 'move-public'
  | 'move-call'
  | 'http-route'
  | 'ws-pub'
  | 'ws-sub'
  | 'sdk-call'
  | 'rust-export'
  | 'ts-export'
  | 'event-emit'
  | 'event-listen'
  | 'import';

export interface Port {
  /** `port:<componentId>:<short-name-or-line>`. */
  id: string;
  kind: PortKind;
  /** Module-qualified symbol (e.g. `vault::redeem`, `GET /api/grants`). */
  symbol: string;
  /** Canonical symbol identity when `symbol` is a display/query alias. */
  canonicalSymbol?: string;
  /** Short UI-friendly alias for canonical symbols. */
  displaySymbol?: string;
  signature?: string;
  /** Repo-relative source file path. */
  sourceFile: string;
  /** 1-based line number. */
  sourceLine: number;
  tags?: string[];
  confidence?: 'high' | 'medium' | 'low';
}

export interface ComponentPorts {
  componentId: string;
  /**
   * Fidelity tier:
   *   - `deterministic-high` — compiler-resolved (move-flow MCP).
   *   - `tree-sitter` — regex/tree-sitter heuristic.
   *   - `llm-labeled` — LLM-verified (deferred).
   */
  extractorFidelity: 'deterministic-high' | 'tree-sitter' | 'llm-labeled';
  producers: Port[];
  consumers: Port[];
  /** Move-only: `[addresses]` table from `Move.toml` (alias → hex). */
  moveAddresses?: Record<string, string>;
  /** Non-fatal extraction problems that degraded the component's port data. */
  warnings?: string[];
}

export type CrossComponentEdgeType = 'sdk-call' | 'move-call' | 'http' | 'ws' | 'event' | 'import';

export interface CrossComponentEdge {
  id: string;
  from: { componentId: string; portId: string };
  to: { componentId: string; portId: string };
  type: CrossComponentEdgeType;
  confidence: 'high' | 'medium' | 'low';
  evidence: { file: string; line: number };
  /** Lower-ranked candidates when multiple producers matched the consumer. */
  alternatives?: Array<{ componentId: string; portId: string }>;
}

export interface CrossComponentGraphComponent {
  id: string;
  name: string;
  kind: ManifestKind;
  ports: Port[];
}

export interface CrossComponentGraph {
  version: '1.0.0';
  generatedAt: string;
  repoRoot: string;
  components: CrossComponentGraphComponent[];
  edges: CrossComponentEdge[];
  unmatched: Array<{ port: Port; reason: string }>;
}

// ── Diff overlay (gitnexus extension) ─────────────────────────────────────

export interface DiffOverlay {
  version: '1.0.0';
  /** Base ref the diff was computed against (`main`, `HEAD`, …). */
  baseBranch: string;
  generatedAt: string;
  /** Repo-relative file paths in the diff. */
  changedFiles: string[];
  /** Graph node IDs whose files appear in the diff. */
  changedNodeIds: string[];
  /** Node IDs reachable from changed nodes via 1-hop CALLS/IMPORTS. */
  affectedNodeIds: string[];
  /** Layer IDs at least one changed/affected node belongs to. */
  affectedLayerIds: string[];
  /** Process IDs (gitnexus execution flows) at least partially impacted. */
  affectedProcessIds: string[];
}

// ── Persistence summary block (lives inside `meta.json`) ──────────────────

export interface UnderstandStats {
  layers: number;
  tourSteps: number;
  components: number;
  ports: number;
  crossEdges: number;
  unmatchedConsumers: number;
  /** ISO timestamp of the last `gitnexus enrich` run (absent until enriched). */
  lastEnrichedAt?: string;
}
