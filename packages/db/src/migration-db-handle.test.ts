import { describe, expect, it } from "vitest";
import { createFileMigrationDbHandle, runOnMigrationDb, type Db } from "./client.js";

function fakeDb(mark: string): Db {
  return { mark } as unknown as Db;
}

/** Extracts the "user:pass" host-prefix portion of a postgres:// URL. */
function markOf(url: string): string {
  return url.replace("postgres://", "").split("@")[0];
}

describe("createFileMigrationDbHandle", () => {
  it("re-reads the credential on every run and uses a fresh client each time", async () => {
    const urls = [
      "postgres://migrator-a:pa-a@postgres.host:5432/db",
      "postgres://migrator-b:pa-b@postgres.host:5432/db",
    ];
    let reads = 0;
    const created: string[] = [];
    const ended: string[] = [];

    const handle = createFileMigrationDbHandle({
      readUrl: async () => urls[reads++],
      createClient: (url) => {
        const mark = markOf(url);
        created.push(mark);
        return fakeDb(mark);
      },
      endClient: async (db, _timeout) => {
        ended.push((db as unknown as { mark: string }).mark);
      },
    });

    const first = await handle.run(async (db) => (db as unknown as { mark: string }).mark);
    expect(first).toBe("migrator-a:pa-a");
    expect(created).toEqual(["migrator-a:pa-a"]);
    expect(ended).toEqual(["migrator-a:pa-a"]);

    // A re-minted credential (fresh unique username) is picked up on the next
    // run; the prior connection is never reused.
    const second = await handle.run(async (db) => (db as unknown as { mark: string }).mark);
    expect(second).toBe("migrator-b:pa-b");
    expect(created).toEqual(["migrator-a:pa-a", "migrator-b:pa-b"]);
    expect(ended).toEqual(["migrator-a:pa-a", "migrator-b:pa-b"]);
    expect(reads).toBe(2);
  });

  it("closes the client even when the operation throws", async () => {
    let closed = false;
    const handle = createFileMigrationDbHandle({
      readUrl: async () => "postgres://u:p@postgres.host:5432/db",
      createClient: () => fakeDb("u:p"),
      endClient: async () => {
        closed = true;
      },
    });

    await expect(handle.run(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(closed).toBe(true);
  });

  it("trims the credential URL before connecting", async () => {
    let seen = "";
    const handle = createFileMigrationDbHandle({
      readUrl: async () => "  postgres://u:p@postgres.host:5432/db  \n",
      createClient: (url) => {
        seen = url;
        return fakeDb("u:p");
      },
      endClient: async () => {},
    });

    await handle.run(async () => "ok");
    expect(seen).toBe("postgres://u:p@postgres.host:5432/db");
  });
});

describe("runOnMigrationDb", () => {
  it("routes through the file-backed provider when one is present", async () => {
    const seen: string[] = [];
    const provider = createFileMigrationDbHandle({
      readUrl: async () => "postgres://file-user:pw@postgres.host:5432/db",
      createClient: (url) => fakeDb(markOf(url)),
      endClient: async (db, _t) => {
        seen.push((db as unknown as { mark: string }).mark);
      },
    });
    const shared = fakeDb("shared-app-pool");

    const result = await runOnMigrationDb(provider, shared, async (db) =>
      (db as unknown as { mark: string }).mark,
    );
    expect(result).toBe("file-user:pw");
    expect(seen).toEqual(["file-user:pw"]);
  });

  it("falls back to the shared app pool (no close) when there is no provider", async () => {
    const shared = fakeDb("shared-app-pool");
    const result = await runOnMigrationDb(undefined, shared, async (db) =>
      (db as unknown as { mark: string }).mark,
    );
    expect(result).toBe("shared-app-pool");
  });
});
