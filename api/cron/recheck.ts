import type { VercelRequest, VercelResponse } from '@vercel/node'

// Vercel Cron이 매일 KST 00:00에 호출 — 사람이 "주문 재확인" 버튼을 안 눌러도
// 취소/상태 변경이 자동으로 감지되게 하는 안전망. 부수 효과로 Supabase에 매일
// 쿼리가 들어가서 무료 플랜의 "7일 무활동 시 자동 일시정지"도 같이 방지됨.
//
// handleRecheck 자체가 대상이 몇 백 건이면 한 번에 못 끝내도록 offset/limit
// 페이지네이션으로 설계돼 있어서(Vercel 60초 제한 때문, 2026-07-28), 여기서도
// 프론트가 하던 것과 동일하게 done이 될 때까지 반복 호출한다. 시간 예산을 넘기면
// 그날은 거기까지만 처리하고 끝내며, 다음 날 자정에 offset 0부터 다시 시작한다.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const baseUrl = `https://${req.headers.host}`
  const DEADLINE_MS = 50_000 // maxDuration 60초 안에서 여유를 두고 멈춤
  const start = Date.now()

  let offset = 0
  let totalProcessed = 0
  let totalUnassigned = 0
  const rounds: any[] = []

  try {
    while (Date.now() - start < DEADLINE_MS) {
      const r = await fetch(`${baseUrl}/api/cafe24/collect?phase=recheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, limit: 50 }),
      })
      const data = await r.json()
      if (data.error) {
        rounds.push({ error: data.error })
        break
      }
      totalProcessed += data.processed ?? 0
      totalUnassigned += data.unassigned ?? 0
      if (data.done) { rounds.push({ done: true, total: data.total }); break }
      offset = data.next_offset
    }
  } catch (e: any) {
    rounds.push({ error: e.message })
  }

  res.status(200).json({ ok: true, totalProcessed, totalUnassigned, rounds })
}
