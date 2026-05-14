/**
 * Migrations track barrel — re-exports the drizzle migration auto-applier
 * surface. Track C imports from here; nothing else should reach into the
 * leaf module directly.
 */

export {
  applyMigrationsBetween,
  classifyPsqlErrors,
  isDrizzleMigrationPath,
  listMigrationsOnDisk,
  splitSqlStatements,
  validateJournalRegistration,
  BENIGN_ALREADY_EXISTS_REGEX,
} from "./drizzle-applier.js";

export type {
  ApplyMigrationsOptions,
  ApplyMigrationsResult,
  ExecRunner,
  MigrationRealError,
  UnregisteredMigration,
} from "./drizzle-applier.js";
