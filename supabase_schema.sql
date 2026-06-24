-- drivers (배송원 / 관리자)
create table drivers (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  email       text unique not null,
  role        text not null default 'driver' check (role in ('admin', 'driver')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- deliveries (배송 건)
create table deliveries (
  id                uuid primary key default gen_random_uuid(),
  cafe24_order_no   text not null,
  customer_name     text not null,
  address           text not null,
  items             jsonb not null default '[]',
  driver_id         uuid references drivers(id),
  sort_order        integer,
  status            text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  scheduled_date    date not null,
  completed_at      timestamptz,
  memo              text,
  invoice_no        text,
  created_at        timestamptz not null default now()
);

-- delivery_photos (배송 완료 사진)
create table delivery_photos (
  id            uuid primary key default gen_random_uuid(),
  delivery_id   uuid not null references deliveries(id) on delete cascade,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);

-- RLS 활성화
alter table drivers enable row level security;
alter table deliveries enable row level security;
alter table delivery_photos enable row level security;

-- drivers RLS
create policy "본인 또는 관리자만 조회" on drivers
  for select using (
    auth.uid() = id
    or exists (select 1 from drivers where id = auth.uid() and role = 'admin')
  );

create policy "관리자만 수정" on drivers
  for all using (
    exists (select 1 from drivers where id = auth.uid() and role = 'admin')
  );

-- deliveries RLS
create policy "관리자 전체 접근" on deliveries
  for all using (
    exists (select 1 from drivers where id = auth.uid() and role = 'admin')
  );

create policy "배송원 본인 건만 조회" on deliveries
  for select using (driver_id = auth.uid());

create policy "배송원 본인 건 상태 업데이트" on deliveries
  for update using (driver_id = auth.uid());

-- delivery_photos RLS
create policy "관리자 전체 접근" on delivery_photos
  for all using (
    exists (select 1 from drivers where id = auth.uid() and role = 'admin')
  );

create policy "배송원 본인 건 사진 삽입" on delivery_photos
  for insert with check (
    exists (select 1 from deliveries where id = delivery_id and driver_id = auth.uid())
  );

create policy "배송원 본인 건 사진 조회" on delivery_photos
  for select using (
    exists (select 1 from deliveries where id = delivery_id and driver_id = auth.uid())
  );

-- Realtime 활성화
alter publication supabase_realtime add table deliveries;
