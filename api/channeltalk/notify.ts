import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? '').trim()
const ACCESS_KEY = (process.env.CHANNEL_TALK_ACCESS_KEY ?? '').trim()
const ACCESS_SECRET = (process.env.CHANNEL_TALK_ACCESS_SECRET ?? '').trim()
const GROUP_NAME = (process.env.CHANNEL_TALK_GROUP_NAME ?? '').trim()

const supabase = createClient(SUPABASE_URL, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim())

// 채널톡 오픈 API는 메시지에 새 이미지를 업로드/첨부하는 기능이 없고(files는 채널 자체
// 스토리지에 이미 있는 파일만 참조 가능), plainText/blocks로 텍스트·링크만 보낼 수 있음
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!ACCESS_KEY || !ACCESS_SECRET || !GROUP_NAME) {
    return res.status(500).json({ error: 'CHANNEL_TALK_ACCESS_KEY / CHANNEL_TALK_ACCESS_SECRET / CHANNEL_TALK_GROUP_NAME 환경변수가 설정되지 않았습니다.' })
  }

  const { order_id } = req.body ?? {}
  if (!order_id) return res.status(400).json({ error: 'order_id 필요' })

  const { data: order } = await supabase
    .from('orders')
    .select('cafe24_order_no, customer_name, receiver_name, address')
    .eq('id', order_id)
    .maybeSingle()
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' })

  const { data: photos } = await supabase
    .from('delivery_photos')
    .select('storage_path')
    .eq('order_id', order_id)
  const photoUrls = (photos ?? []).map(p => `${SUPABASE_URL}/storage/v1/object/public/delivery-photos/${p.storage_path}`)

  const name = order.receiver_name || order.customer_name
  const lines = [
    `[배송완료] ${name} (${order.cafe24_order_no})`,
    order.address ?? '',
    ...(photoUrls.length ? ['', '사진:', ...photoUrls] : []),
  ]

  try {
    const chRes = await fetch(`https://api.channel.io/open/groups/@${encodeURIComponent(GROUP_NAME)}/messages`, {
      method: 'POST',
      headers: {
        'x-access-key': ACCESS_KEY,
        'x-access-secret': ACCESS_SECRET,
        'Channel-Version': '2026-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plainText: lines.filter(Boolean).join('\n') }),
    })
    const chData = await chRes.json()
    if (!chRes.ok) return res.status(502).json({ error: chData })
    res.status(200).json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
