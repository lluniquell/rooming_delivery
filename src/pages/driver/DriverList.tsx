import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

interface Stop {
  id: string
  customer_name: string
  address: string
  delivered_at: string | null
  delivery_memo: string | null
}

const STATUS_LABEL: Record<string, string> = { pending: '대기', done: '완료', failed: '불가' }
const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
}

function statusOf(s: Stop): 'pending' | 'done' | 'failed' {
  if (s.delivered_at) return 'done'
  if (s.delivery_memo) return 'failed'
  return 'pending'
}

// 로컬(KST) 기준 날짜 — toISOString은 UTC라 오전 9시 전에 하루 밀림
function fmtDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function addDays(dateStr: string, delta: number) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + delta)
  return fmtDate(d)
}
function displayDate(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00`)
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`
}

export default function DriverList() {
  const [stops, setStops] = useState<Stop[]>([])
  const todayStr = fmtDate(new Date())
  const [viewDate, setViewDate] = useState(todayStr)
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // 그 날짜에 내가 배정된 루트들을 먼저 찾고, 그 루트에 걸린 주문을 순서대로 가져옴
      const { data: routeRows } = await supabase
        .from('schedule_routes')
        .select('id')
        .eq('date', viewDate)
        .contains('driver_ids', [user.id])
      const routeIds = (routeRows ?? []).map(r => r.id)
      if (!routeIds.length) { setStops([]); return }

      const { data } = await supabase
        .from('orders')
        .select('id, customer_name, receiver_name, address, route_order, delivered_at, delivery_memo')
        .in('route_id', routeIds)
        .eq('scheduled_date', viewDate)
        .order('route_order', { ascending: true, nullsFirst: false })
      setStops((data ?? []).map((o: any) => ({
        id: o.id,
        customer_name: o.receiver_name || o.customer_name,
        address: o.address,
        delivered_at: o.delivered_at,
        delivery_memo: o.delivery_memo,
      })))
    }
    load()
  }, [viewDate])

  function handleTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]
    touchStart.current = { x: t.clientX, y: t.clientY }
  }
  function handleTouchEnd(e: React.TouchEvent) {
    if (!touchStart.current) return
    const t = e.changedTouches[0]
    const dx = t.clientX - touchStart.current.x
    const dy = t.clientY - touchStart.current.y
    touchStart.current = null
    // 세로 스크롤과 헷갈리지 않도록 가로 이동이 충분히 크고 세로 이동보다 뚜렷할 때만 날짜 전환
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
      setViewDate(d => addDays(d, dx < 0 ? 1 : -1))
    }
  }

  return (
    <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setViewDate(d => addDays(d, -1))}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-gray-100 text-gray-600 text-lg active:bg-gray-200"
        >‹</button>
        <div className="text-center">
          <h2 className="text-lg font-bold text-gray-800">{displayDate(viewDate)} 배송 목록</h2>
          {viewDate !== todayStr && (
            <button onClick={() => setViewDate(todayStr)} className="text-xs text-blue-600 mt-0.5">오늘로 이동</button>
          )}
        </div>
        <button
          onClick={() => setViewDate(d => addDays(d, 1))}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-gray-100 text-gray-600 text-lg active:bg-gray-200"
        >›</button>
      </div>
      <div className="space-y-3">
        {stops.length === 0 && (
          <p className="text-center py-12 text-gray-400">배정된 배송이 없습니다.</p>
        )}
        {stops.map((s, i) => {
          const status = statusOf(s)
          return (
            <Link
              key={s.id}
              to={`/delivery/${s.id}`}
              className="block bg-white rounded-xl border p-4 hover:shadow-sm"
            >
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-xs text-gray-400 mr-2">{i + 1}번째</span>
                  <span className="font-medium">{s.customer_name}</span>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[status]}`}>
                  {STATUS_LABEL[status]}
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-1">{s.address}</p>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
