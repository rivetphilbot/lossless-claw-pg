export type FileBlock = {
    fullMatch: string;
    start: number;
    end: number;
    attributes: Record<string, string>;
    fileName?: string;
    mimeType?: string;
    text: string;
};
export type ExplorationSummaryInput = {
    content: string;
    fileName?: string;
    mimeType?: string;
    summarizeText?: (prompt: string) => Promise<string | null | undefined>;
};
export declare function exploreStructuredData(content: string, mimeType?: string, fileName?: string): string;
export declare function exploreCode(content: string, fileName?: string): string;
export declare function parseFileBlocks(content: string): FileBlock[];
export declare function extensionFromNameOrMime(fileName?: string, mimeType?: string): string;
export declare function extractFileIdsFromContent(content: string): string[];
export declare function formatFileReference(input: {
    fileId: string;
    fileName?: string;
    mimeType?: string;
    byteSize: number;
    summary: string;
}): string;
export declare function generateExplorationSummary(input: ExplorationSummaryInput): Promise<string>;
