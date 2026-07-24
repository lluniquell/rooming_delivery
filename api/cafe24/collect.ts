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
    product_code: item.variant_code ?? item.product_code ?? '',
    product_name: item.product_name ?? '',
    option_info: item.option_value || null,
    brand: (item.supplier_name ?? '').trim() || null,
    supplier_name: item.supplier_product_name || null,
    quantity: item.quantity ?? 1,
    inspected_qty: 0,
    status: 'collected',
  }))
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

    // orders.status에는 카페24의 실제 order_status 코드(N20, N10, C00 등)를 그대로 저장.
    // 이미 수집됐지만 아직 배치 미배정인 주문들의 현재 상태를 다시 조회해서, N20이 아니게
    // 바뀐 것들은 실제 값으로 갱신 — 주문 수집 화면은 status='N20'인 것만 보여주므로 자동으로 숨겨짐
    let notReady = 0
    {
      const { data: pendingRows } = await supabase
        .from('order_items')
        .select('orders!inner(id, cafe24_order_no, status)')
        .eq('status', 'collected')
        .is('batch_id', null)
        .eq('orders.status', 'N20')
      const pendingMap = new Map<string, string>()
      for (const row of (pendingRows ?? []) as any[]) {
        pendingMap.set(row.orders.cafe24_order_no, row.orders.id)
      }
      const pendingNos = [...pendingMap.keys()]
      for (let i = 0; i < pendingNos.length; i += 50) {
        const chunk = pendingNos.slice(i, i + 50)
        // order_status는 주문이 아니라 상품(item) 단위 필드라 embed=items로 조회해서 읽어야 함.
        // order_id 지정 시 날짜 파라미터 없이도 조회 가능 (날짜 필터엔 3개월 제한이 있어서 회피)
        const data = await cafe24Get(
          `/api/v2/admin/orders?order_id=${chunk.join(',')}&embed=items&shop_no=1&limit=${chunk.length}`,
          token
        )
        const statusMap = new Map<string, string>(
          (data.orders ?? [])
            .filter((o: any) => o.items?.[0]?.order_status)
            .map((o: any) => [o.order_id, o.items[0].order_status])
        )
        for (const no of chunk) {
          const st = statusMap.get(no)
          if (st && st !== 'N20') {
            await supabase.from('orders').update({ status: st }).eq('id', pendingMap.get(no)!)
            notReady++
          }
        }
      }
    }

    if (!cafe24Orders.length) {
      return res.status(200).json({ collected: 0, skipped: 0, total: 0, not_ready: notReady, message: '수집할 주문이 없습니다.' })
    }

    const ids = cafe24Orders.map(o => o.order_id)
    const { data: existing } = await supabase
      .from('orders')
      .select('id, cafe24_order_no, status, receiver_name, order_place_name, order_items(count)')
      .in('cafe24_order_no', ids)
    const existingMap = new Map(
      (existing ?? []).map((e: any) => [
        e.cafe24_order_no,
        { id: e.id, status: e.status, hasReceiver: !!e.receiver_name, hasPlaceName: !!e.order_place_name, itemCount: e.order_items?.[0]?.count ?? 0 },
      ])
    )

    let collected = 0
    let itemsBackfilled = 0
    const errors: string[] = []

    for (const order of cafe24Orders) {
      const existed = existingMap.get(order.order_id)
      try {
        if (existed) {
          // 이미 수집된 주문 — 빠진 정보만 보충
          if (!existed.hasReceiver && order.receivers?.[0]) {
            await supabase.from('orders').update(receiverFieldsOf(order)).eq('id', existed.id)
          }
          if (!existed.hasPlaceName && order.order_place_name) {
            await supabase.from('orders').update({ order_place_name: order.order_place_name }).eq('id', existed.id)
          }
          // 이 조회 자체가 order_status=N20 필터라, 여기 걸린 주문은 지금 카페24에서 N20이 맞음.
          // 예전에 N20이 아니게(N10 등) 갱신됐다가 다시 N20으로 돌아온 경우 여기서 다시 맞춰줌
          const currentStatus = order.items?.[0]?.order_status ?? orderStatus
          if (existed.status !== currentStatus) {
            await supabase.from('orders').update({ status: currentStatus }).eq('id', existed.id)
          }
          if (existed.itemCount === 0) {
            const rows = itemRowsOf(order, existed.id)
            if (rows.length) {
              const { error } = await supabase.from('order_items').insert(rows)
              if (error) throw new Error(`아이템 저장 실패: ${error.message}`)
              itemsBackfilled++
            }
          } else {
            // cafe24_item_code 컬럼 추가 이전에 수집된 상품 행 보정 (상품코드 매칭, 중복 시 순서대로 매칭)
            const { data: missing } = await supabase
              .from('order_items')
              .select('id, product_code')
              .eq('order_id', existed.id)
              .is('cafe24_item_code', null)
            if (missing?.length) {
              const pool = [...(order.items ?? [])]
              for (const row of missing) {
                const idx = pool.findIndex((i: any) => (i.variant_code ?? i.product_code ?? '') === row.product_code)
                if (idx >= 0) {
                  const [matched] = pool.splice(idx, 1)
                  await supabase.from('order_items').update({ cafe24_item_code: matched.order_item_code ?? null }).eq('id', row.id)
                }
              }
            }
          }
          continue
        }

        const { data: saved, error } = await supabase.from('orders').insert({
          cafe24_order_no: order.order_id,
          customer_name: order.billing_name,
          order_date: order.order_date,
          status: order.items?.[0]?.order_status ?? orderStatus,
          order_place_name: order.order_place_name ?? null,
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
      not_ready: notReady,
      total: cafe24Orders.length,
      ...(errors.length && { errors }),
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
