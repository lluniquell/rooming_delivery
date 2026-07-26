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
}

interface OrderGroup {
  order_id: string
  cafe24_order_no: string
  customer_name: string
  receiver_name: string | null
  address: string | null
  order_date: string | null
  order_place_name: string | null
  items: Item[]
}

interface Batch {
  id: string
  batch_no: string
  name: string
  type: string
}

const DELIVERY_METHODS = ['CJ', '경동', '직배', '팀무버', '업체배송']
const PAGE_SIZE = 100

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
      {/* 주문 헤더 */}
      <div
        onClick={() => onToggleGroup(group)}
        className="px-4 py-2 bg-gray-50/60 flex items-center gap-3 cursor-pointer hover:bg-gray-100"
      >
        <input
          type="checkbox"
          checked={allChecked}
          onChange={() => onToggleGroup(group)}
          onClick={e => e.stopPropagation()}
          className="rounded"
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
        <div className="flex gap-1 ml-auto" onClick={e => e.stopPropagation()}>
          {isAssigning && (
            <span className="text-xs text-gray-400 self-center mr-1">배정 중...</span>
          )}
          {batches.map(b => (
            <button
              key={b.id}
              onClick={() => onQuickAssign(group, b)}
              disabled={isAssigning}
              title={`${b.batch_no}번 ${b.name}으로 배정`}
              className="px-2 py-1 rounded text-xs font-medium border border-gray-200 text-gray-500 bg-white hover:bg-indigo-600 hover:text-white hover:border-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:text-gray-500"
            >
              {b.name}
            </button>
          ))}
        </div>
      </div>
      {/* 상품 행 */}
      {group.items.map(item => {
        const done = assignedIds.has(item.id)
        return (
          <div
            key={item.id}
            onClick={() => onToggleItem(item.id)}
            className={`pl-10 pr-4 py-2.5 flex items-center gap-3 cursor-pointer border-t border-gray-100 transition-colors ${
              done ? 'invisible pointer-events-none' : selected.has(item.id) ? 'bg-blue-50' : 'hover:bg-gray-50'
            }`}
          >
            <input
              type="checkbox"
              checked={selected.has(item.id)}
              onChange={() => onToggleItem(item.id)}
              onClick={e => e.stopPropagation()}
              className="rounded"
            />
            <span className="text-xs text-gray-400 w-24 shrink-0">{item.brand ?? '-'}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-800">
                {item.product_name}
                {item.option_info && <span className="text-gray-400 text-xs ml-2">{item.option_info}</span>}
              </div>
              {item.supplier_name && (
                <div className="text-[10px] text-gray-400 truncate">{item.supplier_name}</div>
              )}
            </div>
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
            <span className="text-sm font-semibold text-gray-800 w-10 text-right shrink-0">×{item.quantity}</span>
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
  const [startDate, setStartDate] = useState(today())
  const [endDate, setEndDate] = useState(today())
  const [activePreset, setActivePreset] = useState('오늘')
  const [shipStats, setShipStats] = useState<Record<string, Record<string, number>>>({})
  const [assignWarn, setAssignWarn] = useState<{ type: 'error' | 'conflict'; text: string } | null>(null)
  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [orderSort, setOrderSort] = useState<'asc' | 'desc'>('desc')
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null)
  // 배정된 상품 id — groups 배열에서는 안 지우고 여기만 기록해서 화면에서 invisible 처리함
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set())

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

  async function loadOrders(pageNum = page, sort = orderSort) {
    const from = pageNum * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const { data, count } = await supabase
      .from('order_items')
      .select('id, product_code, product_name, option_info, brand, supplier_name, quantity, orders!inner(id, cafe24_order_no, customer_name, receiver_name, address, order_date, order_place_name)', { count: 'exact' })
      .eq('status', 'collected')
      .is('batch_id', null)
      .eq('order_status', 'N20')
      .order('orders(cafe24_order_no)', { ascending: sort === 'asc' })
      .order('id', { ascending: true })
      .range(from, to)
    setTotalCount(count ?? 0)
    setPage(pageNum)
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
      })
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
      .neq('type', 'hold')
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
    try {
      const res = await fetch('/api/cafe24/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      })
      const data = await res.json()
      if (data.error) {
        setCollectMsg(`오류: ${JSON.stringify(data.error)}`)
      } else {
        const errMsg = data.errors?.length ? ` | 실패: ${data.errors[0]}` : ''
        const backfillMsg = data.items_backfilled ? ` / 상품보충 ${data.items_backfilled}건` : ''
        const notReadyMsg = data.not_ready ? ` / 상태변경으로 숨김 ${data.not_ready}건` : ''
        setCollectMsg(`카페24 ${data.total ?? 0}건 조회 / 신규 ${data.collected ?? 0}건${backfillMsg}${notReadyMsg}${errMsg}`)
        if (data.collected > 0 || data.items_backfilled > 0 || data.not_ready > 0) loadOrders(0)
      }
    } catch {
      setCollectMsg('네트워크 오류')
    }
    // 락 해제 + 최종 수집 시간 기록
    const now = new Date().toISOString()
    await supabase.from('app_meta').upsert([
      { key: 'collect_lock', value: '', updated_at: now },
      { key: 'last_collected_at', value: now, updated_at: now },
    ])
    setLastCollected(now)
    setCollecting(false)
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
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800">주문 수집</h2>
        <div className="flex items-center gap-3">
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
        </div>
      </div>

      {/* 날짜 선택 */}
      <div className="bg-white rounded-xl border p-3 mb-4 flex flex-wrap items-center gap-2">
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
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
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
