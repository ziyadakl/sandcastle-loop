/**
 * Where the harness's receipt pictures go (Piece G of the screen-check
 * design).
 *
 * Optional: the upload runs only when all four of `R2_ACCOUNT_ID` /
 * `R2_SCREEN_CHECK_ACCESS_KEY_ID` / `R2_SCREEN_CHECK_SECRET_ACCESS_KEY` /
 * `R2_SCREEN_CHECK_BUCKET` are set (an S3-compatible bucket on Cloudflare R2)
 * AND `@aws-sdk/client-s3` is installed. Otherwise the picture is simply not
 * stored.
 *
 * What IS real here: the whole upload path, the retry-twice policy, and —
 * critically — the DISTINCTION Piece G draws between two failure shapes
 * that look identical from the caller's point of view but are not:
 *
 *   - "The picture was taken but the bucket would not accept it" (not
 *     configured, or every retry failed). A browser really opened the
 *     page and an independent check really graded it — only the filing
 *     cabinet was locked. MUST NOT stop the ticket: mark the record
 *     `picture not stored` and raise the alarm.
 *   - "The browser never rendered the page, so no picture was ever taken."
 *     Genuine absence of proof — this module is never even CALLED in that
 *     case (the caller only calls it when a screenshot file actually
 *     exists on disk; see `.sandcastle/main.mts`'s call site).
 *
 * Use a SEPARATE bucket and a SEPARATE, narrowly scoped credential for
 * screenshots: they can be numerous, and the credential should not be able to
 * read anything else.
 */
import { readFile } from "node:fs/promises";


/**
 * `@aws-sdk/client-s3` is an OPTIONAL peer: it is imported lazily, only when
 * an upload is actually configured. A project with the package missing gets
 * one log line and no upload, never a crash. The specifier is a variable so
 * the type checker does not require the package either.
 */
const S3_PACKAGE = "@aws-sdk/client-s3";

export interface PutPictureInput {
  readonly Bucket: string;
  readonly Key: string;
  readonly Body: Buffer;
  readonly ContentType: string;
}
export interface PictureClient {
  send(input: PutPictureInput): Promise<unknown>;
}

export interface PictureStoreEnv {
  readonly accountId: string | undefined;
  readonly accessKeyId: string | undefined;
  readonly secretAccessKey: string | undefined;
  readonly bucket: string | undefined;
}

/** Reads the four env vars this seam needs, straight from `process.env`. */
export function pictureStoreEnvFromProcess(): PictureStoreEnv {
  return {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_SCREEN_CHECK_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SCREEN_CHECK_SECRET_ACCESS_KEY,
    bucket: process.env.R2_SCREEN_CHECK_BUCKET,
  };
}

export type PictureStoreResult =
  | { readonly stored: true; readonly key: string }
  | { readonly stored: false; readonly reason: string };

export interface StoreScreenCheckPictureOptions {
  /** Absolute or cwd-relative path to the screenshot file on disk. */
  readonly localPath: string;
  /** Keyed by run branch, then issue, then screen (Piece G: "a link is predictable, a whole run is one prefix"). */
  readonly key: string;
  readonly env?: PictureStoreEnv;
  /** Injectable for tests — production omits this and gets a real `S3Client`. */
  readonly clientFactory?: (env: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
  }) => PictureClient | null | Promise<PictureClient | null>;
}

/**
 * Every caller of `storeScreenCheckPicture` awaits it on a ticket's
 * critical path (`.sandcastle/main.mts`'s post-check upload step). Without
 * an explicit request timeout the underlying `S3Client` inherits the AWS
 * SDK's own unbounded default, so a wedged R2 endpoint would stall that
 * ticket for as long as the socket stays open — on an upload whose own
 * failure mode is ALREADY supposed to be non-fatal (`stored: false`, ship
 * anyway, raise the alarm). `requestHandler` accepts a plain
 * `NodeHttpHandlerOptions`-shaped object directly (no need to import or add
 * `@smithy/node-http-handler` as its own dependency — the SDK constructs
 * its default handler from these fields internally).
 */
export const R2_REQUEST_TIMEOUT_MS = 10_000;
export const R2_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * The real client, or `null` when `@aws-sdk/client-s3` is not installed.
 * `raw` exposes the underlying `S3Client` so `picture-store.test.ts` can
 * prove the timeout reaches its resolved config.
 */
export async function realClientFactory(env: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Promise<(PictureClient & { readonly raw: unknown }) | null> {
  type Sdk = {
    S3Client: new (cfg: unknown) => { send(cmd: unknown): Promise<unknown> };
    PutObjectCommand: new (input: PutPictureInput) => unknown;
  };
  let sdk: Sdk;
  try {
    sdk = (await import(S3_PACKAGE)) as Sdk;
  } catch {
    return null;
  }
  const raw = new sdk.S3Client({
    region: "auto",
    endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
    requestHandler: {
      requestTimeout: R2_REQUEST_TIMEOUT_MS,
      connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
    },
  });
  return {
    raw,
    send: (input) => raw.send(new sdk.PutObjectCommand(input)),
  };
}

/** Two attempts total, matching the design doc's "retry the upload twice" — one initial try plus one retry. */
const MAX_ATTEMPTS = 2;

/**
 * Upload the receipt picture at `opts.localPath` to the screen-check R2
 * bucket under `opts.key`, retrying once on failure. Returns `stored:
 * false` — never throws — when the four env vars are not all present, or
 * when both attempts fail; the caller (`.sandcastle/main.mts`) is
 * responsible for treating that as "picture not stored, ship anyway,
 * raise the alarm", per Piece G.
 */
export async function storeScreenCheckPicture(
  opts: StoreScreenCheckPictureOptions,
): Promise<PictureStoreResult> {
  const env = opts.env ?? pictureStoreEnvFromProcess();
  if (!env.accountId || !env.accessKeyId || !env.secretAccessKey || !env.bucket) {
    return {
      stored: false,
      reason:
        "r2-not-configured: R2_ACCOUNT_ID, R2_SCREEN_CHECK_ACCESS_KEY_ID, " +
        "R2_SCREEN_CHECK_SECRET_ACCESS_KEY and R2_SCREEN_CHECK_BUCKET are " +
        "not all set (expected unless R2 uploads are set up)",
    };
  }

  let body: Buffer;
  try {
    body = await readFile(opts.localPath);
  } catch (err) {
    return {
      stored: false,
      reason: `could not read screenshot at ${opts.localPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const makeClient = opts.clientFactory ?? realClientFactory;
  const client = await makeClient({
    accountId: env.accountId,
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
  });
  if (!client) {
    return { stored: false, reason: "sdk-not-installed: @aws-sdk/client-s3 is not installed" };
  }

  let lastReason = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await client.send(
        {
          Bucket: env.bucket,
          Key: opts.key,
          Body: body,
          ContentType: "image/png",
        },
      );
      return { stored: true, key: opts.key };
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    stored: false,
    reason: `upload-failed after ${MAX_ATTEMPTS} attempt(s): ${lastReason}`,
  };
}
