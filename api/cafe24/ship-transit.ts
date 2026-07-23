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
        // shipping_code는 D-{주문번호}-00으로 고정이 아님 — 상품(라인)이 서로 다른
        // 배송 그룹으로 나뉘면 -01, -02 등 별도 코드를 갖는 경우가 실제로 있어서,
        // 주문의 실제 아이템을 조회해 존재하는 shipping_code를 전부 처리해야 함
        const itemsData = await cafe24Get(`/api/v2/admin/orders/${orderNo}/items?shop_no=1`, token)
        const shippingCodes = [...new Set((itemsData.items ?? []).map((i: any) => i.shipping_code).filter(Boolean))]

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

    res.status(200).json({ updated, total: order_nos.length, ...(errors.length && { errors }) })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
