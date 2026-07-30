import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

interface Batch {
  id: string
  batch_no: string
  name: string
  type: string
}

interface Item {
  id: string
  product_code: string
  product_name: string
  option_info: string | null
  brand: string | null
  supplier_name: string | null
  location: string | null
  product_no: number | null
  quantity: number
  inspected_qty: number
  picked_at: string | null
}

interface BarcodeRow {
  id: string
  barcode: string | null
  location: string | null
}

interface PickingRow {
  key: string
  product_code: string
  option_info_raw: string | null
  location: string
  brand: string
  product_name: string
  option_info: string
  supplier_note: string
  quantity: number
  product_no: number | null
  barcodes: string[]
  item_ids: string[]
}

interface ThumbnailState {
  row: PickingRow
  loading: boolean
  image: string | null
  title: string | null
  error: string | null
}

// 각 자리는 숫자/문자 상관없이 올 수 있음 (예: NK-01-02-03, NK-A1-B2-C3) — SoumBatch.tsx와 동일한 규칙
const LOC_REGEX = /[A-Z]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}/

function buildPickingList(items: Item[], sort: 'location' | 'brand', barcodeMap: Record<string, BarcodeRow[]>): PickingRow[] {
  const merged: Record<string, PickingRow> = {}

  for (const item of items) {
    // 이미 바코드 검수 끝난 수량은 다시 피킹할 필요 없음 — 남은 수량만 반영
    const remaining = item.quantity - item.inspected_qty
    if (remaining <= 0) continue

    const bcRows = barcodeMap[item.product_code] ?? []
    const bcLocation = bcRows.map(b => b.location).find(l => !!l) ?? null
    const barcodeValues = bcRows.map(b => b.barcode).filter((b): b is string => !!b)

    const supplier = item.supplier_name ?? ''
    const codeMatch = supplier.match(LOC_REGEX)?.[0]
    const hasMiseong = supplier.includes('미성')

    // 로케이션 우선순위: 바코드DB(barcodes.location) > 주문수집 시 저장해둔 값 > 그때그때 계산
    let location = bcLocation ?? item.location ?? ''
    let stripPattern: RegExp | string = ''
    if (!bcLocation && !item.location && codeMatch) {
      location = codeMatch
      stripPattern = LOC_REGEX
    } else if (!bcLocation && !item.location && hasMiseong) {
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
      merged[key].item_ids.push(item.id)
    } else {
      merged[key] = {
        key,
        product_code: item.product_code,
        option_info_raw: item.option_info,
        location,
        brand: item.brand ?? '',
        product_name: item.product_name,
        option_info: item.option_info ?? '',
        supplier_note,
        quantity: remaining,
        product_no: item.product_no,
        barcodes: barcodeValues,
        item_ids: [item.id],
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
  const [barcodeMap, setBarcodeMap] = useState<Record<string, BarcodeRow[]>>({})
  const [sort, setSort] = useState<'location' | 'brand'>('location')
  const [loading, setLoading] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [addingBarcodeKey, setAddingBarcodeKey] = useState<string | null>(null)
  const [barcodeInputValue, setBarcodeInputValue] = useState('')
  const [thumbnail, setThumbnail] = useState<ThumbnailState | null>(null)
  const [showDone, setShowDone] = useState(false)

  useEffect(() => { loadBatches() }, [])

  async function loadBatches() {
    const { data: batchData } = await supabase.from('batches').select('id, batch_no, name, type').order('batch_no')
    if (!batchData) { setBatches([]); return }

    // 확인 안 된(picked_at null) 상품 중 아직 남은 수량(quantity > inspected_qty)이 있는
    // 배치만 선택 목록에 노출 — 피킹할 게 없는 배치는 목록에서 아예 뺌
    const { data: itemData } = await supabase
      .from('order_items')
      .select('batch_id, quantity, inspected_qty')
      .eq('status', 'confirmed')
      .is('picked_at', null)

    const batchesWithStock = new Set<string>()
    for (const it of (itemData ?? []) as any[]) {
      if (it.batch_id && it.quantity - it.inspected_qty > 0) batchesWithStock.add(it.batch_id)
    }

    setBatches(batchData.filter(b => batchesWithStock.has(b.id)))
  }

  async function selectBatch(batchId: string) {
    setActiveBatchId(batchId)
    setLoading(true)
    const { data } = await supabase
      .from('order_items')
      .select('id, product_code, product_name, option_info, brand, supplier_name, location, product_no, quantity, inspected_qty, picked_at')
      .eq('batch_id', batchId)
      .eq('status', 'confirmed')
    const rows = (data ?? []) as Item[]
    setItems(rows)

    const codes = [...new Set(rows.map(r => r.product_code))]
    if (codes.length) {
      const { data: bcData } = await supabase.from('barcodes').select('id, barcode, product_code, location').in('product_code', codes)
      const map: Record<string, BarcodeRow[]> = {}
      for (const b of (bcData ?? []) as any[]) {
        (map[b.product_code] ??= []).push({ id: b.id, barcode: b.barcode, location: b.location })
      }
      setBarcodeMap(map)
    } else {
      setBarcodeMap({})
    }
    setLoading(false)
  }

  // 여러 명이 같은 배치를 동시에 피킹할 때, 한쪽에서 확인 처리한 게 다른 쪽 화면에도
  // 실시간으로 반영되도록 구독 — 배치를 바꾸거나 화면을 나가면 구독 해제
  useEffect(() => {
    if (!activeBatchId) return

    const channel = supabase
      .channel(`picking-${activeBatchId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter: `batch_id=eq.${activeBatchId}` }, payload => {
        if (payload.eventType === 'DELETE') {
          const old = payload.old as { id: string }
          setItems(prev => prev.filter(i => i.id !== old.id))
          return
        }
        const row = payload.new as any
        setItems(prev => {
          if (row.status !== 'confirmed') return prev.filter(i => i.id !== row.id)
          const mapped: Item = {
            id: row.id,
            product_code: row.product_code,
            product_name: row.product_name,
            option_info: row.option_info,
            brand: row.brand,
            supplier_name: row.supplier_name,
            location: row.location,
            product_no: row.product_no,
            quantity: row.quantity,
            inspected_qty: row.inspected_qty,
            picked_at: row.picked_at,
          }
          const exists = prev.some(i => i.id === row.id)
          return exists ? prev.map(i => i.id === row.id ? mapped : i) : [...prev, mapped]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'barcodes' }, payload => {
        setBarcodeMap(prev => {
          if (payload.eventType === 'DELETE') {
            const old = payload.old as { id: string; product_code: string }
            if (!prev[old.product_code]) return prev
            return { ...prev, [old.product_code]: prev[old.product_code].filter(b => b.id !== old.id) }
          }
          const row = payload.new as any
          const rows = prev[row.product_code] ? [...prev[row.product_code]] : []
          const idx = rows.findIndex(b => b.id === row.id)
          const entry: BarcodeRow = { id: row.id, barcode: row.barcode, location: row.location }
          if (idx >= 0) rows[idx] = entry
          else rows.push(entry)
          return { ...prev, [row.product_code]: rows }
        })
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [activeBatchId])

  // 같은 상품(product_code)의 바코드DB 로케이션을 한 번에 반영 — 바코드DB(BarcodeDB.tsx)와
  // 동일한 저장소를 쓰므로 여기서 고치면 그 화면에도 반영됨 (그 반대도 마찬가지)
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
          : [{ id: `temp-${row.product_code}`, barcode: null, location: value }],
      }
    })
    setEditingKey(null)
  }

  // 바코드가 없는 상품에 새 바코드 등록 — 바코드 없이 로케이션만 있는 행이 있으면 그 행을 채움
  // (SoumOutgoing.tsx의 미등록 바코드 등록 로직과 동일한 방식)
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
        : [...rows, { id: `temp-${code}`, barcode: code, location: row.location || null }]
      return { ...prev, [row.product_code]: next }
    })
    setAddingBarcodeKey(null)
    setBarcodeInputValue('')
  }

  // 수량 확인 — 화면에 실제로 보이던 order_item id들만 대상으로 확인 처리 (product_code로
  // 뭉뚱그려 잡으면, 확인 누르는 그 순간 사이에 다른 화면에서 이 배치에 같은 상품이 새로
  // 배정돼도 그것까지 같이 확인 처리돼버림 — 2026-07-30 발견). 이 화면 목록에서만 숨겨지고
  // 배치현황의 기존 픽킹리스트나 출고검수 inspected_qty는 그대로 유지됨
  async function confirmPicked(row: PickingRow, picked: boolean) {
    const value = picked ? new Date().toISOString() : null
    await supabase.from('order_items').update({ picked_at: value }).in('id', row.item_ids)
    const idSet = new Set(row.item_ids)
    setItems(prev => prev.map(i => idSet.has(i.id) ? { ...i, picked_at: value } : i))
  }

  // 루밍 온라인몰 상품 상세페이지에서 썸네일(og:image)만 가져옴 — 카페24 관리자 상품 API
  // 권한 없이도 되는 방식이라, 수집 시 저장해둔 product_no로 공개 페이지를 직접 조회
  async function showThumbnail(row: PickingRow) {
    if (!row.product_no) {
      setThumbnail({ row, loading: false, image: null, title: null, error: '재수집 전 상품이라 이미지를 불러올 수 없습니다.' })
      return
    }
    setThumbnail({ row, loading: true, image: null, title: null, error: null })
    try {
      const res = await fetch(`/api/product-thumbnail?product_no=${row.product_no}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '조회 실패')
      setThumbnail({ row, loading: false, image: data.image, title: data.title, error: null })
    } catch (e: any) {
      setThumbnail({ row, loading: false, image: null, title: null, error: e.message })
    }
  }

  const activeBatch = batches.find(b => b.id === activeBatchId)
  const activeItems = items.filter(i => !i.picked_at)
  const doneItems = items.filter(i => i.picked_at)
  const pickingList = buildPickingList(activeItems, sort, barcodeMap)
  const doneList = buildPickingList(doneItems, sort, barcodeMap)

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
              onClick={() => confirmPicked(row, false)}
              className="text-xs font-medium text-gray-500 border border-gray-300 rounded-lg px-2 py-1 shrink-0"
            >
              ×{row.quantity} · 되돌리기
            </button>
          ) : (
            <button
              onClick={() => confirmPicked(row, true)}
              className="text-xl font-bold text-gray-800 bg-green-50 border border-green-200 rounded-lg px-2.5 py-0.5 shrink-0"
            >
              ×{row.quantity}
            </button>
          )}
        </div>
        <button
          onClick={() => showThumbnail(row)}
          className="text-sm font-medium text-gray-800 text-left underline decoration-dotted underline-offset-2"
        >
          {row.product_name}
        </button>
        {row.option_info && <div className="text-xs text-gray-400 mt-0.5">{row.option_info}</div>}
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-xs text-gray-500">{row.brand || '-'}</span>
          {row.supplier_note && <span className="text-xs text-gray-400 truncate ml-2">{row.supplier_note}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => { setActiveBatchId(null); setItems([]); setBarcodeMap({}) }}
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
      ) : pickingList.length === 0 && doneItems.length === 0 ? (
        <p className="text-center text-gray-400 py-12">피킹할 상품이 없습니다.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-xs text-gray-400">총 {pickingList.length}종</p>
            {doneItems.length > 0 && (
              <button onClick={() => setShowDone(v => !v)} className="text-xs text-gray-500 underline">
                확인완료 {doneList.length}종 {showDone ? '숨기기' : '보기'}
              </button>
            )}
          </div>
          {pickingList.length === 0 ? (
            <p className="text-center text-gray-400 py-8 text-sm">남은 상품이 없습니다.</p>
          ) : (
            pickingList.map(row => renderRow(row, false))
          )}
          {showDone && doneList.map(row => renderRow(row, true))}
        </div>
      )}

      {thumbnail && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setThumbnail(null)}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-2 gap-2">
              <span className="text-sm font-medium text-gray-800">{thumbnail.title ?? thumbnail.row.product_name}</span>
              <button onClick={() => setThumbnail(null)} className="text-gray-400 text-xl leading-none px-1 shrink-0">×</button>
            </div>
            {thumbnail.loading ? (
              <p className="text-center text-gray-400 py-16 text-sm">불러오는 중...</p>
            ) : thumbnail.image ? (
              <img src={thumbnail.image} alt={thumbnail.title ?? ''} className="w-full rounded-lg" />
            ) : (
              <p className="text-center text-gray-400 py-16 text-sm">{thumbnail.error ?? '이미지를 찾을 수 없습니다.'}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
