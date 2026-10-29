/**
 * The ONE place that decides whether a connection string is a database
 * agent-authored DDL is allowed to touch.
 *
 * WHY AN ALLOWLIST, NOT A DENYLIST
 * --------------------------------
 * A denylist ("not supabase.co") has to enumerate every production database
 * that will ever exist, and misses the ones nobody thought of: on a shared
 * server `localhost:5432` is whatever co-resident service's LIVE Postgres
 * already sits there. An allowlist has to enumerate the handful of disposable
 * ones we actually run, which is a closed set. So: parse, then require BOTH
 *
 *   - a loopback host (or the container-gateway aliases the sandbox reaches the
 *     host's published test port through — see `sandboxTestDbHost` in main.mts
 *     for why `host.docker.internal` / `172.17.0.1` exist at all), AND
 *   - a port that is NOT 5432.
 *
 * 5432 is the conventional production / co-resident port, and a managed test
 * container should publish elsewhere (the loop's default is 55432). A missing
 * port counts as 5432, because that is what every Postgres client would dial.
 *
 * Parsing with `new URL()` rather than string-matching the raw URL is
 * deliberate in both directions: a PASSWORD containing "supabase.co" would
 * false-REFUSE a legitimate local database, and a percent-encoded or
 * mixed-case host would false-PASS a production one. Only the parsed
 * `hostname` decides — case-folded by hand, for the reason spelled out at the
 * `toLowerCase()` below.
 */

/**
 * Hosts that can only ever be a disposable test Postgres.
 *
 * The three loopback forms are the host process's own machine. The two
 * container-gateway aliases are how a sandboxed agent reaches that same
 * machine's published port: Docker Desktop resolves `host.docker.internal`,
 * and Docker Engine on Linux (which has no such name unless the run passes
 * `--add-host`) has to dial the default bridge gateway `172.17.0.1`. They are
 * allowed here so ONE guard serves both the host-side admin URL and the
 * sandbox-side URL, and neither of them is routable to a managed database.
 */
const ALLOWED_DB_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
  "172.17.0.1",
]);

/**
 * The port a Postgres client assumes when the URL names none — and the port
 * the one database we must never touch is listening on. Refused outright: a
 * disposable test container has no reason to publish on it, and something that
 * is already on 5432 on this host is, by convention, the real thing.
 */
const PRODUCTION_DB_PORT = "5432";

/**
 * Throw unless `url` is unmistakably a disposable, local test database.
 *
 * `subject` is the caller's name for whatever produced the URL (an option, an
 * env var), so the operator is told which knob to turn. The message names the
 * refused host and port because the whole failure mode is "I did not realise
 * that URL pointed at production".
 *
 * Never throws for a reason other than the target: an unparseable URL is
 * refused too, since a string this guard cannot read is a string it cannot
 * vouch for.
 */
export function assertDisposableDbTarget(url: string, subject: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `${subject}: refusing to use an unparseable connection string — ` +
        "the target must be a disposable local test Postgres " +
        "(localhost, a port other than 5432).",
    );
  }

  // `.toLowerCase()` is NOT redundant, and this is the trap that cost a test
  // run to find: WHATWG `new URL()` only lower-cases the host for SPECIAL
  // schemes (http/https/ws/wss/ftp/file). `postgres:`/`postgresql:` are not
  // special, so their host is parsed as an OPAQUE host and comes back
  // byte-for-byte as written — `DB.ABC.SUPABASE.CO` stays uppercase. Since DNS
  // is case-insensitive, that string resolves to production either way, so the
  // comparison has to be case-folded here. (Opaque hosts are also not
  // percent-decoded, which fails SAFE: an encoded `localhost` simply misses
  // the allowlist and is refused.)
  //
  // Brackets are stripped so an IPv6 literal compares as `::1`, the form the
  // allowlist is written in.
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // An absent port is 5432 to every Postgres client, so it must be to us.
  const port = parsed.port === "" ? PRODUCTION_DB_PORT : parsed.port;

  if (!ALLOWED_DB_HOSTS.has(host) || port === PRODUCTION_DB_PORT) {
    throw new Error(
      `${subject}: refusing to use ${host}:${port} as the test database — ` +
        `the only permitted targets are a disposable local test Postgres ` +
        `(${[...ALLOWED_DB_HOSTS].join(", ")}) on a port other than ` +
        `${PRODUCTION_DB_PORT}. A hosted database (for example Supabase) is a ` +
        `production database outright, and ${PRODUCTION_DB_PORT} is the ` +
        "conventional production/co-resident port — on a shared server it is a " +
        "neighbouring service's live Postgres. Point this at a throwaway " +
        "Postgres on localhost and another port.",
    );
  }
}
