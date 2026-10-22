/**
 * Attic consumes the standalone `mcp-trace` package (see packages/mcp-trace).
 * Kept as a module here so the rest of the server imports one local path.
 */
export { trace, mcpTrace } from "mcp-trace";
export type { TraceFrame, TraceBus } from "mcp-trace";
