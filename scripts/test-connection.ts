#!/usr/bin/env tsx
/**
 * Simple connection test for PostgreSQL adapter
 */

import { createLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import type { LcmConfig } from "../src/db/config.js";

const TEST_CONNECTION_STRING = "postgres://lcm_phil:lcm_phil_2026@10.4.20.16:5432/phil_memory";

async function testConnection() {
  console.log("🧪 Testing PostgreSQL connection...");
  
  const config: LcmConfig = {
    enabled: true,
    databasePath: "",
    connectionString: TEST_CONNECTION_STRING,
    backend: 'postgres' as const,
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

  try {
    console.log("🔌 Creating PostgreSQL connection...");
    const db = createLcmConnection(config);
    
    console.log("🔍 Testing basic query...");
    const result = await db.query("SELECT 1 as test_value, NOW() as current_time");
    console.log("✅ Query result:", result.rows[0]);
    
    console.log("📊 Testing feature detection...");
    const features = getLcmDbFeatures(config);
    console.log("✅ Features:", features);
    
    console.log("🔌 Closing connection...");
    await db.close();
    
    console.log("🎉 PostgreSQL connection test successful!");
    
  } catch (error) {
    console.error("❌ Connection test failed:", error);
    process.exit(1);
  }
}

testConnection();