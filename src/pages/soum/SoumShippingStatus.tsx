import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../../lib/supabase'

const METHODS = ['CJ', '직배', '경동', '팀무버'] as const
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

// 로컬(KST) 기준 날짜 — toISOString은 UTC라 오전 9시 전에 하루 밀림
const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = () => fmtDate(new Date())

interface MethodStat {
  orderCount: number
  skuCount: number
  eaCount: number
}

interface CourierRow { order_id: string; delivery_method: string; quantity: number; shipped_at: string }
interface DirectOrder { id: string; delivered_at: string; order_items: { id: string; delivery_method: string; quantity: number }[] }

// 한 달치는 활동량이 많으면 Supabase 기본 조회 한도(1000건)에 걸릴 수 있어서 끝까지 페이징
async function fetchAllPaged<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const PAGE = 1000
  let rows: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await build(offset, offset + PAGE - 1)
    rows = rows.concat(data ?? [])
    if (!data || data.length < PAGE) break
  }
  return rows
}

export default function SoumShippingStatus() {
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [selectedDate, setSelectedDate] = useState<string | null>(today())
  const [loading, setLoading] = useState(false)
  const [courierRows, setCourierRows] = useState<CourierRow[]>([])
  const [directOrders, setDirectOrders] = useState<DirectOrder[]>([])

  useEffect(() => { load() }, [monthCursor])

  async function load() {
    setLoading(true)
    const start = monthCursor
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1)

    // CJ/경동/팀무버 — 출고검수1에서 배송중 전환된 시각(shipped_at) 기준
    const courierMethods = METHODS.filter(m => m !== '직배') as string[]
    const courier = await fetchAllPaged<CourierRow>((f, t) =>
      supabase
        .from('order_items')
        .select('order_id, delivery_method, quantity, shipped_at')
        .in('delivery_method', courierMethods)
        .gte('shipped_at', start.toISOString())
        .lt('shipped_at', end.toISOString())
        .range(f, t)
    )

    // 직배 — 주문 단위 완료(orders.delivered_at) 기준
    const direct = await fetchAllPaged<DirectOrder>((f, t) =>
      supabase
        .from('orders')
        .select('id, delivered_at, order_items!inner(id, delivery_method, quantity)')
        .eq('order_items.delivery_method', '직배')
        .gte('delivered_at', start.toISOString())
        .lt('delivered_at', end.toISOString())
        .range(f, t)
    )

    setCourierRows(courier)
    setDirectOrders(direct)
    setLoading(false)
  }

  // 날짜×배송방법별 집계 — 달력 칸과 선택한 날짜 상세 카드 둘 다 여기서 파생
  const dayMethodStats = useMemo(() => {
    const map: Record<string, Record<string, MethodStat>> = {}
    const orderIdSets: Record<string, Set<string>> = {}
    function ensure(dateStr: string, method: string) {
      if (!map[dateStr]) map[dateStr] = {}
      if (!map[dateStr][method]) map[dateStr][method] = { orderCount: 0, skuCount: 0, eaCount: 0 }
      return map[dateStr][method]
    }

    for (const r of courierRows) {
      const d = fmtDate(new Date(r.shipped_at))
      const stat = ensure(d, r.delivery_method)
      stat.skuCount += 1
      stat.eaCount += r.quantity
      const key = `${d}__${r.delivery_method}`
      ;(orderIdSets[key] ??= new Set()).add(r.order_id)
    }
    for (const key in orderIdSets) {
      const sep = key.indexOf('__')
      const d = key.slice(0, sep)
      const method = key.slice(sep + 2)
      map[d][method].orderCount = orderIdSets[key].size
    }

    for (const o of directOrders) {
      const d = fmtDate(new Date(o.delivered_at))
      const stat = ensure(d, '직배')
      stat.orderCount += 1
      stat.skuCount += o.order_items?.length ?? 0
      stat.eaCount += (o.order_items ?? []).reduce((s, i) => s + i.quantity, 0)
    }

    return map
  }, [courierRows, directOrders])

  const selectedStats = selectedDate ? (dayMethodStats[selectedDate] ?? {}) : {}

  // 월 합계 — 달력에 표시 중인 달 전체 (날짜 선택과 무관하게 항상 표시)
  const monthStats = useMemo(() => {
    const totals: Record<string, MethodStat> = {}
    for (const day of Object.values(dayMethodStats)) {
      for (const m of METHODS) {
        if (!day[m]) continue
        const t = (totals[m] ??= { orderCount: 0, skuCount: 0, eaCount: 0 })
        t.orderCount += day[m].orderCount
        t.skuCount += day[m].skuCount
        t.eaCount += day[m].eaCount
      }
    }
    return totals
  }, [dayMethodStats])

  const year = monthCursor.getFullYear()
  const month = monthCursor.getMonth()
  const firstWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]

  function changeMonth(delta: number) {
    setMonthCursor(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1))
    setSelectedDate(null)
  }

  const selectedLabel = selectedDate
    ? `${selectedDate} (${WEEKDAYS[new Date(`${selectedDate}T00:00:00`).getDay()]})`
    : null

  return (
    <div className="max-w-4xl">
      <h2 className="text-xl font-bold text-gray-800 mb-6">배송 현황</h2>

      <div className="bg-white rounded-xl border p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => changeMonth(-1)} className="px-2 py-1 rounded hover:bg-gray-100 text-gray-500">‹</button>
          <span className="text-sm font-bold text-gray-800">{year}년 {month + 1}월</span>
          <button onClick={() => changeMonth(1)} className="px-2 py-1 rounded hover:bg-gray-100 text-gray-500">›</button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-xs text-gray-400 mb-1">
          {WEEKDAYS.map(w => <div key={w} className="py-1">{w}</div>)}
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 py-8 text-center">불러오는 중...</p>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {cells.map((day, i) => {
              if (day === null) return <div key={`blank-${i}`} />
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
              const methodStats = dayMethodStats[dateStr] ?? {}
              const entries = METHODS.map(m => [m, methodStats[m]?.orderCount ?? 0] as const).filter(([, c]) => c > 0)
              const total = entries.reduce((sum, [, c]) => sum + c, 0)
              const isToday = dateStr === today()
              const isSelected = dateStr === selectedDate
              return (
                <button
                  key={dateStr}
                  onClick={() => setSelectedDate(dateStr)}
                  className={`text-left rounded-lg p-1.5 min-h-[72px] border transition-colors ${
                    isSelected ? 'border-indigo-500 bg-indigo-50' : isToday ? 'border-indigo-200 bg-indigo-50/30' : 'border-transparent hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span className={`text-xs ${isToday ? 'font-bold text-indigo-600' : 'text-gray-500'}`}>{day}</span>
                    {total > 0 && <span className="text-[11px] font-bold text-gray-700">{total}</span>}
                  </div>
                  <div className="space-y-0.5">
                    {entries.map(([m, c]) => (
                      <div key={m} className="text-[10px] text-gray-500 truncate">{m} {c}</div>
                    ))}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <h3 className="text-sm font-bold text-gray-700 mb-3">{year}년 {month + 1}월 합계</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {METHODS.map(m => (
          <div key={m} className="bg-white rounded-xl border p-4">
            <div className="text-sm text-gray-500 mb-2">{m}</div>
            <div className="text-2xl font-bold text-indigo-600">{monthStats[m]?.orderCount ?? 0}건</div>
            <div className="text-xs text-gray-400 mt-1">SKU {monthStats[m]?.skuCount ?? 0}개 / EA {monthStats[m]?.eaCount ?? 0}개</div>
          </div>
        ))}
      </div>

      {!selectedDate ? (
        <p className="text-sm text-gray-400 text-center py-6">달력에서 날짜를 클릭하면 그 날짜 상세가 여기 표시돼요.</p>
      ) : (
        <>
          <h3 className="text-sm font-bold text-gray-700 mb-3">{selectedLabel} 상세</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {METHODS.map(m => (
              <div key={m} className="bg-white rounded-xl border p-4">
                <div className="text-sm text-gray-500 mb-2">{m}</div>
                <div className="text-2xl font-bold text-indigo-600">{selectedStats[m]?.orderCount ?? 0}건</div>
                <div className="text-xs text-gray-400 mt-1">SKU {selectedStats[m]?.skuCount ?? 0}개 / EA {selectedStats[m]?.eaCount ?? 0}개</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
