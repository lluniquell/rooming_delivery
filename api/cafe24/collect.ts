import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = (process.env.VITE_CAFE24_MALL_ID ?? '').trim()
const CLIENT_ID = (process.env.VITE_CAFE24_CLIENT_ID ?? '').trim()
const CLIENT_SECRET = (process.env.CAFE24_CLIENT_SECRET ?? '').trim()

const supabase = createClient(
  (process.env.VITE_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
)

// 만료 10분 전이면 미리 갱신 (orders/[orderNo].ts에서 병합)
async function getToken(): Promise<string> {
  const { data } = await supabase.from('cafe24_tokens').select('*').eq('id', 1).single()
  if (!data) throw new Error('토큰 없음')

  if (new Date(data.access_expires_at) < new Date(Date.now() + 10 * 60 * 1000)) {
    const tokenRes = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refresh_token }),
    })
    const refreshed = await tokenRes.json()

    // 갱신 실패 응답을 그대로 반영하면 안 됨 — access_token/refresh_token이 없는 채로
    // upsert하면 이 시점까지는 멀쩡했던 기존 토큰을 덮어써버릴 수 있음(2026-09-14,
    // refresh_token invalid_grant 사고)
    if (!tokenRes.ok || !refreshed.access_token || !refreshed.refresh_token) {
      // 카페24 refresh_token은 1회용(사용하면 새 값으로 회전)이라, 동시에 두 요청이 같은
      // 옛 refresh_token으로 갱신을 시도하면 하나만 성공하고 나머지는 여기로 옴 — 그 경우
      // 진짜 실패가 아니라 "이미 다른 요청이 갱신해놨다"는 뜻이므로, DB를 다시 읽어서
      // 내가 썼던 값과 달라져 있고(=누가 갱신함) 아직 유효하면 그 새 토큰을 그대로 씀
      const { data: latest } = await supabase.from('cafe24_tokens').select('*').eq('id', 1).single()
      if (latest && latest.refresh_token !== data.refresh_token && new Date(latest.access_expires_at) > new Date()) {
        return latest.access_token
      }
      throw new Error(`카페24 토큰 갱신 실패: ${refreshed.error_description ?? refreshed.error ?? JSON.stringify(refreshed)}`)
    }

    await supabase.from('cafe24_tokens').upsert({
      id: 1,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      access_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })
    return refreshed.access_token
  }

  return data.access_token
}

// 주문 1건 상세 조회 (orders/[orderNo].ts 병합) — GET ?order_no=xxx
async function getOrder(orderNo: string, token: string) {
  const url = `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders/${orderNo}?shop_no=1&embed=receivers`
  const apiRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const text = await apiRes.text()
  let data: any
  try { data = JSON.parse(text) } catch {
    return { ok: false, status: apiRes.status, body: { error: `Cafe24 응답 파싱 실패 (${apiRes.status})`, raw: text.slice(0, 500), url } }
  }
  return { ok: apiRes.ok, status: apiRes.status, body: apiRes.ok ? (data.order ?? data) : data }
}

async function cafe24Get(path: string, token: string) {
  const res = await fetch(`https://${MALL_ID}.cafe24api.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch {
    throw new Error(`파싱 실패 (${res.status}): ${text.slice(0, 200)}`)
  }
}

// 관리자 메모(주문 단위) — 상품 문제(품절 등) 발생 시 담당자가 남기는 메모라 항상 최신으로 갱신해야 함
async function fetchMemos(orderNo: string, token: string): Promise<string[]> {
  try {
    const data = await cafe24Get(`/api/v2/admin/orders/${orderNo}/memos?shop_no=1`, token)
    return ((data.memos ?? []) as any[]).map(m => m.content).filter(Boolean)
  } catch {
    return []
  }
}

// 픽킹리스트 로케이션 추출 — SoumBatch.tsx의 buildPickingList()와 동일한 규칙
// (공급사 상품명에 로케이션 코드가 텍스트로 박혀있는 걸 여기서 미리 파싱해서 저장)
const LOC_REGEX = /[A-Z]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}/
function deriveLocation(supplierName: string | null): string | null {
  if (!supplierName) return null
  const codeMatch = supplierName.match(LOC_REGEX)?.[0]
  if (codeMatch) return codeMatch
  if (supplierName.includes('미성')) return '미성'
  return null
}

function receiverFieldsOf(order: any) {
  const r = order.receivers?.[0]
  if (!r) return {}
  return {
    receiver_name: r.name ?? null,
    receiver_phone: r.cellphone || r.phone || null,
    zipcode: r.zipcode ?? null,
    address: [r.address1, r.address2].filter(Boolean).join(' ') || null,
    shipping_message: r.shipping_message ?? null,
  }
}

function itemRowsOf(order: any, dbOrderId: string) {
  const items: any[] = order.items ?? []
  return items.map((item: any) => ({
    order_id: dbOrderId,
    cafe24_item_code: item.order_item_code ?? null,
    order_status: item.order_status ?? null,
    product_code: item.variant_code ?? item.product_code ?? '',
    product_name: item.product_name ?? '',
    option_info: item.option_value || null,
    brand: (item.supplier_name ?? '').trim() || null,
    supplier_name: item.supplier_product_name || null,
    location: deriveLocation(item.supplier_product_name || null),
    product_no: item.product_no ?? null,
    quantity: item.quantity ?? 1,
    inspected_qty: 0,
    status: 'collected',
    labels: item.labels ?? [],
  }))
}

// 주문 상태 재확인 — 아직 검수/출고 전인 상품(미배정이든, 배치에 들어갔지만 운송장 등록 전이든)의
// 상태/라벨/메모를 최신화. 운송장이 이미 등록된 상품은 검수 완료 시 status가 'in_transit'으로
// 바뀌어 자동으로 대상에서 빠지므로 별도 제외 불필요 — 단, 보류 배치는 운송장이 있어도 검수를
// 안 거치니 예외로 포함(2026-08-20). 웹훅 없이 이 재확인만으로 취소 감지를 대신함(2026-07-28
// 결정, 검수 전 취소는 CS가 별도로 연락 준다고 확인해서 자동화 범위에 포함 — 2026-08-20).
// 배송중(N3x)/배송완료(N4x)/취소(C계열)로 확인되면 batch_id를 비워 배치에서 자동으로 뺌.
// 대상이 몇 백 건이면 한 번에 다 처리하다 Vercel 60초 제한을 넘길 수 있어서(2026-07-28
// 실제 발생) offset/limit으로 나눠 호출 — 프론트가 진행률 표시하며 반복 호출함
// (POST ?phase=recheck, body: { offset, limit })
async function handleRecheck(req: VercelRequest, res: VercelResponse) {
  try {
    const token = await getToken()
    const { offset = 0, limit = 50 } = req.body ?? {}

    const { data: holdBatch } = await supabase.from('batches').select('id').eq('type', 'hold').maybeSingle()

    // 대상이 1000건 넘으면 Supabase 기본 조회 한도에 조용히 잘려서 뒤쪽 주문은 영원히
    // 재확인 대상에서 빠짐(취소된 주문이 계속 안 걸러지던 원인, 2026-08-20 발견) —
    // range()로 끝까지 페이지네이션
    const PAGE = 1000
    async function fetchAllPages(build: (q: any) => any) {
      let rows: any[] = []
      for (let pOffset = 0; ; pOffset += PAGE) {
        const { data: page } = await build(
          supabase
            .from('order_items')
            .select('id, cafe24_item_code, labels, order_status, batch_id, orders!inner(id, cafe24_order_no)')
            .in('status', ['collected', 'confirmed'])
        ).range(pOffset, pOffset + PAGE - 1)
        rows = rows.concat(page ?? [])
        if (!page || page.length < PAGE) break
      }
      return rows
    }

    // 운송장 없는 상품 — order_status='N20' 조건은 뺌. 이게 있으면 한 번 N20에서 다른
    // 상태(N21 등)로 바뀐 순간부터 그 상품은 재확인 대상에서 영원히 빠져서, 이후 실제로
    // 배송중/취소로 더 진행돼도 다시는 안 잡혔음(20260330-0000907, 2026-08-20 발견)
    let pendingRows = await fetchAllPages(q => q.is('tracking_number', null))

    // 보류 배치는 예외 — 운송장이 이미 붙어있어도 재확인 대상에 포함해야 함. 원래
    // "운송장 있으면 나중에 배송대기 전환 시도할 때 카페24가 취소면 에러로 걸러줌"이
    // 전제였는데, 보류 항목은 그 배송대기 전환 자체를 안 거쳐서 이 안전장치가 전혀
    // 작동 안 함 — 운송장 붙은 채 취소된 보류 주문이 영원히 안 걸러지던 원인
    // (20260811-0000993, 2026-08-20 발견)
    if (holdBatch) {
      const holdRows = await fetchAllPages(q => q.eq('batch_id', holdBatch.id).not('tracking_number', 'is', null))
      pendingRows = pendingRows.concat(holdRows)
    }

    // 로컬에 이미 최종 상태로 확인된 상품은 다시 확인할 필요 없음 — 주문 수집이
    // order_status=N20으로 카페24를 다시 조회하는 방식이라, 혹시 이 중 하나가 다시
    // N20으로 되돌아가도(드문 케이스) 그 날짜로 주문 수집을 돌리면 알아서 다시 잡힘.
    // PostgREST의 not.in 필터는 order_status가 NULL인 행을 걸러버려서(NULL NOT IN (...)
    // 은 NULL) DB 쿼리 대신 여기서 걸러냄 — 아직 한 번도 확인 안 된(NULL) 상품은 계속 대상에
    // 남아야 함 (2026-08-21 결정)
    // 배치 해제/PII 정리 대상 판정 — 예전엔 /^(N[34]|C)/ 정규식만 써서 구매확정(N50)·교환
    // 완료(E40/E41)·반품완료(R30/R40) 상품이 다 끝났는데도 안 걸러졌음(20260806-0000460,
    // 2026-09-22 발견). 취소는 접수 단계(C10 등)부터도 걸러야 해서 RESOLVED_STATUSES와 별개로 챙김
    const RESOLVED_STATUSES = new Set(['N30', 'N40', 'N50', 'C40', 'E40', 'E41', 'R30', 'R40'])
    const isDone = (status: string) => /^C/.test(status) || RESOLVED_STATUSES.has(status)

    // batch_id가 아직 안 지워진 건 로컬 order_status가 이미 최종이어도 배치 해제/PII
    // 정리가 안 끝난 것일 수 있어 계속 대상에 남겨야 함 — 그 판정 조건이 위 isDone으로
    // 바뀌기 전까진 이 정리 자체가 아예 안 됐어서, "이미 최종 확인됨" 필터에 걸려 영원히
    // 재확인 대상에서 빠진 채 방치된 주문들이 있었음(20260724-0000261, 2026-09-22 발견)
    pendingRows = pendingRows.filter((row: any) =>
      !row.order_status || !RESOLVED_STATUSES.has(row.order_status) || row.batch_id)

    const byOrderNo = new Map<string, { id: string; cafe24_item_code: string; labels: string[] | null; order_status: string | null; batch_id: string | null }[]>()
    const orderIdByNo = new Map<string, string>()
    for (const row of (pendingRows ?? []) as any[]) {
      const no = row.orders.cafe24_order_no
      orderIdByNo.set(no, row.orders.id)
      if (!row.cafe24_item_code) continue
      if (!byOrderNo.has(no)) byOrderNo.set(no, [])
      byOrderNo.get(no)!.push({ id: row.id, cafe24_item_code: row.cafe24_item_code, labels: row.labels, order_status: row.order_status, batch_id: row.batch_id })
    }
    // 매 호출마다 순서가 흔들리지 않도록 정렬 후 슬라이스
    const allOrderNos = [...orderIdByNo.keys()].sort()
    const total = allOrderNos.length
    const chunk = allOrderNos.slice(offset, offset + limit)

    let notReady = 0
    let unassigned = 0
    if (chunk.length) {
      // order_id 지정 시 날짜 파라미터 없이도 조회 가능 (날짜 필터엔 3개월 제한이 있어서 회피)
      const data = await cafe24Get(
        `/api/v2/admin/orders?order_id=${chunk.join(',')}&embed=items&shop_no=1&limit=${chunk.length}`,
        token
      )
      const itemsByOrder = new Map<string, any[]>((data.orders ?? []).map((o: any) => [o.order_id, o.items ?? []]))
      const piiClearedOrderIds = new Set<string>()
      for (const no of chunk) {
        const liveItems = itemsByOrder.get(no) ?? []
        // 취소가 감지되면 orders.cancelled_at도 같이 세워야 함 — 이 필드는 출고검수1
        // 화면(SoumOutgoing.tsx)이 "취소 주문입니다, 출고하지 마세요" 경고를 띄우는 유일한
        // 근거인데, 원래 카페24 웹훅(취소 이벤트)만 이걸 채워서 웹훅이 안 온 취소는(예:
        // 이미 운송장이 붙어 보류 배치에 있다가 취소된 건) 재확인이 order_status는 C40으로
        // 갱신해도 cancelled_at은 그대로 null이라 출고검수 경고가 안 떠서 취소 주문이 그대로
        // 검수/출고될 수 있었음(20260825-0000670, 2026-09-01 발견)
        let orderCancelled = false
        for (const pendingItem of byOrderNo.get(no) ?? []) {
          const match = liveItems.find((i: any) => i.order_item_code === pendingItem.cafe24_item_code)
          if (!match) continue
          if (match.order_status && /^C/.test(match.order_status)) orderCancelled = true
          const patch: Record<string, any> = {}
          // 'N20' 고정 비교가 아니라 로컬에 저장된 실제 값과 비교 — N21처럼 중간 상태에서도
          // 계속 최신값을 따라가야 함(위 주석 참고)
          if (match.order_status && match.order_status !== pendingItem.order_status) {
            patch.order_status = match.order_status
            if (match.order_status !== 'N20') notReady++
          }
          // 배치 해제는 "이번에 상태가 바뀐 경우"에만 걸면 안 됨 — order_status는 예전에
          // 이미 N30/N40으로 갱신됐지만 배치해제 로직이 생기기 전이라 그대로 남아있던 건이
          // 185건 있었음(2026-08-20 발견). match.order_status 값 자체로 매번 독립적으로 판단.
          // 배송중/배송완료(N3x/N4x)뿐 아니라 취소(C계열, 취소접수/취소완료 전부)도 우리 쪽에서
          // 더 할 일이 없으니 같이 배치해제 — 검수 전 취소는 CS가 별도로 연락 준다고 확인함
          // (2026-08-20 결정)
          if (match.order_status && isDone(match.order_status) && pendingItem.batch_id) {
            patch.batch_id = null
            unassigned++
          }
          if (JSON.stringify(match.labels ?? []) !== JSON.stringify(pendingItem.labels ?? [])) {
            patch.labels = match.labels ?? []
          }
          if (Object.keys(patch).length) {
            await supabase.from('order_items').update(patch).eq('id', pendingItem.id)
          }
        }

        if (orderCancelled) {
          const orderId = orderIdByNo.get(no)
          if (orderId) await supabase.from('orders').update({ cancelled_at: new Date().toISOString() }).eq('id', orderId)
        }

        // 이 주문의 카페24 상품이 전부 배송중/배송완료/취소로 끝났으면, 출고검수 완료 때와
        // 동일하게 더 이상 필요 없는 고객 개인정보를 비움(SoumOutgoing.tsx의
        // clearPiiIfOrderComplete와 같은 기준 — 자동 배치해제 경로엔 이 처리가 없어서
        // 지금까지 빠져있었음, 2026-08-20). liveItems는 카페24에서 방금 받아온 이 주문의
        // 전체 상품이라 배송방법 불문 다 포함됨 — 로컬 status 대신 이걸로 판단하는 게 더 정확함
        if (liveItems.length && liveItems.every((i: any) => i.order_status && isDone(i.order_status))) {
          const orderId = orderIdByNo.get(no)
          if (orderId) {
            await supabase.from('orders').update({
              customer_name: '(비공개)',
              receiver_name: null,
              receiver_phone: null,
              address: null,
              zipcode: null,
              lat: null,
              lng: null,
              shipping_message: null,
              delivery_memo: null,
              admin_memo: null,
            }).eq('id', orderId)
            piiClearedOrderIds.add(orderId)
          }
        }
      }

      // 관리자 메모는 카페24가 벌크 조회를 지원 안 해서 주문마다 따로 호출해야 함 — 동시에 처리.
      // 방금 PII를 비운 주문은 건너뜀 — 안 그러면 이 단계가 admin_memo를 다시 채워서
      // 비워둔 걸 덮어씀
      const MEMO_CONCURRENCY = 10
      for (let j = 0; j < chunk.length; j += MEMO_CONCURRENCY) {
        const sub = chunk.slice(j, j + MEMO_CONCURRENCY)
        await Promise.all(sub.map(async no => {
          const orderId = orderIdByNo.get(no)
          if (!orderId || piiClearedOrderIds.has(orderId)) return
          const memos = await fetchMemos(no, token)
          await supabase.from('orders').update({ admin_memo: memos }).eq('id', orderId)
        }))
      }
    }

    res.status(200).json({
      processed: chunk.length,
      total,
      not_ready: notReady,
      unassigned,
      next_offset: offset + limit,
      done: offset + limit >= total,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 주문 1건 상세 조회 (orders/[orderNo].ts 병합) — GET ?order_no=xxx
  if (req.method === 'GET') {
    const { order_no } = req.query
    if (!order_no || typeof order_no !== 'string') return res.status(400).json({ error: 'order_no 필요' })
    try {
      const token = await getToken()
      const result = await getOrder(order_no, token)
      return res.status(result.status).json(result.body)
    } catch (e: any) {
      return res.status(500).json({ error: e.message })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()
  if (req.query.phase === 'recheck') return handleRecheck(req, res)

  try {
    const token = await getToken()

    const { start_date, end_date, order_status } = req.body ?? {}
    // 기본값은 KST 기준 (서버는 UTC로 돌므로 +9h 보정)
    const kstNow = (ms = 0) => new Date(Date.now() + 9 * 3600 * 1000 + ms).toISOString().slice(0, 10)
    const endDate = end_date ?? kstNow()
    const startDate = start_date ?? kstNow(-180 * 24 * 3600 * 1000)
    // N20 = 배송준비중. 담당자가 상품준비를 마치고 카페24에서 이 상태로 넘긴 주문만 수집
    const orderStatus = order_status ?? 'N20'

    // 100건씩 페이지네이션으로 전부 수집
    const cafe24Orders: any[] = []
    for (let offset = 0; offset < 5000; offset += 100) {
      const data = await cafe24Get(
        `/api/v2/admin/orders?embed=items,receivers&limit=100&offset=${offset}&shop_no=1&start_date=${startDate}&end_date=${endDate}&order_status=${orderStatus}`,
        token
      )
      if (data.error) return res.status(400).json(data)
      const page: any[] = data.orders ?? []
      cafe24Orders.push(...page)
      if (page.length < 100) break
    }

    // 이미 수집됐지만 아직 배치 미배정인 상품들의 상태/라벨/메모 재확인은 별도 엔드포인트
    // (POST ?phase=recheck)로 분리됨 — 프론트가 offset을 늘려가며 반복 호출

    if (!cafe24Orders.length) {
      return res.status(200).json({ collected: 0, skipped: 0, total: 0, message: '수집할 주문이 없습니다.' })
    }

    const ids = cafe24Orders.map(o => o.order_id)
    // 조회 대상(ids)이 1000건 넘으면 Supabase 기본 조회 한도에 조용히 잘려서, 이미 있는
    // 주문 일부가 existingMap에서 빠져 신규로 착각해 중복 insert될 수 있음(전체 orders가
    // 이미 2,885건인 상황에서 넓은 기간 재수집 시 현실적으로 발생 가능, 2026-08-20 점검) —
    // range()로 끝까지 페이지네이션
    const EXISTING_PAGE = 1000
    let existing: any[] = []
    for (let eOffset = 0; ; eOffset += EXISTING_PAGE) {
      const { data: page } = await supabase
        .from('orders')
        .select('id, cafe24_order_no, order_place_name, order_items(count)')
        .in('cafe24_order_no', ids)
        .range(eOffset, eOffset + EXISTING_PAGE - 1)
      existing = existing.concat(page ?? [])
      if (!page || page.length < EXISTING_PAGE) break
    }
    const existingMap = new Map(
      (existing ?? []).map((e: any) => [
        e.cafe24_order_no,
        { id: e.id, hasPlaceName: !!e.order_place_name, itemCount: e.order_items?.[0]?.count ?? 0 },
      ])
    )

    let collected = 0
    let itemsBackfilled = 0
    const errors: string[] = []

    for (const order of cafe24Orders) {
      const existed = existingMap.get(order.order_id)
      try {
        // 이슈 발생 시 담당자가 남기는 관리자 메모 — 항상 최신 값으로 갱신해야 함
        const memos = await fetchMemos(order.order_id, token)

        if (existed) {
          // 이미 수집된 주문 — 수령인 정보는 이 조회에서 받아온 최신 값으로 항상 덮어씀
          // (예전엔 비어있을 때만 채워서, 한 번 잘못/기본값으로 들어간 뒤엔 영영 안 고쳐졌음)
          if (order.receivers?.[0]) {
            await supabase.from('orders').update(receiverFieldsOf(order)).eq('id', existed.id)
          }
          if (!existed.hasPlaceName && order.order_place_name) {
            await supabase.from('orders').update({ order_place_name: order.order_place_name }).eq('id', existed.id)
          }
          await supabase.from('orders').update({ admin_memo: memos, member_id: order.member_id || null }).eq('id', existed.id)
          if (existed.itemCount === 0) {
            const rows = itemRowsOf(order, existed.id)
            if (rows.length) {
              const { error } = await supabase.from('order_items').insert(rows)
              if (error) throw new Error(`아이템 저장 실패: ${error.message}`)
              itemsBackfilled++
            }
          } else {
            // 기존 상품 행 보정: cafe24_item_code 없으면 상품코드로 매칭해서 채우고,
            // order_item_code로 매칭되면 상품별 order_status/라벨도 최신 값으로 맞춰줌
            const { data: existingItems } = await supabase
              .from('order_items')
              .select('id, product_code, cafe24_item_code, order_status, labels')
              .eq('order_id', existed.id)
            const pool = [...(order.items ?? [])]
            const matchedCodes = new Set<string>()
            for (const row of existingItems ?? []) {
              let match = row.cafe24_item_code
                ? pool.find((i: any) => i.order_item_code === row.cafe24_item_code)
                : undefined
              if (!match && !row.cafe24_item_code) {
                const idx = pool.findIndex((i: any) => (i.variant_code ?? i.product_code ?? '') === row.product_code)
                if (idx >= 0) match = pool.splice(idx, 1)[0]
              }
              if (!match) continue
              if (match.order_item_code) matchedCodes.add(match.order_item_code)
              const patch: Record<string, any> = {}
              if (!row.cafe24_item_code && match.order_item_code) patch.cafe24_item_code = match.order_item_code
              if (match.order_status && match.order_status !== row.order_status) patch.order_status = match.order_status
              if (JSON.stringify(match.labels ?? []) !== JSON.stringify(row.labels ?? [])) patch.labels = match.labels ?? []
              if (Object.keys(patch).length) {
                await supabase.from('order_items').update(patch).eq('id', row.id)
              }
            }

            // 교환/부분 클레임 등으로 주문에 나중에 새로 생긴 라인아이템은 위 매칭에 전혀
            // 안 걸려서 계속 누락됐음(2026-07-30 발견, 20260729-0000782) — 안 걸린 것만 새로 추가
            const newLiveItems = (order.items ?? []).filter((i: any) => i.order_item_code && !matchedCodes.has(i.order_item_code))
            if (newLiveItems.length) {
              const newRows = itemRowsOf({ ...order, items: newLiveItems }, existed.id)
              if (newRows.length) {
                const { error } = await supabase.from('order_items').insert(newRows)
                if (error) throw new Error(`신규 상품 저장 실패: ${error.message}`)
                itemsBackfilled += newRows.length
              }
            }
          }
          continue
        }

        const { data: saved, error } = await supabase.from('orders').insert({
          cafe24_order_no: order.order_id,
          customer_name: order.billing_name,
          order_date: order.order_date,
          order_place_name: order.order_place_name ?? null,
          admin_memo: memos,
          member_id: order.member_id || null,
          ...receiverFieldsOf(order),
        }).select('id').single()

        if (error || !saved) { errors.push(`${order.order_id}: ${error?.message}`); continue }

        const rows = itemRowsOf(order, saved.id)
        if (rows.length) {
          const { error: itemError } = await supabase.from('order_items').insert(rows)
          if (itemError) throw new Error(`아이템 저장 실패: ${itemError.message}`)
        }
        collected++
      } catch (e: any) {
        errors.push(`${order.order_id}: ${e.message}`)
      }
    }

    res.status(200).json({
      collected,
      skipped: cafe24Orders.length - collected,
      items_backfilled: itemsBackfilled,
      total: cafe24Orders.length,
      ...(errors.length && { errors }),
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
