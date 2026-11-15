// The entrypoint owns only the harness lifecycle: start the forge, hand its port to the env, and
// stay alive until the env reports the trial finished. Everything the suite grades lives in
// app.ts; this file just keeps the process and the env in step.
//
// The env is reached through MAKEFUN_ENV_URL (http://store:8080 inside a trial container).
// The sequence, in order:
//   1. Read the env origin. No origin means there is nothing to register with, so exit 1.
//   2. Build the server and bind an ephemeral port (the kernel picks one). Port 8080 belongs
//      to the env and is never bound here.
//   3. POST the bound port to $MAKEFUN_ENV_URL/register. The env notes where the request came
//      from plus the port and dials the forge from then on. The first registration wins; a 409
//      only says another entry got there first, and this process waits like any other.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env answers each
//      poll at once, so a failed or slow poll is retried after a short backoff; the process
//      never leaves before the env says the trial is over.
//   5. Close the server and exit 0, after which the harness stops the env.

import { createApp } from './app.ts';

/** One register or done call may take this long before it is abandoned and retried. */
const CALL_TIMEOUT_MS = 30_000;
/** Backoff starts here after a failed attempt and never grows past the cap. */
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;
/** How many doublings the backoff runs through before it stops growing. */
const BACKOFF_MAX_SHIFT = 8;

/** Drop trailing slashes so the origin joins cleanly with /register and /done. */
function normalizeOrigin(raw: string): string {
  return raw.replace(/\/+$/, '');
}

const envOrigin = normalizeOrigin(process.env.MAKEFUN_ENV_URL ?? '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Awaitable pause used between retries. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The pause after `attempt` failed calls: exponential from BACKOFF_START_MS, capped. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, BACKOFF_MAX_SHIFT));
}

/**
 * Bind `server` to a kernel-chosen port and report it. A listen error, or a bind that is not a
 * TCP port, rejects: without a port there is nothing to register.
 */
async function bindEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
}

/**
 * One attempt to POST the bound port. Returns true when the env accepted it (200) or when a
 * first registration already won (409). Throws only for a contract refusal (400/405); any other
 * status means the env is not ready yet and the caller retries.
 */
async function announceOnce(port: number): Promise<boolean> {
  const res = await fetch(`${envOrigin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (res.status === 200 || res.status === 409) return true;
  if (res.status === 400 || res.status === 405) {
    throw new Error(`env refused the register with HTTP ${res.status}: ${await res.text()}`);
  }
  return false;
}

/** Keep announcing the port until the env takes it; a contract refusal ends the program. */
async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (await announceOnce(port)) return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('env refused the register')) throw err;
    }
    await wait(backoffMs(attempt));
  }
}

/**
 * One GET /done. True only when the env answers 200 with {"done": true}; anything else —
 * another status, a malformed body, a timeout — means the trial is still running.
 */
async function pollDoneOnce(): Promise<boolean> {
  const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  if (!res.ok) return false;
  const body = (await res.json()) as { done?: unknown };
  return body.done === true;
}

/** Poll /done until the env says the trial is over; never return before that. */
async function awaitEnvDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (await pollDoneOnce()) return;
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await wait(backoffMs(attempt));
  }
}

/** Bind the forge, hand its port to the env, then wait for the trial to end. */
async function runLifecycle(): Promise<void> {
  const server = createApp();
  const port = await bindEphemeral(server);
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await announcePort(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitEnvDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

runLifecycle().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
