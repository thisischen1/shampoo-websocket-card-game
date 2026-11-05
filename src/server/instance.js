// Who am I, and am I alone?
//
// Every room this server knows about lives in this process's memory. That is a
// deliberate trade — no database, no migrations — and it holds perfectly for
// exactly one instance. A second instance does not degrade the service; it
// quietly halves it, because a room code only exists on the machine that
// minted it.
//
// The failure is nasty out of proportion to its cause. A player who lands on
// the wrong instance is told "No room with that code", which is a lie: the code
// is fine, they are just talking to the wrong machine. They retype it, the load
// balancer sends them somewhere else, and it works — so the bug presents as
// random and unreproducible.
//
// This module cannot prevent that. It makes it *obvious*: an id you can see
// from outside, and a check that says so in the logs on boot.

import { randomBytes } from 'node:crypto';
import dnsPromises from 'node:dns/promises';

/**
 * A fresh id per boot, surfaced on /healthz. Two consecutive requests that
 * disagree are proof you are running more than one instance — which is the
 * whole reason this exists, since no amount of config inspection beats asking
 * the deployment itself.
 */
export const INSTANCE_ID = process.env.FLY_MACHINE_ID || randomBytes(4).toString('hex');

/**
 * How many instances of this app are running, or `null` if we have no way to
 * know.
 *
 * Fly publishes one AAAA record per running machine on `<app>.internal`, so the
 * count comes from a DNS lookup — no API token, no dependency, no privilege.
 * Everywhere else (local, Railway, anything else) there is nothing to ask, and
 * `null` says exactly that rather than guessing 1 and sounding confident.
 */
export async function countInstances({ env = process.env, dns = dnsPromises } = {}) {
  const app = env.FLY_APP_NAME;
  if (!app) return null;
  try {
    const addresses = await dns.resolve6(`${app}.internal`);
    return addresses.length;
  } catch {
    // No records yet, or DNS is simply not there. Either way this is a
    // diagnostic, and a diagnostic that crashes the server is worse than no
    // diagnostic at all.
    return null;
  }
}

/**
 * Log loudly if we are not alone. Deliberately not fatal: refusing to boot
 * would turn a degraded game into no game, and the operator who scaled up by
 * accident is better served by a message they cannot miss than by a crash loop
 * that buries the reason.
 */
export async function warnIfNotAlone({ env = process.env, dns = dnsPromises, log = console.error } = {}) {
  const count = await countInstances({ env, dns });
  if (count === null || count <= 1) return count;

  log(
    `\n!! ${count} INSTANCES OF THIS APP ARE RUNNING. ROOMS ARE BROKEN. !!\n` +
    `   Every room lives in one process's memory, so a code minted here does\n` +
    `   not exist on the other ${count - 1}. Players who land on the wrong one\n` +
    `   are told "No room with that code" and will think they mistyped it.\n` +
    `   Fix: fly scale count 1   (and check min_machines_running in fly.toml)\n`,
  );
  return count;
}
