import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = process.env.VITE_CAFE24_MALL_ID!
const CLIENT_ID = process.env.VITE_CAFE24_CLIENT_ID!
const CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET!

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function getAccessToken(): Promise<string> {
  const { data } = await supabase.from('cafe24_tokens').select('*').eq('id', 1).single()
  if (!data) throw new Error('토큰 없음. 카페24 연동 필요.')

  // 만료 10분 전이면 갱신
  if (new Date(data.access_expires_at) < new Date(Date.now() + 10 * 60 * 1000)) {
    const tokenRes = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refresh_token }),
    })
    const refreshed = await tokenRes.json()
    await supabase.from('cafe24_tokens').upsert({
      id: 1,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      access_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })
    return refreshed.access_token
  }

  return data.access_token
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { orderNo } = req.query
  try {
    const token = await getAccessToken()
    const url = `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders/${orderNo}?shop_no=1`
    const apiRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    const text = await apiRes.text()
    let data: any
    try { data = JSON.parse(text) } catch {
      return res.status(apiRes.status).json({ error: `Cafe24 응답 파싱 실패 (${apiRes.status})`, raw: text.slice(0, 500), url })
    }
    if (!apiRes.ok) return res.status(apiRes.status).json(data)
    res.status(200).json(data.order ?? data)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
