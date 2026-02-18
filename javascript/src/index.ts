/**
 * hypha-debugger - Injectable debugger for web pages, powered by Hypha RPC.
 *
 * Usage:
 *   import { startDebugger } from 'hypha-debugger';
 *   const session = await startDebugger({ server_url: 'https://hypha.aicell.io' });
 */

export { HyphaDebugger } from "./debugger.js";
export type { DebuggerConfig, DebugSession } from "./debugger.js";
export type { PageInfo } from "./utils/env.js";

import { HyphaDebugger, type DebuggerConfig, type DebugSession } from "./debugger.js";

/**
 * Start the Hypha debugger. Connects to a Hypha server and registers
 * a debug service that remote clients can use to inspect and interact
 * with this web page.
 *
 * @param config - Configuration for the debugger.
 * @returns A session object with service_id, workspace, and destroy().
 *
 * @example
 * ```js
 * import { startDebugger } from 'hypha-debugger';
 * const session = await startDebugger({ server_url: 'https://hypha.aicell.io' });
 * console.log(`Service: ${session.service_id}, Workspace: ${session.workspace}`);
 * ```
 */
export async function startDebugger(config: DebuggerConfig): Promise<DebugSession> {
  const debugger_ = new HyphaDebugger(config);
  return debugger_.start();
}
