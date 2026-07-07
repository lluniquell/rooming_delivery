# 루밍 가구배송 관리 시스템 — 개발 스펙

## 1. 배경 및 목표

현재 프로세스(전부 수기):
1. 카페24 주문 발생 → 스케줄러가 엑셀에 수기 입력
2. 지역 구분, 지정일 배송 고객 일정 배치, 근처 고객을 다음 순서로 수동 배열
3. 배송 완료 시 기사가 채널톡에 사진 업로드
4. 스케줄러가 카페24 관리자에서 배송완료 수동 처리

목표: 위 흐름을 웹 기반 시스템으로 대체.
- **스케줄러**: 웹에서 카페24 주문 자동 수집 → 날짜별/배송원별 드래그앤드롭 배정
- **배송원**: 폰(모바일 웹)에서 당일 배송건 확인 → 완료 버튼 + 사진 업로드
- **시스템**: 완료 시 카페24 API로 배송완료 처리 + 채널톡 API로 사진/완료 메시지 전송

## 2. 기술 스택

- Frontend: React + TypeScript (스케줄러 데스크톱 웹 + 배송원 모바일 반응형 웹, 단일 앱)
- Backend: Supabase (Postgres + Storage + Edge Functions + Auth)
- 외부 API: 카페24 Admin API (OAuth 2.0), 채널톡 Open API (x-access-key/secret)
- 스케줄러 UI 드래그앤드롭: dnd-kit 권장

## 3. DB 스키마 (Supabase Postgres)

설계 원칙: 카페24가 주문 원본(source of truth). 로컬 DB는 배송 운영 레이어.
주문 전체를 복제하지 않고 스케줄링에 필요한 스냅샷 + 운영 상태만 저장.

```sql
-- 배송원
create table drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  pin_code text not null,        -- 간단 PIN 로그인용
  is_active boolean default true,
  created_at timestamptz default now()
);

-- 일자별 배송조 (배정의 단위. 1인조 또는 2인조 — 트럭 한 대 = 조 하나 = 동선 하나)
create table crews (
  id uuid primary key default gen_random_uuid(),
  delivery_date date not null,
  name text,                     -- '1조', '2조' (자동 부여, 수정 가능)
  created_at timestamptz default now()
);

create table crew_members (
  crew_id uuid references crews(id) not null,
  driver_id uuid references drivers(id) not null,
  role text default 'main',      -- 'main' / 'helper'
  primary key (crew_id, driver_id)
);

-- 주문 (카페24 스냅샷 + 운영 필드)
create table orders (
  id uuid primary key default gen_random_uuid(),
  cafe24_order_id text unique not null,
  order_date timestamptz,
  receiver_name text,
  receiver_phone text,
  address text,
  address_region text,           -- 주소 파싱된 시/구 (자동 지역분류)
  lat numeric, lng numeric,      -- 카카오 지오코딩 결과 (Phase 1, 네비 딥링크에 필요, nullable)
  required_persons int default 1, -- 1인/2인 배송 필요 인원 (품목 기준 추정 + 스케줄러 수정)
  items jsonb,                   -- [{name, qty, option}]
  requested_date date,           -- 고객 지정일 (주문 메모/옵션에서 추출, 실패 시 null)
  memo text,                     -- 스케줄러 메모
  status text not null default 'pending',
    -- pending(미배정) / scheduled(배정됨) / out(배송중) / done(완료) / hold(보류)
  synced_at timestamptz,         -- 카페24 마지막 동기화 시각
  created_at timestamptz default now()
);

-- 배송 배정 (주문과 분리 — 재배정/일정변경 이력 보존)
create table assignments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) not null,
  crew_id uuid references crews(id) not null,
  delivery_date date not null,
  sequence int not null,         -- fractional index 방식
  time_slot text,                -- '오전'/'오후' 등 (선택)
  is_active boolean default true,
  created_at timestamptz default now()
);
create unique index one_active_assignment on assignments(order_id) where is_active;

-- 배송 완료 기록
create table completions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid references assignments(id) not null,
  completed_at timestamptz default now(),
  photo_urls text[],             -- Supabase Storage 경로
  driver_note text,
  cafe24_synced boolean default false,
  channeltalk_synced boolean default false,
  sync_error text,
  retry_count int default 0
);

-- 카페24 OAuth 토큰 (단일 행)
create table cafe24_tokens (
  id int primary key default 1,
  access_token text not null,
  refresh_token text not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  updated_at timestamptz default now()
);
```

### sequence — fractional index 방식
- 신규 배정 시 1024 간격으로 부여 (1024, 2048, 3072...)
- 드래그로 A와 B 사이에 삽입 시: `new = floor((A.seq + B.seq) / 2)` → 해당 행 1건만 UPDATE
- 간격이 1로 소진되면 그날+그 배송원의 배정만 재번호
- 조회는 `ORDER BY sequence`

## 4. 카페24 API 연동

### 4.1 OAuth 토큰 관리
- access token 유효 2시간, refresh token 유효 2주
- **refresh token 회전**: 갱신 시 refresh token도 새로 발급. 저장 실패 = 토큰 사슬 단절
  → 토큰 수신 → DB 저장을 트랜잭션으로, 저장 확인 후에만 성공 처리
- **동시 갱신 금지**: 단일 크론, `SELECT ... FOR UPDATE`로 행 잠금 후 갱신
- **이중 방어**: 크론 1시간마다 갱신 + API 401 수신 시 즉시 갱신 후 1회 재시도
- 최초 인증: 관리자 브라우저에서 카페24 앱 승인 → authorization code → 토큰 발급 콜백 페이지

### 4.2 주문 수집
- Edge Function 크론, 15~30분 주기 폴링
- 신규/변경 주문 upsert (cafe24_order_id 기준)
- **지정일 추출**: 주문 메모/배송 메시지/상품 옵션에서 정규식 파싱 → 실패 시 null
- **주소 지역 파싱**: 시/구 추출 → address_region
- 취소/교환 감지 시 status='hold'

### 4.3 배송완료 처리
- shipments 엔드포인트 PUT
- 가구 자체배송 전제 (택배사 송장 연동 없음)
- 배송중 상태 전제 여부 실테스트 필요

## 5. 채널톡 API 연동

- Open API: https://api.channel.io (x-access-key / x-access-secret)
- **⚠️ PoC 필요**: 이미지 첨부 메시지 전송 가능 여부
  - Plan A: 채널톡 파일 업로드 엔드포인트로 이미지 첨부
  - Plan B: Storage URL + 텍스트 메시지
- 고객 매칭: 전화번호 기준 유저 검색

## 6. 완료 처리 플로우

1. completions insert + Storage 업로드 → 배송원 화면 즉시 "완료"
2. 백그라운드에서 카페24 + 채널톡 처리
3. 실패 시 synced=false + sync_error 기록, 지수 백오프 재시도
4. 대시보드에 미동기 건 표시 + 수동 재시도

## 7. 화면 구성

### 스케줄러 (데스크톱)
1. **일자별 뷰 (메인)**: 날짜 선택 + 조 편성 + 미배정 리스트 + 조별 배정 컬럼 (드래그앤드롭)
2. **배송원별 뷰**: 배송원 선택 → 주간 타임라인
3. **주문별 뷰**: 전체 주문 테이블 (검색/필터/카페24 링크)
- 공통: 동기화 대시보드 (sync 실패, hold 주문, 폴링 상태)

### 배송원 (모바일)
1. **일자별 뷰**: PIN 로그인 → 당일 배송 리스트 (sequence 순)
2. **주문 상세**: 주소/전화/품목/메모 + 전화/문자/네비/완료
- 문자: 템플릿 선택(message_templates 테이블) + 직접 입력, OS별 딥링크 분기
- 네비: 네이버지도/티맵, 좌표 없으면 주소 검색 폴백, 앱 미설치 폴백

### 네비 딥링크
- 네이버: `nmap://route/car?dlat={lat}&dlng={lng}&dname={name}&appname={bundleId}`
- 티맵: `tmap://route?goalx={lng}&goaly={lat}&goalname={name}`
- 배송원 선호 네비: drivers.preferred_nav 컬럼

## 8. 개발 단계

- **Phase 0**: 카페24 OAuth 검증, 주문 API 실데이터 확인, shipments PUT 테스트, 채널톡 PoC
- **Phase 1**: 스키마, 토큰 크론, 주문 폴링, 조 편성 + 배정 보드
- **Phase 2**: 모바일 배송원 화면, 완료 파이프라인
- **Phase 3**: 배송원별/주문별 뷰, 순서 추천, 대시보드 고도화

## 9. 미확정 사항

- [ ] 카페24 지정일 배송 정보 실제 필드
- [ ] 배송완료 PUT 전제 상태
- [ ] 송장 연동 주문 존재 여부
- [ ] 채널톡 이미지 첨부 가능 여부
- [ ] 채널톡 고객 매칭 키 (전화번호 포맷)
- [ ] 배송원 수, 하루 평균 배송 건수
- [ ] required_persons 자동 추정 규칙
- [ ] 티맵 딥링크 최신 스킴
