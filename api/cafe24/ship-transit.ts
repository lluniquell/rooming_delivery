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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { order_nos } = req.body ?? {}
  if (!Array.isArray(order_nos) || !order_nos.length) {
    return res.status(400).json({ error: 'order_nos 배열이 필요합니다.' })
  }

  try {
    const token = await getToken()
    let updated = 0
    const errors: string[] = []

    for (const orderNo of order_nos) {
      if (!orderNo) continue
      try {
        // 운송장 업로드 시 이미 만들어진 배송 건 코드 — 패턴이 항상 D-{주문번호}-00 로 고정됨 (실측 확인됨)
        const shippingCode = `D-${orderNo}-00`
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
          errors.push(`${orderNo}: ${data.error?.message ?? JSON.stringify(data).slice(0, 150)}`)
        } else {
          updated++
        }
      } catch (e: any) {
        errors.push(`${orderNo}: ${e.message}`)
      }
      await new Promise(r => setTimeout(r, 150))
    }

    res.status(200).json({ updated, total: order_nos.length, ...(errors.length && { errors }) })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
