/**
 * Entrypoint for the home-control bridge container (design §3; Task 0/15).
 *
 * main() builds the real object graph via composeAndStart() and wires graceful
 * shutdown (SIGTERM / SIGINT) so the hardened container's `init: true` delivers
 * a clean exit. All secrets come from environment variables; the alias table
 * is read from the path in ALIAS_PATH (default: /app/config/aliases.yaml,
 * matching the docker-compose volume mount).
 *
 * On a missing required secret loadSecrets() throws a clear Error naming the
 * key; main() surfaces it, logs it, and exits non-zero so the container
 * orchestrator can detect the failure immediately.
 */

import { composeAndStart } from './app/compose.js';

export function main(): void {
  const aliasPath = process.env['ALIAS_PATH'] ?? '/app/config/aliases.yaml';

  let runtime: ReturnType<typeof composeAndStart>;
  try {
    runtime = composeAndStart({ aliasPath, env: process.env });
  } catch (err: unknown) {
    // loadConfig / loadSecrets throws a clear message on missing secrets.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] startup failed: ${message}`);
    process.exitCode = 1;
    return;
  }

  console.log('[bridge] started');

  let shuttingDown = false;
  function gracefulShutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[bridge] received ${signal}; shutting down`);
    runtime.shutdown();
    // Give in-flight close frames a moment before the process exits.
    setTimeout(() => {
      process.exit(0);
    }, 2_000);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// Export the public API surface that other modules (and tests) import.
export { Bridge } from './app/bridge.js';
export { loadConfig, loadSecrets } from './app/config.js';
export { AuditLogger } from './core/audit.js';
export { ClockSource } from './adapters/clock-source.js';
export { composeAndStart } from './app/compose.js';

if (process.env['NODE_ENV'] !== 'test') {
  main();
}
