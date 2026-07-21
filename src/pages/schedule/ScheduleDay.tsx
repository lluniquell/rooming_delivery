import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, useDroppable,
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
const PINNED_KEY = 'depot' // '선진' — 각 루트 맨 위에 고정
const WAYPOINT_ORDER = ['depot', 'nk']
const WAYPOINT_VERB: Record<string, string> = { depot: '출발' }
const ROUTE_COLORS = ['#2563eb', '#7c3aed', '#059669', '#db2777', '#ea580c', '#0891b2']

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
  route_id: string | null
  lat: number | null
  lng: number | null
  items: StopItem[]
}

interface PresetLocation {
  key: string
  name: string
  address: string
  lat: number | null
  lng: number | null
  type: 'start' | 'waypoint'
}

interface DayWaypoint {
  id: string
  preset_key: string
  route_id: string
  route_order: number
}

interface RouteLane {
  id: string
  label: string
  crew_size: 1 | 2
  sort_order: number
}

// 주문 배송건과 프리셋 경유지(NK빌딩 등)를 하나의 루트로 합친 표현
interface RouteStop {
  id: string
  kind: 'order' | 'preset'
  name: string
  address: string | null
  crew_size: number | null
  lat: number | null
  lng: number | null
  items: StopItem[]
  route_order: number
  route_id: string
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

function SortableStop({ stop, index, color, onRemove }: {
  stop: RouteStop; index: number; color: string; onRemove: (s: RouteStop) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: stop.id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const isPreset = stop.kind === 'preset'

  return (
    <div ref={setNodeRef} style={style} className={`flex items-center gap-2 border rounded-lg p-2 group ${isPreset ? 'bg-amber-50 border-amber-200' : 'bg-white'}`}>
      <span {...attributes} {...listeners} className="cursor-grab text-gray-300 text-lg leading-none px-1">⠿</span>
      <span className="w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center shrink-0" style={{ backgroundColor: color }}>
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {isPreset ? (
            <span className="text-[10px] px-1 rounded font-bold shrink-0 bg-amber-100 text-amber-700">경유지</span>
          ) : (
            <span className={`text-[10px] px-1 rounded font-bold shrink-0 ${
              stop.crew_size === 2 ? 'bg-orange-100 text-orange-600' : 'bg-gray-200 text-gray-600'
            }`}>
              {stop.crew_size === 2 ? '2인' : '1인'}
            </span>
          )}
          <span className="text-sm font-medium text-gray-800 truncate">{stop.name}</span>
        </div>
        <div className="text-[11px] text-gray-400 truncate">{stop.address}</div>
      </div>
      <button
        onClick={() => onRemove(stop)}
        className="text-gray-300 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >✕</button>
    </div>
  )
}

function LaneDropZone({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id })
  return <div ref={setNodeRef} className="space-y-1.5 min-h-[60px]">{children}</div>
}

export default function ScheduleDay() {
  const { date } = useParams<{ date: string }>()
  const [batchId, setBatchId] = useState<string | null>(null)
  const [stops, setStops] = useState<Stop[]>([])
  const [unscheduled, setUnscheduled] = useState<Stop[]>([])
  const [presets, setPresets] = useState<PresetLocation[]>([])
  const [dayWaypoints, setDayWaypoints] = useState<DayWaypoint[]>([])
  const [routes, setRoutes] = useState<RouteLane[]>([])
  const [routeVisibility, setRouteVisibility] = useState<Record<string, boolean>>({})
  const [closed, setClosed] = useState(false)
  const [geocoding, setGeocoding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [assignModal, setAssignModal] = useState<{ stop: Stop; needsCrew: boolean } | null>(null)
  const [modalCrew, setModalCrew] = useState<1 | 2>(1)
  const [modalRouteId, setModalRouteId] = useState('')

  const mapRef = useRef<HTMLDivElement>(null)
  const mapObjRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const sensors = useSensors(useSensor(PointerSensor))

  const waypointPresets = presets
    .filter(p => p.type === 'waypoint')
    .sort((a, b) => WAYPOINT_ORDER.indexOf(a.key) - WAYPOINT_ORDER.indexOf(b.key))

  function colorForRoute(routeId: string) {
    const idx = routes.findIndex(r => r.id === routeId)
    return ROUTE_COLORS[idx % ROUTE_COLORS.length] ?? '#6b7280'
  }

  const routeStopsAll: RouteStop[] = useMemo(() => {
    const orderPart: RouteStop[] = stops
      .filter(s => s.route_id)
      .map(s => ({
        id: s.order_id,
        kind: 'order',
        name: s.customer_name,
        address: s.address,
        crew_size: s.crew_size,
        lat: s.lat,
        lng: s.lng,
        items: s.items,
        route_order: s.route_order ?? 999,
        route_id: s.route_id!,
      }))
    const waypointPart: RouteStop[] = dayWaypoints
      .filter(w => w.preset_key !== PINNED_KEY)
      .map((w): RouteStop | null => {
        const p = presets.find(p => p.key === w.preset_key)
        if (!p) return null
        return {
          id: `preset:${w.route_id}:${p.key}`,
          kind: 'preset',
          name: p.name,
          address: p.address,
          crew_size: null,
          lat: p.lat,
          lng: p.lng,
          items: [],
          route_order: w.route_order,
          route_id: w.route_id,
        }
      })
      .filter((x): x is RouteStop => x !== null)
    return [...orderPart, ...waypointPart]
  }, [stops, dayWaypoints, presets])

  function stopsForRoute(routeId: string) {
    return routeStopsAll.filter(s => s.route_id === routeId).sort((a, b) => a.route_order - b.route_order)
  }

  function pinnedForRoute(routeId: string) {
    const active = dayWaypoints.find(w => w.route_id === routeId && w.preset_key === PINNED_KEY)
    if (!active) return null
    return presets.find(p => p.key === PINNED_KEY) ?? null
  }

  const unrouted = stops.filter(s => !s.route_id)

  useEffect(() => { init() }, [date])

  async function init() {
    setLoading(true)
    const { data: batches } = await supabase.from('batches').select('id, type, name')
    const jikbae = (batches ?? []).find(b => b.type === 'direct' || b.name?.includes('직배'))
    if (jikbae) setBatchId(jikbae.id)

    const { data: presetData } = await supabase.from('preset_locations').select('*')
    setPresets(presetData ?? [])

    const { data: dayRow } = await supabase.from('schedule_days').select('closed').eq('date', date).maybeSingle()
    setClosed(!!dayRow?.closed)

    const { data: routeData } = await supabase
      .from('schedule_routes')
      .select('*')
      .eq('date', date)
      .order('sort_order')
    setRoutes(routeData ?? [])
    setRouteVisibility(prev => {
      const next = { ...prev }
      for (const r of routeData ?? []) if (!(r.id in next)) next[r.id] = true
      return next
    })

    const { data: waypointData } = await supabase
      .from('schedule_day_waypoints')
      .select('id, preset_key, route_id, route_order')
      .eq('date', date)
    setDayWaypoints(waypointData ?? [])

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
          route_id: o.route_id,
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
    const SELECT = 'id, product_name, quantity, orders!inner(id, cafe24_order_no, customer_name, receiver_name, address, crew_size, route_order, route_id, lat, lng, scheduled_date)'

    const { data: scheduledData } = await supabase
      .from('order_items')
      .select(SELECT)
      .eq('batch_id', bid)
      .in('status', ['confirmed', 'in_transit'])
      .eq('orders.scheduled_date', date)
    const scheduledStops = groupRows((scheduledData ?? []) as any[])
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
      } catch { /* 실패한 주소는 다음 페이지 진입 때 재시도 */ }
    }
    setGeocoding(false)
    if (Object.keys(updates).length) {
      const apply = (arr: Stop[]) => arr.map(s => updates[s.order_id] ? { ...s, ...updates[s.order_id] } : s)
      setStops(prev => apply(prev))
      setUnscheduled(prev => apply(prev))
    }
  }

  // 지도 렌더링 — 보이는 루트만 색상별로 표시
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

      const bounds = new window.kakao.maps.LatLngBounds()
      let hasAny = false

      function addPin(lat: number, lng: number, label: string, color: string) {
        const pos = new window.kakao.maps.LatLng(lat, lng)
        const content = document.createElement('div')
        content.style.cssText = `background:${color};color:#fff;border-radius:9999px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)`
        content.textContent = label
        const overlay = new window.kakao.maps.CustomOverlay({ position: pos, content, yAnchor: 0.5 })
        overlay.setMap(mapObjRef.current)
        markersRef.current.push(overlay)
        bounds.extend(pos)
        hasAny = true
      }

      routes.forEach(route => {
        if (routeVisibility[route.id] === false) return
        const color = colorForRoute(route.id)
        const pinned = pinnedForRoute(route.id)
        if (pinned?.lat && pinned?.lng) addPin(pinned.lat, pinned.lng, '출', color)
        stopsForRoute(route.id).forEach((s, i) => {
          if (s.lat && s.lng) addPin(s.lat, s.lng, String(i + 1), color)
        })
      })

      if (hasAny) mapObjRef.current.setBounds(bounds)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [routeStopsAll, routes, routeVisibility, dayWaypoints, presets, loading])

  function persistOrder(list: RouteStop[], routeId: string) {
    list.forEach((s, i) => {
      if (s.kind === 'order') {
        supabase.from('orders').update({ route_order: i + 1, route_id: routeId }).eq('id', s.id).then(() => {})
      } else {
        const key = s.id.split(':')[2]
        supabase.from('schedule_day_waypoints').update({ route_order: i + 1 }).eq('route_id', routeId).eq('preset_key', key).then(() => {})
      }
    })
    setStops(prev => prev.map(p => {
      const idx = list.findIndex(l => l.id === p.order_id)
      return idx >= 0 ? { ...p, route_order: idx + 1, route_id: routeId } : p
    }))
    setDayWaypoints(prev => prev.map(w => {
      const idx = list.findIndex(l => l.id === `preset:${routeId}:${w.preset_key}`)
      return idx >= 0 ? { ...w, route_order: idx + 1, route_id: routeId } : w
    }))
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return

    const activeStop = routeStopsAll.find(s => s.id === activeId)
    if (!activeStop) return

    const overIsLane = overId.startsWith('lane:')
    const destRouteId = overIsLane ? overId.replace('lane:', '') : routeStopsAll.find(s => s.id === overId)?.route_id
    if (!destRouteId) return

    // 경유지(선진/NK)는 자기 루트 안에서만 순서 변경, 다른 루트로는 이동 불가
    if (activeStop.kind === 'preset' && destRouteId !== activeStop.route_id) return

    const sourceRouteId = activeStop.route_id
    const sourceList = stopsForRoute(sourceRouteId)

    if (sourceRouteId === destRouteId) {
      const oldIndex = sourceList.findIndex(s => s.id === activeId)
      const newIndex = overIsLane ? sourceList.length - 1 : sourceList.findIndex(s => s.id === overId)
      persistOrder(arrayMove(sourceList, oldIndex, newIndex), sourceRouteId)
    } else {
      const destList = stopsForRoute(destRouteId)
      const filteredSource = sourceList.filter(s => s.id !== activeId)
      const insertIndex = overIsLane ? destList.length : destList.findIndex(s => s.id === overId)
      const newDest = [...destList]
      newDest.splice(insertIndex < 0 ? newDest.length : insertIndex, 0, { ...activeStop, route_id: destRouteId })
      persistOrder(filteredSource, sourceRouteId)
      persistOrder(newDest, destRouteId)
    }
  }

  async function removeStop(stop: RouteStop) {
    if (stop.kind === 'order') {
      await supabase.from('orders').update({ scheduled_date: null, crew_size: null, route_order: null, route_id: null }).eq('id', stop.id)
      if (batchId) loadAll(batchId)
    } else {
      const [, routeId, key] = stop.id.split(':')
      await supabase.from('schedule_day_waypoints').delete().eq('route_id', routeId).eq('preset_key', key)
      setDayWaypoints(prev => prev.filter(w => !(w.route_id === routeId && w.preset_key === key)))
    }
  }

  async function toggleWaypoint(route: RouteLane, preset: PresetLocation) {
    const active = dayWaypoints.find(w => w.route_id === route.id && w.preset_key === preset.key)
    if (active) {
      await supabase.from('schedule_day_waypoints').delete().eq('id', active.id)
      setDayWaypoints(prev => prev.filter(w => w.id !== active.id))
    } else {
      const route_order = stopsForRoute(route.id).length + 1
      const { data } = await supabase.from('schedule_day_waypoints')
        .insert({ date, route_id: route.id, preset_key: preset.key, route_order })
        .select('id, preset_key, route_id, route_order')
        .single()
      if (data) setDayWaypoints(prev => [...prev, data])
    }
  }

  async function addRoute() {
    const crew: 1 | 2 = confirm('2인 배송 루트인가요? (확인=2인, 취소=1인)') ? 2 : 1
    const label = `${routes.length + 1}호차`
    const sort_order = routes.length
    const { data } = await supabase.from('schedule_routes')
      .insert({ date, label, crew_size: crew, sort_order })
      .select('*')
      .single()
    if (data) {
      setRoutes(prev => [...prev, data])
      setRouteVisibility(prev => ({ ...prev, [data.id]: true }))
    }
  }

  async function removeRoute(route: RouteLane) {
    if (stopsForRoute(route.id).length > 0) {
      alert('이 루트에 배정된 배송건이 있어 삭제할 수 없습니다. 먼저 다른 루트로 옮기거나 배정 해제하세요.')
      return
    }
    if (!confirm(`${route.label}를 삭제할까요?`)) return
    await supabase.from('schedule_routes').delete().eq('id', route.id)
    setRoutes(prev => prev.filter(r => r.id !== route.id))
  }

  async function renameRoute(route: RouteLane, label: string) {
    setRoutes(prev => prev.map(r => r.id === route.id ? { ...r, label } : r))
    await supabase.from('schedule_routes').update({ label }).eq('id', route.id)
  }

  async function setRouteCrew(route: RouteLane, crew: 1 | 2) {
    await supabase.from('schedule_routes').update({ crew_size: crew }).eq('id', route.id)
    setRoutes(prev => prev.map(r => r.id === route.id ? { ...r, crew_size: crew } : r))
  }

  function openAssignModal(stop: Stop, needsCrew: boolean) {
    if (!routes.length) { alert('먼저 루트를 추가해주세요.'); return }
    setAssignModal({ stop, needsCrew })
    setModalCrew((stop.crew_size as 1 | 2) ?? 1)
    setModalRouteId(routes[0].id)
  }

  async function confirmAssign() {
    if (!assignModal || !modalRouteId) return
    const targetLen = stopsForRoute(modalRouteId).length
    await supabase.from('orders').update({
      scheduled_date: date,
      crew_size: assignModal.needsCrew ? modalCrew : assignModal.stop.crew_size,
      route_id: modalRouteId,
      route_order: targetLen + 1,
    }).eq('id', assignModal.stop.order_id)
    setAssignModal(null)
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
            상품 기준: 1인 <b className="text-gray-700">{crew1}</b> · 2인 <b className="text-orange-600">{crew2}</b>
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
            <div className="w-72 shrink-0 space-y-4">
              {unrouted.length > 0 && (
                <div className="bg-white rounded-xl border overflow-hidden">
                  <div className="px-3 py-2.5 border-b bg-red-50 text-sm font-medium text-red-700">
                    루트 미배정 <span className="font-bold">{unrouted.length}</span>건
                  </div>
                  <div className="divide-y max-h-52 overflow-y-auto">
                    {unrouted.map(s => (
                      <div key={s.order_id} onClick={() => openAssignModal(s, false)} className="p-3 cursor-pointer hover:bg-blue-50">
                        <span className="text-sm font-medium text-gray-800">{s.customer_name}</span>
                        <div className="text-[11px] text-gray-400">{regionOf(s.address)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="bg-white rounded-xl border overflow-hidden">
                <div className="px-3 py-2.5 border-b bg-gray-50 text-sm font-medium text-gray-700">
                  미배정 <span className="text-indigo-600 font-bold">{unscheduled.length}</span>건
                  <span className="block text-[11px] text-gray-400 font-normal mt-0.5">가까운 순 정렬</span>
                </div>
                <div className="divide-y max-h-[calc(100vh-360px)] overflow-y-auto">
                  {unscheduled.length === 0 && (
                    <div className="p-6 text-center text-xs text-gray-400">미배정 주문이 없습니다</div>
                  )}
                  {unscheduled.map((s: any) => (
                    <div key={s.order_id} onClick={() => openAssignModal(s, true)} className="p-3 cursor-pointer hover:bg-blue-50">
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
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">루트 {routes.length}개</span>
                <button
                  onClick={addRoute}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700"
                >+ 루트 추가</button>
              </div>

              {routes.length === 0 && (
                <div className="bg-white rounded-xl border p-8 text-center text-xs text-gray-400">
                  아직 루트가 없습니다. "+ 루트 추가"로 시작하세요.
                </div>
              )}

              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <div className="space-y-3 max-h-[calc(100vh-260px)] overflow-y-auto pr-1">
                  {routes.map(route => {
                    const laneStops = stopsForRoute(route.id)
                    const pinned = pinnedForRoute(route.id)
                    const color = colorForRoute(route.id)
                    const visible = routeVisibility[route.id] !== false
                    return (
                      <div key={route.id} className="bg-white rounded-xl border p-2.5">
                        <div className="flex items-center gap-2 mb-2">
                          <input
                            type="checkbox"
                            checked={visible}
                            onChange={() => setRouteVisibility(prev => ({ ...prev, [route.id]: !visible }))}
                            title="지도에 표시"
                          />
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                          <input
                            value={route.label}
                            onChange={e => renameRoute(route, e.target.value)}
                            className="text-sm font-semibold text-gray-800 border-none focus:outline-none focus:ring-1 focus:ring-blue-300 rounded px-1 w-20"
                          />
                          <div className="flex gap-1">
                            {([1, 2] as const).map(n => (
                              <button
                                key={n}
                                onClick={() => setRouteCrew(route, n)}
                                className={`px-2 py-0.5 rounded text-xs font-medium border ${
                                  route.crew_size === n
                                    ? n === 2 ? 'bg-orange-500 text-white border-orange-500' : 'bg-gray-700 text-white border-gray-700'
                                    : 'text-gray-500 border-gray-300'
                                }`}
                              >{n}인</button>
                            ))}
                          </div>
                          <div className="flex gap-1 ml-auto">
                            {waypointPresets.map(p => {
                              const active = dayWaypoints.some(w => w.route_id === route.id && w.preset_key === p.key)
                              const verb = WAYPOINT_VERB[p.key] ?? '경유'
                              return (
                                <button
                                  key={p.key}
                                  onClick={() => toggleWaypoint(route, p)}
                                  className={`px-2 py-0.5 rounded-lg text-[11px] font-medium border transition-colors ${
                                    active ? 'bg-amber-500 text-white border-amber-500' : 'text-amber-600 border-amber-300 hover:bg-amber-50'
                                  }`}
                                >
                                  {active ? `✓ ${p.name} ${verb}` : `+ ${p.name} ${verb}`}
                                </button>
                              )
                            })}
                          </div>
                          <button
                            onClick={() => removeRoute(route)}
                            className="text-gray-300 hover:text-red-400 text-xs px-1"
                          >삭제</button>
                        </div>

                        {pinned && (
                          <div className="flex items-center gap-2 border rounded-lg p-2 bg-green-50 border-green-200 mb-1.5">
                            <span className="w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center shrink-0" style={{ backgroundColor: color }}>출</span>
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium text-gray-800">{pinned.name} 출발</span>
                              <div className="text-[11px] text-gray-400 truncate">{pinned.address}</div>
                            </div>
                          </div>
                        )}

                        <SortableContext items={laneStops.map(s => s.id)} strategy={verticalListSortingStrategy}>
                          <LaneDropZone id={`lane:${route.id}`}>
                            {laneStops.length === 0 ? (
                              <div className="p-4 text-center text-xs text-gray-300">이 루트에 배정된 배송건이 없습니다</div>
                            ) : (
                              laneStops.map((s, i) => (
                                <SortableStop key={s.id} stop={s} index={i} color={color} onRemove={removeStop} />
                              ))
                            )}
                          </LaneDropZone>
                        </SortableContext>
                      </div>
                    )
                  })}
                </div>
              </DndContext>
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

      {assignModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h3 className="font-bold text-gray-800 mb-1">루트 배정</h3>
            <p className="text-sm text-gray-500 mb-4">{assignModal.stop.customer_name}</p>

            {assignModal.needsCrew && (
              <div className="mb-4">
                <p className="text-xs font-medium text-gray-500 mb-2">배송 인원</p>
                <div className="flex gap-2">
                  {([1, 2] as const).map(n => (
                    <button
                      key={n}
                      onClick={() => setModalCrew(n)}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        modalCrew === n
                          ? n === 2 ? 'bg-orange-500 text-white border-orange-500' : 'bg-gray-700 text-white border-gray-700'
                          : 'text-gray-600 border-gray-300 hover:border-gray-400'
                      }`}
                    >{n}인 배송</button>
                  ))}
                </div>
              </div>
            )}

            <div className="mb-6">
              <p className="text-xs font-medium text-gray-500 mb-2">루트 선택</p>
              <div className="flex flex-wrap gap-2">
                {routes.map(r => (
                  <button
                    key={r.id}
                    onClick={() => setModalRouteId(r.id)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      modalRouteId === r.id
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'text-gray-600 border-gray-300 hover:border-indigo-400'
                    }`}
                  >{r.label}</button>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setAssignModal(null)} className="flex-1 py-2 text-sm text-gray-500 border rounded-lg hover:bg-gray-50">취소</button>
              <button onClick={confirmAssign} className="flex-1 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 font-medium">확정</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
