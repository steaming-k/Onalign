-- Onalign 백엔드 스키마: 앱의 모든 데이터(프로젝트 목록, 보드 내용)를 key/value 한 쌍으로 저장한다.
-- 로그인 없이 이름만으로 참여하는 앱 특성상 인증 없이 누구나 읽고 쓸 수 있어야 하므로,
-- RLS는 켜두되 익명(anon/publishable key) 접근을 전체 허용하는 정책을 함께 둔다.
--
-- 적용 방법: Supabase 대시보드 > SQL Editor에서 이 파일 내용을 그대로 실행하면 된다.

create table if not exists public.kv_store (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.kv_store enable row level security;

drop policy if exists "kv_store public select" on public.kv_store;
create policy "kv_store public select" on public.kv_store
  for select using (true);

drop policy if exists "kv_store public insert" on public.kv_store;
create policy "kv_store public insert" on public.kv_store
  for insert with check (true);

drop policy if exists "kv_store public update" on public.kv_store;
create policy "kv_store public update" on public.kv_store
  for update using (true) with check (true);

drop policy if exists "kv_store public delete" on public.kv_store;
create policy "kv_store public delete" on public.kv_store
  for delete using (true);
