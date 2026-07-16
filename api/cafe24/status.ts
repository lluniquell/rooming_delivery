import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  (process.env.VITE_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
)

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const { data, error } = await supabase.from('cafe24_tokens').select('*').eq('id', 1).single()
  if (error || !data) return res.status(404).json({ error: '토큰 없음', detail: error?.message })

  const now = new Date()
  res.status(200).json({
    access_expires_at: data.access_expires_at,
    refresh_expires_at: data.refresh_expires_at,
    updated_at: data.updated_at,
    access_valid: new Date(data.access_expires_at) > now,
    refresh_valid: new Date(data.refresh_expires_at) > now,
    access_token_prefix: data.access_token?.slice(0, 10) + '...',
  })
}
