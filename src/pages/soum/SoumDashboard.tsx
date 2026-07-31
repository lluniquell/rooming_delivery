import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = () => fmtDate(new Date())

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

export default function SoumDashboard() {
  const [loading, setLoading] = useState(true)
  const [unassignedCount, setUnassignedCount] = useState(0)
  const [holdCount, setHoldCount] = useState(0)
  const [miseongToday, setMiseongToday] = useState(0)
  const [shippedToday, setShippedToday] = useState(0)
  const [collectedToday, setCollectedToday] = useState(0)
  const [staffStats, setStaffStats] = useState<StaffStats[]>([])

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const dayStart = new Date(`${today()}T00:00:00`)
    const dayEnd = new Date(dayStart.getTime() + 86400000)

    const { data: holdBatch } = await supabase.from('batches').select('id').eq('type', 'hold').maybeSingle()

    const [
      { data: unassignedRows },
      { count: holdItemCount },
      { data: miseongRows },
      { data: shippedRows },
      { count: collectedCount },
      { data: pickedRows },
      { data: stowRows },
    ] = await Promise.all([
      supabase.from('order_items').select('order_id').eq('status', 'collected').is('batch_id', null),
      holdBatch
        ? supabase.from('order_items').select('id', { count: 'exact', head: true }).eq('status', 'confirmed').eq('batch_id', holdBatch.id)
        : Promise.resolve({ count: 0 } as any),
      supabase.from('miseong_pickups').select('quantity, picked_by').eq('picked_date', today()),
      supabase
        .from('order_items')
        .select('quantity, shipped_by')
        .gte('shipped_at', dayStart.toISOString())
        .lt('shipped_at', dayEnd.toISOString()),
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', dayStart.toISOString())
        .lt('created_at', dayEnd.toISOString()),
      supabase
        .from('order_items')
        .select('quantity, picked_by')
        .gte('picked_at', dayStart.toISOString())
        .lt('picked_at', dayEnd.toISOString()),
      supabase
        .from('stow_events')
        .select('quantity, staff_name')
        .gte('created_at', dayStart.toISOString())
        .lt('created_at', dayEnd.toISOString()),
    ])

    setUnassignedCount(new Set((unassignedRows ?? []).map(r => r.order_id)).size)
    setHoldCount(holdItemCount ?? 0)
    setMiseongToday((miseongRows ?? []).reduce((sum, r) => sum + r.quantity, 0))
    setShippedToday((shippedRows ?? []).length)
    setCollectedToday(collectedCount ?? 0)

    const map: Record<string, StaffStats> = {}
    for (const r of pickedRows ?? []) addTo(map, r.picked_by, 'picked', r.quantity)
    for (const r of miseongRows ?? []) addTo(map, r.picked_by, 'miseong', r.quantity)
    for (const r of shippedRows ?? []) addTo(map, r.shipped_by, 'shipped', r.quantity)
    for (const r of stowRows ?? []) addTo(map, r.staff_name, 'stow', r.quantity)
    const stats = Object.values(map).sort((a, b) =>
      (b.picked + b.miseong + b.shipped + b.stow) - (a.picked + a.miseong + a.shipped + a.stow)
    )
    setStaffStats(stats)

    setLoading(false)
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-gray-800 mb-6">소품팀 대시보드</h2>

      {loading ? (
        <p className="text-sm text-gray-400">불러오는 중...</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            <div className="bg-white rounded-xl border p-4">
              <div className="text-sm text-gray-500 mb-1">오늘 수집</div>
              <div className="text-2xl font-bold text-gray-800">{collectedToday}건</div>
            </div>
            <div className="bg-white rounded-xl border p-4">
              <div className="text-sm text-gray-500 mb-1">미배정 주문</div>
              <div className="text-2xl font-bold text-red-600">{unassignedCount}건</div>
            </div>
            <div className="bg-white rounded-xl border p-4">
              <div className="text-sm text-gray-500 mb-1">보류 상품</div>
              <div className="text-2xl font-bold text-orange-600">{holdCount}개</div>
            </div>
            <div className="bg-white rounded-xl border p-4">
              <div className="text-sm text-gray-500 mb-1">오늘 미성 이동</div>
              <div className="text-2xl font-bold text-amber-600">{miseongToday}개</div>
            </div>
            <div className="bg-white rounded-xl border p-4">
              <div className="text-sm text-gray-500 mb-1">오늘 배송중 전환</div>
              <div className="text-2xl font-bold text-blue-600">{shippedToday}건</div>
            </div>
          </div>

          <h3 className="text-sm font-bold text-gray-700 mb-2">담당자별 오늘 처리 수량</h3>
          {staffStats.length === 0 ? (
            <p className="text-sm text-gray-400 mb-6">오늘 처리 기록이 없습니다.</p>
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
                  {staffStats.map(s => (
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

      <p className="text-xs text-gray-400">
        필요한 지표 있으면 알려주세요.
      </p>
    </div>
  )
}
