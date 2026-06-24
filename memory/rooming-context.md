---
name: rooming-context
description: 루밍 전체 프로젝트 구조, 카페24/이카운트 연동 방식, 모듈별 역할 및 기술 스택
metadata:
  type: project
---

## 회사 시스템 구조
- **카페24**: 판매 솔루션, WMS처럼 사용 중. 주문 마스터.
- **이카운트**: ERP. 재고/상품 마스터.
- **카페24 상품코드 = 이카운트 품목코드** (동일 체계, 별도 매핑 불필요)

**Why:** WMS 도입 시도했지만 실패, 카페24+이카운트 API 연동으로 해결하기로 함.
**How to apply:** 주문 데이터는 카페24에서, 재고/상품 데이터는 이카운트에서 조회.

---

## 모듈 구성

### 1. 딜리버리 (E:\claude\looming-delivery\rooming_delivery)
- GitHub: https://github.com/lluniquell/rooming_delivery.git
- 가구 직접배송 관리 도구
- 관리자 웹(PC) + 배송원 모바일 웹앱(PWA)
- 스택: React + Vite + TS + Tailwind + Supabase + 카페24 API
- 배송완료 시 카페24 상태 업데이트 + 완료 사진 업로드
- 스펙 문서: DELIVERY_SPEC.md

### 2. 차수 관리 + 바코드 검수 (신규 개발 예정)
- 카페24 주문을 차수(01~10)별로 수동 그루핑
- 상품별 소품팀/배송팀 구분 + 차수 배정
- 피킹리스트 출력
- 운송장 스캔(블루투스, PC) → 이카운트 API 바코드 조회 → 검수
- 검수 완료 시 카페24 배송중 상태 업데이트
- 스펙 상세: PLANNING_NOTES.md

### 3. 바코드 생성기 (E:\claude\rooming_barcode_generator)
- GitHub: https://github.com/lluniquell/rooming_barcode_generator.git
- Python tkinter 데스크탑 앱 (노트북에서 실행)
- 이카운트 품목 엑셀 → 바코드 채번 → Supabase barcodes 테이블 저장
- 바코드 형식: 200 + YY(2) + MM(2) + W(1) + SERIAL(5) = 13자리
- Supabase: { product_code, product_name, barcode }
- 추후 웹 통합 고려

### 4. 오더봇 (E:\claude\rooming_order_bot)
- Python + Playwright 자동화 스크립트
- 사방넷 주문 엑셀 → 카페24 수기주문 자동 입력
- 카페24 API에 주문 생성 엔드포인트 없어서 브라우저 자동화로 처리

---

## 카페24 주문 상태 흐름
상품준비중 → 배송준비중(송장출력) → 배송대기 → 배송중 → 배송완료

## 미결 기술 사항
- 카페24 API 운송장번호로 주문 역조회 가능 여부 (개발 시 확인 필요)
- 이카운트 Open API 키 발급
