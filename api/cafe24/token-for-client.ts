import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = (process.env.VITE_CAFE24_MALL_ID ?? '').trim()

const supabase = createClient(
  (process.env.VITE_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
)

// 브라우저에서 직접 Cafe24 API를 호출할 수 있도록 토큰 반환 (내부용)
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const { data, error } = await supabase.from('cafe24_tokens').select('access_token').eq('id', 1).single()
  if (error || !data) return res.status(404).json({ error: '토큰 없음' })
  res.status(200).json({ access_token: data.access_token, mall_id: MALL_ID })
}
