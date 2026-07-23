import { useState, useEffect } from 'react'
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
  receiver_name: string
  address: string | null
  order_date: string | null
  items: Item[]
}

interface Batch {
  id: string
  batch_no: string
  name: string
  type: string
}

const DELIVERY_METHODS = ['CJ', '경동', '직배', '팀무버']
const PAGE_SIZE = 500

// 배치 이름으로 배송방법을 유추 — 어느 바구니에 넣느냐가 곧 배송방법 지정이라,
// 배정 시점에 자동으로 order_items.delivery_method에 찍어둠 (보류로 옮겨도 이 값은 안 바뀜)
function methodOfBatch(name: string): string | null {
  if (name.includes('CJ')) return 'CJ'
  if (name.includes('경동')) return '경동'
  if (name.includes('직배')) return '직배'
  if (name.includes('팀무버')) return '팀무버'
  return null
}
const LOC_REGEX = /[A-Z]{2}-\d{2}-\d{2}-\d{2}/

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

  async function loadOrders(pageNum = page) {
    const from = pageNum * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const { data, count } = await supabase
      .from('order_items')
      .select('id, product_code, product_name, option_info, brand, supplier_name, quantity, orders!inner(id, cafe24_order_no, customer_name, receiver_name, address, order_date, status)', { count: 'exact' })
      .eq('status', 'collected')
      .is('batch_id', null)
      .eq('orders.status', 'N20')
      .order('order_date', { referencedTable: 'orders', ascending: false })
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
          receiver_name: o.receiver_name || o.customer_name,
          address: o.address,
          order_date: o.order_date,
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
      Object.values(map).sort((a, b) => (b.order_date ?? '').localeCompare(a.order_date ?? ''))
    )
    setSelected(new Set())

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

  const allItemIds = groups.flatMap(g => g.items.map(i => i.id))

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleGroup(group: OrderGroup) {
    setSelected(prev => {
      const next = new Set(prev)
      const allSelected = group.items.every(i => next.has(i.id))
      for (const item of group.items) {
        allSelected ? next.delete(item.id) : next.add(item.id)
      }
      return next
    })
  }

  function toggleAll() {
    setSelected(selected.size === allItemIds.length ? new Set() : new Set(allItemIds))
  }

  // 아직 미배정 상태인 상품만 업데이트 — 다른 사람이 먼저 배정한 상품은 건너뛰고 주문번호 반환
  async function assignItems(ids: string[], fields: Record<string, string>) {
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
    for (const g of groups) {
      for (const it of g.items) {
        if (failedIds.includes(it.id)) orderNos.add(g.cafe24_order_no)
      }
    }
    setAssignWarn(
      orderNos.size
        ? { type: 'conflict', text: `⚠️ 이미 배정된 상품이라 제외됨: ${[...orderNos].join(', ')}` }
        : null
    )

    // 서버 재조회 없이 방금 배정된 상품만 화면에서 바로 제거 (전체 재조회는 느림)
    setGroups(prev => prev
      .map(g => ({ ...g, items: g.items.filter(i => !updatedSet.has(i.id)) }))
      .filter(g => g.items.length > 0)
    )
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of updatedSet) next.delete(id)
      return next
    })
  }

  async function quickAssign(group: OrderGroup, batch: Batch) {
    // 이 주문에서 체크된 상품이 있으면 그 상품만, 없으면 주문 전체
    const checkedInGroup = group.items.filter(i => selected.has(i.id))
    const targets = checkedInGroup.length ? checkedInGroup : group.items
    const method = methodOfBatch(batch.name)
    await assignItems(targets.map(i => i.id), {
      batch_id: batch.id,
      status: 'confirmed',
      ...(method && { delivery_method: method }),
    })
  }

  function locationOf(item: Item) {
    return item.supplier_name?.match(LOC_REGEX)?.[0] ?? ''
  }

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
              이 페이지 전체 선택 (주문 {groups.length}건 / 상품 {allItemIds.length}개)
            </label>
            {selected.size > 0 && (
              <span className="text-xs text-gray-400">
                상품 {selected.size}개 선택됨 — 배정할 주문의 배치 버튼을 누르세요
              </span>
            )}
          </div>

          {groups.map(group => {
            const allChecked = group.items.every(i => selected.has(i.id))
            return (
              <div key={group.order_id} className="border-b last:border-0">
                {/* 주문 헤더 */}
                <div
                  onClick={() => toggleGroup(group)}
                  className="px-4 py-2 bg-gray-50/60 flex items-center gap-3 cursor-pointer hover:bg-gray-100"
                >
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={() => toggleGroup(group)}
                    onClick={e => e.stopPropagation()}
                    className="rounded"
                  />
                  <span className="font-mono text-xs text-gray-500">{group.cafe24_order_no}</span>
                  <span className="font-medium text-gray-800 text-sm">{group.receiver_name}</span>
                  {group.address && (
                    <span className="text-xs text-gray-400 truncate max-w-xs">{group.address}</span>
                  )}
                  <span className="text-xs text-gray-400">
                    {group.order_date ? new Date(group.order_date).toLocaleDateString('ko-KR') : '-'}
                  </span>
                  <div className="flex gap-1 ml-auto" onClick={e => e.stopPropagation()}>
                    {batches.map(b => (
                      <button
                        key={b.id}
                        onClick={() => quickAssign(group, b)}
                        title={`${b.batch_no}번 ${b.name}으로 배정`}
                        className="px-2 py-1 rounded text-xs font-medium border border-gray-200 text-gray-500 bg-white hover:bg-indigo-600 hover:text-white hover:border-indigo-600 transition-colors"
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                </div>
                {/* 상품 행 */}
                {group.items.map(item => (
                  <div
                    key={item.id}
                    onClick={() => toggle(item.id)}
                    className={`pl-10 pr-4 py-2.5 flex items-center gap-3 cursor-pointer border-t border-gray-100 transition-colors ${
                      selected.has(item.id) ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                      onClick={e => e.stopPropagation()}
                      className="rounded"
                    />
                    <span className="text-xs text-gray-400 w-24 shrink-0">{item.brand ?? '-'}</span>
                    <span className="text-sm text-gray-800 flex-1">
                      {item.product_name}
                      {item.option_info && <span className="text-gray-400 text-xs ml-2">{item.option_info}</span>}
                    </span>
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
                ))}
              </div>
            )
          })}

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
