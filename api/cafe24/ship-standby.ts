import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = (process.env.VITE_CAFE24_MALL_ID ?? '').trim()
// 카페24 배송사 코드 — 0006 "CJ대한통운" (일반). 1040 "CJ대한통운(연동)"은
// 카페24가 API로 직접 수정하는 걸 막아둔 코드라("연동된 배송사로 수정 불가" 422 에러) 사용 불가.
// /api/cafe24/carriers 조회로 확인: 0019=롯데택배(오배정 사례), 0006=CJ대한통운(정상 동작 확인)
const CJ_CARRIER_CODE = (process.env.CAFE24_CJ_CARRIER_CODE ?? '0006').trim()

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { orders, carrier_code } = req.body ?? {}
  if (!Array.isArray(orders) || !orders.length) {
    return res.status(400).json({ error: 'orders 배열이 필요합니다. [{ order_no, tracking_no }]' })
  }

  try {
    const token = await getToken()
    const code = (carrier_code ?? CJ_CARRIER_CODE).trim()

    let updated = 0
    const errors: string[] = []

    for (const { order_no, tracking_no } of orders) {
      if (!order_no || !tracking_no) continue
      try {
        const { data: orderRow } = await supabase
          .from('orders')
          .select('id')
          .eq('cafe24_order_no', order_no)
          .maybeSingle()
        if (!orderRow) { errors.push(`${order_no}: 주문을 찾을 수 없음`); continue }

        // 이 주문에서 CJ로 배정된 상품 행만 대상으로 함 — 같은 주문에 경동/직배 상품이
        // 섞여 있어도 그쪽 shipping_code는 절대 건드리지 않기 위함
        const { data: cjItems } = await supabase
          .from('order_items')
          .select('id, cafe24_item_code')
          .eq('order_id', orderRow.id)
          .eq('delivery_method', 'CJ')
          .eq('status', 'confirmed')
        if (!cjItems?.length) { errors.push(`${order_no}: CJ 배정 상품 없음`); continue }

        const itemCodes = new Set(cjItems.map(i => i.cafe24_item_code).filter(Boolean))
        if (!itemCodes.size) { errors.push(`${order_no}: cafe24_item_code 없음 (재수집 필요)`); continue }

        // 카페24 실제 상품 목록에서, 우리가 CJ로 배정한 상품 행(order_item_code)에
        // 해당하는 shipping_code만 추출 — 다른 배송방법 상품의 shipping_code는 제외됨
        const itemsData = await cafe24Get(`/api/v2/admin/orders/${order_no}/items?shop_no=1`, token)
        const shippingCodes = [...new Set(
          (itemsData.items ?? [])
            .filter((i: any) => itemCodes.has(i.order_item_code))
            .map((i: any) => i.shipping_code)
            .filter(Boolean)
        )]
        if (!shippingCodes.length) { errors.push(`${order_no}: 매칭되는 shipping_code 없음`); continue }

        let orderOk = true
        for (const shippingCode of shippingCodes) {
          const apiRes = await fetch(
            `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders/${order_no}/shipments/${shippingCode}`,
            {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                shop_no: 1,
                request: {
                  tracking_no: String(tracking_no),
                  shipping_company_code: code,
                  status: 'standby', // 배송대기
                },
              }),
            }
          )
          const text = await apiRes.text()
          let data: any
          try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }

          if (!apiRes.ok || data.error) {
            orderOk = false
            errors.push(`${order_no} (${shippingCode}): ${data.error?.message ?? JSON.stringify(data).slice(0, 150)}`)
          }
          await new Promise(r => setTimeout(r, 150))
        }

        if (orderOk) {
          updated++
          await supabase.from('order_items')
            .update({ tracking_number: String(tracking_no) })
            .in('id', cjItems.map(i => i.id))
          await supabase.from('orders')
            .update({ cafe24_synced_at: new Date().toISOString() })
            .eq('id', orderRow.id)
        }
      } catch (e: any) {
        errors.push(`${order_no}: ${e.message}`)
      }
    }

    res.status(200).json({ updated, total: orders.length, ...(errors.length && { errors }) })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
