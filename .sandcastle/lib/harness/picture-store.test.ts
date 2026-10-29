import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  R2_CONNECTION_TIMEOUT_MS,
  R2_REQUEST_TIMEOUT_MS,
  realClientFactory,
  storeScreenCheckPicture,
} from "./picture-store.js";

let dir: string;
let picturePath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "screen-check-picture-"));
  picturePath = path.join(dir, "receipt.png");
  await writeFile(picturePath, Buffer.from("fake-png-bytes"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("storeScreenCheckPicture", () => {
  it("reports not-configured, without attempting a client, when env vars are absent — the exact 'Mac whose key was never installed' case", async () => {
    const result = await storeScreenCheckPicture({
      localPath: picturePath,
      key: "run/issue-912/finance-reports.png",
      env: {
        accountId: undefined,
        accessKeyId: undefined,
        secretAccessKey: undefined,
        bucket: undefined,
      },
    });
    expect(result.stored).toBe(false);
    if (!result.stored) expect(result.reason).toContain("r2-not-configured");
  });

  it("reports not-configured when only SOME env vars are present", async () => {
    const result = await storeScreenCheckPicture({
      localPath: picturePath,
      key: "k",
      env: {
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: undefined,
        bucket: "bucket",
      },
    });
    expect(result.stored).toBe(false);
  });

  it("stores on the first attempt when the client succeeds", async () => {
    let calls = 0;
    const result = await storeScreenCheckPicture({
      localPath: picturePath,
      key: "run/issue-912/finance-reports.png",
      env: {
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "bucket",
      },
      clientFactory: () => ({
        send: async () => {
          calls += 1;
          return {};
        },
      }),
    });
    expect(result).toEqual({
      stored: true,
      key: "run/issue-912/finance-reports.png",
    });
    expect(calls).toBe(1);
  });

  it("retries exactly once on failure, then succeeds if the retry works", async () => {
    let calls = 0;
    const result = await storeScreenCheckPicture({
      localPath: picturePath,
      key: "k",
      env: {
        accountId: "a",
        accessKeyId: "b",
        secretAccessKey: "c",
        bucket: "d",
      },
      clientFactory: () => ({
        send: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient 503");
          return {};
        },
      }),
    });
    expect(result.stored).toBe(true);
    expect(calls).toBe(2);
  });

  it("gives up after two failed attempts — never a third — and reports upload-failed", async () => {
    let calls = 0;
    const result = await storeScreenCheckPicture({
      localPath: picturePath,
      key: "k",
      env: {
        accountId: "a",
        accessKeyId: "b",
        secretAccessKey: "c",
        bucket: "d",
      },
      clientFactory: () => ({
        send: async () => {
          calls += 1;
          throw new Error("bucket locked");
        },
      }),
    });
    expect(calls).toBe(2);
    expect(result.stored).toBe(false);
    if (!result.stored) {
      expect(result.reason).toContain("upload-failed after 2 attempt(s)");
      expect(result.reason).toContain("bucket locked");
    }
  });

  it("reports a read failure without throwing when the local screenshot is missing", async () => {
    const result = await storeScreenCheckPicture({
      localPath: path.join(dir, "does-not-exist.png"),
      key: "k",
      env: { accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" },
    });
    expect(result.stored).toBe(false);
    if (!result.stored) expect(result.reason).toContain("could not read screenshot");
  });
});

const sdkInstalled = await import("@aws-sdk/client-s3" as string).then(
  () => true,
  () => false,
);

describe("storeScreenCheckPicture without the optional SDK", () => {
  it("skips the upload with stored:false when the client factory finds no SDK", async () => {
    const result = await storeScreenCheckPicture({
      localPath: picturePath,
      key: "k",
      env: { accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" },
      clientFactory: () => null,
    });
    expect(result.stored).toBe(false);
    if (!result.stored) expect(result.reason).toContain("sdk-not-installed");
  });
});

describe.skipIf(!sdkInstalled)("realClientFactory (the un-injected, production path)", () => {
  it("actually configures the S3 client with a bounded request/connection timeout — not the SDK's unbounded default", async () => {
    const client = await realClientFactory({
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
    // `S3Client`'s `requestHandler` resolves its normalized config
    // lazily (only inside `.handle()`, i.e. on a real request) — its own
    // `httpHandlerConfigs()` returns `{}` until then. `configProvider` is
    // the same promise `.handle()` awaits, so reading it directly proves
    // what a real request would actually use WITHOUT making one.
    const requestHandler = (
      client!.raw as unknown as {
        config: { requestHandler: { configProvider: Promise<Record<string, unknown>> } };
      }
    ).config.requestHandler;
    const resolved = await requestHandler.configProvider;
    expect(resolved.requestTimeout).toBe(R2_REQUEST_TIMEOUT_MS);
    expect(resolved.connectionTimeout).toBe(R2_CONNECTION_TIMEOUT_MS);
  });
});
