import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

const missingConfigPath = path.join(os.tmpdir(), `paperclip-migration-url-file-${process.pid}.json`);

function isolateConfigEnvironment() {
  vi.stubEnv("PAPERCLIP_CONFIG", missingConfigPath);
  vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
  vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
  vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "");
  vi.stubEnv("BETTER_AUTH_URL", "");
  vi.stubEnv("BETTER_AUTH_BASE_URL", "");
  vi.stubEnv("PAPERCLIP_AUTH_BASE_URL_MODE", "");
  vi.stubEnv("PAPERCLIP_ALLOWED_HOSTNAMES", "");
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_EXPOSURE", "private");
  vi.stubEnv("PAPERCLIP_BIND", "loopback");
  vi.stubEnv("HOST", "127.0.0.1");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("DATABASE_MIGRATION_URL", "");
  vi.stubEnv("DATABASE_URL_FILE", "");
  vi.stubEnv("DATABASE_MIGRATION_URL_FILE", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig DATABASE_MIGRATION_URL_FILE", () => {
  it("maps DATABASE_MIGRATION_URL_FILE onto config.databaseMigrationUrlFile", () => {
    isolateConfigEnvironment();
    vi.stubEnv(
      "DATABASE_MIGRATION_URL_FILE",
      "/paperclip/secrets/migration_url",
    );

    expect(loadConfig().databaseMigrationUrlFile).toBe(
      "/paperclip/secrets/migration_url",
    );
  });

  it("leaves databaseMigrationUrlFile undefined when the var is absent", () => {
    isolateConfigEnvironment();
    delete process.env.DATABASE_MIGRATION_URL_FILE;
    expect(loadConfig().databaseMigrationUrlFile).toBeUndefined();
  });

  it("throws when both DATABASE_MIGRATION_URL and DATABASE_MIGRATION_URL_FILE are set", () => {
    isolateConfigEnvironment();
    vi.stubEnv("DATABASE_MIGRATION_URL", "postgres://migrate:pw@db:5432/app");
    vi.stubEnv("DATABASE_MIGRATION_URL_FILE", "/paperclip/secrets/migration_url");
    expect(() => loadConfig()).toThrowError(
      /DATABASE_MIGRATION_URL and DATABASE_MIGRATION_URL_FILE are mutually exclusive/,
    );
  });

  it("does not throw when only DATABASE_MIGRATION_URL is set", () => {
    isolateConfigEnvironment();
    vi.stubEnv("DATABASE_MIGRATION_URL", "postgres://migrate:pw@db:5432/app");
    const cfg = loadConfig();
    expect(cfg.databaseMigrationUrlFile).toBeFalsy();
  });
});
