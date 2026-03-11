-- Add embedding column to summaries (messages already has it)
ALTER TABLE summaries ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create HNSW indexes for fast approximate nearest-neighbor search
-- HNSW is preferred over IVFFlat: no training step, better recall, good for <100k rows
CREATE INDEX IF NOT EXISTS messages_embedding_hnsw_idx
  ON messages USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS summaries_embedding_hnsw_idx
  ON summaries USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
