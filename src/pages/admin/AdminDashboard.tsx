import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { getCafe24AuthUrl } from '../../lib/cafe24'
import type { Delivery, Driver } from '../../types'

const STATUS_LABEL: Record<string, string> = { pending: '대기', done: '완료', failed: '불가' }
const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
}

export default function AdminDashboard() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [filterDriver, setFilterDriver] = useState('')

  useEffect(() => {
    supabase.from('drivers').select('*').eq('is_active', true).then(({ data }) => setDrivers(data ?? []))
  }, [])

  useEffect(() => {
    const query = supabase
      .from('deliveries')
      .select('*, driver:drivers(*)')
      .eq('scheduled_date', date)
      .order('sort_order', { ascending: true, nullsFirst: false })

    query.then(({ data }) => setDeliveries(data ?? []))

    const channel = supabase
      .channel('deliveries')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, () => {
        query.then(({ data }) => setDeliveries(data ?? []))
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [date])

  const filtered = filterDriver ? deliveries.filter(d => d.driver_id === filterDriver) : deliveries

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <h2 className="text-xl font-bold text-gray-800">배송 현황</h2>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm"
        />
        <select
          value={filterDriver}
          onChange={e => setFilterDriver(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">전체 배송원</option>
          {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <span className="text-sm text-gray-500 ml-auto">총 {filtered.length}건</span>
        <a
          href={getCafe24AuthUrl()}
          className="text-xs text-gray-400 hover:text-blue-500 border rounded px-2 py-1"
        >
          카페24 연동
        </a>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">순서</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">주문번호</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">고객명</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">주소</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">배송원</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">상태</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="text-center py-12 text-gray-400">배송 건이 없습니다.</td></tr>
            )}
            {filtered.map(d => (
              <tr key={d.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-400">{d.sort_order ?? '-'}</td>
                <td className="px-4 py-3 font-mono">{d.cafe24_order_no}</td>
                <td className="px-4 py-3">{d.customer_name}</td>
                <td className="px-4 py-3 text-gray-600 max-w-xs truncate">{d.address}</td>
                <td className="px-4 py-3">{(d.driver as Driver)?.name ?? <span className="text-gray-400">미배정</span>}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[d.status]}`}>
                    {STATUS_LABEL[d.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
