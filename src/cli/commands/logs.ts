/** Command: logs — view (or tail) the daemon log. */
import fs from 'fs';
import { spawn } from 'child_process';
import { LOG_PATH } from '../../daemon/process.js';

const DEFAULT_LINES = 50;

export async function logs(args: Record<string, unknown>): Promise<void> {
  const positional = (args._ as string[] | undefined) ?? [];
  const follow = Boolean(args.follow) || Boolean(args.f) || positional[0] === '-f' || positional[0] === 'tail';

  if (follow) {
    if (process.platform === 'win32') {
      console.error(
        'logs -f is not supported on Windows yet. Use a shell tail command on `~/.munchfile/daemon.log` directly.'
      );
      process.exit(1);
    }
    if (!fs.existsSync(LOG_PATH)) {
      console.log('No daemon log yet. Run `munchfile watch <path>` to start the daemon.');
      return;
    }
    await runTailFollow();
    return;
  }

  // Default: print last N lines.
  let data: string;
  try {
    data = await fs.promises.readFile(LOG_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('No daemon log yet. Run `munchfile watch <path>` to start the daemon.');
      return;
    }
    throw err;
  }
  const linesArg = args.lines;
  const n = typeof linesArg === 'number'
    ? linesArg
    : typeof linesArg === 'string' ? parseInt(linesArg, 10) || DEFAULT_LINES : DEFAULT_LINES;
  const lines = data.split('\n');
  console.log(lines.slice(-n).join('\n'));
}

function runTailFollow(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/tail', ['-f', LOG_PATH], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const cleanup = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch {
        // already dead
      }
    };
    const onSigint = () => cleanup('SIGINT');
    const onSigterm = () => cleanup('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    const detach = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };

    child.on('exit', (code, signal) => {
      detach();
      if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`tail exited with code ${code}`));
      }
    });
    child.on('error', err => {
      detach();
      reject(err);
    });
  });
}
