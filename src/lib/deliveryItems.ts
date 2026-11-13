// 스케줄러/물류팀 라벨처럼 "그 날 배송할 상품"만 보여줘야 하는 화면 공통 기준(2026-11-13).
// 직배 배치 + confirmed/in_transit만 보면 같은 주문의 예전 배송분(이미 완료된 상품)이나
// 카페24에서 취소/교환완료된 상품까지 같이 나옴(20261010-0000556)
// - 취소(C*)·교환완료(E4*) 상품은 제외
// - 그 날짜 이전에 이미 배송 처리된(in_transit) 상품은 제외 — 당일 완료분과 아직 처리 안 된 상품만 남김
export function isItemToDeliver(
  item: { status: string; order_status: string | null; shipped_at: string | null },
  date: string,
) {
  if (item.order_status && /^C|^E4/.test(item.order_status)) return false
  if (item.status === 'in_transit' && item.shipped_at) {
    const shippedKst = new Date(new Date(item.shipped_at).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
    if (shippedKst < date) return false
  }
  return true
}
