import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

interface StopItem {
  id: string
  product_name: string
  option_info: string | null
  quantity: number
  labels: string[] | null
}

interface Stop {
  order_id: string
  cafe24_order_no: string
  customer_name: string
  address: string | null
  scheduled_date: string | null
  crew_size: number | null
  items: StopItem[]
}

// 로컬(KST) 기준 날짜 — toISOString은 UTC라 자정 기준 계산이 하루 밀림
const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']

function mondayOf(d: Date) {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const m = new Date(d)
  m.setDate(d.getDate() + diff)
  m.setHours(0, 0, 0, 0)
  return m
}

function regionOf(address: string | null) {
  if (!address) return ''
  return address.split(/\s+/).slice(0, 2).join(' ')
}

export default function ScheduleBoard() {
  const [batchId, setBatchId] = useState<string | null>(null)
  const [unscheduled, setUnscheduled] = useState<Stop[]>([])
  const [scheduled, setScheduled] = useState<Stop[]>([])
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()))
  const [error, setError] = useState('')

  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(weekStart.getDate() + i)
    return d
  })

  useEffect(() => { init() }, [])
  useEffect(() => { if (batchId) loadScheduled(batchId) }, [batchId, weekStart])

  async function init() {
    const { data: batches } = await supabase.from('batches').select('id, name, type')
    const jikbae = (batches ?? []).find(b => b.type === 'direct' || b.name?.includes('직배'))
    if (!jikbae) {
      setError('직배 배치가 없습니다. batches 테이블에 직배 배치를 먼저 추가해주세요.')
      return
    }
    setBatchId(jikbae.id)
    loadUnscheduled(jikbae.id)
    loadScheduled(jikbae.id)
  }

  function groupRows(rows: any[]): Stop[] {
    const map: Record<string, Stop> = {}
    for (const row of rows) {
      const o = row.orders
      if (!map[o.id]) {
        map[o.id] = {
          order_id: o.id,
          cafe24_order_no: o.cafe24_order_no,
          customer_name: o.receiver_name || o.customer_name,
          address: o.address,
          scheduled_date: o.scheduled_date,
          crew_size: o.crew_size,
          items: [],
        }
      }
      map[o.id].items.push({
        id: row.id,
        product_name: row.product_name,
        option_info: row.option_info,
        quantity: row.quantity,
        labels: row.labels,
      })
    }
    return Object.values(map)
  }

  async function loadUnscheduled(bid: string) {
    const { data } = await supabase
      .from('order_items')
      .select('id, product_name, option_info, quantity, labels, orders!inner(id, cafe24_order_no, customer_name, receiver_name, address, scheduled_date, crew_size)')
      .eq('batch_id', bid)
      .eq('status', 'confirmed')
      .is('orders.scheduled_date', null)
    setUnscheduled(groupRows((data ?? []) as any[]))
  }

  async function loadScheduled(bid: string) {
    const { data } = await supabase
      .from('order_items')
      .select('id, product_name, option_info, quantity, labels, orders!inner(id, cafe24_order_no, customer_name, receiver_name, address, scheduled_date, crew_size)')
      .eq('batch_id', bid)
      .in('status', ['confirmed', 'in_transit'])
      .gte('orders.scheduled_date', fmt(weekDates[0]))
      .lte('orders.scheduled_date', fmt(weekDates[6]))
    setScheduled(groupRows((data ?? []) as any[]))
  }

  async function assignDate(stop: Stop, dateStr: string) {
    await supabase.from('orders')
      .update({ scheduled_date: dateStr })
      .eq('id', stop.order_id)
    if (batchId) { loadUnscheduled(batchId); loadScheduled(batchId) }
  }

  async function unschedule(stop: Stop) {
    // route_id/route_order도 같이 지워야 함 — 이미 루트에 배정된 주문을 여기서
    // 배정 해제만 하고 route_id를 남겨두면, 나중에 scheduled_date를 다른 날짜로
    // 옮겼을 때 예전 route_id가 그 날짜엔 존재하지 않는 값이라 스케줄 화면의
    // 루트에도 미배정 목록에도 안 나타나고 사라져버림(2026-09-22 실제 발생)
    await supabase.from('orders')
      .update({ scheduled_date: null, crew_size: null, route_id: null, route_order: null, visit_time: null })
      .eq('id', stop.order_id)
    if (batchId) { loadUnscheduled(batchId); loadScheduled(batchId) }
  }

  const stopsByDate: Record<string, Stop[]> = {}
  for (const s of scheduled) {
    if (!s.scheduled_date) continue
    ;(stopsByDate[s.scheduled_date] ??= []).push(s)
  }

  const todayStr = fmt(new Date())

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800">배송 스케줄</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWeekStart(prev => { const d = new Date(prev); d.setDate(d.getDate() - 7); return d })}
            className="px-3 py-1.5 rounded-lg border text-sm text-gray-600 hover:bg-gray-50"
          >◀ 이전주</button>
          <button
            onClick={() => setWeekStart(mondayOf(new Date()))}
            className="px-3 py-1.5 rounded-lg border text-sm text-gray-600 hover:bg-gray-50"
          >이번주</button>
          <button
            onClick={() => setWeekStart(prev => { const d = new Date(prev); d.setDate(d.getDate() + 7); return d })}
            className="px-3 py-1.5 rounded-lg border text-sm text-gray-600 hover:bg-gray-50"
          >다음주 ▶</button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl px-4 py-3 mb-4 text-sm">{error}</div>
      )}

      <div className="flex gap-4">
        {/* 미배정 목록 */}
        <div className="w-72 shrink-0">
          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="px-3 py-2.5 border-b bg-gray-50 text-sm font-medium text-gray-700">
              미배정 <span className="text-indigo-600 font-bold">{unscheduled.length}</span>건
            </div>
            <div className="divide-y max-h-[calc(100vh-220px)] overflow-y-auto">
              {unscheduled.length === 0 && (
                <div className="p-6 text-center text-xs text-gray-400">직배 배치에 미배정 주문이 없습니다</div>
              )}
              {unscheduled.map(stop => (
                <div
                  key={stop.order_id}
                  draggable
                  onDragStart={e => e.dataTransfer.setData('text/plain', stop.order_id)}
                  onClick={() => assignDate(stop, todayStr)}
                  className="p-3 cursor-pointer hover:bg-blue-50"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-800">{stop.customer_name}</span>
                    <span className="text-[11px] text-indigo-600 font-medium">{regionOf(stop.address)}</span>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5 font-mono">{stop.cafe24_order_no}</div>
                  <div className="mt-1 space-y-0.5">
                    {stop.items.map(it => (
                      <div key={it.id}>
                        <div className="text-xs text-gray-600 truncate">
                          {it.product_name} <span className="text-gray-400">×{it.quantity}</span>
                        </div>
                        {it.labels && it.labels.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {it.labels.map((l, idx) => (
                              <span key={idx} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-100 text-rose-700">
                                {l}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 주간 보드 */}
        <div className="flex-1 grid grid-cols-7 gap-2 min-w-0">
          {weekDates.map(d => {
            const dateStr = fmt(d)
            const stops = stopsByDate[dateStr] ?? []
            const isToday = dateStr === todayStr
            const isSunday = d.getDay() === 0
            return (
              <div
                key={dateStr}
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  const orderId = e.dataTransfer.getData('text/plain')
                  const stop = unscheduled.find(s => s.order_id === orderId)
                  if (stop) assignDate(stop, dateStr)
                }}
                className={`bg-white rounded-xl border flex flex-col min-h-[300px] ${
                  isToday ? 'border-blue-400 ring-1 ring-blue-200' : ''
                }`}
              >
                <Link
                  to={`/admin/schedule/day/${dateStr}`}
                  className={`block px-2 py-2 border-b text-center ${isToday ? 'bg-blue-50' : 'bg-gray-50'} rounded-t-xl hover:brightness-95 transition`}
                >
                  <div className={`text-xs font-bold ${isSunday ? 'text-red-500' : isToday ? 'text-blue-700' : 'text-gray-700'}`}>
                    {d.getMonth() + 1}/{d.getDate()} ({DAY_LABELS[d.getDay()]})
                  </div>
                  <div className="text-[11px] mt-0.5 text-gray-500">
                    {stops.length > 0 ? `${stops.length}건` : <span className="text-gray-300">-</span>}
                  </div>
                </Link>
                <div className="flex-1 p-1.5 space-y-1.5 overflow-y-auto">
                  {stops.map(stop => (
                    <div key={stop.order_id} className="border rounded-lg p-2 bg-gray-50/50 group relative">
                      <div className="flex items-center gap-1">
                        <span className="text-xs font-medium text-gray-800 truncate">{stop.customer_name}</span>
                        {stop.items.some(i => i.labels && i.labels.length > 0) && (
                          <span
                            className="text-[10px] shrink-0"
                            title={stop.items.flatMap(i => i.labels ?? []).join('\n')}
                          >🏷️</span>
                        )}
                      </div>
                      <div className="text-[10px] text-indigo-600 mt-0.5">{regionOf(stop.address)}</div>
                      <div className="text-[10px] text-gray-500 truncate">
                        {stop.items[0]?.product_name}{stop.items.length > 1 ? ` 외 ${stop.items.length - 1}` : ''}
                      </div>
                      <button
                        onClick={() => unschedule(stop)}
                        title="배정 해제"
                        className="absolute top-1 right-1 hidden group-hover:block text-gray-300 hover:text-red-400 text-xs leading-none"
                      >✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
