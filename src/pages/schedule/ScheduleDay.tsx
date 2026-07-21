import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '../../lib/supabase'

declare global {
  interface Window { kakao: any }
}

const KAKAO_JS_KEY = import.meta.env.VITE_KAKAO_JS_KEY

interface StopItem {
  id: string
  product_name: string
  quantity: number
}

interface Stop {
  order_id: string
  cafe24_order_no: string
  customer_name: string
  address: string | null
  crew_size: number | null
  route_order: number | null
  lat: number | null
  lng: number | null
  items: StopItem[]
}

function regionOf(address: string | null) {
  if (!address) return ''
  return address.split(/\s+/).slice(0, 2).join(' ')
}

// 두 좌표 사이 직선거리 (km, 하버사인)
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function loadKakaoSdk(): Promise<void> {
  if (window.kakao?.maps) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `//dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JS_KEY}&autoload=false`
    script.onload = () => window.kakao.maps.load(() => resolve())
    script.onerror = () => reject(new Error('카카오맵 로드 실패'))
    document.head.appendChild(script)
  })
}

function SortableStop({ stop, index, onUnschedule }: { stop: Stop; index: number; onUnschedule: (s: Stop) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: stop.order_id })
  const style = { transform: CSS.Transform.toString(transform), transition }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 border rounded-lg p-2.5 bg-white group">
      <span {...attributes} {...listeners} className="cursor-grab text-gray-300 text-lg leading-none px-1">⠿</span>
      <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center shrink-0">
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] px-1 rounded font-bold shrink-0 ${
            stop.crew_size === 2 ? 'bg-orange-100 text-orange-600' : 'bg-gray-200 text-gray-600'
          }`}>
            {stop.crew_size === 2 ? '2인' : '1인'}
          </span>
          <span className="text-sm font-medium text-gray-800 truncate">{stop.customer_name}</span>
        </div>
        <div className="text-[11px] text-gray-400 truncate">{stop.address}</div>
      </div>
      <button
        onClick={() => onUnschedule(stop)}
        className="text-gray-300 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >✕</button>
    </div>
  )
}

export default function ScheduleDay() {
  const { date } = useParams<{ date: string }>()
  const [batchId, setBatchId] = useState<string | null>(null)
  const [stops, setStops] = useState<Stop[]>([])
  const [unscheduled, setUnscheduled] = useState<Stop[]>([])
  const [closed, setClosed] = useState(false)
  const [geocoding, setGeocoding] = useState(false)
  const [loading, setLoading] = useState(true)

  const mapRef = useRef<HTMLDivElement>(null)
  const mapObjRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const sensors = useSensors(useSensor(PointerSensor))

  useEffect(() => { init() }, [date])

  async function init() {
    setLoading(true)
    const { data: batches } = await supabase.from('batches').select('id, type, name')
    const jikbae = (batches ?? []).find(b => b.type === 'direct' || b.name?.includes('직배'))
    if (jikbae) setBatchId(jikbae.id)

    const { data: dayRow } = await supabase.from('schedule_days').select('closed').eq('date', date).maybeSingle()
    setClosed(!!dayRow?.closed)

    if (jikbae) await loadAll(jikbae.id)
    setLoading(false)
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
          crew_size: o.crew_size,
          route_order: o.route_order,
          lat: o.lat,
          lng: o.lng,
          items: [],
        }
      }
      map[o.id].items.push({ id: row.id, product_name: row.product_name, quantity: row.quantity })
    }
    return Object.values(map)
  }

  async function loadAll(bid: string) {
    const SELECT = 'id, product_name, quantity, orders!inner(id, cafe24_order_no, customer_name, receiver_name, address, crew_size, route_order, lat, lng, scheduled_date)'

    const { data: scheduledData } = await supabase
      .from('order_items')
      .select(SELECT)
      .eq('batch_id', bid)
      .in('status', ['confirmed', 'in_transit'])
      .eq('orders.scheduled_date', date)
    const scheduledStops = groupRows((scheduledData ?? []) as any[])
      .sort((a, b) => (a.route_order ?? 999) - (b.route_order ?? 999))
    setStops(scheduledStops)

    const { data: unschedData } = await supabase
      .from('order_items')
      .select(SELECT)
      .eq('batch_id', bid)
      .eq('status', 'confirmed')
      .is('orders.scheduled_date', null)
    let unschedStops = groupRows((unschedData ?? []) as any[])

    // 이미 배정된 좌표가 있으면 거리순 정렬 + 근처 표시
    const anchor = scheduledStops.find(s => s.lat && s.lng)
    if (anchor) {
      unschedStops = unschedStops
        .map(s => ({ ...s, _dist: (s.lat && s.lng) ? distanceKm(anchor as any, s as any) : Infinity }))
        .sort((a: any, b: any) => a._dist - b._dist)
    }
    setUnscheduled(unschedStops)

    // 지오코딩은 백그라운드로 진행 — 완료된 항목만 로컬 state에 반영 (재조회 없음, 무한루프 방지)
    geocodeMissing([...scheduledStops, ...unschedStops])
  }

  async function geocodeMissing(list: Stop[]) {
    const missing = list.filter(s => s.address && (!s.lat || !s.lng))
    if (!missing.length) return
    setGeocoding(true)
    const updates: Record<string, { lat: number; lng: number }> = {}
    for (const s of missing) {
      try {
        const res = await fetch('/api/kakao/geocode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: s.address }),
        })
        const { lat, lng } = await res.json()
        if (lat && lng) {
          await supabase.from('orders').update({ lat, lng }).eq('id', s.order_id)
          updates[s.order_id] = { lat, lng }
        }
      } catch { /* 실패한 주소는 다음 페이지 진입 때 재시도 — 이 세션에서는 재시도하지 않음 */ }
    }
    setGeocoding(false)
    if (Object.keys(updates).length) {
      const apply = (arr: Stop[]) => arr.map(s => updates[s.order_id] ? { ...s, ...updates[s.order_id] } : s)
      setStops(prev => apply(prev))
      setUnscheduled(prev => apply(prev))
    }
  }

  // 지도 렌더링
  useEffect(() => {
    if (!mapRef.current || !KAKAO_JS_KEY) return
    let cancelled = false
    loadKakaoSdk().then(() => {
      if (cancelled || !mapRef.current) return
      if (!mapObjRef.current) {
        mapObjRef.current = new window.kakao.maps.Map(mapRef.current, {
          center: new window.kakao.maps.LatLng(37.5665, 126.9780),
          level: 8,
        })
      }
      markersRef.current.forEach(m => m.setMap(null))
      markersRef.current = []

      const withCoords = stops.filter(s => s.lat && s.lng)
      if (!withCoords.length) return
      const bounds = new window.kakao.maps.LatLngBounds()
      withCoords.forEach(s => {
        const pos = new window.kakao.maps.LatLng(s.lat!, s.lng!)
        const content = document.createElement('div')
        content.style.cssText = 'background:#2563eb;color:#fff;border-radius:9999px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)'
        content.textContent = String(stops.findIndex(x => x.order_id === s.order_id) + 1)
        const overlay = new window.kakao.maps.CustomOverlay({ position: pos, content, yAnchor: 0.5 })
        overlay.setMap(mapObjRef.current)
        markersRef.current.push(overlay)
        bounds.extend(pos)
      })
      mapObjRef.current.setBounds(bounds)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [stops])

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setStops(items => {
      const oldIndex = items.findIndex(i => i.order_id === active.id)
      const newIndex = items.findIndex(i => i.order_id === over.id)
      const reordered = arrayMove(items, oldIndex, newIndex)
      reordered.forEach((s, i) => {
        supabase.from('orders').update({ route_order: i + 1 }).eq('id', s.order_id).then(() => {})
      })
      return reordered
    })
  }

  async function assignToDay(stop: Stop) {
    const crew = confirm('2인 배송인가요? (확인=2인, 취소=1인)') ? 2 : 1
    await supabase.from('orders').update({
      scheduled_date: date,
      crew_size: crew,
      route_order: stops.length + 1,
    }).eq('id', stop.order_id)
    if (batchId) loadAll(batchId)
  }

  async function unschedule(stop: Stop) {
    await supabase.from('orders').update({ scheduled_date: null, crew_size: null, route_order: null }).eq('id', stop.order_id)
    if (batchId) loadAll(batchId)
  }

  async function toggleClosed() {
    const next = !closed
    await supabase.from('schedule_days').upsert({ date, closed: next, closed_at: next ? new Date().toISOString() : null })
    setClosed(next)
  }

  const crew1 = stops.filter(s => s.crew_size === 1).length
  const crew2 = stops.filter(s => s.crew_size === 2).length

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to="/admin/schedule" className="text-gray-400 hover:text-gray-700 text-sm">← 스케줄 보드</Link>
          <h2 className="text-xl font-bold text-gray-800">{date} 배송 루트</h2>
          <span className="text-sm text-gray-500">
            1인 <b className="text-gray-700">{crew1}</b> · 2인 <b className="text-orange-600">{crew2}</b>
          </span>
          {geocoding && <span className="text-xs text-gray-400">좌표 변환 중...</span>}
        </div>
        <button
          onClick={toggleClosed}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${
            closed ? 'bg-gray-200 text-gray-700 hover:bg-gray-300' : 'bg-red-600 text-white hover:bg-red-700'
          }`}
        >
          {closed ? '마감 취소' : '마감'}
        </button>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-20 text-sm">불러오는 중...</div>
      ) : (
        <div className="flex gap-4">
          {!closed && (
            <div className="w-72 shrink-0">
              <div className="bg-white rounded-xl border overflow-hidden">
                <div className="px-3 py-2.5 border-b bg-gray-50 text-sm font-medium text-gray-700">
                  미배정 <span className="text-indigo-600 font-bold">{unscheduled.length}</span>건
                  <span className="block text-[11px] text-gray-400 font-normal mt-0.5">가까운 순 정렬</span>
                </div>
                <div className="divide-y max-h-[calc(100vh-260px)] overflow-y-auto">
                  {unscheduled.length === 0 && (
                    <div className="p-6 text-center text-xs text-gray-400">미배정 주문이 없습니다</div>
                  )}
                  {unscheduled.map((s: any) => (
                    <div key={s.order_id} onClick={() => assignToDay(s)} className="p-3 cursor-pointer hover:bg-blue-50">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-800">{s.customer_name}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          {s._dist < 10 && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">📍 근처</span>}
                          <span className="text-[11px] text-indigo-600 font-medium">{regionOf(s.address)}</span>
                        </div>
                      </div>
                      <div className="mt-1 space-y-0.5">
                        {s.items.map((it: StopItem) => (
                          <div key={it.id} className="text-xs text-gray-600 truncate">{it.product_name} <span className="text-gray-400">×{it.quantity}</span></div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex-1 grid grid-cols-2 gap-4 min-w-0">
            <div className="bg-white rounded-xl border p-2">
              <div className="text-xs font-medium text-gray-500 px-1 pb-2">배송 루트 ({stops.length}건) — 드래그로 순서 변경</div>
              {stops.length === 0 ? (
                <div className="p-8 text-center text-xs text-gray-400">배정된 배송건이 없습니다</div>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={stops.map(s => s.order_id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-1.5 max-h-[calc(100vh-300px)] overflow-y-auto">
                      {stops.map((s, i) => (
                        <SortableStop key={s.order_id} stop={s} index={i} onUnschedule={unschedule} />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </div>

            <div className="bg-white rounded-xl border overflow-hidden">
              {KAKAO_JS_KEY ? (
                <div ref={mapRef} className="w-full h-full min-h-[400px]" />
              ) : (
                <div className="p-8 text-center text-xs text-gray-400">
                  카카오맵 키(VITE_KAKAO_JS_KEY)가 설정되지 않았습니다.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
