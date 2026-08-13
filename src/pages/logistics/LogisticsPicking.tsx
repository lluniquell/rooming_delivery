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
}

interface PickingRow {
  key: string
  product_name: string
  option_info: string
  brand: string
  supplier_note: string
  quantity: number
  item_ids: string[]
  order_ids: Set<string>
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

function buildPickingList(items: Item[]): PickingRow[] {
  const merged: Record<string, PickingRow> = {}
  for (const item of items) {
    const remaining = item.quantity - item.inspected_qty
    if (remaining <= 0) continue
    const key = `${item.product_code}__${item.option_info ?? ''}`
    if (merged[key]) {
      merged[key].quantity += remaining
      merged[key].item_ids.push(item.id)
      merged[key].order_ids.add(item.order_id)
    } else {
      merged[key] = {
        key,
        product_name: item.product_name,
        option_info: item.option_info ?? '',
        brand: item.brand ?? '',
        supplier_note: supplierNoteOf(item.supplier_name),
        quantity: remaining,
        item_ids: [item.id],
        order_ids: new Set([item.order_id]),
      }
    }
  }
  return Object.values(merged).sort((a, b) => a.product_name.localeCompare(b.product_name))
}

export default function LogisticsPicking() {
  const [date, setDate] = useState(tomorrowStr())
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [showDone, setShowDone] = useState(false)
  const [staffName, setStaffName] = useState('')

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
    if (!jikbae) { setItems([]); setLoading(false); return }

    const { data } = await supabase
      .from('order_items')
      .select('id, order_id, product_code, product_name, option_info, brand, supplier_name, quantity, inspected_qty, picked_at, orders!inner(scheduled_date)')
      .eq('batch_id', jikbae.id)
      .in('status', ['confirmed', 'in_transit'])
      .eq('orders.scheduled_date', date)
    setItems((data ?? []) as unknown as Item[])
    setLoading(false)
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
  const pickingList = buildPickingList(activeItems)
  const doneList = buildPickingList(doneItems)

  function renderRow(row: PickingRow, done: boolean) {
    return (
      <div key={row.key} className={`bg-white rounded-xl border p-3.5 ${done ? 'opacity-60' : ''}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-800 break-words">{row.product_name}</div>
            {row.option_info && <div className="text-xs text-gray-400 mt-0.5">{row.option_info}</div>}
            <div className="mt-0.5">
              <span className="text-xs text-gray-500">{row.brand || '-'}</span>
              {row.supplier_note && <div className="text-xs text-gray-400 mt-0.5 break-words">{row.supplier_note}</div>}
            </div>
            <div className="text-[11px] text-gray-400 mt-1">{row.order_ids.size}건 주문에 사용</div>
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
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">물류팀 피킹</h2>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>

      {loading ? (
        <p className="text-center text-gray-400 py-12">불러오는 중...</p>
      ) : pickingList.length === 0 && doneList.length === 0 ? (
        <p className="text-center text-gray-400 py-12">이 날짜에 준비할 배송건이 없습니다.</p>
      ) : (
        <>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400">
              총 {pickingList.length}종 / {pickingList.reduce((sum, r) => sum + r.quantity, 0)}개
            </p>
            {doneList.length > 0 && (
              <button onClick={() => setShowDone(v => !v)} className="text-xs text-indigo-600 font-medium">
                {showDone ? '완료 항목 숨기기' : `완료 ${doneList.length}종 보기`}
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
  )
}
