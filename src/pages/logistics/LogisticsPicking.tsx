import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

interface Item {
  id: string
  order_id: string
  product_code: string
  product_name: string
  option_info: string | null
  brand: string | null
  supplier_name: string | null
  quantity: number
  inspected_qty: number
  picked_at: string | null
  customer_name: string
  cafe24_order_no: string
  route_id: string | null
  route_order: number | null
}

interface BarcodeRow {
  id: string
  product_code: string
  barcode: string | null
  location: string | null
}

interface PickingRow {
  key: string
  product_code: string
  product_name: string
  option_info: string
  brand: string
  location: string
  barcodes: string[]
  supplier_note: string
  quantity: number
  item_ids: string[]
  order_ids: Set<string>
}

interface Label {
  key: string
  driverName: string
  orderPosition: string
  productName: string
  customerName: string
  dateLabel: string
  routeOrder: number | null
}

// SoumBatch.tsx/SoumPicking.tsx와 동일한 규칙 — 공급자 상품명에 섞여있는
// 로케이션 코드/미성 표시를 걷어내고 순수한 메모만 남김
const LOC_REGEX = /[A-Z]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}/
function supplierNoteOf(supplierName: string | null) {
  const supplier = supplierName ?? ''
  const codeMatch = supplier.match(LOC_REGEX)?.[0]
  const stripPattern: RegExp | string = codeMatch ? LOC_REGEX : supplier.includes('미성') ? '미성' : ''
  return (stripPattern ? supplier.replace(stripPattern, '') : supplier)
    .replace(/^\s*[|｜]\s*|\s*[|｜]\s*$/g, '')
    .trim()
}

// 로컬(KST) 기준 내일 날짜 — 전날 준비 작업이라 기본값을 내일로 둠
function tomorrowStr() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function buildPickingList(items: Item[], sort: 'location' | 'brand', barcodeMap: Record<string, BarcodeRow[]>): PickingRow[] {
  const merged: Record<string, PickingRow> = {}
  for (const item of items) {
    const remaining = item.quantity - item.inspected_qty
    if (remaining <= 0) continue
    const bcRows = barcodeMap[item.product_code] ?? []
    const location = bcRows.map(b => b.location).find(l => !!l) ?? ''
    const barcodes = bcRows.map(b => b.barcode).filter((b): b is string => !!b)
    const key = `${item.product_code}__${item.option_info ?? ''}`
    if (merged[key]) {
      merged[key].quantity += remaining
      merged[key].item_ids.push(item.id)
      merged[key].order_ids.add(item.order_id)
    } else {
      merged[key] = {
        key,
        product_code: item.product_code,
        product_name: item.product_name,
        option_info: item.option_info ?? '',
        brand: item.brand ?? '',
        location,
        barcodes,
        supplier_note: supplierNoteOf(item.supplier_name),
        quantity: remaining,
        item_ids: [item.id],
        order_ids: new Set([item.order_id]),
      }
    }
  }
  const rows = Object.values(merged)
  return sort === 'brand'
    ? rows.sort((a, b) => a.brand.localeCompare(b.brand) || a.product_name.localeCompare(b.product_name))
    : rows.sort((a, b) => a.location.localeCompare(b.location) || a.product_name.localeCompare(b.product_name))
}

export default function LogisticsPicking() {
  const [date, setDate] = useState(tomorrowStr())
  const [items, setItems] = useState<Item[]>([])
  const [barcodeMap, setBarcodeMap] = useState<Record<string, BarcodeRow[]>>({})
  const [driverNameByRoute, setDriverNameByRoute] = useState<Record<string, string>>({})
  const [companionRoutesByOrderNo, setCompanionRoutesByOrderNo] = useState<Record<string, string[]>>({})
  const [sort, setSort] = useState<'location' | 'brand'>('location')
  const [loading, setLoading] = useState(true)
  const [showDone, setShowDone] = useState(false)
  const [showLabels, setShowLabels] = useState(false)
  const [staffName, setStaffName] = useState('')
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [addingBarcodeKey, setAddingBarcodeKey] = useState<string | null>(null)
  const [barcodeInputValue, setBarcodeInputValue] = useState('')

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('drivers').select('name').eq('id', user.id).maybeSingle()
        .then(({ data }) => { if (data) setStaffName(data.name) })
    })
  }, [])

  useEffect(() => { load() }, [date])

  async function load() {
    setLoading(true)
    const { data: batches } = await supabase.from('batches').select('id, type, name')
    const jikbae = (batches ?? []).find(b => b.type === 'direct' || b.name?.includes('직배'))
    if (!jikbae) { setItems([]); setBarcodeMap({}); setDriverNameByRoute({}); setLoading(false); return }

    const { data } = await supabase
      .from('order_items')
      .select('id, order_id, product_code, product_name, option_info, brand, supplier_name, quantity, inspected_qty, picked_at, orders!inner(cafe24_order_no, receiver_name, customer_name, route_id, route_order, scheduled_date)')
      .eq('batch_id', jikbae.id)
      .in('status', ['confirmed', 'in_transit'])
      .eq('orders.scheduled_date', date)
    const rows: Item[] = ((data ?? []) as any[]).map(row => ({
      id: row.id,
      order_id: row.order_id,
      product_code: row.product_code,
      product_name: row.product_name,
      option_info: row.option_info,
      brand: row.brand,
      supplier_name: row.supplier_name,
      quantity: row.quantity,
      inspected_qty: row.inspected_qty,
      picked_at: row.picked_at,
      customer_name: row.orders.receiver_name || row.orders.customer_name,
      cafe24_order_no: row.orders.cafe24_order_no,
      route_id: row.orders.route_id,
      route_order: row.orders.route_order,
    }))
    setItems(rows)

    const codes = [...new Set(rows.map(r => r.product_code))]
    if (codes.length) {
      const { data: bcData } = await supabase.from('barcodes').select('id, product_code, barcode, location').in('product_code', codes)
      const map: Record<string, BarcodeRow[]> = {}
      for (const b of (bcData ?? []) as BarcodeRow[]) {
        (map[b.product_code] ??= []).push(b)
      }
      setBarcodeMap(map)
    } else {
      setBarcodeMap({})
    }

    // 라벨의 "배송담당자명"용 — 이 날짜 루트별 배정 배송원 이름. 배정된 배송원이 없으면
    // 담당자 대신 차량번호(루트 라벨, 예: "1호차")를 대신 넣음
    const { data: routeData } = await supabase.from('schedule_routes').select('id, label, driver_ids').eq('date', date)
    const driverIds = [...new Set((routeData ?? []).flatMap(r => r.driver_ids as string[]))]
    let driverNameById: Record<string, string> = {}
    if (driverIds.length) {
      const { data: driverData } = await supabase.from('drivers').select('id, name').in('id', driverIds)
      driverNameById = Object.fromEntries((driverData ?? []).map(d => [d.id, d.name]))
    }
    const byRoute: Record<string, string> = {}
    for (const r of routeData ?? []) {
      const names = (r.driver_ids as string[]).map((id: string) => driverNameById[id] ?? '?').join('/')
      byRoute[r.id] = names || r.label
    }
    setDriverNameByRoute(byRoute)

    // 2인 배송 등으로 다른 루트에 "동행"으로 같이 붙어있는 주문 — 라벨엔 원래 루트
    // 담당자와 동행 루트 담당자를 같이 표시해야 함 (ScheduleDay.tsx의 addOrderAsAdhoc이
    // reason에 "동행 (주문번호)" 형식으로 남겨둔 걸 파싱)
    const { data: adhocData } = await supabase.from('schedule_adhoc_stops').select('route_id, reason').eq('date', date)
    const companions: Record<string, string[]> = {}
    for (const a of adhocData ?? []) {
      const orderNo = a.reason?.match(/\d{8}-\d{7}/)?.[0]
      if (!orderNo) continue
      (companions[orderNo] ??= []).push(a.route_id)
    }
    setCompanionRoutesByOrderNo(companions)

    setLoading(false)
  }

  // 같은 상품(product_code)의 바코드DB 로케이션을 한 번에 반영 — 바코드DB(BarcodeDB.tsx)/
  // 소품팀 피킹과 동일한 저장소를 쓰므로 여기서 고치면 그 화면들에도 반영됨
  async function updateLocation(row: PickingRow, newLocation: string) {
    const value = newLocation.trim() || null
    const existingRows = barcodeMap[row.product_code] ?? []
    if (existingRows.length) {
      await supabase.from('barcodes').update({ location: value }).eq('product_code', row.product_code)
    } else {
      await supabase.from('barcodes').insert({ product_code: row.product_code, product_name: row.product_name, location: value })
    }
    setBarcodeMap(prev => {
      const rows = prev[row.product_code] ?? []
      return {
        ...prev,
        [row.product_code]: rows.length
          ? rows.map(r => ({ ...r, location: value }))
          : [{ id: `temp-${row.product_code}`, product_code: row.product_code, barcode: null, location: value }],
      }
    })
    setEditingKey(null)
  }

  // 바코드가 없는 상품에 새 바코드 등록 — 바코드 없이 로케이션만 있는 행이 있으면 그 행을 채움
  async function addBarcode(row: PickingRow, value: string) {
    const code = value.trim()
    if (!code) return
    const existingRows = barcodeMap[row.product_code] ?? []
    const emptyRow = existingRows.find(r => !r.barcode)
    if (emptyRow) {
      const { error } = await supabase.from('barcodes').update({ barcode: code, product_name: row.product_name }).eq('id', emptyRow.id)
      if (error) { alert(`바코드 등록 실패: ${error.message}`); return }
    } else {
      const { error } = await supabase.from('barcodes')
        .upsert({ barcode: code, product_code: row.product_code, product_name: row.product_name, location: row.location || null }, { onConflict: 'barcode' })
      if (error) { alert(`바코드 등록 실패: ${error.message}`); return }
    }
    setBarcodeMap(prev => {
      const rows = prev[row.product_code] ?? []
      const next = emptyRow
        ? rows.map(r => r.id === emptyRow.id ? { ...r, barcode: code } : r)
        : [...rows, { id: `temp-${code}`, product_code: row.product_code, barcode: code, location: row.location || null }]
      return { ...prev, [row.product_code]: next }
    })
    setAddingBarcodeKey(null)
    setBarcodeInputValue('')
  }

  // 여러 명이 같이 준비할 때 서로 화면이 안 어긋나도록, 확인 즉시 로컬 patch 대신
  // 다시 조회해서 최신 상태로 맞춤 (소품팀 피킹 화면과 동일한 방식)
  async function toggleReady(row: PickingRow, ready: boolean) {
    const value = ready ? new Date().toISOString() : null
    await supabase.from('order_items')
      .update({ picked_at: value, picked_by: ready ? staffName : null })
      .in('id', row.item_ids)
    load()
  }

  const activeItems = items.filter(i => !i.picked_at)
  const doneItems = items.filter(i => i.picked_at)
  const pickingList = buildPickingList(activeItems, sort, barcodeMap)
  const doneList = buildPickingList(doneItems, sort, barcodeMap)

  // 실제 운송장이 아니라 창고에서 상품에 붙이는 식별용 라벨 — 주문 1건당 1장씩,
  // 배송담당자/상품명/고객명+날짜-배송순서만 텍스트로 인쇄.
  // 아직 준비(피킹) 안 된 상품까지 라벨이 나가면 실물 없이 라벨만 붙이게 될 수 있어서
  // 준비완료(picked_at 있음) 상품만 대상으로 함
  const dateLabel = date.slice(2).replace(/-/g, '')

  // 상품명 앞의 "몇 번째 / 총 몇 건" 표시용 — 같은 주문의 전체 상품 구성 기준(피킹 여부 무관)
  const itemsByOrder: Record<string, Item[]> = {}
  for (const i of items) {
    (itemsByOrder[i.order_id] ??= []).push(i)
  }
  for (const list of Object.values(itemsByOrder)) {
    list.sort((a, b) => a.product_name.localeCompare(b.product_name) || a.id.localeCompare(b.id))
  }

  const labels: Label[] = doneItems
    .map(i => {
      const routeIds = [i.route_id, ...(companionRoutesByOrderNo[i.cafe24_order_no] ?? [])].filter((id): id is string => !!id)
      const driverNames = [...new Set(routeIds.map(id => driverNameByRoute[id]).filter((n): n is string => !!n))]
      const orderList = itemsByOrder[i.order_id] ?? [i]
      const position = orderList.findIndex(x => x.id === i.id) + 1
      return {
        key: i.id,
        driverName: driverNames.join(',') || '미배정',
        orderPosition: `${position}-${orderList.length}`,
        productName: i.product_name,
        customerName: i.customer_name,
        dateLabel,
        routeOrder: i.route_order,
      }
    })
    .sort((a, b) => a.driverName.localeCompare(b.driverName) || (a.routeOrder ?? 999) - (b.routeOrder ?? 999))

  function renderRow(row: PickingRow, done: boolean) {
    return (
      <div key={row.key} className={`bg-white rounded-xl border p-3.5 ${done ? 'opacity-60' : ''}`}>
        <div className="flex items-center justify-between mb-1.5 gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            {editingKey === row.key ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') updateLocation(row, editValue) }}
                  className="w-28 border rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  placeholder="로케이션"
                />
                <button onClick={() => updateLocation(row, editValue)} className="text-xs font-medium text-white bg-indigo-600 rounded px-2 py-1">저장</button>
                <button onClick={() => setEditingKey(null)} className="text-xs text-gray-400 px-1">취소</button>
              </div>
            ) : (
              <button
                onClick={() => { setEditingKey(row.key); setEditValue(row.location) }}
                className="font-mono text-sm font-bold text-indigo-600 underline decoration-dotted underline-offset-2"
              >
                {row.location || '위치 입력'}
              </button>
            )}

            {row.barcodes.length > 0 ? (
              <span className="font-mono text-[11px] text-gray-400">{row.barcodes.join(', ')}</span>
            ) : addingBarcodeKey === row.key ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={barcodeInputValue}
                  onChange={e => setBarcodeInputValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addBarcode(row, barcodeInputValue) }}
                  className="w-24 border rounded px-1.5 py-0.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  placeholder="바코드"
                  inputMode="numeric"
                  pattern="[0-9]*"
                />
                <button onClick={() => addBarcode(row, barcodeInputValue)} className="text-[11px] font-medium text-white bg-indigo-600 rounded px-1.5 py-0.5">등록</button>
                <button onClick={() => setAddingBarcodeKey(null)} className="text-[11px] text-gray-400 px-1">취소</button>
              </div>
            ) : (
              <button
                onClick={() => { setAddingBarcodeKey(row.key); setBarcodeInputValue('') }}
                className="text-[11px] text-gray-400 border border-gray-300 rounded px-1.5 py-0.5"
              >
                + 바코드
              </button>
            )}
          </div>
          {done ? (
            <button
              onClick={() => toggleReady(row, false)}
              className="text-xs font-medium text-gray-500 border border-gray-300 rounded-lg px-2 py-1 shrink-0"
            >
              ×{row.quantity} · 되돌리기
            </button>
          ) : (
            <button
              onClick={() => toggleReady(row, true)}
              className="text-xl font-bold text-gray-800 bg-green-50 border border-green-200 rounded-lg px-2.5 py-0.5 shrink-0"
            >
              ×{row.quantity}
            </button>
          )}
        </div>
        <div className="text-sm font-medium text-gray-800 break-words">{row.product_name}</div>
        {row.option_info && <div className="text-xs text-gray-400 mt-0.5">{row.option_info}</div>}
        <div className="mt-1.5">
          <span className="text-xs text-gray-500">{row.brand || '-'}</span>
          {row.supplier_note && <div className="text-xs text-gray-400 mt-0.5 break-words">{row.supplier_note}</div>}
        </div>
        <div className="text-[11px] text-gray-400 mt-1">{row.order_ids.size}건 주문에 사용</div>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="print:hidden">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-base font-bold text-gray-800 flex-1">물류팀 피킹</h2>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>

      <div className="flex gap-2 mb-2">
        <button
          onClick={() => setSort('location')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
            sort === 'location' ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-300'
          }`}
        >로케이션순</button>
        <button
          onClick={() => setSort('brand')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
            sort === 'brand' ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-300'
          }`}
        >브랜드순</button>
      </div>
      <button
        onClick={() => setShowLabels(true)}
        disabled={doneItems.length === 0}
        className="w-full py-2 rounded-lg text-sm font-medium bg-orange-500 text-white disabled:opacity-40 mb-3"
      >라벨 출력 {doneItems.length > 0 && `(${doneItems.length})`}</button>

      {loading ? (
        <p className="text-center text-gray-400 py-12">불러오는 중...</p>
      ) : pickingList.length === 0 && doneList.length === 0 ? (
        <p className="text-center text-gray-400 py-12">이 날짜에 준비할 배송건이 없습니다.</p>
      ) : (
        <>
          <div className="flex items-center justify-between px-1 mb-2">
            <p className="text-xs text-gray-400">
              총 {pickingList.length}종 / {pickingList.reduce((sum, r) => sum + r.quantity, 0)}개
            </p>
            {doneList.length > 0 && (
              <button onClick={() => setShowDone(v => !v)} className="text-xs text-gray-500 underline">
                완료 {doneList.length}종 {showDone ? '숨기기' : '보기'}
              </button>
            )}
          </div>
          <div className="space-y-2">
            {pickingList.length === 0 ? (
              <p className="text-center text-gray-400 py-12">준비할 상품이 없습니다.</p>
            ) : (
              pickingList.map(row => renderRow(row, false))
            )}
            {showDone && doneList.map(row => renderRow(row, true))}
          </div>
        </>
      )}
      </div>

      {showLabels && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 print:static print:bg-white print:p-0 print:block">
          {/* 라벨 프린터 용지 크기(가로 80mm x 세로 60mm)에 맞춰 1장씩 한 줄로 인쇄 */}
          <style>{'@page { size: 80mm 60mm; margin: 0; }'}</style>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col print:rounded-none print:shadow-none print:max-h-none print:max-w-none print:block">
            <div className="px-5 py-3 border-b flex items-center justify-between shrink-0 print:hidden">
              <h3 className="font-bold text-gray-800">
                라벨 출력 <span className="text-gray-400 font-normal text-sm ml-1">{date} · {labels.length}장</span>
              </h3>
              <div className="flex items-center gap-2">
                <button onClick={() => window.print()} className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-300 text-gray-600 hover:border-indigo-400">인쇄</button>
                <button onClick={() => setShowLabels(false)} className="ml-2 text-gray-400 hover:text-gray-600 text-xl leading-none px-1">×</button>
              </div>
            </div>
            <div className="overflow-y-auto print:overflow-visible p-4 print:p-0 space-y-3 print:space-y-0">
              {labels.map(l => (
                <div
                  key={l.key}
                  className="w-[80mm] h-[60mm] mx-auto border border-gray-300 print:border-0 rounded-lg print:rounded-none px-4 pt-4 pb-3 flex flex-col justify-start gap-1.5 break-inside-avoid print:break-after-page"
                >
                  <div className="text-2xl font-bold text-gray-800">
                    {l.driverName} {l.dateLabel}{l.routeOrder != null ? ` - ${l.routeOrder}` : ''}
                  </div>
                  <div className="text-lg text-gray-700 break-words">{l.orderPosition} {l.productName}</div>
                  <div className="text-base text-gray-500">{l.customerName}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
