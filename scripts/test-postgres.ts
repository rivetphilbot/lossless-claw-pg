#!/usr/bin/env tsx
/**
 * Test script to verify PostgreSQL adapter functionality
 */

import type { LcmConfig } from "../src/db/config.js";
import { createLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const TEST_CONNECTION_STRING = "postgres://lcm_phil:lcm_phil_2026@10.4.20.16:5432/phil_memory";

async function main() {
  console.log("🧪 Testing PostgreSQL LCM adapter...");
  
  const config: LcmConfig = {
    enabled: true,
    databasePath: "", // Not used for Postgres
    connectionString: TEST_CONNECTION_STRING,
    backend: 'postgres',
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
    timezone: "America/New_York",
    pruneHeartbeatOk: false,
  };

  console.log("📊 Config:", {
    backend: config.backend,
    connectionString: config.connectionString?.replace(/:[^:@]*@/, ":***@"),
  });

  try {
    // Test connection creation
    console.log("🔌 Creating database connection...");
    const db = createLcmConnection(config);
    console.log("✅ Database connection created");

    // Test feature detection
    console.log("🔍 Detecting database features...");
    const features = getLcmDbFeatures(config);
    console.log("✅ Features detected:", features);

    // Test basic query
    console.log("🔍 Testing basic query...");
    const result = await db.query("SELECT 1 as test_value");
    console.log("✅ Basic query successful:", result.rows);

    // Test conversation store
    console.log("🗃️ Testing ConversationStore...");
    const conversationStore = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    // Test basic conversation operations
    console.log("📝 Testing conversation creation...");
    const testSession = `test_session_${Date.now()}`;
    const conversation = await conversationStore.getOrCreateConversation(testSession, "Test Conversation");
    console.log("✅ Conversation created:", {
      id: conversation.conversationId,
      sessionId: conversation.sessionId,
      title: conversation.title,
    });

    // Test message creation
    console.log("💬 Testing message creation...");
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "Hello, this is a test message for PostgreSQL adapter!",
      tokenCount: 12,
    });
    console.log("✅ Message created:", {
      id: message.messageId,
      role: message.role,
      content: message.content.substring(0, 50) + "...",
    });

    // Test message retrieval
    console.log("📖 Testing message retrieval...");
    const messages = await conversationStore.getMessages(conversation.conversationId);
    console.log("✅ Messages retrieved:", messages.length);

    // Test full-text search
    if (features.fullTextAvailable) {
      console.log("🔍 Testing full-text search...");
      const searchResults = await conversationStore.searchMessages({
        query: "test",
        mode: "full_text",
        limit: 10,
      });
      console.log("✅ Search completed:", searchResults.length, "results");
    } else {
      console.log("⚠️ FTS not available, skipping search test");
    }

    // Test summary store
    console.log("📋 Testing SummaryStore...");
    const summaryStore = new SummaryStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    // Test basic summary operations - creating a simple test summary
    console.log("📝 Testing summary creation...");
    const summary = await summaryStore.insertSummary({
      summaryId: `test_summary_${Date.now()}`,
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "This is a test summary for the PostgreSQL adapter.",
      tokenCount: 10,
    });
    console.log("✅ Summary created:", {
      id: summary.summaryId,
      kind: summary.kind,
      content: summary.content.substring(0, 50) + "...",
    });

    // Close connection
    console.log("🔌 Closing database connection...");
    await db.close();
    console.log("✅ Connection closed");

    console.log("🎉 All tests completed successfully!");
    console.log("");
    console.log("✅ PostgreSQL adapter is working correctly");
    console.log(`   Backend: ${features.backend}`);
    console.log(`   FTS Available: ${features.fullTextAvailable}`);
    console.log(`   Connection: ${config.connectionString?.replace(/:[^:@]*@/, ":***@")}`);

  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

main().catch((error) => {
  console.error("❌ Script failed:", error);
  process.exit(1);
});