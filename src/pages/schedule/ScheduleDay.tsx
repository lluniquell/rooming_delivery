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
// 셀 서식(자동 줄바꿈 등) 쓰기가 필요해서 일반 xlsx 대신 씀 — 일반 xlsx는 스타일 쓰기를 지원 안 함
import * as XLSX from 'xlsx-js-style'

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
  supplier_name: string | null
}

interface Stop {
  order_id: string
  cafe24_order_no: string
  customer_name: string
  orderer_name: string | null // 주문자(구매자) 원본 — customer_name은 위에서 수령인 표시용으로 덮어씀
  receiver_phone: string | null
  address: string | null
  crew_size: number | null
  route_order: number | null
  route_id: string | null
  lat: number | null
  lng: number | null
  visit_time: string | null
  items: StopItem[]
  _dist?: number
  _routeLabel?: string | null
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

// 주문과 무관하게 1회성으로 넣는 배송지 (예: 2인 배송에서 지원기사가 합류하는 곳)
interface AdhocStop {
  id: string
  route_id: string
  route_order: number
  name: string
  phone: string | null
  address: string | null
  reason: string | null
}

interface RouteLane {
  id: string
  label: string
  crew_size: 1 | 2
  sort_order: number
  driver_ids: string[]
  closed: boolean
  closed_at: string | null
}

interface DriverInfo {
  id: string
  name: string
}

// 주문 배송건과 프리셋 경유지(NK빌딩 등), 1회성 기타 배송지를 하나의 루트로 합친 표현
interface RouteStop {
  id: string
  kind: 'order' | 'preset' | 'adhoc'
  name: string
  address: string | null
  crew_size: number | null
  lat: number | null
  lng: number | null
  visit_time: string | null
  items: StopItem[]
  route_order: number
  route_id: string
  orderer_name?: string | null
  phone?: string | null
  reason?: string | null
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

function SortableStop({ stop, index, color, locked, onRemove, onTimeChange }: {
  stop: RouteStop; index: number; color: string; locked: boolean; onRemove: (s: RouteStop) => void
  onTimeChange: (s: RouteStop, time: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: stop.id, disabled: locked })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const isPreset = stop.kind === 'preset'
  const isAdhoc = stop.kind === 'adhoc'

  return (
    <div ref={setNodeRef} style={style} className={`flex items-center gap-2 border rounded-lg p-2 group ${isPreset ? 'bg-amber-50 border-amber-200' : isAdhoc ? 'bg-purple-50 border-purple-200' : 'bg-white'} ${locked ? 'opacity-70' : ''}`}>
      {/* 고객 약속시간/지원기사 합류시간 — 동선 맨 앞에 표시 */}
      {isPreset || isAdhoc ? (
        <span className="w-[4.5rem] shrink-0" />
      ) : (
        <input
          type="time"
          value={stop.visit_time ?? ''}
          onChange={e => onTimeChange(stop, e.target.value)}
          onClick={e => e.stopPropagation()}
          disabled={locked}
          className="w-[4.5rem] shrink-0 text-xs border rounded px-1 py-1 text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
        />
      )}
      <span {...(locked ? {} : { ...attributes, ...listeners })} className={`text-gray-300 text-lg leading-none px-1 ${locked ? '' : 'cursor-grab'}`}>⠿</span>
      <span className="w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center shrink-0" style={{ backgroundColor: color }}>
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {isPreset ? (
            <span className="text-[10px] px-1 rounded font-bold shrink-0 bg-amber-100 text-amber-700">경유지</span>
          ) : isAdhoc ? (
            <span className="text-[10px] px-1 rounded font-bold shrink-0 bg-purple-100 text-purple-700">기타</span>
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
        {isAdhoc && (stop.phone || stop.reason) && (
          <div className="text-[11px] text-gray-400 truncate">
            {[stop.phone, stop.reason].filter(Boolean).join(' · ')}
          </div>
        )}
        {!isPreset && !isAdhoc && stop.items.map(i => (
          <div key={i.id} className="text-[11px] text-gray-500 truncate">
            {i.product_name} ×{i.quantity}
          </div>
        ))}
      </div>
      {!locked && (
        <button
          onClick={() => onRemove(stop)}
          className="text-gray-300 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity"
        >✕</button>
      )}
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
  const [presets, setPresets] = useState<PresetLocation[]>([])
  const [dayWaypoints, setDayWaypoints] = useState<DayWaypoint[]>([])
  const [adhocStops, setAdhocStops] = useState<AdhocStop[]>([])
  const [routes, setRoutes] = useState<RouteLane[]>([])
  const [routeVisibility, setRouteVisibility] = useState<Record<string, boolean>>({})
  const [drivers, setDrivers] = useState<DriverInfo[]>([])
  const [registeringRouteId, setRegisteringRouteId] = useState<string | null>(null)
  const [geocoding, setGeocoding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [assignModal, setAssignModal] = useState<Stop | null>(null)
  const [modalRouteId, setModalRouteId] = useState('')
  const [adhocModal, setAdhocModal] = useState<RouteLane | null>(null)
  const [adhocForm, setAdhocForm] = useState({ name: '', phone: '', address: '', reason: '' })
  const [adhocTab, setAdhocTab] = useState<'manual' | 'import'>('manual')
  const [importQuery, setImportQuery] = useState('')
  const [importedOrderIds, setImportedOrderIds] = useState<Set<string>>(new Set())

  const mapRef = useRef<HTMLDivElement>(null)
  const mapObjRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const sensors = useSensors(useSensor(PointerSensor))

  const waypointPresets = presets
    .filter(p => p.type === 'waypoint')
    .sort((a, b) => WAYPOINT_ORDER.indexOf(a.key) - WAYPOINT_ORDER.indexOf(b.key))

  const assignedDriverIds = new Set(routes.flatMap(r => r.driver_ids))
  const availableDrivers = drivers.filter(d => !assignedDriverIds.has(d.id))

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
        visit_time: s.visit_time,
        items: s.items,
        route_order: s.route_order ?? 999,
        route_id: s.route_id!,
        orderer_name: s.orderer_name,
        phone: s.receiver_phone,
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
          visit_time: null,
          items: [],
          route_order: w.route_order,
          route_id: w.route_id,
        }
      })
      .filter((x): x is RouteStop => x !== null)
    const adhocPart: RouteStop[] = adhocStops.map(a => ({
      id: `adhoc:${a.id}`,
      kind: 'adhoc',
      name: a.name,
      address: a.address,
      crew_size: null,
      lat: null,
      lng: null,
      visit_time: null,
      items: [],
      route_order: a.route_order,
      route_id: a.route_id,
      phone: a.phone,
      reason: a.reason,
    }))
    return [...orderPart, ...waypointPart, ...adhocPart]
  }, [stops, dayWaypoints, presets, adhocStops])

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

    const { data: driverData } = await supabase
      .from('drivers')
      .select('id, name')
      .contains('permissions', ['driver'])
      .eq('is_active', true)
      .order('name')
    setDrivers(driverData ?? [])

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

    const { data: adhocData } = await supabase
      .from('schedule_adhoc_stops')
      .select('id, route_id, route_order, name, phone, address, reason')
      .eq('date', date)
    setAdhocStops(adhocData ?? [])

    if (jikbae) await loadAll(jikbae.id, routeData ?? [])
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
          orderer_name: o.customer_name,
          receiver_phone: o.receiver_phone,
          address: o.address,
          crew_size: o.crew_size,
          route_order: o.route_order,
          route_id: o.route_id,
          lat: o.lat,
          lng: o.lng,
          visit_time: o.visit_time,
          items: [],
        }
      }
      map[o.id].items.push({ id: row.id, product_name: row.product_name, quantity: row.quantity, supplier_name: row.supplier_name })
    }
    return Object.values(map)
  }

  async function loadAll(bid: string, routesForDate: RouteLane[]) {
    const SELECT = 'id, product_name, quantity, supplier_name, orders!inner(id, cafe24_order_no, customer_name, receiver_name, receiver_phone, address, crew_size, route_order, route_id, lat, lng, scheduled_date, visit_time)'

    const { data: scheduledData } = await supabase
      .from('order_items')
      .select(SELECT)
      .eq('batch_id', bid)
      .in('status', ['confirmed', 'in_transit'])
      .eq('orders.scheduled_date', date)
    const scheduledStops = groupRows((scheduledData ?? []) as any[])

    // 기준점 = 각 루트의 "마지막" 배송지 (다음 배송지를 그 뒤에 이어붙일 위치)
    const routedStops = scheduledStops.filter(s => s.route_id)
    const lastByRoute: Record<string, Stop> = {}
    for (const s of routedStops) {
      const rid = s.route_id!
      if (!lastByRoute[rid] || (s.route_order ?? 0) > (lastByRoute[rid].route_order ?? 0)) {
        lastByRoute[rid] = s
      }
    }
    const anchors = Object.values(lastByRoute).filter(s => s.lat && s.lng)

    function withNearest(list: Stop[]): Stop[] {
      if (!anchors.length) return list
      return list.map(s => {
        if (!s.lat || !s.lng) return { ...s, _dist: Infinity, _routeLabel: null }
        let bestDist = Infinity
        let bestRouteId: string | null = null
        for (const a of anchors) {
          const d = distanceKm(a as any, s as any)
          if (d < bestDist) { bestDist = d; bestRouteId = a.route_id }
        }
        const label = routesForDate.find(r => r.id === bestRouteId)?.label ?? null
        return { ...s, _dist: bestDist, _routeLabel: label }
      }).sort((a, b) => (a._dist ?? Infinity) - (b._dist ?? Infinity))
    }

    // 아직 라우트 없는(같은 날짜) 배송건만 가까운 순 계산
    const unroutedStops = withNearest(scheduledStops.filter(s => !s.route_id))
    setStops([...routedStops, ...unroutedStops])

    // 지오코딩은 백그라운드로 진행 — 완료된 항목만 로컬 state에 반영 (재조회 없음, 무한루프 방지)
    geocodeMissing(scheduledStops)
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
      } else if (s.kind === 'preset') {
        const key = s.id.split(':')[2]
        supabase.from('schedule_day_waypoints').update({ route_order: i + 1 }).eq('route_id', routeId).eq('preset_key', key).then(() => {})
      } else {
        const adhocId = s.id.split(':')[1]
        supabase.from('schedule_adhoc_stops').update({ route_order: i + 1, route_id: routeId }).eq('id', adhocId).then(() => {})
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
    setAdhocStops(prev => prev.map(a => {
      const idx = list.findIndex(l => l.id === `adhoc:${a.id}`)
      return idx >= 0 ? { ...a, route_order: idx + 1, route_id: routeId } : a
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

    // 마감(잠금)된 루트는 내용 변경 불가 — 옮겨오는 것도, 옮겨나가는 것도 막음
    if (routes.find(r => r.id === activeStop.route_id)?.closed) return
    if (routes.find(r => r.id === destRouteId)?.closed) return

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

  async function updateVisitTime(stop: RouteStop, time: string) {
    if (stop.kind !== 'order') return
    await supabase.from('orders').update({ visit_time: time || null }).eq('id', stop.id)
    setStops(prev => prev.map(s => s.order_id === stop.id ? { ...s, visit_time: time || null } : s))
  }

  async function removeStop(stop: RouteStop) {
    if (stop.kind === 'order') {
      await supabase.from('orders').update({ scheduled_date: null, crew_size: null, route_order: null, route_id: null, visit_time: null }).eq('id', stop.id)
      if (batchId) loadAll(batchId, routes)
    } else if (stop.kind === 'preset') {
      const [, routeId, key] = stop.id.split(':')
      await supabase.from('schedule_day_waypoints').delete().eq('route_id', routeId).eq('preset_key', key)
      setDayWaypoints(prev => prev.filter(w => !(w.route_id === routeId && w.preset_key === key)))
    } else {
      const adhocId = stop.id.split(':')[1]
      await supabase.from('schedule_adhoc_stops').delete().eq('id', adhocId)
      setAdhocStops(prev => prev.filter(a => a.id !== adhocId))
    }
  }

  function openAdhocModal(route: RouteLane) {
    setAdhocForm({ name: '', phone: '', address: '', reason: '' })
    setAdhocTab('manual')
    setImportQuery('')
    setImportedOrderIds(new Set())
    setAdhocModal(route)
  }

  async function confirmAddAdhoc() {
    if (!adhocModal || !adhocForm.name.trim() || !date) return
    const route_order = stopsForRoute(adhocModal.id).length + 1
    const { data } = await supabase.from('schedule_adhoc_stops')
      .insert({
        date,
        route_id: adhocModal.id,
        route_order,
        name: adhocForm.name.trim(),
        phone: adhocForm.phone.trim() || null,
        address: adhocForm.address.trim() || null,
        reason: adhocForm.reason.trim() || null,
      })
      .select('id, route_id, route_order, name, phone, address, reason')
      .single()
    if (data) setAdhocStops(prev => [...prev, data])
    setAdhocModal(null)
  }

  // 2인 배송 등에서, 이미 다른 루트에 배정된 당일 주문을 이 루트에도 동행 배송지로
  // 그대로 가져다 붙임(수기로 이름/연락처/주소 재입력 안 해도 되게) — 실제 order_id를
  // 공유하는 게 아니라 값만 복사한 1회성 배송지(adhoc)로 추가
  async function addOrderAsAdhoc(stop: Stop) {
    if (!adhocModal || !date) return
    const route_order = stopsForRoute(adhocModal.id).length + 1
    const { data } = await supabase.from('schedule_adhoc_stops')
      .insert({
        date,
        route_id: adhocModal.id,
        route_order,
        name: stop.customer_name,
        phone: stop.receiver_phone,
        address: stop.address,
        reason: `동행 (${stop.cafe24_order_no})`,
      })
      .select('id, route_id, route_order, name, phone, address, reason')
      .single()
    if (data) {
      setAdhocStops(prev => [...prev, data])
      setImportedOrderIds(prev => new Set(prev).add(stop.order_id))
    }
  }

  // 이 루트의 현재 배송 순서를 직배 수기 엑셀과 동일한 양식으로 다운로드
  function downloadRouteExcel(route: RouteLane) {
    const laneStops = stopsForRoute(route.id)
    const pinned = pinnedForRoute(route.id)
    if (!laneStops.length && !pinned) { alert('이 루트에 배정된 배송건이 없습니다.'); return }

    const header = ['배송 담당자', '판매담당자', '고객명', '번호', '제품명', '도착시간', '연락처', '주소']
    const lines: { groupKey: string; cells: string[] }[] = []

    if (pinned) {
      lines.push({ groupKey: `pinned-${route.id}`, cells: ['', '', `${pinned.name} 출발`, '', '', '', '', pinned.address ?? ''] })
    }

    for (const stop of laneStops) {
      if (stop.kind === 'preset') {
        lines.push({ groupKey: stop.id, cells: ['', '', stop.name, '', '', '', '', stop.address ?? ''] })
      } else if (stop.kind === 'adhoc') {
        lines.push({ groupKey: stop.id, cells: ['', '', stop.name, '', stop.reason ?? '', '', stop.phone ?? '', stop.address ?? ''] })
      } else {
        const total = stop.items.length
        stop.items.forEach((item, idx) => {
          lines.push({
            groupKey: stop.id,
            cells: [
              '',
              stop.orderer_name ?? '',
              stop.name,
              total > 1 ? `${idx + 1}-${total}` : '',
              item.supplier_name ? `${item.product_name} x ${item.quantity}ea\n${item.supplier_name}` : `${item.product_name} x ${item.quantity}ea`,
              stop.visit_time ?? '',
              stop.phone ?? '',
              stop.address ?? '',
            ],
          })
        })
      }
    }

    const ws = XLSX.utils.aoa_to_sheet([header, ...lines.map(l => l.cells)])

    // 제품명 셀에 상품명\n공급사명 줄바꿈이 들어가므로 자동 줄바꿈 서식 적용
    for (let i = 0; i < lines.length; i++) {
      const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: 4 })
      if (ws[cellRef]) ws[cellRef].s = { alignment: { wrapText: true, vertical: 'top' } }
    }

    // 같은 배송지(주문/경유지/기타)의 여러 상품 행은 판매담당자/고객명/연락처/주소가 똑같으니 셀 병합
    const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = []
    const mergeCols = [1, 2, 6, 7]
    let runStart = 0
    for (let i = 1; i <= lines.length; i++) {
      const sameGroup = i < lines.length && lines[i].groupKey === lines[runStart].groupKey
      if (!sameGroup) {
        if (i - runStart > 1) {
          for (const c of mergeCols) merges.push({ s: { r: runStart + 1, c }, e: { r: i, c } })
        }
        runStart = i
      }
    }
    ws['!merges'] = merges

    // 열 너비 자동 지정 (한글은 2칸으로 계산), 제품명·주소는 상한선
    const strWidth = (s: string) => {
      let w = 0
      for (const ch of s) w += /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch) ? 2 : 1
      return w
    }
    const COL_MAX: Record<number, number> = { 4: 40, 7: 45 }
    ws['!cols'] = header.map((h, colIdx) => {
      let max = strWidth(h)
      for (const l of lines) {
        for (const line of String(l.cells[colIdx] ?? '').split('\n')) max = Math.max(max, strWidth(line))
      }
      const width = max + 2
      return { wch: COL_MAX[colIdx] ? Math.min(width, COL_MAX[colIdx]) : width }
    })

    // 병합된 행은 엑셀이 줄바꿈에 맞춰 행 높이를 자동으로 못 맞추므로, 줄 수에 맞춰 직접 지정
    const ROW_HEIGHT_PT = 15
    ws['!rows'] = [{}, ...lines.map(l => {
      const lineCount = (String(l.cells[4]).match(/\n/g)?.length ?? 0) + 1
      return { hpt: ROW_HEIGHT_PT * lineCount }
    })]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, route.label.slice(0, 28) || '루트')
    XLSX.writeFile(wb, `루트_${route.label}_${date}.xlsx`)
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
    const label = `${routes.length + 1}호차`
    const sort_order = routes.length
    const { data } = await supabase.from('schedule_routes')
      .insert({ date, label, crew_size: 1, sort_order, driver_ids: [] })
      .select('*')
      .single()
    if (data) {
      setRoutes(prev => [...prev, data])
      setRouteVisibility(prev => ({ ...prev, [data.id]: true }))
    }
  }

  // 배송원 배정 — 한 배송원은 하루에 한 루트에만, 다른 루트에 있었으면 자동으로 빠짐
  async function assignDriver(route: RouteLane, driverId: string) {
    if (route.driver_ids.includes(driverId)) return
    const updates: { id: string; driver_ids: string[] }[] = []
    for (const r of routes) {
      if (r.id === route.id) {
        updates.push({ id: r.id, driver_ids: [...r.driver_ids, driverId] })
      } else if (r.driver_ids.includes(driverId)) {
        updates.push({ id: r.id, driver_ids: r.driver_ids.filter(id => id !== driverId) })
      }
    }
    await Promise.all(updates.map(u => supabase.from('schedule_routes').update({ driver_ids: u.driver_ids }).eq('id', u.id)))
    setRoutes(prev => prev.map(r => {
      const u = updates.find(u => u.id === r.id)
      return u ? { ...r, driver_ids: u.driver_ids } : r
    }))
  }

  async function unassignDriver(route: RouteLane, driverId: string) {
    const driver_ids = route.driver_ids.filter(id => id !== driverId)
    await supabase.from('schedule_routes').update({ driver_ids }).eq('id', route.id)
    setRoutes(prev => prev.map(r => r.id === route.id ? { ...r, driver_ids } : r))
  }

  async function removeRoute(route: RouteLane) {
    if (route.closed) return
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

  function openAssignModal(stop: Stop) {
    const openRoutes = routes.filter(r => !r.closed)
    if (!openRoutes.length) { alert('배정 가능한 루트가 없습니다. 먼저 루트를 추가하거나, 마감되지 않은 루트가 있는지 확인해주세요.'); return }
    setAssignModal(stop)
    setModalRouteId(openRoutes[0].id)
  }

  async function confirmAssign() {
    if (!assignModal || !modalRouteId) return
    const targetLen = stopsForRoute(modalRouteId).length
    await supabase.from('orders').update({
      route_id: modalRouteId,
      route_order: targetLen + 1,
    }).eq('id', assignModal.order_id)
    setAssignModal(null)
    if (batchId) loadAll(batchId, routes)
  }

  // 루트 마감(잠금) — 이 루트에 배정된 직배 주문들만 카페24에 배송대기로 등록하고, 이후 이 루트의
  // 내용(주문/경유지/기타 배송지 추가·삭제·순서변경)은 잠김. 마감 취소로 다시 잠금 해제 가능
  async function toggleRouteClosed(route: RouteLane) {
    if (!date) return
    const next = !route.closed
    if (next) {
      const routeOrders = stops.filter(s => s.route_id === route.id)
      if (routeOrders.length) {
        setRegisteringRouteId(route.id)
        const trackingNo = `직배${date.replace(/-/g, '')}`
        try {
          const res = await fetch('/api/cafe24/shipments?action=standby', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orders: routeOrders.map(s => ({ order_no: s.cafe24_order_no, tracking_no: trackingNo })),
              delivery_method: '직배',
              carrier_code: '0001',
            }),
          })
          const data = await res.json()
          if (data.errors?.length) {
            alert(`카페24 배송대기 등록 ${data.updated ?? 0}건 / 전체 ${data.total ?? routeOrders.length}건\n실패:\n${data.errors.slice(0, 5).join('\n')}`)
          }
        } catch {
          alert('카페24 등록 중 네트워크 오류가 발생했습니다.')
        }
        setRegisteringRouteId(null)
      }
    }
    const closed_at = next ? new Date().toISOString() : null
    await supabase.from('schedule_routes').update({ closed: next, closed_at }).eq('id', route.id)
    setRoutes(prev => prev.map(r => r.id === route.id ? { ...r, closed: next, closed_at } : r))
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
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-20 text-sm">불러오는 중...</div>
      ) : (
        <div className="flex gap-4">
          {routes.some(r => !r.closed) && unrouted.length > 0 && (
            <div className="w-72 shrink-0">
              <div className="bg-white rounded-xl border overflow-hidden">
                <div className="px-3 py-2.5 border-b bg-red-50 text-sm font-medium text-red-700">
                  루트 미배정 <span className="font-bold">{unrouted.length}</span>건
                  <span className="block text-[11px] text-red-400 font-normal mt-0.5">가까운 순 정렬</span>
                </div>
                <div className="divide-y max-h-[calc(100vh-260px)] overflow-y-auto">
                  {unrouted.map(s => (
                    <div key={s.order_id} onClick={() => openAssignModal(s)} className="p-3 cursor-pointer hover:bg-blue-50">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-800">{s.customer_name}</span>
                        {s._dist !== undefined && s._dist !== Infinity && s._routeLabel && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${
                            s._dist < 10 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                          }`}>
                            📍 {s._routeLabel} · {s._dist.toFixed(1)}km
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-400">{regionOf(s.address)}</div>
                      {s.items.map(i => (
                        <div key={i.id} className="text-[11px] text-gray-500 truncate">
                          {i.product_name} ×{i.quantity}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex-1 grid grid-cols-2 gap-4 min-w-0">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-gray-700 shrink-0">루트 {routes.length}개</span>
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  {availableDrivers.length > 0 && (
                    <>
                      <span className="text-[11px] text-gray-400">가용 배송원</span>
                      {availableDrivers.map(d => (
                        <div
                          key={d.id}
                          draggable
                          onDragStart={e => e.dataTransfer.setData('text/driver-id', d.id)}
                          className="px-2 py-1 rounded-lg text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200 cursor-grab hover:bg-gray-200"
                        >{d.name}</div>
                      ))}
                    </>
                  )}
                  <button
                    onClick={addRoute}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700"
                  >+ 루트 추가</button>
                </div>
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
                      <div
                        key={route.id}
                        className={`bg-white rounded-xl border p-2.5 ${route.closed ? 'opacity-80' : ''}`}
                        onDragOver={e => e.preventDefault()}
                        onDrop={e => {
                          const driverId = e.dataTransfer.getData('text/driver-id')
                          if (driverId) assignDriver(route, driverId)
                        }}
                      >
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
                          {route.closed && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-gray-200 text-gray-600 shrink-0">🔒 마감</span>
                          )}
                          <div className="flex gap-1 ml-auto items-center">
                            <button
                              onClick={() => downloadRouteExcel(route)}
                              title="이 루트를 직배 수기 엑셀과 동일한 양식으로 다운로드"
                              className="px-2 py-0.5 rounded-lg text-[11px] font-medium border border-gray-300 text-gray-600 hover:bg-gray-50"
                            >⬇ 엑셀</button>
                            {waypointPresets.map(p => {
                              const active = dayWaypoints.some(w => w.route_id === route.id && w.preset_key === p.key)
                              const verb = WAYPOINT_VERB[p.key] ?? '경유'
                              return (
                                <button
                                  key={p.key}
                                  onClick={() => toggleWaypoint(route, p)}
                                  disabled={route.closed}
                                  className={`px-2 py-0.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                    active ? 'bg-amber-500 text-white border-amber-500' : 'text-amber-600 border-amber-300 hover:bg-amber-50'
                                  }`}
                                >
                                  {active ? `✓ ${p.name} ${verb}` : `+ ${p.name} ${verb}`}
                                </button>
                              )
                            })}
                            <button
                              onClick={() => openAdhocModal(route)}
                              disabled={route.closed}
                              className="px-2 py-0.5 rounded-lg text-[11px] font-medium border border-purple-300 text-purple-600 hover:bg-purple-50 disabled:opacity-40 disabled:cursor-not-allowed"
                            >+ 기타 배송지</button>
                          </div>
                          <button
                            onClick={() => toggleRouteClosed(route)}
                            disabled={registeringRouteId === route.id}
                            className={`px-2 py-0.5 rounded-lg text-[11px] font-medium disabled:opacity-50 ${
                              route.closed ? 'bg-gray-200 text-gray-700 hover:bg-gray-300' : 'bg-red-600 text-white hover:bg-red-700'
                            }`}
                          >
                            {registeringRouteId === route.id ? '카페24 등록 중...' : route.closed ? '🔓 마감 취소' : '🔒 마감'}
                          </button>
                          <button
                            onClick={() => removeRoute(route)}
                            disabled={route.closed}
                            className="text-gray-300 hover:text-red-400 text-xs px-1 disabled:opacity-30 disabled:cursor-not-allowed"
                          >삭제</button>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap mb-2 min-h-[22px]">
                          {route.driver_ids.length === 0 ? (
                            <span className="text-[11px] text-gray-300">배송원을 여기로 끌어넣으세요</span>
                          ) : (
                            route.driver_ids.map(id => {
                              const driver = drivers.find(d => d.id === id)
                              return (
                                <span key={id} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
                                  {driver?.name ?? '알 수 없음'}
                                  <button onClick={() => unassignDriver(route, id)} className="text-indigo-400 hover:text-indigo-700">✕</button>
                                </span>
                              )
                            })
                          )}
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
                                <SortableStop key={s.id} stop={s} index={i} color={color} locked={route.closed} onRemove={removeStop} onTimeChange={updateVisitTime} />
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
              {routes.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 border-b bg-gray-50">
                  {routes.map(route => {
                    const visible = routeVisibility[route.id] !== false
                    return (
                      <label key={route.id} className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={visible}
                          onChange={() => setRouteVisibility(prev => ({ ...prev, [route.id]: !visible }))}
                        />
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorForRoute(route.id) }} />
                        {route.label}
                      </label>
                    )
                  })}
                </div>
              )}
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
            <p className="text-sm text-gray-500 mb-4">{assignModal.customer_name}</p>

            <div className="mb-6">
              <p className="text-xs font-medium text-gray-500 mb-2">루트 선택</p>
              <div className="flex flex-wrap gap-2">
                {routes.filter(r => !r.closed).map(r => (
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

      {adhocModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h3 className="font-bold text-gray-800 mb-1">기타 배송지 추가</h3>
            <p className="text-sm text-gray-500 mb-4">{adhocModal.label}에 1회성 배송지를 추가합니다.</p>

            <div className="flex gap-1 mb-4 bg-gray-100 rounded-lg p-1">
              <button
                onClick={() => setAdhocTab('manual')}
                className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  adhocTab === 'manual' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'
                }`}
              >직접 입력</button>
              <button
                onClick={() => setAdhocTab('import')}
                className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  adhocTab === 'import' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'
                }`}
              >당일 배송건 불러오기</button>
            </div>

            {adhocTab === 'manual' ? (
              <div className="space-y-3 mb-6">
                <input
                  value={adhocForm.name}
                  onChange={e => setAdhocForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="이름"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <input
                  value={adhocForm.phone}
                  onChange={e => setAdhocForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="연락처"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <input
                  value={adhocForm.address}
                  onChange={e => setAdhocForm(f => ({ ...f, address: e.target.value }))}
                  placeholder="배송지"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <input
                  value={adhocForm.reason}
                  onChange={e => setAdhocForm(f => ({ ...f, reason: e.target.value }))}
                  placeholder="사유"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
            ) : (
              <div className="mb-6">
                <input
                  value={importQuery}
                  onChange={e => setImportQuery(e.target.value)}
                  placeholder="이름·주소·주문번호로 검색"
                  className="w-full border rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <div className="border rounded-lg divide-y max-h-72 overflow-y-auto">
                  {stops
                    .filter(s => {
                      const q = importQuery.trim()
                      if (!q) return true
                      return [s.customer_name, s.address, s.cafe24_order_no].some(v => v?.includes(q))
                    })
                    .map(s => {
                      const added = importedOrderIds.has(s.order_id)
                      const routeLabel = routes.find(r => r.id === s.route_id)?.label
                      return (
                        <div key={s.order_id} className="flex items-center justify-between gap-2 px-3 py-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium text-gray-800 truncate">{s.customer_name}</span>
                              <span className="text-[10px] text-gray-400 shrink-0">
                                {routeLabel ? `${routeLabel} 배정` : '미배정'}
                              </span>
                            </div>
                            <div className="text-[11px] text-gray-400 truncate">{s.address}</div>
                            <div className="text-[10px] text-gray-300 font-mono">{s.cafe24_order_no}</div>
                          </div>
                          <button
                            onClick={() => addOrderAsAdhoc(s)}
                            disabled={added}
                            className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed"
                          >{added ? '추가됨' : '+ 추가'}</button>
                        </div>
                      )
                    })}
                  {stops.length === 0 && (
                    <div className="px-3 py-6 text-center text-xs text-gray-400">오늘 등록된 배송건이 없습니다</div>
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={() => setAdhocModal(null)} className="flex-1 py-2 text-sm text-gray-500 border rounded-lg hover:bg-gray-50">
                {adhocTab === 'import' ? '닫기' : '취소'}
              </button>
              {adhocTab === 'manual' && (
                <button
                  onClick={confirmAddAdhoc}
                  disabled={!adhocForm.name.trim()}
                  className="flex-1 py-2 text-sm text-white bg-purple-600 rounded-lg hover:bg-purple-700 font-medium disabled:opacity-50"
                >추가</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
