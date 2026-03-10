import { DatabaseSync } from "node:sqlite";
import type { DbClient } from "./db-interface.js";
import type { LcmConfig } from "./config.js";
export declare function createLcmConnection(config: LcmConfig): DbClient;
export declare function closeLcmConnection(key?: string): Promise<void>;
export declare function getLcmConnection(dbPath: string): DatabaseSync;
