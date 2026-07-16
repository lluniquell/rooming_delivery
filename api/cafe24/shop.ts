import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = (process.env.VITE_CAFE24_MALL_ID ?? '').trim()

const supabase = createClient(
  (process.env.VITE_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
)

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const { data: tokenRow } = await supabase.from('cafe24_tokens').select('access_token').eq('id', 1).single()
  if (!tokenRow) return res.status(400).json({ error: '토큰 없음' })

  const url = `https://${MALL_ID}.cafe24api.com/api/v2/admin/shops/1`
  const apiRes = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokenRow.access_token}`,
      'Content-Type': 'application/json',
      'X-Cafe24-Api-Version': '2023-08-01',
    },
  })
  const text = await apiRes.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 1000), status: apiRes.status } }
  res.status(apiRes.status).json(data)
}
