create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create type public.document_status as enum ('uploaded','queued','extracting','embedding','mapping','ready','failed');
create type public.node_kind as enum ('macro','micro');
create type public.chunk_strategy as enum ('page','semantic','chapter','hybrid');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  original_filename text not null,
  storage_bucket text not null default 'study-materials',
  storage_path text not null unique,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  checksum_sha256 text,
  page_count integer check (page_count is null or page_count >= 0),
  status public.document_status not null default 'uploaded',
  processing_error text,
  embedding_model text,
  macro_node_id uuid,
  layout_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.document_pages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  page_number integer not null check (page_number > 0),
  title text,
  extracted_text text not null default '',
  extraction_method text not null default 'native',
  token_count integer not null default 0,
  content_hash text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(document_id,page_number), unique(id,user_id)
);

create table public.globe_layouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null,
  algorithm text not null default 'umap',
  parameters jsonb not null default '{}',
  embedding_model text not null,
  corpus_hash text not null,
  random_seed integer not null default 42,
  radius real not null default 1,
  status text not null check(status in ('building','active','superseded','failed')),
  created_at timestamptz not null default now(),
  unique(user_id,version), unique(id,user_id)
);

create table public.knowledge_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  parent_node_id uuid references public.knowledge_nodes(id) on delete cascade,
  page_id uuid references public.document_pages(id) on delete set null,
  layout_id uuid not null references public.globe_layouts(id) on delete cascade,
  kind public.node_kind not null,
  chunk_strategy public.chunk_strategy,
  chunk_index integer,
  page_start integer check(page_start is null or page_start > 0),
  page_end integer check(page_end is null or page_end >= page_start),
  label text not null,
  summary text,
  topic_key text,
  embedding extensions.vector(1536),
  umap_x double precision not null,
  umap_y double precision not null,
  umap_z double precision not null,
  sphere_x double precision not null,
  sphere_y double precision not null,
  sphere_z double precision not null,
  radius real not null default 1,
  cluster_radius real not null default 0,
  color_key text,
  importance real not null default 1,
  child_count integer not null default 0 check(child_count >= 0),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(id,user_id),
  unique(layout_id,document_id,kind,chunk_index),
  check((kind='macro' and parent_node_id is null and chunk_index is null) or (kind='micro' and parent_node_id is not null and chunk_index is not null)),
  check(abs(sqrt(sphere_x*sphere_x+sphere_y*sphere_y+sphere_z*sphere_z)-radius)<0.001)
);

create table public.page_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  page_id uuid references public.document_pages(id) on delete set null,
  node_id uuid references public.knowledge_nodes(id) on delete set null,
  chunk_index integer not null,
  page_start integer not null check(page_start > 0),
  page_end integer not null check(page_end >= page_start),
  title text,
  content text not null,
  token_count integer not null,
  start_offset integer,
  end_offset integer,
  chunk_strategy public.chunk_strategy not null default 'hybrid',
  embedding extensions.vector(1536) not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(document_id,chunk_index),
  unique(node_id)
);

alter table public.documents
  add constraint documents_macro_node_fk foreign key (macro_node_id) references public.knowledge_nodes(id) on delete set null;

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  job_type text not null,
  status text not null check(status in ('queued','running','succeeded','failed','cancelled')),
  progress smallint not null default 0 check(progress between 0 and 100),
  attempts smallint not null default 0, locked_at timestamptz, locked_by text,
  error_code text, error_message text, created_at timestamptz not null default now(),
  started_at timestamptz, completed_at timestamptz
);

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  page_id uuid not null references public.document_pages(id) on delete cascade,
  node_id uuid not null references public.knowledge_nodes(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check(role in ('user','assistant')), content text not null,
  citations jsonb not null default '[]', model text, created_at timestamptz not null default now()
);

create index documents_owner_idx on public.documents(user_id,created_at desc);
create index pages_document_idx on public.document_pages(document_id,page_number);
create index nodes_layout_idx on public.knowledge_nodes(user_id,layout_id,kind);
create index nodes_parent_idx on public.knowledge_nodes(parent_node_id,chunk_index) where kind='micro';
create index nodes_document_macro_idx on public.knowledge_nodes(document_id) where kind='macro';
create index nodes_embedding_hnsw on public.knowledge_nodes using hnsw (embedding vector_cosine_ops) where embedding is not null;
create index chunks_document_idx on public.page_chunks(user_id,document_id,chunk_index);
create index chunks_embedding_hnsw on public.page_chunks using hnsw (embedding vector_cosine_ops);

create or replace function public.set_document_macro_node() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.kind = 'macro' then
    update public.documents set macro_node_id = new.id, updated_at = now() where id = new.document_id;
  end if;
  return new;
end; $$;
create trigger on_macro_node_created after insert on public.knowledge_nodes
for each row execute procedure public.set_document_macro_node();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.profiles(id,email,display_name,avatar_url)
  values(new.id,coalesce(new.email,''),new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'avatar_url');
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.documents enable row level security;
alter table public.document_pages enable row level security;
alter table public.globe_layouts enable row level security;
alter table public.knowledge_nodes enable row level security;
alter table public.page_chunks enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;

create policy "own profile" on public.profiles for all using(id=auth.uid()) with check(id=auth.uid());
create policy "own documents" on public.documents for all using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy "own pages" on public.document_pages for select using(user_id=auth.uid());
create policy "own layouts" on public.globe_layouts for select using(user_id=auth.uid());
create policy "own nodes" on public.knowledge_nodes for select using(user_id=auth.uid());
create policy "own chunks" on public.page_chunks for select using(user_id=auth.uid());
create policy "own jobs" on public.processing_jobs for select using(user_id=auth.uid());
create policy "own sessions" on public.chat_sessions for all using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy "own messages" on public.chat_messages for all using(user_id=auth.uid()) with check(user_id=auth.uid());

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('study-materials','study-materials',false,52428800,array['application/pdf'])
on conflict(id) do nothing;
create policy "upload own material" on storage.objects for insert to authenticated
with check(bucket_id='study-materials' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "read own material" on storage.objects for select to authenticated
using(bucket_id='study-materials' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "delete own material" on storage.objects for delete to authenticated
using(bucket_id='study-materials' and (storage.foldername(name))[1]=auth.uid()::text);
