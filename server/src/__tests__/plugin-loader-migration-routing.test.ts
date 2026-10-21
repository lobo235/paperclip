/**
 * Plugin-loader migration routing: when a plugin declares a `database`, its DDL
 * migrations run on the migration connection chosen by the loader, not always
 * on the app pool.
 *
 * The two call sites (install tx, and the pre-worker `applyMigrations` in the
 * activate path) both funnel through `runOnMigrationDb(migrationDbProvider,
 * migrationDb, op)`. These tests exercise the real activate path end to end and
 * assert which client reaches `pluginDatabaseService`:
 *   - a file-backed `migrationDbProvider` present  → the provider's fresh client
 *     is used, and the long-lived migration pool is never used for the migration;
 *   - no provider (existing deploys)               → the migration pool is used,
 *     byte-for-byte the pre-change behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  list: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  delete: vi.fn(),
  install: vi.fn(),
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

// Records which client the loader hands to pluginDatabaseService, so the test
// can tell whether a provider client or the pool reached the migration call.
const mockDb = vi.hoisted(() => ({
  seen: [] as unknown[],
  applyMigrations: vi.fn(async (_pluginId: string, _manifest: unknown, _packageRoot: string) => ({
    namespaceName: "example_db_plugin",
  })),
}));
vi.mock("../services/plugin-database.js", () => ({
  pluginDatabaseService: (client: unknown) => {
    mockDb.seen.push(client);
    return { applyMigrations: mockDb.applyMigrations };
  },
}));

import { pluginLoader } from "../services/plugin-loader.js";
import type { PluginRuntimeServices } from "../services/plugin-loader.js";
import type { MigrationDbHandle } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

function makeDatabaseManifest(): PaperclipPluginManifestV1 {
  return {
    id: "example.db-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "DB Plugin",
    description: "Fixture",
    author: "Test",
    categories: ["automation"],
    capabilities: [
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
    ],
    entrypoints: { worker: "./dist/worker.js" },
    database: {
      namespaceSlug: "db_plugin",
      migrationsDir: "migrations",
      coreReadTables: [],
    },
  } as unknown as PaperclipPluginManifestV1;
}

function createPackage() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "plugin-mig-routing-")));
  const packageRoot = path.join(root, "example");
  mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  mkdirSync(path.join(packageRoot, "migrations"), { recursive: true });
  const manifest = makeDatabaseManifest();
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "example.db-plugin",
      version: "1.0.0",
      type: "module",
      paperclipPlugin: { manifest: "./manifest.js", worker: "./dist/worker.js" },
    }),
  );
  writeFileSync(
    path.join(packageRoot, "manifest.js"),
    `export default ${JSON.stringify(manifest)};\n`,
  );
  writeFileSync(path.join(packageRoot, "dist/worker.js"), "export default {};\n");
  return { root, packageRoot, manifest };
}

function createPluginRecord(packageRoot: string, manifest: PaperclipPluginManifestV1) {
  return {
    id: "plugin-db-1",
    pluginKey: "example.db-plugin",
    packageName: "example.db-plugin",
    packagePath: packageRoot,
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    status: "ready",
    lastError: null,
    installOrder: 1,
    manifestJson: manifest,
  };
}

function createRuntimeServices(): PluginRuntimeServices {
  return {
    lifecycleManager: {
      markError: vi.fn(async () => null),
      markReady: vi.fn(async () => null),
    },
    workerManager: {
      startWorker: vi.fn(async () => ({})),
      stopWorker: vi.fn(async () => {}),
    },
    eventBus: {
      subscribe: vi.fn(async () => () => {}),
      publish: vi.fn(async () => {}),
    },
    jobScheduler: { register: vi.fn(async () => {}), unregister: vi.fn(async () => {}) },
    jobStore: {},
    toolDispatcher: { register: vi.fn(), unregister: vi.fn() },
    buildHostHandlers: vi.fn(() => ({})),
    instanceInfo: { hostVersion: "0.0.0-test" },
  } as unknown as PluginRuntimeServices;
}

describe("pluginLoader migration routing (activate path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.seen.length = 0;
  });

  it("routes a database plugin's migrations through the file-backed provider, not the pool", async () => {
    const { root, packageRoot, manifest } = createPackage();
    try {
      const plugin = createPluginRecord(packageRoot, manifest);
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.update.mockResolvedValue(plugin);

      const pool = { __marker: "pool" } as unknown as Db;
      const provider = {
        runCalls: 0,
        run: async (op: (db: Db) => Promise<unknown>) => {
          provider.runCalls += 1;
          return op({ __marker: "provider-client" } as unknown as Db);
        },
      };

      const loader = pluginLoader(
        {} as Db,
        {
          localPluginDir: root,
          enableLocalFilesystem: false,
          enableNpmDiscovery: false,
          migrationDb: pool,
          migrationDbProvider: provider as MigrationDbHandle,
        },
        createRuntimeServices(),
      );

      // The migration (step 2) runs before worker startup; activation may still
      // report a worker error afterwards, which is irrelevant to the routing.
      await loader.loadSingle(plugin.id);

      expect(provider.runCalls).toBe(1);
      expect(mockDb.applyMigrations).toHaveBeenCalled();
      // The provider's fresh client reached the migration; the pool did not.
      expect(mockDb.seen).toHaveLength(1);
      expect(mockDb.seen[0]).toEqual({ __marker: "provider-client" });
      expect(mockDb.seen[0]).not.toBe(pool);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the migration pool (unchanged behavior) when no provider is configured", async () => {
    const { root, packageRoot, manifest } = createPackage();
    try {
      const plugin = createPluginRecord(packageRoot, manifest);
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.update.mockResolvedValue(plugin);

      const pool = { __marker: "pool" } as unknown as Db;

      const loader = pluginLoader(
        {} as Db,
        {
          localPluginDir: root,
          enableLocalFilesystem: false,
          enableNpmDiscovery: false,
          migrationDb: pool,
        },
        createRuntimeServices(),
      );

      await loader.loadSingle(plugin.id);

      expect(mockDb.applyMigrations).toHaveBeenCalled();
      // No provider → the migration pool is the client handed to the migration.
      expect(mockDb.seen).toHaveLength(1);
      expect(mockDb.seen[0]).toBe(pool);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
