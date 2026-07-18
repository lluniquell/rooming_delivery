import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = (process.env.VITE_CAFE24_MALL_ID ?? '').trim()

const supabase = createClient(
  (process.env.VITE_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
)

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const { data } = await supabase.from('cafe24_tokens').select('access_token').eq('id', 1).single()
    if (!data) throw new Error('토큰 없음')

    const apiRes = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/admin/carriers?shop_no=1`, {
      headers: { Authorization: `Bearer ${data.access_token}`, 'Content-Type': 'application/json' },
    })
    const text = await apiRes.text()
    try { res.status(apiRes.status).json(JSON.parse(text)) }
    catch { res.status(apiRes.status).json({ raw: text.slice(0, 500) }) }
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
