import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

interface Batch {
  id: string
  batch_no: string
  name: string
  type: string
}

interface Item {
  product_code: string
  product_name: string
  option_info: string | null
  brand: string | null
  supplier_name: string | null
  location: string | null
  quantity: number
  inspected_qty: number
}

interface PickingRow {
  location: string
  brand: string
  product_name: string
  option_info: string
  supplier_note: string
  quantity: number
}

// 각 자리는 숫자/문자 상관없이 올 수 있음 (예: NK-01-02-03, NK-A1-B2-C3) — SoumBatch.tsx와 동일한 규칙
const LOC_REGEX = /[A-Z]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}/

function buildPickingList(items: Item[], sort: 'location' | 'brand'): PickingRow[] {
  const merged: Record<string, PickingRow> = {}

  for (const item of items) {
    // 이미 바코드 검수 끝난 수량은 다시 피킹할 필요 없음 — 남은 수량만 반영
    const remaining = item.quantity - item.inspected_qty
    if (remaining <= 0) continue

    const supplier = item.supplier_name ?? ''
    const codeMatch = supplier.match(LOC_REGEX)?.[0]
    const hasMiseong = supplier.includes('미성')

    // 주문수집 시 이미 파싱해서 저장해둔 값을 우선 사용, 없는 옛 데이터만 그때 계산
    let location = item.location ?? ''
    let stripPattern: RegExp | string = ''
    if (!item.location && codeMatch) {
      location = codeMatch
      stripPattern = LOC_REGEX
    } else if (!item.location && hasMiseong) {
      location = '미성'
      stripPattern = '미성'
    } else if (codeMatch) {
      stripPattern = LOC_REGEX
    } else if (hasMiseong) {
      stripPattern = '미성'
    }

    const supplier_note = (stripPattern ? supplier.replace(stripPattern, '') : supplier)
      .replace(/^\s*[|｜]\s*|\s*[|｜]\s*$/g, '').trim()
    const key = `${item.product_code}__${item.option_info ?? ''}`
    if (merged[key]) {
      merged[key].quantity += remaining
    } else {
      merged[key] = {
        location,
        brand: item.brand ?? '',
        product_name: item.product_name,
        option_info: item.option_info ?? '',
        supplier_note,
        quantity: remaining,
      }
    }
  }

  const rows = Object.values(merged)
  return sort === 'brand'
    ? rows.sort((a, b) => a.brand.localeCompare(b.brand) || a.product_name.localeCompare(b.product_name))
    : rows.sort((a, b) => a.location.localeCompare(b.location) || a.product_name.localeCompare(b.product_name))
}

export default function SoumPicking() {
  const [batches, setBatches] = useState<Batch[]>([])
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [sort, setSort] = useState<'location' | 'brand'>('location')
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadBatches() }, [])

  async function loadBatches() {
    const { data } = await supabase.from('batches').select('id, batch_no, name, type').order('batch_no')
    setBatches(data ?? [])
  }

  async function selectBatch(batchId: string) {
    setActiveBatchId(batchId)
    setLoading(true)
    const { data } = await supabase
      .from('order_items')
      .select('product_code, product_name, option_info, brand, supplier_name, location, quantity, inspected_qty')
      .eq('batch_id', batchId)
      .eq('status', 'confirmed')
    setItems((data ?? []) as Item[])
    setLoading(false)
  }

  const activeBatch = batches.find(b => b.id === activeBatchId)
  const pickingList = buildPickingList(items, sort)

  if (!activeBatchId) {
    return (
      <div className="max-w-md mx-auto">
        <h2 className="text-lg font-bold text-gray-800 mb-4">피킹 — 배치 선택</h2>
        {batches.length === 0 ? (
          <p className="text-center text-gray-400 py-12">배치가 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {batches.map(b => (
              <button
                key={b.id}
                onClick={() => selectBatch(b.id)}
                className="w-full text-left bg-white rounded-xl border p-4 hover:bg-blue-50 hover:border-blue-300 transition-colors"
              >
                <span className="font-medium text-gray-800">{b.batch_no}번 {b.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => { setActiveBatchId(null); setItems([]) }}
          className="text-sm text-blue-600 shrink-0"
        >
          ← 배치 선택
        </button>
        <h2 className="text-base font-bold text-gray-800 flex-1 text-center truncate">
          {activeBatch?.batch_no}번 {activeBatch?.name}
        </h2>
        <span className="w-14 shrink-0" />
      </div>

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setSort('location')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
            sort === 'location' ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-300'
          }`}
        >
          로케이션순
        </button>
        <button
          onClick={() => setSort('brand')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
            sort === 'brand' ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-300'
          }`}
        >
          브랜드순
        </button>
      </div>

      {loading ? (
        <p className="text-center text-gray-400 py-12">불러오는 중...</p>
      ) : pickingList.length === 0 ? (
        <p className="text-center text-gray-400 py-12">피킹할 상품이 없습니다.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-gray-400 px-1">총 {pickingList.length}종</p>
          {pickingList.map((row, i) => (
            <div key={i} className="bg-white rounded-xl border p-3.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-mono text-sm font-bold text-indigo-600">{row.location || '-'}</span>
                <span className="text-xl font-bold text-gray-800">×{row.quantity}</span>
              </div>
              <div className="text-sm font-medium text-gray-800">{row.product_name}</div>
              {row.option_info && <div className="text-xs text-gray-400 mt-0.5">{row.option_info}</div>}
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-xs text-gray-500">{row.brand || '-'}</span>
                {row.supplier_note && <span className="text-xs text-gray-400 truncate ml-2">{row.supplier_note}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
