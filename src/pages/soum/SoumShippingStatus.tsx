import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

const METHODS = ['CJ', '직배', '경동', '팀무버'] as const

// 로컬(KST) 기준 날짜 — toISOString은 UTC라 오전 9시 전에 하루 밀림
const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = () => fmtDate(new Date())

interface MethodStat {
  orderCount: number
  skuCount: number
  eaCount: number
}

export default function SoumShippingStatus() {
  const [date, setDate] = useState(today())
  const [stats, setStats] = useState<Record<string, MethodStat>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => { load() }, [date])

  async function load() {
    setLoading(true)
    const dayStart = new Date(`${date}T00:00:00`)
    const dayEnd = new Date(dayStart.getTime() + 86400000)

    const next: Record<string, MethodStat> = {}

    // CJ/경동/팀무버 — 출고검수1에서 배송중 전환된 시각(shipped_at) 기준
    const courierMethods = METHODS.filter(m => m !== '직배') as string[]
    const { data: courierRows } = await supabase
      .from('order_items')
      .select('order_id, delivery_method, quantity')
      .in('delivery_method', courierMethods)
      .gte('shipped_at', dayStart.toISOString())
      .lt('shipped_at', dayEnd.toISOString())

    for (const m of courierMethods) {
      const rows = (courierRows ?? []).filter(r => r.delivery_method === m)
      next[m] = {
        orderCount: new Set(rows.map(r => r.order_id)).size,
        skuCount: rows.length,
        eaCount: rows.reduce((sum, r) => sum + r.quantity, 0),
      }
    }

    // 직배 — 주문 단위 완료(orders.delivered_at) 기준
    const { data: directOrders } = await supabase
      .from('orders')
      .select('id, order_items!inner(id, delivery_method, quantity)')
      .eq('order_items.delivery_method', '직배')
      .gte('delivered_at', dayStart.toISOString())
      .lt('delivered_at', dayEnd.toISOString())

    const directSkuCount = (directOrders ?? []).reduce(
      (sum: number, o: any) => sum + (o.order_items?.length ?? 0), 0
    )
    const directEaCount = (directOrders ?? []).reduce(
      (sum: number, o: any) => sum + (o.order_items ?? []).reduce((s: number, i: any) => s + i.quantity, 0), 0
    )
    next['직배'] = { orderCount: (directOrders ?? []).length, skuCount: directSkuCount, eaCount: directEaCount }

    setStats(next)
    setLoading(false)
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800">배송 현황</h2>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">불러오는 중...</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {METHODS.map(m => (
            <div key={m} className="bg-white rounded-xl border p-4">
              <div className="text-sm text-gray-500 mb-2">{m}</div>
              <div className="text-2xl font-bold text-indigo-600">{stats[m]?.orderCount ?? 0}건</div>
              <div className="text-xs text-gray-400 mt-1">SKU {stats[m]?.skuCount ?? 0}개 / EA {stats[m]?.eaCount ?? 0}개</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
