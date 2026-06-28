/**
 * One-sentence, human-facing instruction to paste into an AI agent. It says
 * what this is and where the API lives; the agent reads the URL (get_skill_md)
 * for everything else. Shared by the overlay, the console log, and the
 * extension side panel so they stay consistent.
 */
export function buildAgentInstruction(
  serviceUrl: string,
  opts: { token?: string; target?: string } = {},
): string {
  const where = opts.target ? ` ("${opts.target}")` : "";
  const auth = opts.token
    ? ` (auth header: Authorization: Bearer ${opts.token})`
    : "";
  return (
    `A Hypha debugger is attached to this live web page${where} — call its HTTP API at ` +
    `${serviceUrl} to inspect and control the page; GET ${serviceUrl}/get_skill_md ` +
    `for the full tool list and usage${auth}.`
  );
}
