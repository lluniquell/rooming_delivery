import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'

const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = () => fmtDate(new Date())
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

interface StaffStats {
  name: string
  picked: number
  miseong: number
  shipped: number
  stow: number
}

function addTo(map: Record<string, StaffStats>, name: string | null, key: keyof Omit<StaffStats, 'name'>, qty: number) {
  const staffName = name?.trim() || '(미상)'
  if (!map[staffName]) map[staffName] = { name: staffName, picked: 0, miseong: 0, shipped: 0, stow: 0 }
  map[staffName][key] += qty
}

interface RawPicked { quantity: number; picked_by: string | null; picked_at: string }
interface RawMiseong { quantity: number; picked_by: string | null; picked_date: string }
interface RawShipped { quantity: number; shipped_by: string | null; shipped_at: string }
interface RawStow { quantity: number; staff_name: string | null; created_at: string }
interface RawOrder { created_at: string }

// 한 달치 데이터도 활동량이 많으면 Supabase 기본 조회 한도(1000건)에 걸릴 수 있어서
// (이 프로젝트에서 이미 여러 번 겪은 문제) 끝까지 페이징해서 가져옴
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

export default function SoumDashboard() {
  const [snapshotLoading, setSnapshotLoading] = useState(true)
  const [unassignedCount, setUnassignedCount] = useState(0)
  const [holdCount, setHoldCount] = useState(0)

  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [monthLoading, setMonthLoading] = useState(true)
  const [selectedDate, setSelectedDate] = useState<string | null>(today())

  const [pickedRows, setPickedRows] = useState<RawPicked[]>([])
  const [miseongRows, setMiseongRows] = useState<RawMiseong[]>([])
  const [shippedRows, setShippedRows] = useState<RawShipped[]>([])
  const [stowRows, setStowRows] = useState<RawStow[]>([])
  const [orderRows, setOrderRows] = useState<RawOrder[]>([])

  useEffect(() => { loadSnapshot() }, [])
  useEffect(() => { loadMonth() }, [monthCursor])

  // 미배정/보류는 히스토리 개념이 아니라 "지금 현재" 스냅샷이라 날짜 선택과 무관하게 한 번만 로드
  async function loadSnapshot() {
    setSnapshotLoading(true)
    const { data: holdBatch } = await supabase.from('batches').select('id').eq('type', 'hold').maybeSingle()

    async function loadUnassignedOrderIds() {
      return fetchAllPaged<{ order_id: string }>((f, t) =>
        supabase.from('order_items').select('order_id').eq('status', 'collected').is('batch_id', null).range(f, t)
      )
    }

    const [unassignedRows, { count: holdItemCount }] = await Promise.all([
      loadUnassignedOrderIds(),
      holdBatch
        ? supabase.from('order_items').select('id', { count: 'exact', head: true }).eq('status', 'confirmed').eq('batch_id', holdBatch.id)
        : Promise.resolve({ count: 0 } as any),
    ])

    setUnassignedCount(new Set(unassignedRows.map(r => r.order_id)).size)
    setHoldCount(holdItemCount ?? 0)
    setSnapshotLoading(false)
  }

  async function loadMonth() {
    setMonthLoading(true)
    const start = monthCursor
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    const startStr = fmtDate(start)
    const endStr = fmtDate(end)

    const [picked, miseong, shipped, stow, orders] = await Promise.all([
      fetchAllPaged<RawPicked>((f, t) =>
        supabase.from('order_items').select('quantity, picked_by, picked_at')
          .gte('picked_at', start.toISOString()).lt('picked_at', end.toISOString()).range(f, t)),
      fetchAllPaged<RawMiseong>((f, t) =>
        supabase.from('miseong_pickups').select('quantity, picked_by, picked_date')
          .gte('picked_date', startStr).lt('picked_date', endStr).not('fetched_at', 'is', null).range(f, t)),
      fetchAllPaged<RawShipped>((f, t) =>
        supabase.from('order_items').select('quantity, shipped_by, shipped_at')
          .gte('shipped_at', start.toISOString()).lt('shipped_at', end.toISOString()).range(f, t)),
      fetchAllPaged<RawStow>((f, t) =>
        supabase.from('stow_events').select('quantity, staff_name, created_at')
          .gte('created_at', start.toISOString()).lt('created_at', end.toISOString()).range(f, t)),
      fetchAllPaged<RawOrder>((f, t) =>
        supabase.from('orders').select('created_at')
          .gte('created_at', start.toISOString()).lt('created_at', end.toISOString()).range(f, t)),
    ])

    setPickedRows(picked)
    setMiseongRows(miseong)
    setShippedRows(shipped)
    setStowRows(stow)
    setOrderRows(orders)
    setMonthLoading(false)
  }

  // 날짜별 달력 칸에 쓸 요약(담당자별 합계 수량) — 카테고리 구분 없이 전부 합산
  const dayIndex = useMemo(() => {
    const map: Record<string, { staff: Record<string, number>; total: number }> = {}
    function add(dateStr: string, name: string | null, qty: number) {
      const staffName = name?.trim() || '(미상)'
      if (!map[dateStr]) map[dateStr] = { staff: {}, total: 0 }
      map[dateStr].staff[staffName] = (map[dateStr].staff[staffName] ?? 0) + qty
      map[dateStr].total += qty
    }
    for (const r of pickedRows) add(fmtDate(new Date(r.picked_at)), r.picked_by, r.quantity)
    for (const r of miseongRows) add(r.picked_date, r.picked_by, r.quantity)
    for (const r of shippedRows) add(fmtDate(new Date(r.shipped_at)), r.shipped_by, r.quantity)
    for (const r of stowRows) add(fmtDate(new Date(r.created_at)), r.staff_name, r.quantity)
    return map
  }, [pickedRows, miseongRows, shippedRows, stowRows])

  const collectedByDay = useMemo(() => {
    const map: Record<string, number> = {}
    for (const r of orderRows) {
      const d = fmtDate(new Date(r.created_at))
      map[d] = (map[d] ?? 0) + 1
    }
    return map
  }, [orderRows])

  // 선택한 날짜의 상세(카테고리별 담당자 표) — 달력용 dayIndex와 달리 피킹/미성/출고/입고를 구분해야 해서 따로 계산
  const selectedDayStats = useMemo(() => {
    if (!selectedDate) return []
    const map: Record<string, StaffStats> = {}
    for (const r of pickedRows) if (fmtDate(new Date(r.picked_at)) === selectedDate) addTo(map, r.picked_by, 'picked', r.quantity)
    for (const r of miseongRows) if (r.picked_date === selectedDate) addTo(map, r.picked_by, 'miseong', r.quantity)
    for (const r of shippedRows) if (fmtDate(new Date(r.shipped_at)) === selectedDate) addTo(map, r.shipped_by, 'shipped', r.quantity)
    for (const r of stowRows) if (fmtDate(new Date(r.created_at)) === selectedDate) addTo(map, r.staff_name, 'stow', r.quantity)
    return Object.values(map).sort((a, b) =>
      (b.picked + b.miseong + b.shipped + b.stow) - (a.picked + a.miseong + a.shipped + a.stow)
    )
  }, [pickedRows, miseongRows, shippedRows, stowRows, selectedDate])

  const collectedForSelected = selectedDate ? (collectedByDay[selectedDate] ?? 0) : 0
  const miseongForSelected = selectedDate
    ? miseongRows.filter(r => r.picked_date === selectedDate).reduce((sum, r) => sum + r.quantity, 0)
    : 0
  const shippedForSelected = selectedDate
    ? shippedRows.filter(r => fmtDate(new Date(r.shipped_at)) === selectedDate).length
    : 0

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
      <h2 className="text-xl font-bold text-gray-800 mb-6">소품팀 대시보드</h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <div className="bg-white rounded-xl border p-4">
          <div className="text-sm text-gray-500 mb-1">미배정 주문 <span className="text-xs text-gray-400">(현재 기준)</span></div>
          <div className="text-2xl font-bold text-red-600">{snapshotLoading ? '-' : `${unassignedCount}건`}</div>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <div className="text-sm text-gray-500 mb-1">보류 상품 <span className="text-xs text-gray-400">(현재 기준)</span></div>
          <div className="text-2xl font-bold text-orange-600">{snapshotLoading ? '-' : `${holdCount}개`}</div>
        </div>
      </div>

      <div className="bg-white rounded-xl border p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => changeMonth(-1)} className="px-2 py-1 rounded hover:bg-gray-100 text-gray-500">‹</button>
          <span className="text-sm font-bold text-gray-800">{year}년 {month + 1}월</span>
          <button onClick={() => changeMonth(1)} className="px-2 py-1 rounded hover:bg-gray-100 text-gray-500">›</button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-xs text-gray-400 mb-1">
          {WEEKDAYS.map(w => <div key={w} className="py-1">{w}</div>)}
        </div>

        {monthLoading ? (
          <p className="text-sm text-gray-400 py-8 text-center">불러오는 중...</p>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {cells.map((day, i) => {
              if (day === null) return <div key={`blank-${i}`} />
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
              const info = dayIndex[dateStr]
              const staffEntries = info ? Object.entries(info.staff).sort((a, b) => b[1] - a[1]) : []
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
                    {info && info.total > 0 && <span className="text-[11px] font-bold text-gray-700">{info.total}</span>}
                  </div>
                  <div className="space-y-0.5">
                    {staffEntries.slice(0, 4).map(([name, qty]) => (
                      <div key={name} className="text-[10px] text-gray-500 truncate">{name} {qty}</div>
                    ))}
                    {staffEntries.length > 4 && (
                      <div className="text-[10px] text-gray-400">+{staffEntries.length - 4}명</div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {!selectedDate ? (
        <p className="text-sm text-gray-400 text-center py-6">달력에서 날짜를 클릭하면 상세 내역을 볼 수 있어요.</p>
      ) : (
        <>
          <h3 className="text-sm font-bold text-gray-700 mb-3">{selectedLabel} 상세</h3>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-white rounded-xl border p-4">
              <div className="text-sm text-gray-500 mb-1">수집</div>
              <div className="text-2xl font-bold text-gray-800">{collectedForSelected}건</div>
            </div>
            <div className="bg-white rounded-xl border p-4">
              <div className="text-sm text-gray-500 mb-1">미성 이동</div>
              <div className="text-2xl font-bold text-amber-600">{miseongForSelected}개</div>
            </div>
            <div className="bg-white rounded-xl border p-4">
              <div className="text-sm text-gray-500 mb-1">배송중 전환</div>
              <div className="text-2xl font-bold text-blue-600">{shippedForSelected}건</div>
            </div>
          </div>

          <h3 className="text-sm font-bold text-gray-700 mb-2">담당자별 처리 수량</h3>
          {selectedDayStats.length === 0 ? (
            <p className="text-sm text-gray-400 mb-6">해당 날짜 처리 기록이 없습니다.</p>
          ) : (
            <div className="bg-white rounded-xl border overflow-x-auto mb-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-gray-500 text-xs">
                    <th className="text-left px-4 py-2 font-medium">담당자</th>
                    <th className="text-right px-4 py-2 font-medium">피킹확인</th>
                    <th className="text-right px-4 py-2 font-medium">미성이동</th>
                    <th className="text-right px-4 py-2 font-medium">출고검수</th>
                    <th className="text-right px-4 py-2 font-medium">입고진열</th>
                    <th className="text-right px-4 py-2 font-medium">합계</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedDayStats.map(s => (
                    <tr key={s.name} className="border-b last:border-0">
                      <td className="px-4 py-2 font-medium text-gray-800">{s.name}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{s.picked || '-'}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{s.miseong || '-'}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{s.shipped || '-'}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{s.stow || '-'}</td>
                      <td className="px-4 py-2 text-right font-bold text-gray-800">{s.picked + s.miseong + s.shipped + s.stow}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
