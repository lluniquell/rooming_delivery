import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  (process.env.VITE_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
)

// 90026: 주문 취소상태 변경(단건), 90072: 주문 취소상태 변경(일괄) — event_code는 둘 다 cancel_order
const CANCEL_EVENTS = new Set([90026, 90072])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  try {
    const { event_no, resource } = req.body ?? {}

    if (CANCEL_EVENTS.has(event_no) && resource?.order_id) {
      // 일괄취소(90072)는 order_id가 콤마로 여러 건 — 항상 배열로 통일해서 처리
      const orderNos: string[] = String(resource.order_id).split(',').map((s: string) => s.trim()).filter(Boolean)
      if (orderNos.length) {
        await supabase
          .from('orders')
          .update({ cancelled_at: new Date().toISOString() })
          .in('cafe24_order_no', orderNos)
      }
    }

    // 처리 대상이 아닌 이벤트도 200으로 응답 — 그래야 카페24가 실패로 보고 재발송을 반복하지 않음
    res.status(200).json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
