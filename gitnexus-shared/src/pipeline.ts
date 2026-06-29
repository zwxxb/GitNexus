/**
 * Pipeline progress types — shared between CLI and web.
 */

export type PipelinePhase =
  | 'idle'
  | 'extracting'
  | 'structure'
  | 'moveIngest'
  | 'parsing'
  | 'imports'
  | 'calls'
  | 'heritage'
  | 'scopeResolution'
  | 'communities'
  | 'processes'
  | 'understandComponents'
  | 'understandLayers'
  | 'understandTour'
  | 'understandPorts'
  | 'understandCrossComponent'
  | 'enriching'
  | 'complete'
  | 'error';

export interface PipelineProgress {
  phase: PipelinePhase;
  percent: number;
  message: string;
  detail?: string;
  stats?: {
    filesProcessed: number;
    totalFiles: number;
    nodesCreated: number;
  };
}
