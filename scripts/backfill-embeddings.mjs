#!/usr/bin/env node
/**
 * Backfill embeddings for all messages and summaries in the LCM PostgreSQL database.
 *
 * Usage:
 *   node scripts/backfill-embeddings.mjs [--messages] [--summaries] [--batch-size 100] [--dry-run]
 *
 * Env vars:
 *   LCM_CONNECTION_STRING — PostgreSQL connection string (required)
 *   OPENAI_API_KEY or LCM_EMBEDDING_API_KEY — OpenAI API key (required)
 *
 * Cost estimate: ~10k messages ≈ 2-5M tokens ≈ $0.04-0.10 at text-embedding-3-small rates
 */

import pg from "pg";
const { Pool } = pg;

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const API_BASE = "https://api.openai.com/v1";
const DEFAULT_BATCH_SIZE = 100;

// ── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const doMessages = args.includes("--messages") || (!args.includes("--summaries"));
const doSummaries = args.includes("--summaries") || (!args.includes("--messages"));
const dryRun = args.includes("--dry-run");
const batchSizeArg = args.indexOf("--batch-size");
const BATCH_SIZE = batchSizeArg >= 0 ? parseInt(args[batchSizeArg + 1], 10) : DEFAULT_BATCH_SIZE;

const CONNECTION_STRING = process.env.LCM_CONNECTION_STRING;
const API_KEY = process.env.LCM_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY;

if (!CONNECTION_STRING) {
  console.error("Error: LCM_CONNECTION_STRING is required");
  process.exit(1);
}
if (!API_KEY) {
  console.error("Error: OPENAI_API_KEY or LCM_EMBEDDING_API_KEY is required");
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getEmbeddings(texts) {
  // Truncate to stay under 8191 token limit (~4 chars/token, use 28k chars for safety)
  const truncated = texts.map((t) => (t.length > 28000 ? t.slice(0, 28000) : t));

  const res = await fetch(`${API_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: truncated,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    // If batch fails due to token length, try individually
    if (res.status === 400 && errText.includes("maximum input length")) {
      return await getEmbeddingsOneByOne(truncated);
    }
    throw new Error(`OpenAI API error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const sorted = json.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

/** Fall back to embedding one at a time when batch fails (e.g. one text too long) */
async function getEmbeddingsOneByOne(texts) {
  const results = [];
  for (const text of texts) {
    // Aggressively truncate for individual retry
    const truncated = text.length > 20000 ? text.slice(0, 20000) : text;
    try {
      const res = await fetch(`${API_BASE}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: [truncated],
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });
      if (!res.ok) {
        // If still too long, truncate harder
        if (res.status === 400) {
          const res2 = await fetch(`${API_BASE}/embeddings`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({
              model: EMBEDDING_MODEL,
              input: [truncated.slice(0, 10000)],
              dimensions: EMBEDDING_DIMENSIONS,
            }),
          });
          if (res2.ok) {
            const json = await res2.json();
            results.push(json.data[0].embedding);
            continue;
          }
        }
        results.push(null);
        continue;
      }
      const json = await res.json();
      results.push(json.data[0].embedding);
    } catch {
      results.push(null);
    }
  }
  return results;
}

function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: CONNECTION_STRING });

  try {
    if (doMessages) {
      await backfillTable(pool, "messages", "message_id", "content");
    }
    if (doSummaries) {
      await backfillTable(pool, "summaries", "summary_id", "content");
    }
  } finally {
    await pool.end();
  }
}

async function backfillTable(pool, table, idColumn, contentColumn) {
  // Count how many need embeddings
  const countResult = await pool.query(
    `SELECT COUNT(*) as total FROM ${table} WHERE embedding IS NULL AND length(${contentColumn}) > 20`,
  );
  const total = parseInt(countResult.rows[0].total, 10);

  console.log(`\n📊 ${table}: ${total} rows need embeddings`);
  if (total === 0) {
    console.log(`  ✅ All ${table} already have embeddings`);
    return;
  }

  if (dryRun) {
    console.log(`  🏃 Dry run — would process ${total} rows in batches of ${BATCH_SIZE}`);
    return;
  }

  let processed = 0;
  let embedded = 0;
  let skipped = 0;
  let totalTokensEstimate = 0;
  let consecutiveErrors = 0;
  const skipIds = new Set(); // Track IDs that fail repeatedly

  while (true) {
    // Fetch next batch of rows without embeddings, excluding known-bad IDs
    let skipClause = "";
    const skipArr = [...skipIds];
    if (skipArr.length > 0) {
      // Build exclusion — use text casting for summary_id (text), numeric for message_id
      const isTextId = typeof skipArr[0] === "string";
      if (isTextId) {
        skipClause = ` AND ${idColumn} NOT IN (${skipArr.map((id) => `'${id}'`).join(",")})`;
      } else {
        skipClause = ` AND ${idColumn} NOT IN (${skipArr.join(",")})`;
      }
    }

    const batch = await pool.query(
      `SELECT ${idColumn} as id, ${contentColumn} as content
       FROM ${table}
       WHERE embedding IS NULL AND length(${contentColumn}) > 20${skipClause}
       ORDER BY ${idColumn}
       LIMIT $1`,
      [BATCH_SIZE],
    );

    if (batch.rows.length === 0) break;

    const texts = batch.rows.map((r) => r.content);
    const ids = batch.rows.map((r) => r.id);

    try {
      const embeddings = await getEmbeddings(texts);

      // Batch update in a transaction (skip nulls from failed individual embeddings)
      const client = await pool.connect();
      let batchSuccess = 0;
      try {
        await client.query("BEGIN");
        for (let i = 0; i < ids.length; i++) {
          if (embeddings[i] != null) {
            await client.query(
              `UPDATE ${table} SET embedding = $1 WHERE ${idColumn} = $2`,
              [toVectorLiteral(embeddings[i]), ids[i]],
            );
            batchSuccess++;
          } else {
            // Mark this ID as unskippable for future batches
            skipIds.add(ids[i]);
            skipped++;
          }
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      processed += batch.rows.length;
      embedded += batchSuccess;
      totalTokensEstimate += texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
      consecutiveErrors = 0;

      const pct = ((processed / total) * 100).toFixed(1);
      const costEstimate = ((totalTokensEstimate / 1_000_000) * 0.02).toFixed(4);
      process.stdout.write(
        `\r  ⏳ ${table}: ${processed}/${total} (${pct}%) — ${embedded} embedded, ${skipped} skipped — ~$${costEstimate}   `,
      );

      // Rate limit
      if (batch.rows.length === BATCH_SIZE) {
        await sleep(200);
      }
    } catch (e) {
      consecutiveErrors++;
      console.error(`\n  ❌ Error at batch starting with id ${ids[0]}: ${e.message}`);

      if (e.message?.includes("500") || e.message?.includes("server_error")) {
        // Server error — skip ALL IDs in this batch and move on
        for (const id of ids) {
          skipIds.add(id);
        }
        skipped += ids.length;
        console.log(`  ⏭️  Skipping ${ids.length} ids from ${ids[0]} to ${ids[ids.length-1]} (server error)`);
        consecutiveErrors = 0; // Reset since we're making progress by skipping
        await sleep(2000);
        continue;
      }

      if (consecutiveErrors > 20) {
        console.error("  🛑 Too many consecutive errors, stopping");
        break;
      }
      if (e.message?.includes("429")) {
        console.log("  ⏳ Rate limited, waiting 30s...");
        await sleep(30000);
      } else {
        await sleep(2000);
      }
    }
  }

  console.log(`\n  ✅ ${table}: ${embedded} embedded, ${skipped} skipped out of ${total} total`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
