import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
export declare function createLcmGrepTool(input: {
    deps: LcmDependencies;
    lcm: LcmContextEngine;
    sessionId?: string;
    sessionKey?: string;
}): AnyAgentTool;
