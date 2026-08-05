import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { supabase } from '../../lib/supabase'

interface Item {
  id: string
  product_code: string
  product_name: string
  option_info: string | null
  brand: string | null
  supplier_name: string | null
  quantity: number
  labels: string[] | null
  cafe24_item_code: string | null
}

interface OrderGroup {
  order_id: string
  cafe24_order_no: string
  customer_name: string
  receiver_name: string | null
  address: string | null
  order_date: string | null
  order_place_name: string | null
  admin_memo: string[] | null
  items: Item[]
}

interface Batch {
  id: string
  batch_no: string
  name: string
  type: string
}

const DELIVERY_METHODS = ['CJ', '경동', '직배', '팀무버', '업체배송']
// 상품(order_item) 개수가 아니라 "주문" 개수 기준 — 그래야 한 주문의 상품들이
// 페이지 경계에서 쪼개지지 않음
const PAGE_SIZE = 50

// 배치 이름으로 배송방법을 유추 — 어느 바구니에 넣느냐가 곧 배송방법 지정이라,
// 배정 시점에 자동으로 order_items.delivery_method에 찍어둠 (보류로 옮겨도 이 값은 안 바뀜)
function methodOfBatch(name: string): string | null {
  if (name.includes('CJ')) return 'CJ'
  if (name.includes('경동')) return '경동'
  if (name.includes('직배')) return '직배'
  if (name.includes('팀무버')) return '팀무버'
  if (name.includes('업체배송')) return '업체배송'
  return null
}
const LOC_REGEX = /[A-Z]{2}-\d{2}-\d{2}-\d{2}/

// 동까지만 (예: "서울 강남구 도산대로83길")
function regionOf(address: string) {
  return address.split(/\s+/).slice(0, 3).join(' ')
}

function locationOf(item: Item) {
  return item.supplier_name?.match(LOC_REGEX)?.[0] ?? ''
}

// 주문경로 텍스트로 판단 — 정확한 코드값 대신 이름 텍스트 매칭이라 표기가 바뀌어도 웬만하면 잡힘
function ChannelBadge({ placeName }: { placeName: string | null }) {
  if (!placeName) return null
  if (placeName.includes('카카오')) {
    return (
      <span title={placeName} className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold shrink-0" style={{ backgroundColor: '#FEE500', color: '#391B1B' }}>
        K
      </span>
    )
  }
  if (placeName.includes('스마트스토어') || placeName.includes('네이버')) {
    return (
      <span title={placeName} className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold shrink-0 text-white" style={{ backgroundColor: '#03C75A' }}>
        N
      </span>
    )
  }
  return null
}

// 로컬(KST) 기준 날짜 — toISOString은 UTC라 오전 9시 전에 하루 밀림
const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = () => fmtDate(new Date())
const daysAgo = (n: number) => fmtDate(new Date(Date.now() - n * 86400000))

// 넓은 날짜 범위를 하루 단위로 쪼개서 순차 수집 — 한 번에 다 하면 타임아웃 남
function dateRange(start: string, end: string): string[] {
  const days: string[] = []
  const cur = new Date(`${start}T00:00:00`)
  const last = new Date(`${end}T00:00:00`)
  while (cur <= last) {
    days.push(fmtDate(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

const PRESETS = [
  { label: '오늘', start: () => today() },
  { label: '어제', start: () => daysAgo(1), end: () => daysAgo(1) },
  { label: '3일', start: () => daysAgo(3) },
  { label: '7일', start: () => daysAgo(7) },
  { label: '15일', start: () => daysAgo(15) },
  { label: '1개월', start: () => daysAgo(30) },
  { label: '3개월', start: () => daysAgo(90) },
  { label: '6개월', start: () => daysAgo(180) },
  { label: '1년', start: () => daysAgo(365) },
]

// 주문 하나 + 그 상품 행들. 500건까지 나열되는 목록에서 배정할 때마다 전체가 다시
// 그려지면 화면이 버벅여서(스크롤도 멈춤), 실제로 바뀐 주문만 다시 그리도록 분리 + memo 처리
const OrderRow = memo(function OrderRow({
  group, batches, shipStats, isAssigning, selected, assignedIds, onToggleItem, onToggleGroup, onQuickAssign,
}: {
  group: OrderGroup
  batches: Batch[]
  shipStats: Record<string, Record<string, number>>
  isAssigning: boolean
  selected: Set<string>
  assignedIds: Set<string>
  onToggleItem: (id: string) => void
  onToggleGroup: (group: OrderGroup) => void
  onQuickAssign: (group: OrderGroup, batch: Batch) => void
}) {
  const activeItems = group.items.filter(i => !assignedIds.has(i.id))
  // 배정된 상품은 배열에서 지우지 않고 화면에서만 안 보이게(invisible) 함 — 지우면 그 아래
  // 모든 행이 위치를 다시 계산(reflow)해야 해서 목록이 길수록 순간적으로 버벅였음.
  // invisible은 자리를 그대로 차지해서 reflow가 안 생김 (작업 끝나면 새로고침으로 정리)
  const groupDone = group.items.length > 0 && activeItems.length === 0
  const allChecked = activeItems.length > 0 && activeItems.every(i => selected.has(i.id))
  return (
    <div className={`border-b last:border-0 ${groupDone ? 'invisible pointer-events-none' : ''}`}>
      {/* 주문 헤더 — 폰에서는 정보 줄과 배치 버튼 줄을 분리(세로로 쌓음), 배치 버튼은 터치하기 쉽게 크게 */}
      <div
        onClick={() => onToggleGroup(group)}
        className="px-4 py-2.5 bg-gray-50/60 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 cursor-pointer hover:bg-gray-100"
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={() => onToggleGroup(group)}
            onClick={e => e.stopPropagation()}
            className="rounded w-[18px] h-[18px] shrink-0"
          />
          <span className="font-mono text-xs text-gray-500">{group.cafe24_order_no}</span>
          <ChannelBadge placeName={group.order_place_name} />
          <span className="text-gray-600 text-sm">{group.customer_name}</span>
          <span className="font-medium text-gray-800 text-sm">{group.receiver_name || '-'}</span>
          {group.address && (
            <span className="text-xs text-gray-400 shrink-0">{regionOf(group.address)}</span>
          )}
          <span className="text-xs text-gray-400">
            {group.order_date ? new Date(group.order_date).toLocaleDateString('ko-KR') : '-'}
          </span>
          {group.admin_memo && group.admin_memo.length > 0 && (
            <span
              title={group.admin_memo.join('\n')}
              className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 shrink-0"
            >
              📝 메모 {group.admin_memo.length}
            </span>
          )}
        </div>
        <div className="flex items-center flex-wrap gap-1.5 sm:gap-1 sm:ml-auto sm:justify-end" onClick={e => e.stopPropagation()}>
          {isAssigning && (
            <span className="text-xs text-gray-400 self-center mr-1">배정 중...</span>
          )}
          {batches.map(b => (
            <button
              key={b.id}
              onClick={() => onQuickAssign(group, b)}
              disabled={isAssigning}
              title={`${b.batch_no}번 ${b.name}으로 배정`}
              className="px-2.5 py-1.5 min-h-[34px] sm:px-2 sm:py-1 sm:min-h-0 rounded text-xs font-medium border border-gray-200 text-gray-500 bg-white hover:bg-indigo-600 hover:text-white hover:border-indigo-600 active:bg-indigo-700 active:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:text-gray-500"
            >
              {b.name}
            </button>
          ))}
        </div>
      </div>
      {/* 상품 행 — 폰에서는 상품 정보와 배송방법/위치/수량을 두 줄로 나눔 */}
      {group.items.map(item => {
        const done = assignedIds.has(item.id)
        return (
          <div
            key={item.id}
            onClick={() => onToggleItem(item.id)}
            className={`pl-4 sm:pl-10 pr-4 py-2.5 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 cursor-pointer border-t border-gray-100 transition-colors ${
              done ? 'invisible pointer-events-none' : selected.has(item.id) ? 'bg-blue-50' : 'hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => onToggleItem(item.id)}
                onClick={e => e.stopPropagation()}
                className="rounded w-[18px] h-[18px] shrink-0"
              />
              <span className="text-xs text-gray-400 w-24 shrink-0 hidden sm:inline">{item.brand ?? '-'}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-800">
                  {item.product_name}
                  {item.option_info && <span className="text-gray-400 text-xs ml-2">{item.option_info}</span>}
                </div>
                <div className="text-xs text-gray-400 sm:hidden">{item.brand ?? '-'}</div>
                {item.supplier_name && (
                  <div className="text-[10px] text-gray-400 truncate">{item.supplier_name}</div>
                )}
                {item.labels && item.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {item.labels.map((l, idx) => (
                      <span key={idx} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-100 text-rose-700">
                        {l}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap pl-8 sm:pl-0 sm:shrink-0">
              <span className="flex gap-2 text-[11px] shrink-0">
                {DELIVERY_METHODS.map(m => {
                  const c = shipStats[item.product_code]?.[m] ?? 0
                  return (
                    <span key={m} className={c > 0 ? 'text-blue-600 font-semibold' : 'text-gray-300'}>
                      {m} {c}
                    </span>
                  )
                })}
              </span>
              <span className="font-mono text-xs text-indigo-600 shrink-0">{locationOf(item)}</span>
              <span className="text-sm font-semibold text-gray-800 shrink-0 ml-auto sm:ml-0 sm:w-10 sm:text-right">×{item.quantity}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}, (prev, next) => {
  if (prev.group !== next.group) return false
  if (prev.batches !== next.batches) return false
  if (prev.shipStats !== next.shipStats) return false
  if (prev.isAssigning !== next.isAssigning) return false
  if (prev.onToggleItem !== next.onToggleItem) return false
  if (prev.onToggleGroup !== next.onToggleGroup) return false
  if (prev.onQuickAssign !== next.onQuickAssign) return false
  // selected/assignedIds Set 자체는 매번 새로 만들어지지만, 이 주문에 실제로 영향 있을 때만 다시 그림
  for (const item of next.group.items) {
    if (prev.selected.has(item.id) !== next.selected.has(item.id)) return false
    if (prev.assignedIds.has(item.id) !== next.assignedIds.has(item.id)) return false
  }
  return true
})

export default function SoumOrders() {
  const [groups, setGroups] = useState<OrderGroup[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collecting, setCollecting] = useState(false)
  const [collectMsg, setCollectMsg] = useState('')
  const [progress, setProgress] = useState<{ phase: 'main' | 'recheck'; current: number; total: number } | null>(null)
  const [startDate, setStartDate] = useState(today())
  const [endDate, setEndDate] = useState(today())
  const [activePreset, setActivePreset] = useState('오늘')
  const [shipStats, setShipStats] = useState<Record<string, Record<string, number>>>({})
  const [assignWarn, setAssignWarn] = useState<{ type: 'error' | 'conflict'; text: string } | null>(null)
  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [orderSort, setOrderSort] = useState<'asc' | 'desc'>('desc')
  const [searchQuery, setSearchQuery] = useState('')
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null)
  // 배정된 상품 id — groups 배열에서는 안 지우고 여기만 기록해서 화면에서 invisible 처리함
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set())
  // 폰에서는 날짜/검색 툴바가 화면을 너무 많이 차지해서 기본적으로 접어둠 (데스크톱은 항상 펼침)
  const [showFilters, setShowFilters] = useState(false)

  // useCallback으로 고정한 핸들러들이 최신 값을 읽을 수 있도록 (stale closure 방지)
  const groupsRef = useRef<OrderGroup[]>(groups)
  useEffect(() => { groupsRef.current = groups }, [groups])
  const selectedRef = useRef<Set<string>>(selected)
  useEffect(() => { selectedRef.current = selected }, [selected])
  const assignedIdsRef = useRef<Set<string>>(assignedIds)
  useEffect(() => { assignedIdsRef.current = assignedIds }, [assignedIds])

  function applyPreset(preset: typeof PRESETS[0]) {
    setStartDate(preset.start())
    setEndDate(preset.end ? preset.end() : today())
    setActivePreset(preset.label)
  }

  const [lastCollected, setLastCollected] = useState<string | null>(null)

  useEffect(() => {
    loadOrders()
    loadBatches()
    loadMeta()
  }, [])

  async function loadMeta() {
    const { data } = await supabase.from('app_meta').select('value').eq('key', 'last_collected_at').maybeSingle()
    setLastCollected(data?.value || null)
  }

  async function loadOrders(pageNum = page, sort = orderSort, search = searchQuery) {
    // 1단계: 조건에 맞는 주문id + 주문번호만 가볍게 전부 조회 — 여기서 정렬/페이지를
    // "주문" 단위로 정해야 한 주문의 상품들이 페이지 경계에서 쪼개지지 않음
    let idQuery = supabase
      .from('order_items')
      .select('order_id, orders!inner(cafe24_order_no)')
      .eq('status', 'collected')
      .is('batch_id', null)
      .eq('order_status', 'N20')

    // 검색어가 숫자/하이픈뿐이면 주문번호로, 아니면 주문자/수령인 이름으로 검색
    const q = search.trim()
    if (q) {
      if (/^[\d-]+$/.test(q)) {
        idQuery = idQuery.ilike('orders.cafe24_order_no', `%${q}%`)
      } else {
        idQuery = idQuery.or(`customer_name.ilike.%${q}%,receiver_name.ilike.%${q}%`, { foreignTable: 'orders' })
      }
    }

    const { data: idRows } = await idQuery

    const orderNoById = new Map<string, string>()
    for (const row of (idRows ?? []) as any[]) {
      orderNoById.set(row.order_id, row.orders.cafe24_order_no)
    }
    const sortedOrderIds = [...orderNoById.entries()]
      .sort((a, b) => sort === 'asc' ? a[1].localeCompare(b[1]) : b[1].localeCompare(a[1]))
      .map(([id]) => id)

    setTotalCount(sortedOrderIds.length)
    setPage(pageNum)

    const from = pageNum * PAGE_SIZE
    const pageOrderIds = sortedOrderIds.slice(from, from + PAGE_SIZE)

    if (!pageOrderIds.length) {
      setGroups([])
      setSelected(new Set())
      setAssignedIds(new Set())
      setShipStats({})
      return
    }

    // 2단계: 이 페이지 주문들의 상품 전체를 실제 컬럼으로 조회 (주문이 몇 개짜리든 다 가져옴)
    const { data } = await supabase
      .from('order_items')
      .select('id, product_code, product_name, option_info, brand, supplier_name, quantity, labels, cafe24_item_code, orders!inner(id, cafe24_order_no, customer_name, receiver_name, address, order_date, order_place_name, admin_memo)')
      .in('order_id', pageOrderIds)
      .eq('status', 'collected')
      .is('batch_id', null)
      .eq('order_status', 'N20')
    const map: Record<string, OrderGroup> = {}
    for (const row of (data ?? []) as any[]) {
      const o = row.orders
      if (!map[o.id]) {
        map[o.id] = {
          order_id: o.id,
          cafe24_order_no: o.cafe24_order_no,
          customer_name: o.customer_name,
          receiver_name: o.receiver_name,
          address: o.address,
          order_date: o.order_date,
          order_place_name: o.order_place_name,
          admin_memo: o.admin_memo,
          items: [],
        }
      }
      map[o.id].items.push({
        id: row.id,
        product_code: row.product_code,
        product_name: row.product_name,
        option_info: row.option_info,
        brand: row.brand,
        supplier_name: row.supplier_name,
        quantity: row.quantity,
        labels: row.labels,
        cafe24_item_code: row.cafe24_item_code,
      })
    }
    for (const g of Object.values(map)) {
      g.items.sort((a, b) => (a.cafe24_item_code ?? '').localeCompare(b.cafe24_item_code ?? ''))
    }
    setGroups(
      Object.values(map).sort((a, b) =>
        sort === 'asc'
          ? a.cafe24_order_no.localeCompare(b.cafe24_order_no)
          : b.cafe24_order_no.localeCompare(a.cafe24_order_no)
      )
    )
    setSelected(new Set())
    setAssignedIds(new Set())

    // 상품별 배송방법 누적 카운트
    const codes = [...new Set(((data ?? []) as any[]).map(r => r.product_code).filter(Boolean))]
    if (codes.length) {
      const { data: statData } = await supabase
        .from('product_ship_stats')
        .select('product_code, method, ship_count')
        .in('product_code', codes)
      const statMap: Record<string, Record<string, number>> = {}
      for (const s of statData ?? []) {
        ;(statMap[s.product_code] ??= {})[s.method] = s.ship_count
      }
      setShipStats(statMap)
    } else {
      setShipStats({})
    }
  }

  async function loadBatches() {
    const { data } = await supabase
      .from('batches')
      .select('*')
      .not('type', 'in', '(hold,miseong)')
      .order('batch_no')
    setBatches(data ?? [])
  }

  async function collect() {
    // 다른 작업자가 수집 중인지 확인 (2분 이내 시작한 락이 있으면 경고)
    const { data: lockRow } = await supabase.from('app_meta').select('value').eq('key', 'collect_lock').maybeSingle()
    if (lockRow?.value && Date.now() - new Date(lockRow.value).getTime() < 2 * 60 * 1000) {
      if (!confirm('⚠️ 다른 작업자가 이미 수집 중입니다 (2분 이내 시작).\n그래도 계속할까요?')) return
    }

    setCollecting(true)
    setCollectMsg('')
    await supabase.from('app_meta').upsert({ key: 'collect_lock', value: new Date().toISOString(), updated_at: new Date().toISOString() })

    // 1단계: 메인 수집 — 범위가 넓으면 한 번에 처리하다 타임아웃 나서, 하루씩 나눠 순차 호출
    const days = dateRange(startDate, endDate)
    let totalCollected = 0, totalBackfilled = 0, totalChecked = 0
    const mainErrors: string[] = []
    setProgress({ phase: 'main', current: 0, total: days.length })
    for (let i = 0; i < days.length; i++) {
      const day = days[i]
      try {
        const res = await fetch('/api/cafe24/collect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start_date: day, end_date: day }),
        })
        const data = await res.json()
        if (data.error) {
          mainErrors.push(`${day}: ${JSON.stringify(data.error)}`)
        } else {
          totalCollected += data.collected ?? 0
          totalBackfilled += data.items_backfilled ?? 0
          totalChecked += data.total ?? 0
          if (data.errors?.length) mainErrors.push(...data.errors)
        }
      } catch {
        mainErrors.push(`${day}: 네트워크 오류`)
      }
      setProgress({ phase: 'main', current: i + 1, total: days.length })
    }

    // 2단계: 주문 상태 재확인 — 대상이 많을 때 타임아웃 나서, 50건씩 나눠 반복 호출
    let notReady = 0
    {
      let offset = 0
      let total = 0
      try {
        do {
          const res = await fetch('/api/cafe24/collect?phase=recheck', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offset, limit: 50 }),
          })
          const data = await res.json()
          if (data.error) break
          total = data.total
          notReady += data.not_ready ?? 0
          offset = data.next_offset
          setProgress({ phase: 'recheck', current: Math.min(offset, total), total })
          if (data.done) break
        } while (offset < total)
      } catch {
        // 재확인 실패해도 메인 수집 결과는 유지
      }
    }

    const errMsg = mainErrors.length ? ` | 실패: ${mainErrors[0]}${mainErrors.length > 1 ? ` 외 ${mainErrors.length - 1}건` : ''}` : ''
    const backfillMsg = totalBackfilled ? ` / 상품보충 ${totalBackfilled}건` : ''
    const notReadyMsg = notReady ? ` / 상태변경으로 숨김 ${notReady}건` : ''
    setCollectMsg(`카페24 ${totalChecked}건 조회 / 신규 ${totalCollected}건${backfillMsg}${notReadyMsg}${errMsg}`)
    if (totalCollected > 0 || totalBackfilled > 0 || notReady > 0) loadOrders(0)

    // 락 해제 + 최종 수집 시간 기록
    const now = new Date().toISOString()
    await supabase.from('app_meta').upsert([
      { key: 'collect_lock', value: '', updated_at: now },
      { key: 'last_collected_at', value: now, updated_at: now },
    ])
    setLastCollected(now)
    setCollecting(false)
    setProgress(null)
  }

  const allItemIds = groups.flatMap(g => g.items.filter(i => !assignedIds.has(i.id)).map(i => i.id))
  const visibleGroupCount = groups.filter(g => g.items.some(i => !assignedIds.has(i.id))).length

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const toggleGroup = useCallback((group: OrderGroup) => {
    const activeItems = group.items.filter(i => !assignedIdsRef.current.has(i.id))
    setSelected(prev => {
      const next = new Set(prev)
      const allSelected = activeItems.every(i => next.has(i.id))
      for (const item of activeItems) {
        allSelected ? next.delete(item.id) : next.add(item.id)
      }
      return next
    })
  }, [])

  function toggleAll() {
    setSelected(selected.size === allItemIds.length ? new Set() : new Set(allItemIds))
  }

  // 아직 미배정 상태인 상품만 업데이트 — 다른 사람이 먼저 배정한 상품은 건너뛰고 주문번호 반환
  const assignItems = useCallback(async (ids: string[], fields: Record<string, string>) => {
    const { data: updatedRows, error } = await supabase.from('order_items')
      .update(fields)
      .in('id', ids)
      .eq('status', 'collected')
      .is('batch_id', null)
      .select('id')

    // 업데이트 자체가 실패한 경우 — 경합이 아니라 오류
    if (error) {
      setAssignWarn({ type: 'error', text: `배정 실패 — 네트워크/서버 오류입니다. 다시 시도해주세요. (${error.message})` })
      return
    }

    const updatedSet = new Set((updatedRows ?? []).map(r => r.id))
    const failedIds = ids.filter(id => !updatedSet.has(id))
    const orderNos = new Set<string>()
    for (const g of groupsRef.current) {
      for (const it of g.items) {
        if (failedIds.includes(it.id)) orderNos.add(g.cafe24_order_no)
      }
    }
    setAssignWarn(
      orderNos.size
        ? { type: 'conflict', text: `⚠️ 이미 배정된 상품이라 제외됨: ${[...orderNos].join(', ')}` }
        : null
    )

    // groups 배열에서는 지우지 않고 배정된 id만 기록 — 지우면 그 아래 행들이 전부
    // 위치를 다시 계산(reflow)해야 해서 목록이 길 때 순간적으로 버벅였음. invisible로만
    // 처리하면 자리를 그대로 유지해서 reflow가 안 생김 (작업 끝나면 새로고침으로 정리)
    setAssignedIds(prev => new Set([...prev, ...updatedSet]))
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of updatedSet) next.delete(id)
      return next
    })
  }, [])

  const quickAssign = useCallback(async (group: OrderGroup, batch: Batch) => {
    // 이미 배정된(invisible 처리된) 상품은 대상에서 제외하고, 체크된 상품이 있으면 그 상품만,
    // 없으면 아직 안 배정된 나머지 전체
    const activeItems = group.items.filter(i => !assignedIdsRef.current.has(i.id))
    const currentSelected = selectedRef.current
    const checkedInGroup = activeItems.filter(i => currentSelected.has(i.id))
    const targets = checkedInGroup.length ? checkedInGroup : activeItems
    if (!targets.length) return
    const method = methodOfBatch(batch.name)
    setAssigningOrderId(group.order_id)
    try {
      await assignItems(targets.map(i => i.id), {
        batch_id: batch.id,
        status: 'confirmed',
        ...(method && { delivery_method: method }),
      })
    } finally {
      setAssigningOrderId(null)
    }
  }, [assignItems])

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
        <h2 className="text-xl font-bold text-gray-800">주문 수집</h2>
        <div className="flex flex-wrap items-center gap-3">
          {collectMsg && <span className="text-sm text-gray-500">{collectMsg}</span>}
          {lastCollected && (
            <span className="text-xs text-gray-400">
              마지막 수집 {new Date(lastCollected).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={collect}
            disabled={collecting}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {collecting ? '수집 중...' : '카페24 주문 수집'}
          </button>
          <button
            onClick={() => setShowFilters(v => !v)}
            className="sm:hidden px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600"
          >
            {activePreset || '기간'} · 필터 {showFilters ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {/* 수집 진행 상태: 메인 수집 → 주문 상태 재확인(50건씩 나눠 호출) */}
      {progress && (
        <div className="bg-white rounded-xl border p-3 mb-4">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
            <span className="font-medium text-gray-700">
              {progress.phase === 'main' ? '메인 수집 중...' : '주문 상태 재확인 중...'}
            </span>
            {progress.total > 0 && (
              <span>{progress.current} / {progress.total}{progress.phase === 'main' ? '일' : '건'}</span>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                progress.phase === 'main' ? 'bg-blue-400' : 'bg-blue-600'
              }`}
              style={progress.total > 0
                ? { width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }
                : undefined}
            />
          </div>
        </div>
      )}

      {/* 날짜 선택 — 폰에서는 필터 토글로 접었다 폈다 함 */}
      <div className={`bg-white rounded-xl border p-3 mb-4 flex-wrap items-center gap-2 ${showFilters ? 'flex' : 'hidden'} sm:flex`}>
        {PRESETS.map(p => (
          <button
            key={p.label}
            onClick={() => applyPreset(p)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              activePreset === p.label
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {p.label}
          </button>
        ))}
        <div className="flex items-center gap-1 ml-2">
          <input
            type="date"
            value={startDate}
            onChange={e => { setStartDate(e.target.value); setActivePreset('') }}
            className="border rounded-lg px-2 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <span className="text-gray-400 text-sm">~</span>
          <input
            type="date"
            value={endDate}
            onChange={e => { setEndDate(e.target.value); setActivePreset('') }}
            className="border rounded-lg px-2 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          onClick={() => {
            const next = orderSort === 'asc' ? 'desc' : 'asc'
            setOrderSort(next)
            loadOrders(0, next)
          }}
          className="ml-auto px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
        >
          주문번호 {orderSort === 'asc' ? '오름차순 ↑' : '내림차순 ↓'}
        </button>
      </div>

      {/* 검색 — 숫자/하이픈만 입력하면 주문번호로, 그 외엔 주문자/수령인 이름으로 검색. 폰에서는 필터 토글에 같이 묶임 */}
      <div className={`bg-white rounded-xl border p-3 mb-4 items-center gap-2 ${showFilters ? 'flex' : 'hidden'} sm:flex`}>
        <input
          type="text"
          value={searchQuery}
          onChange={e => {
            const v = e.target.value
            setSearchQuery(v)
            if (searchTimeout.current) clearTimeout(searchTimeout.current)
            searchTimeout.current = setTimeout(() => loadOrders(0, orderSort, v), 400)
          }}
          placeholder="주문자 / 수령인 / 주문번호로 검색"
          className="flex-1 border rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {searchQuery && (
          <button
            onClick={() => { setSearchQuery(''); loadOrders(0, orderSort, '') }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
          >
            초기화
          </button>
        )}
      </div>

      {assignWarn && (
        <div className={`rounded-xl px-4 py-3 mb-4 text-sm flex items-center justify-between border ${
          assignWarn.type === 'error'
            ? 'bg-red-50 border-red-300 text-red-700'
            : 'bg-amber-50 border-amber-300 text-amber-700'
        }`}>
          <span>{assignWarn.text}</span>
          <button onClick={() => setAssignWarn(null)} className="opacity-50 hover:opacity-100 text-xs ml-3">닫기</button>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="bg-white rounded-xl border p-16 text-center text-gray-400 text-sm">
          미배정 상품이 없습니다
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selected.size === allItemIds.length && allItemIds.length > 0}
                onChange={toggleAll}
                className="rounded"
              />
              이 페이지 전체 선택 (주문 {visibleGroupCount}건 / 상품 {allItemIds.length}개)
            </label>
            {selected.size > 0 && (
              <span className="text-xs text-gray-400">
                상품 {selected.size}개 선택됨 — 배정할 주문의 배치 버튼을 누르세요
              </span>
            )}
          </div>

          {visibleGroupCount === 0 && (
            <div className="p-8 text-center text-gray-400 text-sm">
              이 페이지 상품을 모두 배정했습니다 — 새로고침하면 목록이 정리됩니다
            </div>
          )}

          {groups.map(group => (
            <OrderRow
              key={group.order_id}
              group={group}
              batches={batches}
              shipStats={shipStats}
              isAssigning={assigningOrderId === group.order_id}
              selected={selected}
              assignedIds={assignedIds}
              onToggleItem={toggle}
              onToggleGroup={toggleGroup}
              onQuickAssign={quickAssign}
            />
          ))}

          {totalCount > PAGE_SIZE && (
            <div className="px-4 py-3 border-t bg-gray-50 flex items-center justify-between text-sm">
              <span className="text-gray-500">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalCount)} / 전체 {totalCount}건
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => loadOrders(page - 1)}
                  disabled={page === 0}
                  className="px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >이전</button>
                <button
                  onClick={() => loadOrders(page + 1)}
                  disabled={(page + 1) * PAGE_SIZE >= totalCount}
                  className="px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >다음</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
