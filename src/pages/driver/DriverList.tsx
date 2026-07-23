import { useEffect, useState } from 'react'
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

export default function DriverList() {
  const [stops, setStops] = useState<Stop[]>([])
  const today = new Date().toISOString().slice(0, 10)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // 오늘 내가 배정된 루트들을 먼저 찾고, 그 루트에 걸린 주문을 순서대로 가져옴
      const { data: routeRows } = await supabase
        .from('schedule_routes')
        .select('id')
        .eq('date', today)
        .contains('driver_ids', [user.id])
      const routeIds = (routeRows ?? []).map(r => r.id)
      if (!routeIds.length) { setStops([]); return }

      const { data } = await supabase
        .from('orders')
        .select('id, customer_name, receiver_name, address, route_order, delivered_at, delivery_memo')
        .in('route_id', routeIds)
        .eq('scheduled_date', today)
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
  }, [today])

  return (
    <div>
      <h2 className="text-lg font-bold text-gray-800 mb-4">오늘 배송 목록</h2>
      <div className="space-y-3">
        {stops.length === 0 && (
          <p className="text-center py-12 text-gray-400">오늘 배정된 배송이 없습니다.</p>
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
