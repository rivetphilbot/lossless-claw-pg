#!/usr/bin/env tsx

import { createLcmConnection } from "../src/db/connection.js";
import type { LcmConfig } from "../src/db/config.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { SqliteClient } from "../src/db/sqlite-client.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

async function testSqlite() {
  console.log("Testing SQLite backend...");

  const config: LcmConfig = {
    enabled: true,
    databasePath: ":memory:",
    backend: "sqlite",
    contextThreshold: 0.75,
    freshTailCount: 32,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20000,
    leafTargetTokens: 1200,
    condensedTargetTokens: 2000,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25000,
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    autocompactDisabled: false,
    timezone: "UTC",
    pruneHeartbeatOk: false,
  };

  const db = createLcmConnection(config);
  if (db instanceof SqliteClient) {
    runLcmMigrations(db.getUnderlyingDatabase(), { fullTextAvailable: true });
  }
  const convStore = new ConversationStore(db, { fullTextAvailable: true, backend: "sqlite" });
  const summStore = new SummaryStore(db, { fullTextAvailable: true, backend: "sqlite" });

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => Promise<void>) {
    return async () => {
      try {
        await fn();
        console.log(`✅ ${name}`);
        passed++;
      } catch (error) {
        console.log(`❌ ${name}: ${error instanceof Error ? error.message : error}`);
        failed++;
      }
    };
  }

  const tests = [
    test("Create conversation", async () => {
      const conv = await convStore.createConversation({ sessionId: "test-session", title: "Test Conversation" });
      if (conv.sessionId !== "test-session" || conv.title !== "Test Conversation") {
        throw new Error("Conversation creation failed");
      }
    }),

    test("Create messages", async () => {
      const conv = await convStore.getOrCreateConversation("test-session");
      const msg1 = await convStore.createMessage({
        conversationId: conv.conversationId,
        seq: 1,
        role: "user",
        content: "Hello world",
        tokenCount: 2,
      });
      const msg2 = await convStore.createMessage({
        conversationId: conv.conversationId,
        seq: 2,
        role: "assistant",
        content: "Hello back",
        tokenCount: 2,
      });
      await summStore.appendContextMessage(conv.conversationId, msg1.messageId);
      await summStore.appendContextMessage(conv.conversationId, msg2.messageId);
    }),

    test("Get messages", async () => {
      const conv = await convStore.getConversationBySessionId("test-session");
      if (!conv) throw new Error("Conversation not found");
      const messages = await convStore.getMessages(conv.conversationId);
      if (messages.length !== 2) throw new Error(`Expected 2 messages, got ${messages.length}`);
    }),

    test("Full-text search messages", async () => {
      const results = await convStore.searchMessages({
        query: "Hello",
        mode: "full_text",
        limit: 10,
      });
      if (results.length < 1) throw new Error("No search results");
    }),

    test("Regex search messages", async () => {
      const results = await convStore.searchMessages({
        query: "world",
        mode: "regex",
        limit: 10,
      });
      if (results.length < 1) throw new Error("No regex search results");
    }),

    test("Create summary", async () => {
      const conv = await convStore.getConversationBySessionId("test-session");
      if (!conv) throw new Error("Conversation not found");
      const summary = await summStore.insertSummary({
        summaryId: "test-summary-1",
        conversationId: conv.conversationId,
        kind: "leaf",
        content: "A test summary",
        tokenCount: 3,
      });
      if (summary.summaryId !== "test-summary-1") throw new Error("Summary creation failed");
    }),

    test("Get summary", async () => {
      const summary = await summStore.getSummary("test-summary-1");
      if (!summary || summary.content !== "A test summary") throw new Error("Summary retrieval failed");
    }),

    test("Search summaries", async () => {
      const results = await summStore.searchSummaries({
        query: "test",
        mode: "full_text",
        limit: 10,
      });
      if (results.length < 1) throw new Error("No summary search results");
    }),

    test("Append context summary", async () => {
      const conv = await convStore.getConversationBySessionId("test-session");
      if (!conv) throw new Error("Conversation not found");
      await summStore.appendContextSummary(conv.conversationId, "test-summary-1");
    }),

    test("Get context items", async () => {
      const conv = await convStore.getConversationBySessionId("test-session");
      if (!conv) throw new Error("Conversation not found");
      const items = await summStore.getContextItems(conv.conversationId);
      if (items.length < 3) throw new Error(`Expected at least 3 context items, got ${items.length}`);
    }),

    test("Create large file", async () => {
      const conv = await convStore.getConversationBySessionId("test-session");
      if (!conv) throw new Error("Conversation not found");
      const file = await summStore.insertLargeFile({
        fileId: "test-file-1",
        conversationId: conv.conversationId,
        fileName: "test.txt",
        mimeType: "text/plain",
        byteSize: 100,
        storageUri: "/tmp/test.txt",
        explorationSummary: "A test file",
      });
      if (file.fileId !== "test-file-1") throw new Error("Large file creation failed");
    }),

    test("Get large files", async () => {
      const conv = await convStore.getConversationBySessionId("test-session");
      if (!conv) throw new Error("Conversation not found");
      const files = await summStore.getLargeFilesByConversation(conv.conversationId);
      if (files.length !== 1) throw new Error(`Expected 1 large file, got ${files.length}`);
    }),
  ];

  for (const t of tests) {
    await t();
  }

  await db.close();

  console.log(`\nTest results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

testSqlite().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});