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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  // orders: [{ order_no, item_codes }] — item_codes가 있으면 그 상품(order_item_code)들의
  // shipping_code만 전환, 없으면(구버전 호출 호환) 주문의 모든 shipping_code를 전환
  const { order_nos, orders } = req.body ?? {}
  const targets: { order_no: string; item_codes?: string[] }[] =
    Array.isArray(orders) ? orders
    : Array.isArray(order_nos) ? order_nos.map((o: string) => ({ order_no: o }))
    : []
  if (!targets.length) {
    return res.status(400).json({ error: 'order_nos 또는 orders 배열이 필요합니다.' })
  }

  try {
    const token = await getToken()
    let updated = 0
    const errors: string[] = []

    for (const { order_no: orderNo, item_codes } of targets) {
      if (!orderNo) continue
      try {
        // shipping_code는 D-{주문번호}-00으로 고정이 아님 — 상품(라인)이 서로 다른
        // 배송 그룹으로 나뉘면 -01, -02 등 별도 코드를 갖는 경우가 실제로 있어서,
        // 주문의 실제 아이템을 조회해 존재하는 shipping_code를 전부 처리해야 함
        const itemsData = await cafe24Get(`/api/v2/admin/orders/${orderNo}/items?shop_no=1`, token)
        const allItems: any[] = itemsData.items ?? []

        // item_codes가 지정된 경우, 그 상품(order_item_code)에 해당하는 shipping_code만 대상으로 함
        // — 같은 주문에 다른 배송방법 상품이 섞여 있어도 그쪽 그룹은 건드리지 않기 위함
        const scoped = item_codes?.length
          ? allItems.filter(i => item_codes.includes(i.order_item_code))
          : allItems
        const shippingCodes = [...new Set(scoped.map((i: any) => i.shipping_code).filter(Boolean))]

        if (!shippingCodes.length) {
          errors.push(`${orderNo}: shipping_code를 찾을 수 없음`)
          continue
        }

        for (const shippingCode of shippingCodes) {
          const apiRes = await fetch(
            `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders/${orderNo}/shipments/${shippingCode}`,
            {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ shop_no: 1, request: { status: 'shipping' } }),
            }
          )
          const text = await apiRes.text()
          let data: any
          try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }

          if (!apiRes.ok || data.error) {
            errors.push(`${orderNo} (${shippingCode}): ${data.error?.message ?? JSON.stringify(data).slice(0, 150)}`)
          }
          await new Promise(r => setTimeout(r, 150))
        }
        updated++
      } catch (e: any) {
        errors.push(`${orderNo}: ${e.message}`)
      }
    }

    res.status(200).json({ updated, total: targets.length, ...(errors.length && { errors }) })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
