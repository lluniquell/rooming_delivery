import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? '').trim()
const supabase = createClient(SUPABASE_URL, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim())

// 채널톡 메시지에 넣기엔 너무 긴 Supabase 스토리지 URL(주문id/사진id/타임스탬프.jpg)을
// 짧게 줄이기 위한 리다이렉트 — delivery_photos.id 하나만으로 실제 공개 URL로 넘겨줌(2026-09-22)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { id } = req.query
  if (!id || typeof id !== 'string') return res.status(400).send('id required')

  const { data } = await supabase.from('delivery_photos').select('storage_path').eq('id', id).maybeSingle()
  if (!data) return res.status(404).send('사진을 찾을 수 없습니다.')

  res.redirect(302, `${SUPABASE_URL}/storage/v1/object/public/delivery-photos/${data.storage_path}`)
}
