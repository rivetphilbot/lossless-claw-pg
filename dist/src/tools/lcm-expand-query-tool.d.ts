import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import { type AnyAgentTool } from "./common.js";
export declare function createLcmExpandQueryTool(input: {
    deps: LcmDependencies;
    lcm: LcmContextEngine;
    /** Session id used for LCM conversation scoping. */
    sessionId?: string;
    /** Requester agent session key used for delegated child session/auth scoping. */
    requesterSessionKey?: string;
    /** Session key for scope fallback when sessionId is unavailable. */
    sessionKey?: string;
}): AnyAgentTool;
