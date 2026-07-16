import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = (process.env.VITE_CAFE24_MALL_ID ?? '').trim()
const CLIENT_ID = (process.env.VITE_CAFE24_CLIENT_ID ?? '').trim()
const CLIENT_SECRET = (process.env.CAFE24_CLIENT_SECRET ?? '').trim()

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 내부 크론 또는 서버에서만 호출 가능하도록 시크릿 체크
  const secret = req.headers['x-cron-secret']
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  try {
    // 현재 토큰 조회
    const { data: token, error: fetchError } = await supabase
      .from('cafe24_tokens')
      .select('*')
      .eq('id', 1)
      .single()

    if (fetchError || !token) {
      return res.status(400).json({ error: '저장된 토큰 없음. OAuth 재인증 필요.' })
    }

    // refresh token 만료 체크
    if (new Date(token.refresh_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Refresh token 만료. OAuth 재인증 필요.' })
    }

    // access token 갱신
    const tokenRes = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      }),
    })

    if (!tokenRes.ok) {
      const text = await tokenRes.text()
      return res.status(400).json({ error: `카페24 갱신 실패: ${text}` })
    }

    const data = await tokenRes.json()

    const { error: saveError } = await supabase.from('cafe24_tokens').upsert({
      id: 1,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      access_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })

    if (saveError) {
      return res.status(500).json({ error: `토큰 저장 실패: ${saveError.message}` })
    }

    res.status(200).json({ ok: true, updated_at: new Date().toISOString() })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
