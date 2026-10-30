/**
 * Ports layer: the interfaces the application depends on and the adapters
 * implement (Brain, Executor, PlaybookAuthoring, Memory, TraceSink, Clock,
 * CostTable, Workspace). Ports may import the domain, nothing higher.
 *
 * Today it holds only `Clock`, the one port the skeleton exercises.
 */

/** The single source of wall-clock time, so time is injectable in tests. */
export interface Clock {
  now(): Date;
}
