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

-- ============================================================
-- 구글 로그인 + 소유권(owner_id) + 리더 권한 확장
-- 적용 방법: 위와 동일하게 SQL Editor에서 그대로 실행(여러 번 실행해도 안전).
-- ============================================================

-- ---- profiles: 구글 로그인 성공 시 최초 1회 자동 생성되는 사용자 프로필 ----
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ---- projects: 기존에는 kv_store의 "facilitation-projects-index" 키 하나에 프로젝트 전체를
-- JSON 배열로 뭉쳐 저장했다. owner_id 기준으로 행 단위 권한(RLS)을 걸려면 진짜 테이블이 필요해서
-- 새로 만든다. id는 클라이언트의 uid()가 만드는 임의 문자열(uuid 형식 아님)과 호환되도록 text로 둔다.
-- owner_id는 반드시 nullable — 로그인 이전에 만든 프로젝트, 그리고 비로그인 참여자가 계속
-- 프로젝트를 만들 수 있어야 하는 요구사항 때문이다.
--
-- instructions(STEP 안내 배너)·votes_per_user(1인당 투표권)는 "리더만 수정 가능"이 걸리는 두 필드라
-- board(kv_store, JSON 통짜 저장)에 남겨두면 RLS로 이 두 필드만 따로 보호할 방법이 없다.
-- 그래서 이 두 필드만 이 실제 테이블 컬럼으로 옮기고, 포스트잇/투표/회고/문서표준필드/회의록 등
-- 나머지 보드 데이터는 지금처럼 kv_store에 그대로 둔다(참여자 누구나 계속 자유롭게 쓸 수 있어야 함).
create table if not exists public.projects (
  id text primary key,
  title text not null,
  goal text not null default '',
  pinned boolean not null default false,
  owner_id uuid references auth.users (id) on delete set null,
  instructions text,
  votes_per_user integer not null default 3,
  created_at timestamptz not null default now()
);

alter table public.projects enable row level security;

-- 읽기는 계속 전체 허용한다 — 팀원이 공유 링크(앱의 ?p=프로젝트id)로 로그인 없이 들어오는 기존
-- 사용 방식을 유지해야 하기 때문. "내 프로젝트" 목록의 owner_id 필터링은 RLS가 아니라
-- 클라이언트 쿼리(.eq('owner_id', 내_uid))가 책임진다.
drop policy if exists "projects public select" on public.projects;
create policy "projects public select" on public.projects
  for select using (true);

-- 생성도 계속 전체 허용(비로그인 참여자도 프로젝트를 만들 수 있어야 하는 기존 동작 유지).
-- owner_id 위조만 막는다: null이거나 반드시 본인 uid여야 한다.
drop policy if exists "projects public insert" on public.projects;
create policy "projects public insert" on public.projects
  for insert with check (owner_id is null or owner_id = auth.uid());

-- 목표(goal) 편집 등은 팀원 누구나 가능해야 하므로 행 단위로는 전체 허용한다.
-- instructions/votes_per_user만 "오너 전용"으로 막는 세밀한 제어는 RLS(행 단위)로는 표현할 수
-- 없어서, 아래 트리거로 컬럼 단위 보호를 구현한다.
drop policy if exists "projects public update" on public.projects;
create policy "projects public update" on public.projects
  for update using (true) with check (true);

-- 삭제는 오너 전용이다(4단계 제안 확정). owner_id가 아직 없는(귀속 전) 프로젝트는
-- 특정 오너가 없으니 누구나 지울 수 있게 둔다(로그인 없이 만든 프로젝트가 영영 안 지워지는 것 방지).
drop policy if exists "projects public delete" on public.projects;
create policy "projects owner or unclaimed delete" on public.projects
  for delete using (owner_id is null or owner_id = auth.uid());

-- ---- 컬럼 단위 보호: instructions/votes_per_user/owner_id는 오너만 바꿀 수 있다 ----
-- RLS는 행 단위 정책이라 "이 두 컬럼만 오너 전용"을 표현할 수 없다. 대신 트리거로
-- 실제로 값이 바뀌려는 시도(update 전후 값이 다를 때)에 한해 오너인지 검사한다.
-- (goal/title/pinned 등 다른 컬럼은 이 트리거의 검사 대상이 아니므로 계속 누구나 수정 가능하다.)
create or replace function public.protect_owner_only_project_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    -- owner_id 변경은 "귀속(claim)" 로직(널 -> 로그인 사용자)에서만 허용한다.
    if old.owner_id is not null then
      raise exception 'owner_id는 한번 정해지면 변경할 수 없습니다';
    end if;
  end if;

  if new.instructions is distinct from old.instructions
     or new.votes_per_user is distinct from old.votes_per_user then
    -- "<>"는 auth.uid()가 NULL(비로그인 요청)일 때 비교 결과 자체가 NULL이 되어 IF가 그냥
    -- 통과해버리는 함정이 있다(PL/pgSQL은 조건이 NULL이면 예외를 안 던지고 넘어감).
    -- IS DISTINCT FROM은 NULL을 다른 값과 항상 "다르다"로 취급해 이 구멍을 막는다.
    if old.owner_id is null or old.owner_id is distinct from auth.uid() then
      raise exception 'STEP 안내 배너와 1인당 투표권은 프로젝트 오너만 수정할 수 있습니다';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_owner_only_project_fields on public.projects;
create trigger trg_protect_owner_only_project_fields
  before update on public.projects
  for each row execute function public.protect_owner_only_project_fields();

-- ---- 기존 JSON 인덱스 데이터를 새 projects 테이블로 1회 이관 ----
-- "facilitation-projects-index" 키의 JSON 배열을 행 단위로 풀어서 넣는다.
-- id가 이미 있으면 건너뛰므로(on conflict do nothing) 이 파일을 다시 실행해도 안전하고,
-- 이 이관 이후 새로 생기는 프로젝트는 앱이 곧바로 projects 테이블에만 쓴다.
insert into public.projects (id, title, goal, pinned, created_at)
select
  (elem ->> 'id')::text,
  coalesce(elem ->> 'title', '(제목 없음)'),
  coalesce(elem ->> 'goal', ''),
  coalesce((elem ->> 'pinned')::boolean, false),
  case
    when (elem ->> 'createdAt') ~ '^\d+$' then to_timestamp((elem ->> 'createdAt')::bigint / 1000.0)
    else now()
  end
from public.kv_store, jsonb_array_elements(value::jsonb) as elem
where key = 'facilitation-projects-index'
on conflict (id) do nothing;

-- 각 프로젝트의 보드(kv_store: "facilitation-board:{id}")에 있던 instructions/votesPerUser 값도
-- 함께 옮긴다(방금 이관돼 instructions가 아직 비어있는 행에 한해서만 — 재실행해도 안전).
update public.projects p
set instructions = (b.value::jsonb ->> 'instructions'),
    votes_per_user = coalesce((b.value::jsonb ->> 'votesPerUser')::int, 3)
from public.kv_store b
where b.key = 'facilitation-board:' || p.id
  and p.instructions is null;

-- ============================================================
-- 온보딩 가이드 투어: "세션당 1회"(sessionStorage)에서 "계정당 1회, 30일 이상 재접속
-- 시 다시 1회"로 변경하면서 이 시점을 계정(profiles)에 저장해야 해서 컬럼을 추가한다.
-- ============================================================
alter table public.profiles add column if not exists last_guide_seen_at timestamptz;
