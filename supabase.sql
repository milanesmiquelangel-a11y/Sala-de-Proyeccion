-- Ejecuta este archivo una sola vez en Supabase > SQL Editor.

create table if not exists public.users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.generations (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  prompt text not null,
  model text not null,
  aspect_ratio text not null,
  duration integer not null,
  audio boolean not null default false,
  has_image boolean not null default false,
  image_path text,
  video_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists generations_user_created_idx
  on public.generations(user_id, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800, array['image/jpeg','image/png','image/webp','video/mp4'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
