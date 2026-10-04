-- 002_memory.sql
-- Advisory semantic memory (spec section 14). Requires pgvector.
-- Embedding dimension matches qwen3-embedding-0-6b at 1024 dims (section 40.5).

create extension if not exists vector;

create table memory_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id),
  kind text not null,
  text text not null,
  source_message_id uuid references messages(id),
  source_type text not null,
  confidence real not null,
  importance real not null,
  embedding vector(1024),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  forgotten_at timestamptz
);

create index memory_records_user_idx
  on memory_records(user_id)
  where forgotten_at is null;

create index memory_records_embedding_idx
  on memory_records using hnsw (embedding vector_cosine_ops);
