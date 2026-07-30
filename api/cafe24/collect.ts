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
  const url = `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders/${orderNo}?shop_no=1`
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

// 미배정 재확인 — 아직 운송장이 없는 상품(미배정이든, 배치에 들어갔지만 운송장 등록 전이든)의
// 상태/라벨/메모를 최신화. 운송장이 이미 등록된 상품은 대상에서 제외 — 그건 나중에 배송대기
// 전환 시도할 때 카페24가 취소 주문이면 알아서 에러로 걸러줌. 웹훅 없이 이 재확인만으로
// 취소 감지를 대신함(2026-07-28 결정) — 배치에 들어간 채로 취소된 상품도 order_status가
// 갱신되면 화면엔 안 보여도(주문 수집 화면은 batch_id null인 것만 보여줌) 내부 데이터는 정확해짐.
// 대상이 몇 백 건이면 한 번에 다 처리하다 Vercel 60초 제한을 넘길 수 있어서(2026-07-28
// 실제 발생) offset/limit으로 나눠 호출 — 프론트가 진행률 표시하며 반복 호출함
// (POST ?phase=recheck, body: { offset, limit })
async function handleRecheck(req: VercelRequest, res: VercelResponse) {
  try {
    const token = await getToken()
    const { offset = 0, limit = 50 } = req.body ?? {}

    const { data: pendingRows } = await supabase
      .from('order_items')
      .select('id, cafe24_item_code, labels, orders!inner(id, cafe24_order_no)')
      .in('status', ['collected', 'confirmed'])
      .is('tracking_number', null)
      .eq('order_status', 'N20')

    const byOrderNo = new Map<string, { id: string; cafe24_item_code: string; labels: string[] | null }[]>()
    const orderIdByNo = new Map<string, string>()
    for (const row of (pendingRows ?? []) as any[]) {
      const no = row.orders.cafe24_order_no
      orderIdByNo.set(no, row.orders.id)
      if (!row.cafe24_item_code) continue
      if (!byOrderNo.has(no)) byOrderNo.set(no, [])
      byOrderNo.get(no)!.push({ id: row.id, cafe24_item_code: row.cafe24_item_code, labels: row.labels })
    }
    // 매 호출마다 순서가 흔들리지 않도록 정렬 후 슬라이스
    const allOrderNos = [...orderIdByNo.keys()].sort()
    const total = allOrderNos.length
    const chunk = allOrderNos.slice(offset, offset + limit)

    let notReady = 0
    if (chunk.length) {
      // order_id 지정 시 날짜 파라미터 없이도 조회 가능 (날짜 필터엔 3개월 제한이 있어서 회피)
      const data = await cafe24Get(
        `/api/v2/admin/orders?order_id=${chunk.join(',')}&embed=items&shop_no=1&limit=${chunk.length}`,
        token
      )
      const itemsByOrder = new Map<string, any[]>((data.orders ?? []).map((o: any) => [o.order_id, o.items ?? []]))
      for (const no of chunk) {
        const liveItems = itemsByOrder.get(no) ?? []
        for (const pendingItem of byOrderNo.get(no) ?? []) {
          const match = liveItems.find((i: any) => i.order_item_code === pendingItem.cafe24_item_code)
          if (!match) continue
          const patch: Record<string, any> = {}
          if (match.order_status && match.order_status !== 'N20') { patch.order_status = match.order_status; notReady++ }
          if (JSON.stringify(match.labels ?? []) !== JSON.stringify(pendingItem.labels ?? [])) {
            patch.labels = match.labels ?? []
          }
          if (Object.keys(patch).length) {
            await supabase.from('order_items').update(patch).eq('id', pendingItem.id)
          }
        }
      }

      // 관리자 메모는 카페24가 벌크 조회를 지원 안 해서 주문마다 따로 호출해야 함 — 동시에 처리
      const MEMO_CONCURRENCY = 10
      for (let j = 0; j < chunk.length; j += MEMO_CONCURRENCY) {
        const sub = chunk.slice(j, j + MEMO_CONCURRENCY)
        await Promise.all(sub.map(async no => {
          const orderId = orderIdByNo.get(no)
          if (!orderId) return
          const memos = await fetchMemos(no, token)
          await supabase.from('orders').update({ admin_memo: memos }).eq('id', orderId)
        }))
      }
    }

    res.status(200).json({
      processed: chunk.length,
      total,
      not_ready: notReady,
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
    const { data: existing } = await supabase
      .from('orders')
      .select('id, cafe24_order_no, order_place_name, order_items(count)')
      .in('cafe24_order_no', ids)
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
          await supabase.from('orders').update({ admin_memo: memos }).eq('id', existed.id)
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
            for (const row of existingItems ?? []) {
              let match = row.cafe24_item_code
                ? pool.find((i: any) => i.order_item_code === row.cafe24_item_code)
                : undefined
              if (!match && !row.cafe24_item_code) {
                const idx = pool.findIndex((i: any) => (i.variant_code ?? i.product_code ?? '') === row.product_code)
                if (idx >= 0) match = pool.splice(idx, 1)[0]
              }
              if (!match) continue
              const patch: Record<string, any> = {}
              if (!row.cafe24_item_code && match.order_item_code) patch.cafe24_item_code = match.order_item_code
              if (match.order_status && match.order_status !== row.order_status) patch.order_status = match.order_status
              if (JSON.stringify(match.labels ?? []) !== JSON.stringify(row.labels ?? [])) patch.labels = match.labels ?? []
              if (Object.keys(patch).length) {
                await supabase.from('order_items').update(patch).eq('id', row.id)
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
