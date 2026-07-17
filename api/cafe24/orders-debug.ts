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
  const { start_date, end_date } = req.query
  const today = new Date().toISOString().slice(0, 10)
  const s = (start_date as string) ?? today
  const e = (end_date as string) ?? today

  try {
    const token = await getToken()
    const url = `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders?limit=100&shop_no=1&start_date=${s}&end_date=${e}`
    const apiRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    const text = await apiRes.text()
    let data: any
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 1000) } }

    const orders = data.orders ?? []
    res.status(200).json({
      url,
      status: apiRes.status,
      count: orders.length,
      order_ids: orders.map((o: any) => o.order_id),
      first_order: orders[0] ?? null,
      raw_keys: Object.keys(data),
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
