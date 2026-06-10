import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHttpRequestHandler, isLegacyTokenAuthorized } from "./http";
import type { ServerAuthShape } from "./auth/Services/ServerAuth";
import { deriveServerPaths, type ServerConfigShape } from "./config";
import type { ProjectFaviconResolverShape } from "./project/Services/ProjectFaviconResolver";
import type { ServerReadiness } from "./server/readiness";
import { _resetCacheForTests } from "./staticAssetCache";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const readiness: ServerReadiness = {
  awaitServerReady: Effect.void,
  markHttpListening: Effect.void,
  markPushBusReady: Effect.void,
  markKeybindingsReady: Effect.void,
  markTerminalSubscriptionsReady: Effect.void,
  markOrchestrationSubscriptionsReady: Effect.void,
  getSnapshot: Effect.succeed({
    httpListening: true,
    pushBusReady: true,
    keybindingsReady: true,
    terminalSubscriptionsReady: false,
    orchestrationSubscriptionsReady: false,
    startupReady: false,
  }),
};

const projectFaviconResolver: ProjectFaviconResolverShape = {
  resolvePath: () => Effect.succeed(null),
};

async function makeConfig(overrides: Partial<ServerConfigShape> = {}): Promise<ServerConfigShape> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-http-test-"));
  tempDirs.push(baseDir);
  const derivedPaths = await Effect.runPromise(
    deriveServerPaths(baseDir, undefined).pipe(Effect.provide(NodeServices.layer)),
  );
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: baseDir,
    homeDir: os.homedir(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  };
}

async function makeHandler(
  config: ServerConfigShape,
  auth?: {
    readonly serverAuth: ServerAuthShape;
    readonly cookieName: string;
  },
): Promise<http.RequestListener> {
  const services = await Effect.runPromise(
    Effect.gen(function* () {
      return {
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
      };
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  return createHttpRequestHandler({
    serverConfig: config,
    readiness,
    fileSystem: services.fileSystem,
    projectFaviconResolver,
    path: services.path,
    ...(auth
      ? {
          serverAuth: auth.serverAuth,
          sessionCredentials: { cookieName: auth.cookieName },
        }
      : {}),
  });
}

function makeAuthDescriptor() {
  return {
    policy: "loopback-browser" as const,
    bootstrapMethods: ["one-time-token" as const],
    sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
    sessionCookieName: "t3_session",
  };
}

function makeFakeServerAuth(overrides: Partial<ServerAuthShape> = {}): ServerAuthShape {
  const expiresAt = Effect.runSync(DateTime.now);
  const descriptor = makeAuthDescriptor();
  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState: () =>
      Effect.succeed({
        authenticated: false,
        auth: descriptor,
      }),
    exchangeBootstrapCredential: () =>
      Effect.succeed({
        response: {
          authenticated: true,
          role: "client",
          sessionMethod: "browser-session-cookie",
          expiresAt,
        },
        sessionToken: "session-token",
      }),
    exchangeBootstrapCredentialForBearerSession: () =>
      Effect.succeed({
        authenticated: true,
        role: "client",
        sessionMethod: "bearer-session-token",
        expiresAt,
        sessionToken: "bearer-session-token",
      }),
    issuePairingCredential: () =>
      Effect.succeed({ id: "pairing-id", credential: "PAIRINGTOKEN", expiresAt }),
    listPairingLinks: () => Effect.succeed([]),
    revokePairingLink: () => Effect.succeed(true),
    listClientSessions: () => Effect.succeed([]),
    revokeClientSession: () => Effect.succeed(true),
    revokeOtherClientSessions: () => Effect.succeed(1),
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: "session-id" as never,
        subject: "owner",
        method: "browser-session-cookie",
        role: "owner",
        expiresAt,
      }),
    authenticateWebSocketUpgrade: () =>
      Effect.succeed({
        sessionId: "session-id" as never,
        subject: "owner",
        method: "browser-session-cookie",
        role: "owner",
        expiresAt,
      }),
    issueWebSocketToken: () => Effect.succeed({ token: "ws-token", expiresAt }),
    issueStartupPairingUrl: () => Effect.succeed("http://127.0.0.1:3773/pair#token=PAIRINGTOKEN"),
    ...overrides,
  } satisfies ServerAuthShape;
}

async function withServer<T>(
  handler: http.RequestListener,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) {
    throw new Error("Expected TCP server address");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("createHttpRequestHandler", () => {
  it("recognizes the desktop startup token for legacy attachment requests", async () => {
    const config = await makeConfig({ authToken: "desktop-secret" });

    expect(
      isLegacyTokenAuthorized({
        config,
        url: new URL("http://127.0.0.1:3773/attachments/attachment-id?token=desktop-secret"),
      }),
    ).toBe(true);
    expect(
      isLegacyTokenAuthorized({
        config,
        url: new URL("http://127.0.0.1:3773/attachments/attachment-id?token=wrong"),
      }),
    ).toBe(false);
  });

  it("serves health readiness JSON", async () => {
    const config = await makeConfig();
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/health`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toMatchObject({
        status: "ok",
        startupReady: false,
        pushBusReady: true,
      });
    });
  });

  it("preserves dev URL redirect behavior", async () => {
    const config = await makeConfig({ devUrl: new URL("http://localhost:5173/") });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/anything`, { redirect: "manual" });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("http://localhost:5173/");
    });
  });

  it("serves static files and SPA fallback", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-static-test-"));
    tempDirs.push(staticDir);
    fs.writeFileSync(path.join(staticDir, "index.html"), "<main>app</main>");
    fs.writeFileSync(path.join(staticDir, "asset.txt"), "asset");
    const config = await makeConfig({ staticDir });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const indexResponse = await fetch(`${origin}/missing-route`);
      expect(indexResponse.status).toBe(200);
      await expect(indexResponse.text()).resolves.toBe("<main>app</main>");

      const assetResponse = await fetch(`${origin}/asset.txt`);
      expect(assetResponse.status).toBe(200);
      await expect(assetResponse.text()).resolves.toBe("asset");
    });
  });

  it("serves attachments by id with immutable cache headers", async () => {
    const config = await makeConfig();
    fs.mkdirSync(config.attachmentsDir, { recursive: true });
    fs.writeFileSync(path.join(config.attachmentsDir, "attachment-id.bin"), "payload");
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/attachments/attachment-id`);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      await expect(response.text()).resolves.toBe("payload");
    });
  });

  it("serves auth session state before dev/static fallback", async () => {
    const config = await makeConfig({ devUrl: new URL("http://localhost:5173/") });
    const handler = await makeHandler(config, {
      serverAuth: makeFakeServerAuth(),
      cookieName: "t3_session",
    });

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/api/auth/session`, { redirect: "manual" });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toMatchObject({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
        },
      });
    });
  });

  it("sets a session cookie on auth bootstrap", async () => {
    const config = await makeConfig();
    const handler = await makeHandler(config, {
      serverAuth: makeFakeServerAuth(),
      cookieName: "t3_session",
    });

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("t3_session=session-token");
      await expect(response.json()).resolves.toMatchObject({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Cache headers, compression, and ETag tests
// ---------------------------------------------------------------------------

describe("serveStaticAsset — cache headers + compression", () => {
  beforeEach(() => {
    _resetCacheForTests();
  });

  it("serves hashed assets under assets/ with immutable Cache-Control", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-static-cache-test-"));
    tempDirs.push(staticDir);
    fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(staticDir, "assets", "index-DGfPhPk3.js"), "console.log(1)");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<main>app</main>");
    const config = await makeConfig({ staticDir });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/assets/index-DGfPhPk3.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    });
  });

  it("serves index.html with no-cache Cache-Control and an ETag", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-static-etag-test-"));
    tempDirs.push(staticDir);
    fs.writeFileSync(path.join(staticDir, "index.html"), "<main>etag-test</main>");
    const config = await makeConfig({ staticDir });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("etag")).toBeTruthy();
    });
  });

  it("responds 304 when If-None-Match matches the ETag of index.html", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-static-304-test-"));
    tempDirs.push(staticDir);
    fs.writeFileSync(path.join(staticDir, "index.html"), "<main>conditional</main>");
    const config = await makeConfig({ staticDir });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      // First request: get the ETag.
      const first = await fetch(`${origin}/`);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      // Second request with matching If-None-Match: should be 304.
      const second = await fetch(`${origin}/`, {
        headers: { "If-None-Match": etag! },
      });
      expect(second.status).toBe(304);
    });
  });

  it("compresses hashed JS assets with brotli when Accept-Encoding includes br", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-static-br-test-"));
    tempDirs.push(staticDir);
    fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    const jsContent = "const x = 'hello world, compressible content';";
    fs.writeFileSync(path.join(staticDir, "assets", "app-AbCd1234.js"), jsContent);
    fs.writeFileSync(path.join(staticDir, "index.html"), "<main>app</main>");
    const config = await makeConfig({ staticDir });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      // Use raw Node http.get to avoid automatic decompression by undici/fetch.
      const { statusCode, headers, body } = await rawGet(origin, "/assets/app-AbCd1234.js", {
        "Accept-Encoding": "br, gzip, deflate",
      });
      expect(statusCode).toBe(200);
      expect(headers["content-encoding"]).toBe("br");
      expect(headers["vary"]).toContain("Accept-Encoding");
      const decompressed = zlib.brotliDecompressSync(body).toString();
      expect(decompressed).toBe(jsContent);
    });
  });

  it("falls back to gzip when Accept-Encoding does not include br", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-static-gz-test-"));
    tempDirs.push(staticDir);
    fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    const jsContent = "const y = 'gzip fallback content';";
    fs.writeFileSync(path.join(staticDir, "assets", "chunk-XyZ98765.js"), jsContent);
    fs.writeFileSync(path.join(staticDir, "index.html"), "<main>app</main>");
    const config = await makeConfig({ staticDir });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const { statusCode, headers, body } = await rawGet(origin, "/assets/chunk-XyZ98765.js", {
        "Accept-Encoding": "gzip, deflate",
      });
      expect(statusCode).toBe(200);
      expect(headers["content-encoding"]).toBe("gzip");
      const decompressed = zlib.gunzipSync(body).toString();
      expect(decompressed).toBe(jsContent);
    });
  });

  it("returns identity encoding when Accept-Encoding is absent", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-static-identity-test-"));
    tempDirs.push(staticDir);
    fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    const jsContent = "const z = 'no encoding';";
    fs.writeFileSync(path.join(staticDir, "assets", "plain-000.js"), jsContent);
    fs.writeFileSync(path.join(staticDir, "index.html"), "<main>app</main>");
    const config = await makeConfig({ staticDir });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      // No Accept-Encoding header → identity (uncompressed) response.
      const { statusCode, headers, body } = await rawGet(origin, "/assets/plain-000.js", {});
      expect(statusCode).toBe(200);
      expect(headers["content-encoding"]).toBeUndefined();
      expect(body.toString()).toBe(jsContent);
    });
  });
});

// ---------------------------------------------------------------------------
// Low-level helper: raw HTTP GET without automatic decompression
// ---------------------------------------------------------------------------

function rawGet(
  origin: string,
  urlPath: string,
  reqHeaders: Record<string, string>,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, origin);
    const req = http.get(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, headers: reqHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}
