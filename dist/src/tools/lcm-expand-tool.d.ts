import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
/**
 * Build the runtime LCM expansion tool with route-vs-delegate orchestration.
 */
export declare function createLcmExpandTool(input: {
    deps: LcmDependencies;
    lcm: LcmContextEngine;
    /** Runtime session key (used for delegated expansion auth scoping). */
    sessionId?: string;
    sessionKey?: string;
}): AnyAgentTool;
