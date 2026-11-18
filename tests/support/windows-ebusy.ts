// Robust lifecycle for the embedded Postgres servers that tests start (vitest setup file, see vitest.config.ts).
//
// Why this exists. embedded-postgres 18.x has three failure modes that leak postgres.exe processes and
// %TEMP%\dmc-* data folders, and the previous version of this file hid the symptom by swallowing EBUSY:
//  1. start() rejects with `undefined` when the server exits early (for example the port is taken). The
//     process is already dead, but stop() waits for an 'exit' event that never fires again, so afterAll
//     hangs until the hook timeout and the data directory is never removed.
//  2. stop() returns early when the server was never started (initialise() failed), leaving the directory.
//  3. stop() kills the tree with taskkill /f /t, which races with the postmaster restarting its workers, and
//     removes the data directory right after the postmaster exits. On Windows the children of the
//     postmaster (killed by `taskkill /t`) still hold handles for a moment, so the removal fails with
//     EBUSY/EPERM. There is no retry, and no wait for the tree to be gone.
// Note: if a worker is torn down before afterAll runs (hook timeout, crash), postgres.exe is not tied to the
// worker on Windows and can outlive it; embedded-postgres only stops it from a graceful exit hook.
//
// This replaces start() and stop() with versions that: clean up after a failed start, wait until the
// server process has really exited (force-killing the tree if needed), and remove the data directory
// with retries. A directory that still cannot be removed after the retries is reported, not ignored.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

type Internals = { process?: ChildProcess; options: { databaseDir: string; port: number; persistent?: boolean } };
type Proto = { start: () => Promise<void>; stop: () => Promise<void> };

const WIN = process.platform === 'win32';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hasExited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;


function killTreeSync(p: ChildProcess) {
  if (!p.pid || hasExited(p)) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(p.pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
  else p.kill('SIGKILL');
}

/** Ask the postmaster to shut down through pg_ctl (immediate mode: it ends its own children before it exits). */
async function pgCtlStop(p: ChildProcess, dataDir: string) {
  const ctl = p.spawnfile.replace(/postgres(.exe)?$/, 'pg_ctl$1');
  await new Promise<void>((resolve) => {
    const k = spawn(ctl, ['stop', '-D', dataDir, '-m', 'immediate', '-t', '20', '-w'], { stdio: 'ignore', windowsHide: true });
    k.on('close', () => resolve()); k.on('error', () => resolve());
  });
}

async function killTree(p: ChildProcess) {
  if (!p.pid) return;
  if (WIN) {
    await new Promise<void>((resolve) => {
      const k = spawn('taskkill', ['/pid', String(p.pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
      k.on('close', () => resolve()); k.on('error', () => resolve());
    });
  } else p.kill('SIGINT');   // fast shutdown, children follow the postmaster
}

async function removeDir(dir: string) {
  const deadline = Date.now() + 20_000;
  for (let attempt = 0; ; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') || Date.now() > deadline) {
        throw new Error(`embedded Postgres data directory ${dir} could not be removed (${code}); a postgres.exe still holds it`, { cause: e });
      }
      await sleep(Math.min(100 * (attempt + 1), 1000));
    }
  }
}

const proto = EmbeddedPostgres.prototype as unknown as Proto;
const MARK = Symbol.for('dmc.embedded-postgres.patched');
if (!(proto as unknown as Record<symbol, unknown>)[MARK]) {
  (proto as unknown as Record<symbol, unknown>)[MARK] = true;
  const start = proto.start;

  proto.start = async function (this: Internals) {
    try {
      await start.call(this);
    } catch (e) {
      // The server did not come up: make sure nothing is left behind, then report a real error.
      await (this as unknown as Proto).stop().catch(() => undefined);
      throw e ?? new Error(`embedded Postgres exited before it was ready (port ${this.options.port}); is the port already in use?`);
    }
  } as Proto['start'];

  proto.stop = async function (this: Internals) {
    const proc = this.process;
    this.process = undefined;
    if (proc) {
      if (!hasExited(proc)) {
        const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
        // taskkill /t alone is racy: the postmaster restarts workers (autovacuum launcher, io_worker) that are
        // killed before it, and those orphans keep the data directory locked. So stop it cleanly first.
        await pgCtlStop(proc, this.options.databaseDir);
        await Promise.race([closed, sleep(10_000)]);
        if (!hasExited(proc)) await killTree(proc);
        await Promise.race([closed, sleep(20_000)]);
        if (!hasExited(proc)) killTreeSync(proc);
      }
    }
    // Also covers a server whose initialise() ran but start() never did, and a server that already died.
    if (this.options.persistent === false && existsSync(this.options.databaseDir)) await removeDir(this.options.databaseDir);
  } as Proto['stop'];

}
