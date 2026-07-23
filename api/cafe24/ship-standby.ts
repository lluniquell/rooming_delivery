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
        const apiRes = await fetch(
          `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders/${order_no}/shipments`,
          {
            method: 'POST',
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
          errors.push(`${order_no}: ${data.error?.message ?? JSON.stringify(data).slice(0, 150)}`)
        } else {
          updated++
          await supabase.from('orders')
            .update({ cafe24_synced_at: new Date().toISOString() })
            .eq('cafe24_order_no', order_no)
        }
      } catch (e: any) {
        errors.push(`${order_no}: ${e.message}`)
      }
      await new Promise(r => setTimeout(r, 150))
    }

    res.status(200).json({ updated, total: orders.length, ...(errors.length && { errors }) })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
