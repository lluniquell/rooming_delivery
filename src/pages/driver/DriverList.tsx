import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import type { Delivery } from '../../types'

const STATUS_LABEL: Record<string, string> = { pending: '대기', done: '완료', failed: '불가' }
const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
}

export default function DriverList() {
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const today = new Date().toISOString().slice(0, 10)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('deliveries')
        .select('*')
        .eq('driver_id', user.id)
        .eq('scheduled_date', today)
        .order('sort_order', { ascending: true, nullsFirst: false })
      setDeliveries(data ?? [])
    }
    load()
  }, [today])

  return (
    <div>
      <h2 className="text-lg font-bold text-gray-800 mb-4">오늘 배송 목록</h2>
      <div className="space-y-3">
        {deliveries.length === 0 && (
          <p className="text-center py-12 text-gray-400">오늘 배정된 배송이 없습니다.</p>
        )}
        {deliveries.map((d, i) => (
          <Link
            key={d.id}
            to={`/delivery/${d.id}`}
            className="block bg-white rounded-xl border p-4 hover:shadow-sm"
          >
            <div className="flex items-start justify-between">
              <div>
                <span className="text-xs text-gray-400 mr-2">{i + 1}번째</span>
                <span className="font-medium">{d.customer_name}</span>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[d.status]}`}>
                {STATUS_LABEL[d.status]}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">{d.address}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
