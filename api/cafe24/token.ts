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
  if (req.method !== 'POST') return res.status(405).end()

  const { code, redirect_uri } = req.body

  try {
    const tokenRes = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri,
      }),
    })

    if (!tokenRes.ok) {
      const text = await tokenRes.text()
      return res.status(400).json({ error: text })
    }

    const data = await tokenRes.json()

    await supabase.from('cafe24_tokens').upsert({
      id: 1,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      access_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })

    res.status(200).json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
