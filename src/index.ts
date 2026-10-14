// Bun only: SQLite through bun:sqlite, and `.env` loading from disk.
export { sqliteAdapter } from "./adapters/sqlite.js";
export { config } from "./core/config.js";
export * from "./portable.js";
