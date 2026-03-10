import type { AnyAgentTool as OpenClawAnyAgentTool } from "openclaw/plugin-sdk";
export type AnyAgentTool = OpenClawAnyAgentTool;
/** Render structured payloads as deterministic text tool results. */
export declare function jsonResult(payload: unknown): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: unknown;
};
/** Read a string param with optional trimming/required checks. */
export declare function readStringParam(params: Record<string, unknown>, key: string, options?: {
    required?: boolean;
    trim?: boolean;
    allowEmpty?: boolean;
    label?: string;
}): string | undefined;
