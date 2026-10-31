import { configFromEnv } from "./domain/orders.js";

export const DEFAULT_PORT = 3000;

export interface ServerConfig {
  port: number;
  holdSeconds: number;
}

/** Reads PORT (0-65535, default 3000) and HOLD_SECONDS (default 600) from an environment. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const raw = env["PORT"];
  let port = DEFAULT_PORT;
  if (raw !== undefined && raw !== "") {
    port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(port) || port > 65535) throw new Error(`invalid PORT: ${raw}`);
  }
  return { port, holdSeconds: configFromEnv(env).holdSeconds };
}
