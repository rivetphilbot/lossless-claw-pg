import type { DatabaseSync } from "node:sqlite";
export declare function runLcmMigrations(db: DatabaseSync, options?: {
    fullTextAvailable?: boolean;
}): void;
