import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { compressImage } from '../../lib/photo'

interface OrderStop {
  id: string
  customer_name: string
  address: string
  delivered_at: string | null
  delivery_memo: string | null
}

// 관리자 화면(ScheduleDay)의 루트 순서에는 실제 주문뿐 아니라 경유지/기타 배송지도 자기 순번을
// 차지하고 있어서, 여기서도 셋 다 합쳐서 같은 순서로 보여줘야 관리자/기사 앱의 번호가 일치함
type CombinedStop =
  | { kind: 'order'; route_order: number; order: OrderStop }
  | { kind: 'preset'; route_order: number; name: string; address: string | null }
  | { kind: 'adhoc'; route_order: number; id: string; name: string; address: string | null; phone: string | null; reason: string | null }

const STATUS_LABEL: Record<string, string> = { pending: '대기', done: '완료', failed: '불가' }
const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
}

function statusOf(s: OrderStop): 'pending' | 'done' | 'failed' {
  if (s.delivered_at) return 'done'
  if (s.delivery_memo) return 'failed'
  return 'pending'
}

function mapDeeplink(address: string) {
  const encoded = encodeURIComponent(address)
  return {
    tmap: `tmap://search?name=${encoded}`,
    naver: `nmap://search?query=${encoded}&appname=com.rooming.delivery`,
  }
}

// 로컬(KST) 기준 날짜 — toISOString은 UTC라 오전 9시 전에 하루 밀림
function fmtDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function addDays(dateStr: string, delta: number) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + delta)
  return fmtDate(d)
}
function displayDate(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00`)
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`
}

export default function DriverList() {
  const [stops, setStops] = useState<CombinedStop[]>([])
  const [pinned, setPinned] = useState<{ name: string; address: string | null } | null>(null)
  const [photoTakenAdhoc, setPhotoTakenAdhoc] = useState<Set<string>>(new Set())
  const [expandedAdhoc, setExpandedAdhoc] = useState<Set<string>>(new Set())
  const [uploadingAdhocId, setUploadingAdhocId] = useState<string | null>(null)
  const [driverName, setDriverName] = useState('')
  const todayStr = fmtDate(new Date())
  const [viewDate, setViewDate] = useState(todayStr)
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: driverRow } = await supabase.from('drivers').select('name').eq('id', user.id).maybeSingle()
      if (driverRow) setDriverName(driverRow.name)

      // 그 날짜에 내가 배정된 루트들을 먼저 찾음 (배송원 한 명은 하루에 한 루트에만 배정됨)
      const { data: routeRows } = await supabase
        .from('schedule_routes')
        .select('id')
        .eq('date', viewDate)
        .contains('driver_ids', [user.id])
      const routeIds = (routeRows ?? []).map(r => r.id)
      if (!routeIds.length) { setStops([]); setPinned(null); return }

      // 주문뿐 아니라 경유지(NK 등)·기타 배송지도 같은 route_order 순번을 차지하므로
      // 셋 다 가져와 합쳐야 관리자 화면(ScheduleDay)의 순서/번호와 일치함
      const [{ data: orderData }, { data: waypointData }, { data: adhocData }] = await Promise.all([
        supabase
          .from('orders')
          .select('id, customer_name, receiver_name, address, route_order, delivered_at, delivery_memo')
          .in('route_id', routeIds)
          .eq('scheduled_date', viewDate),
        supabase
          .from('schedule_day_waypoints')
          .select('preset_key, route_order')
          .in('route_id', routeIds)
          .eq('date', viewDate),
        supabase
          .from('schedule_adhoc_stops')
          .select('id, name, phone, address, reason, route_order')
          .in('route_id', routeIds)
          .eq('date', viewDate),
      ])

      // 출발지(선진)는 관리자 화면에서도 번호 매김 없이 맨 위에 고정 표시되므로 여기서도 동일하게 분리
      const depotWaypoint = (waypointData ?? []).find(w => w.preset_key === 'depot')
      const routedWaypoints = (waypointData ?? []).filter(w => w.preset_key !== 'depot')
      const presetKeys = [...new Set([depotWaypoint?.preset_key, ...routedWaypoints.map(w => w.preset_key)].filter((k): k is string => !!k))]
      const presetMap: Record<string, { name: string; address: string | null }> = {}
      if (presetKeys.length) {
        const { data: presetData } = await supabase.from('preset_locations').select('key, name, address').in('key', presetKeys)
        for (const p of presetData ?? []) presetMap[p.key] = { name: p.name, address: p.address }
      }
      setPinned(depotWaypoint ? presetMap[depotWaypoint.preset_key] ?? null : null)

      const combined: CombinedStop[] = [
        ...(orderData ?? []).map((o: any): CombinedStop => ({
          kind: 'order',
          route_order: o.route_order ?? 0,
          order: {
            id: o.id,
            customer_name: o.receiver_name || o.customer_name,
            address: o.address,
            delivered_at: o.delivered_at,
            delivery_memo: o.delivery_memo,
          },
        })),
        ...routedWaypoints.map((w): CombinedStop => ({
          kind: 'preset',
          route_order: w.route_order,
          name: presetMap[w.preset_key]?.name ?? w.preset_key,
          address: presetMap[w.preset_key]?.address ?? null,
        })),
        ...(adhocData ?? []).map((a): CombinedStop => ({
          kind: 'adhoc',
          route_order: a.route_order,
          id: a.id,
          name: a.name,
          address: a.address,
          phone: a.phone,
          reason: a.reason,
        })),
      ].sort((a, b) => a.route_order - b.route_order)

      setStops(combined)

      // 이미 찍은 기타 배송지 사진은 미리 체크 표시 (앱을 도중에 나갔다 다시 들어온 경우 대비)
      const adhocIds = (adhocData ?? []).map(a => a.id)
      if (adhocIds.length) {
        const { data: photos } = await supabase
          .from('delivery_photos')
          .select('adhoc_stop_id')
          .in('adhoc_stop_id', adhocIds)
        setPhotoTakenAdhoc(new Set((photos ?? []).map((p: any) => p.adhoc_stop_id)))
      } else {
        setPhotoTakenAdhoc(new Set())
      }
    }
    load()
  }, [viewDate])

  async function handleAdhocPhoto(stopId: string, file: File) {
    setUploadingAdhocId(stopId)
    try {
      const compressed = await compressImage(file)
      const path = `adhoc/${stopId}/${Date.now()}.jpg`
      const { error: uploadError } = await supabase.storage.from('delivery-photos').upload(path, compressed)
      if (uploadError) { alert(`사진 업로드 실패: ${uploadError.message}`); return }
      const { error: insertError } = await supabase.from('delivery_photos').insert({ adhoc_stop_id: stopId, storage_path: path })
      if (insertError) { alert(`사진 저장 실패: ${insertError.message}`); return }
      setPhotoTakenAdhoc(prev => new Set([...prev, stopId]))

      // 채널톡 알림 — 실패해도 사진 저장 자체는 이미 끝난 상태라 조용히 넘어감
      try {
        await fetch('/api/channeltalk/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'adhoc', id: stopId, driver_name: driverName }),
        })
      } catch { /* 알림 실패는 사진 저장에 영향 없음 */ }
    } finally {
      setUploadingAdhocId(null)
    }
  }

  function handleTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]
    touchStart.current = { x: t.clientX, y: t.clientY }
  }
  function handleTouchEnd(e: React.TouchEvent) {
    if (!touchStart.current) return
    const t = e.changedTouches[0]
    const dx = t.clientX - touchStart.current.x
    const dy = t.clientY - touchStart.current.y
    touchStart.current = null
    // 세로 스크롤과 헷갈리지 않도록 가로 이동이 충분히 크고 세로 이동보다 뚜렷할 때만 날짜 전환
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
      setViewDate(d => addDays(d, dx < 0 ? 1 : -1))
    }
  }

  return (
    <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setViewDate(d => addDays(d, -1))}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-gray-100 text-gray-600 text-lg active:bg-gray-200"
        >‹</button>
        <div className="text-center">
          <h2 className="text-lg font-bold text-gray-800">{displayDate(viewDate)} 배송 목록</h2>
          {viewDate !== todayStr && (
            <button onClick={() => setViewDate(todayStr)} className="text-xs text-blue-600 mt-0.5">오늘로 이동</button>
          )}
        </div>
        <button
          onClick={() => setViewDate(d => addDays(d, 1))}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-gray-100 text-gray-600 text-lg active:bg-gray-200"
        >›</button>
      </div>
      {pinned && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl p-4 mb-3">
          <span className="w-8 h-8 rounded-full bg-green-600 text-white text-xs font-bold flex items-center justify-center shrink-0">출</span>
          <div className="min-w-0">
            <span className="font-medium text-gray-800">{pinned.name} 출발</span>
            {pinned.address && <p className="text-xs text-gray-400 truncate">{pinned.address}</p>}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {stops.length === 0 && !pinned && (
          <p className="text-center py-12 text-gray-400">배정된 배송이 없습니다.</p>
        )}
        {stops.map((s, i) => {
          if (s.kind === 'order') {
            const status = statusOf(s.order)
            return (
              <Link
                key={s.order.id}
                to={`/delivery/${s.order.id}`}
                className="block bg-white rounded-xl border p-4 hover:shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-xs text-gray-400 mr-2">{i + 1}번째</span>
                    <span className="font-medium">{s.order.customer_name}</span>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[status]}`}>
                    {STATUS_LABEL[status]}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1">{s.order.address}</p>
              </Link>
            )
          }
          if (s.kind === 'preset') {
            return (
              <div key={`preset-${i}`} className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">{i + 1}번째</span>
                  <span className="text-[10px] px-1 rounded font-bold bg-amber-100 text-amber-700">경유지</span>
                  <span className="font-medium">{s.name}</span>
                </div>
                {s.address && <p className="text-sm text-gray-500 mt-1">{s.address}</p>}
              </div>
            )
          }
          {
            // s.kind === 'adhoc' — 원래 배송(주문) 카드와 동일하게, 클릭해서 펼쳐야
            // 전화/문자/지도/촬영 버튼이 나오게 함(2026-09-21)
            const photographed = photoTakenAdhoc.has(s.id)
            const uploading = uploadingAdhocId === s.id
            const expanded = expandedAdhoc.has(s.id)
            const links = s.address ? mapDeeplink(s.address) : null
            return (
              <div key={s.id} className="bg-purple-50 border border-purple-200 rounded-xl p-4">
                <button
                  className="w-full text-left"
                  onClick={() => setExpandedAdhoc(prev => {
                    const next = new Set(prev)
                    next.has(s.id) ? next.delete(s.id) : next.add(s.id)
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">{i + 1}번째</span>
                    <span className="text-[10px] px-1 rounded font-bold bg-purple-100 text-purple-700">기타</span>
                    <span className="font-medium">{s.name}</span>
                    {photographed && <span className="text-green-600 text-xs font-medium ml-auto">✓ 촬영완료</span>}
                  </div>
                  {s.address && <p className="text-sm text-gray-500 mt-1">{s.address}</p>}
                </button>
                {expanded && (
                  <>
                    {(s.phone || s.reason) && (
                      <p className="text-xs text-gray-400 mt-1">{[s.phone, s.reason].filter(Boolean).join(' · ')}</p>
                    )}
                    <div className="flex gap-2 mt-2">
                      {s.phone && (
                        <a href={`tel:${s.phone}`} className="flex-1 text-center bg-white text-gray-700 border py-1.5 rounded-lg text-xs font-medium">📞 전화</a>
                      )}
                      {s.phone && (
                        <a href={`sms:${s.phone}`} className="flex-1 text-center bg-white text-gray-700 border py-1.5 rounded-lg text-xs font-medium">💬 문자</a>
                      )}
                      {links && (
                        <a href={links.tmap} className="flex-1 text-center bg-white text-gray-700 border py-1.5 rounded-lg text-xs font-medium">🗺️ 티맵</a>
                      )}
                      {links && (
                        <a href={links.naver} className="flex-1 text-center bg-white text-gray-700 border py-1.5 rounded-lg text-xs font-medium">📍 네이버</a>
                      )}
                      {!photographed && (
                        <label className="flex-1 text-center bg-purple-600 text-white py-1.5 rounded-lg text-xs font-medium cursor-pointer">
                          {uploading ? '업로드 중...' : '📷 촬영'}
                          <input
                            type="file"
                            accept="image/*"
                            capture="environment"
                            className="hidden"
                            disabled={uploading}
                            onChange={e => {
                              const file = e.target.files?.[0]
                              if (file) handleAdhocPhoto(s.id, file)
                            }}
                          />
                        </label>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          }
        })}
      </div>
    </div>
  )
}
