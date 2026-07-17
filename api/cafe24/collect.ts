import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = (process.env.VITE_CAFE24_MALL_ID ?? '').trim()

const supabase = createClient(
  (process.env.VITE_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
)

async function getToken(): Promise<string> {
  const { data } = await supabase.from('cafe24_tokens').select('access_token').eq('id', 1).single()
  if (!data) throw new Error('토큰 없음')
  return data.access_token
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
  if (req.method !== 'POST') return res.status(405).end()

  try {
    const token = await getToken()

    const { start_date, end_date } = req.body ?? {}
    const endDate = end_date ?? new Date().toISOString().slice(0, 10)
    const startDate = start_date ?? new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const data = await cafe24Get(
      `/api/v2/admin/orders?embed=items,receivers&limit=100&shop_no=1&start_date=${startDate}&end_date=${endDate}`,
      token
    )
    if (data.error) return res.status(400).json(data)

    const cafe24Orders: any[] = data.orders ?? []
    if (!cafe24Orders.length) {
      return res.status(200).json({ collected: 0, skipped: 0, total: 0, message: '수집할 주문이 없습니다.' })
    }

    const ids = cafe24Orders.map(o => o.order_id)
    const { data: existing } = await supabase
      .from('orders')
      .select('id, cafe24_order_no, receiver_name, order_items(count)')
      .in('cafe24_order_no', ids)
    const existingMap = new Map(
      (existing ?? []).map((e: any) => [
        e.cafe24_order_no,
        { id: e.id, hasReceiver: !!e.receiver_name, itemCount: e.order_items?.[0]?.count ?? 0 },
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
          if (existed.itemCount === 0) {
            const rows = itemRowsOf(order, existed.id)
            if (rows.length) {
              const { error } = await supabase.from('order_items').insert(rows)
              if (error) throw new Error(`아이템 저장 실패: ${error.message}`)
              itemsBackfilled++
            }
          }
          continue
        }

        const { data: saved, error } = await supabase.from('orders').insert({
          cafe24_order_no: order.order_id,
          customer_name: order.billing_name,
          order_date: order.order_date,
          status: 'collected',
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
