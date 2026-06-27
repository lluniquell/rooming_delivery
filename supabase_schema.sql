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


-- =============================================
-- 차수 관리 + 바코드 검수 모듈
-- =============================================

-- batches (차수, 고정 01~10)
create table batches (
  id         uuid primary key default gen_random_uuid(),
  batch_no   text not null unique check (batch_no in ('01','02','03','04','05','06','07','08','09','10')),
  name       text not null default ''
);

-- 고정 10개 초기 데이터
insert into batches (batch_no, name) values
  ('01', ''), ('02', ''), ('03', ''), ('04', ''), ('05', ''),
  ('06', ''), ('07', ''), ('08', ''), ('09', ''), ('10', '');

-- orders (카페24 주문 헤더)
create table orders (
  id                uuid primary key default gen_random_uuid(),
  cafe24_order_no   text not null unique,
  customer_name     text not null,
  address           text not null,
  created_at        timestamptz not null default now()
);

-- order_items (주문 내 상품별 행)
create table order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete cascade,
  product_code   text not null,
  product_name   text not null,
  option_info    text,
  quantity       integer not null default 1,
  team           text check (team in ('interior', 'delivery')),
  batch_id       uuid references batches(id),
  batch_date     date,
  inspected_qty  integer not null default 0,
  status         text not null default 'unassigned'
                   check (status in ('unassigned', 'assigned', 'partial', 'done')),
  created_at     timestamptz not null default now()
);

-- barcodes (품목 바코드 마스터, 이카운트 엑셀 업로드)
create table barcodes (
  id             uuid primary key default gen_random_uuid(),
  barcode        text not null unique,
  product_code   text not null,
  product_name   text not null,
  created_at     timestamptz not null default now()
);

-- RLS 활성화 (차수+검수는 관리자만 접근)
alter table batches    enable row level security;
alter table orders     enable row level security;
alter table order_items enable row level security;
alter table barcodes   enable row level security;

create policy "관리자만 접근" on batches
  for all using (exists (select 1 from drivers where id = auth.uid() and role = 'admin'));

create policy "관리자만 접근" on orders
  for all using (exists (select 1 from drivers where id = auth.uid() and role = 'admin'));

create policy "관리자만 접근" on order_items
  for all using (exists (select 1 from drivers where id = auth.uid() and role = 'admin'));

create policy "관리자만 접근" on barcodes
  for all using (exists (select 1 from drivers where id = auth.uid() and role = 'admin'));

-- 인덱스
create index on order_items (order_id);
create index on order_items (batch_id, batch_date);
create index on order_items (status);
create index on barcodes (barcode);
create index on barcodes (product_code);
