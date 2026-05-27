-- Step 3e: search_chunks RPC.
--
-- Returns the top-k chunks for a given document, ordered by cosine
-- similarity to a query embedding. Cosine similarity = 1 - cosine
-- distance; pgvector's <=> operator is cosine distance with HNSW/IVFFlat
-- support if we add an index later.
--
-- At pilot scale (handful of docs, low thousands of chunks per doc) we
-- run without a vector index — seq scan over 768-d vectors is fine.
--
-- Note on search_path: pgvector's operators (<=>, <->, <#>) live in the
-- `extensions` schema. Functions don't inherit a search_path that
-- includes `extensions` by default, so we set it explicitly here.

create or replace function public.search_chunks(
  query_embedding extensions.vector(768),
  doc_id          uuid,
  k               integer default 10
)
returns table (
  chunk_index   integer,
  page_number   integer,
  section_ref   text,
  text          text,
  similarity    real
)
language sql
stable
set search_path = public, extensions
as $$
  select
    chunk_index,
    page_number,
    section_ref,
    text,
    1 - (embedding <=> query_embedding) as similarity
  from document_chunks
  where document_id = doc_id
    and embedding is not null
  order by embedding <=> query_embedding
  limit greatest(k, 1);
$$;

grant execute on function public.search_chunks(extensions.vector, uuid, integer) to authenticated;
