/**
 * db.ts - Cross-runtime SQLite compatibility layer
 *
 * Provides a unified Database export that works under both Bun (bun:sqlite)
 * and Node.js (better-sqlite3). The APIs are nearly identical — the main
 * difference is the import path.
 */

import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const isBun = typeof globalThis.Bun !== "undefined";

let _Database: any;
let _sqliteVecLoad: (db: any) => void;

const loadedSimpleDbs = new WeakSet<object>();
const initializedJiebaDbs = new WeakSet<object>();

type SimplePlatformConfig = {
  folder: string;
  library: string;
};

function getSimplePlatformConfig(): SimplePlatformConfig {
  const platform = `${process.platform}/${process.arch}`;
  switch (platform) {
    case "linux/x64":
      return {
        folder: "libsimple-linux-ubuntu-latest",
        library: "libsimple.so",
      };
    case "darwin/x64":
      return {
        folder: "libsimple-osx-x64",
        library: "libsimple.dylib",
      };
    case "darwin/arm64":
      return {
        folder: "libsimple-osx-arm64",
        library: "libsimple.dylib",
      };
    case "win32/x64":
      return {
        folder: "libsimple-windows-x64",
        library: "simple.dll",
      };
    default:
      throw new Error(
        `simple extension is not bundled for platform ${platform}. ` +
        "Supported platforms: linux/x64, darwin/x64, darwin/arm64, win32/x64."
      );
  }
}

export function getSimpleExtensionPaths(): { libraryPath: string; dictPath: string } {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const vendorDir = resolvePath(moduleDir, "../vendor");
  const { folder, library } = getSimplePlatformConfig();
  const baseDir = resolvePath(vendorDir, folder);
  const libraryPath = resolvePath(baseDir, library);
  const dictPath = resolvePath(baseDir, "dict");

  if (!existsSync(libraryPath)) {
    throw new Error(
      `Bundled simple extension not found at ${libraryPath}. ` +
      "Make sure the vendor directory is included in the installed package."
    );
  }

  if (!existsSync(dictPath)) {
    throw new Error(
      `Bundled jieba dictionary directory not found at ${dictPath}. ` +
      "Make sure the vendor directory is included in the installed package."
    );
  }

  return { libraryPath, dictPath };
}

if (isBun) {
  // Dynamic string prevents tsc from resolving bun:sqlite on Node.js builds
  const bunSqlite = "bun:" + "sqlite";
  _Database = (await import(/* @vite-ignore */ bunSqlite)).Database;
  const { getLoadablePath } = await import("sqlite-vec");
  _sqliteVecLoad = (db: any) => db.loadExtension(getLoadablePath());
} else {
  _Database = (await import("better-sqlite3")).default;
  const sqliteVec = await import("sqlite-vec");
  _sqliteVecLoad = (db: any) => sqliteVec.load(db);
}

/**
 * Open a SQLite database. Works with both bun:sqlite and better-sqlite3.
 */
export function openDatabase(path: string): Database {
  return new _Database(path) as Database;
}

/**
 * Common subset of the Database interface used throughout QMD.
 */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  loadExtension(path: string): void;
  close(): void;
}

export interface Statement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/**
 * Load the sqlite-vec extension into a database.
 */
export function loadSqliteVec(db: Database): void {
  _sqliteVecLoad(db);
}

export function loadSimpleExtension(db: Database): void {
  const dbKey = db as unknown as object;
  if (loadedSimpleDbs.has(dbKey)) return;

  const { libraryPath } = getSimpleExtensionPaths();
  try {
    db.loadExtension(libraryPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`simple extension failed to load from ${libraryPath}: ${message}`);
  }

  loadedSimpleDbs.add(dbKey);
}

export function ensureJiebaInitialized(db: Database): void {
  const dbKey = db as unknown as object;
  if (initializedJiebaDbs.has(dbKey)) return;

  loadSimpleExtension(db);
  const { dictPath } = getSimpleExtensionPaths();

  try {
    db.prepare(`SELECT jieba_dict(?)`).get(dictPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`jieba_dict() failed for ${dictPath}: ${message}`);
  }

  initializedJiebaDbs.add(dbKey);
}
