/**
 * CLI parser — maps argv to command handlers.
 * Uses the built-in module with a simple command map.
 */

import { login } from './commands/login.js';
import { logout } from './commands/logout.js';
import { watch } from './commands/watch.js';
import { unwatch } from './commands/unwatch.js';
import { status } from './commands/status.js';
import { relink } from './commands/relink.js';
import { startDaemon } from './commands/start.js';
import { stop } from './commands/stop.js';
import { logs } from './commands/logs.js';
import { cleanup } from './commands/cleanup.js';
import { profile } from './commands/profile.js';
import { autostart } from './commands/autostart.js';

export type CommandHandler = (args: Record<string, unknown>) => Promise<void>;

const commands: Record<string, { handler: CommandHandler; description: string }> = {
  login:    { handler: login,       description: 'Authenticate via magic link' },
  logout:   { handler: logout,      description: 'Revoke session tokens' },
  watch:    { handler: watch,       description: 'Watch a file or folder for changes' },
  unwatch:  { handler: unwatch,     description: 'Remove a path from the watch list' },
  status:   { handler: status,      description: 'Show watched paths and stale files' },
  relink:   { handler: relink,      description: 'Recover a stale file after moving it' },
  start:    { handler: startDaemon, description: 'Start the daemon in foreground (advanced; conflicts with auto-spawned daemon)' },
  stop:      { handler: stop,        description: 'Stop the daemon (waits up to 30s for in-flight uploads)' },
  autostart: { handler: autostart,  description: 'Manage daemon autostart on login (enable, disable, status)' },
  logs:      { handler: logs,       description: 'View daemon logs (`-f` to follow, `--lines N` for last N, default 50)' },
  cleanup:  { handler: cleanup,     description: 'Remove stale records older than 90 days' },
  profile:  { handler: profile,     description: 'View or update your profile' },
};

export function parse(argv: string[]): { command: string; args: Record<string, unknown> } {
  const [, , ...rest] = argv; // strip `node` and script path
  const command = rest[0];
  const args: Record<string, unknown> = {};

  for (let i = 1; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = rest[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else if (!token.startsWith('-')) {
      args._ ??= [];
      (args._ as string[]).push(token);
    }
  }

  return { command: command ?? 'help', args };
}

export async function run(argv: string[]): Promise<void> {
  const { command, args } = parse(argv);

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const entry = commands[command];
  if (!entry) {
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
  }

  try {
    await entry.handler(args);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`munchfile — Local Files. Live on the Web.

Usage: munchfile <command> [options]

Commands:
${Object.entries(commands)
  .map(([name, { description }]) => `  ${name.padEnd(12)} ${description}`)
  .join('\n')}

Run 'munchfile <command> --help' for more on a specific command.
`);
}
