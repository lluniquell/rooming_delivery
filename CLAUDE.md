# 루밍 딜리버리 프로젝트

## 프로젝트 개요
루밍 가구 직접배송 관리 시스템. 관리자가 카페24 주문을 등록하고 배송원에게 배정, 배송원이 모바일로 완료 처리.

## 스펙 문서
- **DELIVERY_SPEC.md** — 딜리버리 모듈 전체 스펙 (DB 스키마, 화면 목록, API 연동)
- **PLANNING_NOTES.md** — 차수 관리 + 검수 모듈 기획 노트 (2026-06-25)
- **memory/rooming-context.md** — 루밍 전체 프로젝트 컨텍스트

## 기술 스택
- React + Vite + TypeScript + Tailwind CSS
- Supabase (DB + Auth + Storage + Realtime)
- 카페24 REST API
- Vercel 배포

## 주요 규칙
- 배송원 계정은 관리자가 직접 생성 (자체 회원가입 없음)
- 카페24 상품코드 = 이카운트 품목코드 (동일 체계)
- 직배 송장번호 형식: `직배YYYYMMDD`

## 관련 레포
- 바코드 생성기: https://github.com/lluniquell/rooming_barcode_generator
- 오더봇: E:\claude\rooming_order_bot (로컬 전용)
