import { useState, useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import * as XLSX from 'xlsx'

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

interface MiseongPickup {
  id: string
  product_code: string
  product_name: string
  quantity: number
  fetched_at: string | null
}

interface ProductCandidate {
  product_code: string
  product_name: string
  barcode: string | null
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

// 로컬(KST) 기준 오늘 날짜 문자열
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
  const [miseongBatch, setMiseongBatch] = useState<Batch | null>(null)
  const [miseongFetchKey, setMiseongFetchKey] = useState<string | null>(null)
  const [miseongQtyValue, setMiseongQtyValue] = useState('')
  const [miseongPickupsToday, setMiseongPickupsToday] = useState<MiseongPickup[]>([])
  const [showAddMiseong, setShowAddMiseong] = useState(false)
  const [addForm, setAddForm] = useState({ product_code: '', product_name: '', quantity: '' })
  const [productQuery, setProductQuery] = useState('')
  const [productResults, setProductResults] = useState<ProductCandidate[]>([])
  const [staffName, setStaffName] = useState('')
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    loadBatches()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('drivers').select('name').eq('id', user.id).maybeSingle()
        .then(({ data }) => { if (data) setStaffName(data.name) })
    })
  }, [])

  // 배치 선택 목록(CJ1~5 카드)은 화면 진입 시 한 번만 불러와서, 이미 열어둔 채로 다른 배치에
  // 새로 주문이 배정돼도 목록이 갱신되지 않는 문제가 있었음 — 탭이 다시 포커스될 때 재조회
  useEffect(() => {
    function onFocus() { loadBatches() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  async function loadBatches() {
    // 미성 배치는 소품팀 피킹 화면 전용 임시 보관소라 일반 배치 목록엔 안 섞고 따로 고정 노출
    const { data: miseong } = await supabase.from('batches').select('id, batch_no, name, type').eq('type', 'miseong').maybeSingle()
    setMiseongBatch(miseong ?? null)

    // 소품팀 피킹은 CJ 배치만 대상 — 경동/직배/업체배송/팀무버/기타/보류 등은 여기서 다루지 않음
    const { data: batchData } = await supabase.from('batches').select('id, batch_no, name, type').ilike('name', 'CJ%').order('batch_no')
    if (!batchData) { setBatches([]); return }

    // 확인 안 된(picked_at null) 상품 중 아직 남은 수량(quantity > inspected_qty)이 있는
    // 배치만 선택 목록에 노출 — 피킹할 게 없는 배치는 목록에서 아예 뺌. 미성으로 보낸
    // 상품은 원래 배치의 batch_id를 그대로 유지하니 여기서 따로 제외해야 함
    const { data: itemData } = await supabase
      .from('order_items')
      .select('batch_id, quantity, inspected_qty')
      .eq('status', 'confirmed')
      .is('picked_at', null)
      .is('miseong_sent_at', null)

    const batchesWithStock = new Set<string>()
    for (const it of (itemData ?? []) as any[]) {
      if (it.batch_id && it.quantity - it.inspected_qty > 0) batchesWithStock.add(it.batch_id)
    }

    setBatches(batchData.filter(b => batchesWithStock.has(b.id)))
  }

  async function selectBatch(batchId: string) {
    setActiveBatchId(batchId)
    setLoading(true)

    // 미성 화면은 실제 batch_id가 아니라 miseong_sent_at이 찍힌 상품을(원래 배치가 뭐든)
    // 전부 모아서 보여줌 — 미성으로 보낸다고 실제 batch_id는 절대 안 바뀌므로(다른 화면에
    // 영향 없게 하려고) 이렇게 별도 조건으로 조회해야 함
    const isMiseong = miseongBatch && batchId === miseongBatch.id
    let query = supabase
      .from('order_items')
      .select('id, product_code, product_name, option_info, brand, supplier_name, location, product_no, quantity, inspected_qty, picked_at')
      .eq('status', 'confirmed')
    query = isMiseong ? query.not('miseong_sent_at', 'is', null) : query.eq('batch_id', batchId).is('miseong_sent_at', null)
    const { data } = await query
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

    if (miseongBatch && batchId === miseongBatch.id) {
      await loadMiseongPickupsToday()
    }
    setLoading(false)
  }

  // 확인 처리 직후 이 화면에서 다시 불러와 최신 상태로 맞춤 — realtime 구독이 끊겼다 붙는
  // 사이의 이벤트를 놓쳐도, 각자 터치할 때마다 스스로 최신화되니 화면이 계속 어긋나 있지 않음.
  // 로딩 스피너 없이 조용히 갱신(barcodeMap은 건드릴 필요 없어 items만 다시 조회).
  // 배치 선택 목록도 같이 갱신 — 이 터치로 다른 배치가 새로 "피킹할 게 있는" 상태가 될 수 있음
  async function refetchItems() {
    if (!activeBatchId) return
    const isMiseong = !!miseongBatch && activeBatchId === miseongBatch.id
    let query = supabase
      .from('order_items')
      .select('id, product_code, product_name, option_info, brand, supplier_name, location, product_no, quantity, inspected_qty, picked_at')
      .eq('status', 'confirmed')
    query = isMiseong ? query.not('miseong_sent_at', 'is', null) : query.eq('batch_id', activeBatchId).is('miseong_sent_at', null)
    const { data } = await query
    setItems((data ?? []) as Item[])
    loadBatches()
  }

  async function loadMiseongPickupsToday() {
    const { data } = await supabase
      .from('miseong_pickups')
      .select('id, product_code, product_name, quantity, fetched_at')
      .eq('picked_date', todayStr())
      .order('created_at', { ascending: false })
    setMiseongPickupsToday((data ?? []) as MiseongPickup[])
  }

  // 여러 명이 같은 배치를 동시에 피킹할 때, 한쪽에서 확인 처리한 게 다른 쪽 화면에도
  // 실시간으로 반영되도록 구독 — 배치를 바꾸거나 화면을 나가면 구독 해제.
  // 미성 화면은 실제 batch_id로 필터링이 안 되니(원래 배치가 제각각이라) 필터 없이
  // 전체 구독해서 miseong_sent_at으로 클라이언트에서 걸러냄
  useEffect(() => {
    if (!activeBatchId) return
    const isMiseong = !!miseongBatch && activeBatchId === miseongBatch.id

    const channel = supabase
      .channel(`picking-${activeBatchId}`)
      .on(
        'postgres_changes',
        isMiseong
          ? { event: '*', schema: 'public', table: 'order_items' }
          : { event: '*', schema: 'public', table: 'order_items', filter: `batch_id=eq.${activeBatchId}` },
        payload => {
          if (payload.eventType === 'DELETE') {
            const old = payload.old as { id: string }
            setItems(prev => prev.filter(i => i.id !== old.id))
            return
          }
          const row = payload.new as any
          const belongsHere = isMiseong
            ? !!row.miseong_sent_at
            : row.batch_id === activeBatchId && !row.miseong_sent_at
          setItems(prev => {
            if (row.status !== 'confirmed' || !belongsHere) return prev.filter(i => i.id !== row.id)
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
        }
      )
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
  }, [activeBatchId, miseongBatch?.id])

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
    await supabase.from('order_items').update({ picked_at: value, picked_by: picked ? staffName : null }).in('id', row.item_ids)
    await refetchItems()
  }

  // 미성에서 찾기 — NK에 없는 상품을 미성 배치로 옮겨 파킹만 해둠 (수량은 여기선 안 물어봄,
  // 실제 이동 수량은 미성에서 실물을 픽킹할 때 그 화면에서 정함)
  async function moveToMiseong(row: PickingRow) {
    if (!confirm(`${row.product_name}을(를) 미성 배치로 옮길까요?`)) return

    // 실제 batch_id는 절대 안 건드림 — 그래야 배치현황/CJ 엑셀/출고검수 등 다른 화면엔
    // 원래 배치 그대로 보임. miseong_sent_at만 찍어서 이 화면(피킹)에서만 미성으로 취급
    const { error } = await supabase.from('order_items').update({ miseong_sent_at: new Date().toISOString() }).in('id', row.item_ids)
    if (error) { alert(`미성 이동 실패: ${error.message}`); return }

    const idSet = new Set(row.item_ids)
    setItems(prev => prev.filter(i => !idSet.has(i.id)))
  }

  // 미성으로 잘못 보냈거나 다시 원래 배치에서 찾기로 한 경우 — miseong_sent_at만 지워서
  // 원래 배치 화면으로 되돌림 (batch_id는 애초에 안 건드렸으니 그대로 복귀)
  async function removeFromMiseong(row: PickingRow) {
    if (!confirm(`${row.product_name}을(를) 미성에서 빼고 원래 배치로 되돌릴까요?`)) return
    const { error } = await supabase.from('order_items').update({ miseong_sent_at: null }).in('id', row.item_ids)
    if (error) { alert(`제외 실패: ${error.message}`); return }
    const idSet = new Set(row.item_ids)
    setItems(prev => prev.filter(i => !idSet.has(i.id)))
  }

  // 미성 배치 화면에서 실제 피킹 완료 처리 — 미성은 박스 단위로 가져오는 경우가 많아서
  // 주문에 필요한 수량과 실제 이동 수량이 다를 수 있어, 확인하는 시점에 수량을 직접
  // 입력받아 이카운트 재고이동 기록에 남기고 나서 확인(picked_at) 처리함
  async function confirmMiseongPickup(row: PickingRow, qtyInput: string) {
    const qty = Number(qtyInput)
    if (!qty || qty <= 0) { alert('이동 수량을 입력해주세요.'); return }

    const { error: logError } = await supabase.from('miseong_pickups').insert({
      picked_date: todayStr(),
      product_code: row.product_code,
      product_name: row.product_name,
      quantity: qty,
      requested_quantity: row.quantity,
      picked_by: staffName,
      fetched_at: new Date().toISOString(),   // 실물을 이미 손에 들고 확정하는 시점 → 바로 완료
    })
    if (logError) { alert(`미성 이동 기록 실패: ${logError.message}`); return }

    const value = new Date().toISOString()
    await supabase.from('order_items').update({ picked_at: value, picked_by: staffName }).in('id', row.item_ids)
    await refetchItems()
    setMiseongFetchKey(null)
    setMiseongQtyValue('')
    loadMiseongPickupsToday()
  }

  // 미성 배치 화면에서 특정 주문과 무관하게 상품을 임의로 요청(예: 다음에 필요할 것 같아
  // 미리 가져와달라고 요청하는 경우) — order_item과 연결이 없으니 이카운트 재고이동
  // 기록(miseong_pickups)에 fetched_at=null(대기중)로 남김. 실제로 가져온 뒤 "가져옴"을
  // 눌러야 완료로 넘어감(markMiseongFetched). 상품코드는 현장에서 알기 어려워서 필수로
  // 안 받음 — 검색해서 고르면 자동으로 채워지고, 못 고르면 빈 값으로 저장했다가 엑셀
  // 받아서 나중에 채워 넣으면 됨
  async function addMiseongManual() {
    const product_code = addForm.product_code.trim()
    const product_name = addForm.product_name.trim()
    const quantity = Number(addForm.quantity)
    if (!product_name || !quantity || quantity <= 0) {
      alert('상품명/수량을 입력해주세요.')
      return
    }
    const { error } = await supabase.from('miseong_pickups').insert({
      picked_date: todayStr(),
      product_code,
      product_name,
      quantity,
      requested_quantity: quantity,
      picked_by: staffName,
      fetched_at: null,   // 아직 안 가져온 요청 상태 — "가져옴" 누르면 완료로 전환
    })
    if (error) { alert(`추가 실패: ${error.message}`); return }
    setAddForm({ product_code: '', product_name: '', quantity: '' })
    setProductQuery('')
    setProductResults([])
    setShowAddMiseong(false)
    loadMiseongPickupsToday()
  }

  // 요청 카드에서 "가져옴"을 누르면 완료(fetched_at 기록)로 전환 — 오늘 미성 이동 기록에 합류
  async function markMiseongFetched(id: string) {
    const fetched_at = new Date().toISOString()
    const { error } = await supabase.from('miseong_pickups').update({ fetched_at }).eq('id', id)
    if (error) { alert(`완료 처리 실패: ${error.message}`); return }
    setMiseongPickupsToday(prev => prev.map(p => p.id === id ? { ...p, fetched_at } : p))
  }

  async function removeMiseongPickup(id: string) {
    await supabase.from('miseong_pickups').delete().eq('id', id)
    setMiseongPickupsToday(prev => prev.filter(p => p.id !== id))
  }

  // 상품명/상품코드/바코드로 바코드DB에서 검색 — 여기 등록된 상품은 상품코드/상품명을
  // 직접 타이핑할 필요 없이 목록에서 골라서 채울 수 있음
  async function searchProducts(q: string) {
    const query = q.trim()
    if (!query) { setProductResults([]); return }
    const { data } = await supabase
      .from('barcodes')
      .select('product_code, product_name, barcode')
      .or(`barcode.ilike.%${query}%,product_name.ilike.%${query}%,product_code.ilike.%${query}%`)
      .limit(8)
    const seen = new Set<string>()
    const deduped: ProductCandidate[] = []
    for (const row of (data ?? []) as ProductCandidate[]) {
      if (seen.has(row.product_code)) continue
      seen.add(row.product_code)
      deduped.push(row)
    }
    setProductResults(deduped)
  }

  // 당일 미성에서 피킹한(이동한) 상품 목록 — 이카운트 재고이동 등록용.
  // 담당자는 실제 피킹한 사람이 아니라 엑셀을 다운로드하는(재고이동 등록하는) 사람 기준.
  // B105/A100은 이카운트 재고이동 양식의 고정 창고코드, 헤더 없이 데이터 행만 그대로 업로드하는 형식
  async function downloadMiseongExcel() {
    const dateStr = todayStr()
    const { data } = await supabase
      .from('miseong_pickups')
      .select('product_code, product_name, quantity, requested_quantity')
      .eq('picked_date', dateStr)
      .not('fetched_at', 'is', null)   // 실제로 가져온(완료된) 것만 — 대기중 요청은 아직 이동 안 했으니 제외
      .order('product_code')
    if (!data?.length) { alert('오늘 미성에서 이동한 상품이 없습니다.'); return }

    const merged: Record<string, { product_code: string; product_name: string; quantity: number; requested_quantity: number }> = {}
    for (const row of data) {
      if (merged[row.product_code]) {
        merged[row.product_code].quantity += row.quantity
        merged[row.product_code].requested_quantity += row.requested_quantity ?? row.quantity
      } else {
        merged[row.product_code] = { product_code: row.product_code, product_name: row.product_name, quantity: row.quantity, requested_quantity: row.requested_quantity ?? row.quantity }
      }
    }

    const dateSlash = dateStr.replace(/-/g, '/')
    const rows = Object.values(merged).map(r => [
      dateSlash, staffName, 'B105', 'A100', r.product_code, r.product_name, '', r.requested_quantity, r.quantity,
    ])
    const ws = XLSX.utils.aoa_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '미성이동')
    XLSX.writeFile(wb, `미성이동_${dateStr}.xlsx`)
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

  const activeBatch = activeBatchId === miseongBatch?.id ? miseongBatch : batches.find(b => b.id === activeBatchId)
  const isMiseongView = !!miseongBatch && activeBatchId === miseongBatch.id
  const activeItems = items.filter(i => !i.picked_at)
  const doneItems = items.filter(i => i.picked_at)
  const pickingList = buildPickingList(activeItems, sort, barcodeMap)
  const doneList = buildPickingList(doneItems, sort, barcodeMap)
  const pendingManual = isMiseongView ? miseongPickupsToday.filter(p => !p.fetched_at) : []

  if (!activeBatchId) {
    return (
      <div className="max-w-md mx-auto">
        <h2 className="text-lg font-bold text-gray-800 mb-4">피킹 — 배치 선택</h2>
        {miseongBatch && (
          <button
            onClick={() => selectBatch(miseongBatch.id)}
            className="w-full text-left bg-amber-50 rounded-xl border border-amber-200 p-4 hover:bg-amber-100 transition-colors mb-3"
          >
            <span className="font-medium text-amber-800">🚚 미성 (임시 보관)</span>
          </button>
        )}
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

            {/* NK에 없으면 미성에서 대신 가져오는 경우가 있어서, 로케이션과 무관하게
                모든 상품에 이 옵션을 열어둠 (미성 배치 화면 자체에서는 의미 없으니 제외) */}
            {!isMiseongView && !done && (
              <button onClick={() => moveToMiseong(row)} className="text-[11px] text-amber-600">
                🚚 미성
              </button>
            )}
            {isMiseongView && !done && (
              <button onClick={() => removeFromMiseong(row)} className="text-[11px] text-gray-400">
                ↩ 미성에서 빼기
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
          ) : isMiseongView && miseongFetchKey === row.key ? (
            <div className="flex items-center gap-1 shrink-0">
              <input
                autoFocus
                type="number"
                min={1}
                value={miseongQtyValue}
                onChange={e => setMiseongQtyValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmMiseongPickup(row, miseongQtyValue) }}
                className="w-16 border rounded px-1.5 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <button onClick={() => confirmMiseongPickup(row, miseongQtyValue)} className="text-xs font-medium text-white bg-amber-600 rounded-lg px-2 py-1">확정</button>
              <button onClick={() => setMiseongFetchKey(null)} className="text-xs text-gray-400 px-1">취소</button>
            </div>
          ) : isMiseongView ? (
            <button
              onClick={() => { setMiseongFetchKey(row.key); setMiseongQtyValue(String(row.quantity)) }}
              className="text-xl font-bold text-gray-800 bg-green-50 border border-green-200 rounded-lg px-2.5 py-0.5 shrink-0"
            >
              ×{row.quantity}
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
        <div className="mt-1.5">
          <span className="text-xs text-gray-500">{row.brand || '-'}</span>
          {row.supplier_note && <div className="text-xs text-gray-400 mt-0.5 break-words">{row.supplier_note}</div>}
        </div>
      </div>
    )
  }

  // "+ 추가"로 등록했지만 아직 실제로 가져오지 않은 요청 — 미성 화면은 어차피 전부
  // "가져와야 할 것"들이라 별도 표시 없이 아래 피킹 카드와 완전히 동일한 형식으로 섞어서 보여줌
  function renderPendingMiseong(p: MiseongPickup) {
    return (
      <div key={p.id} className="bg-white rounded-xl border p-3.5">
        <div className="flex items-center justify-end mb-1.5">
          <button
            onClick={() => markMiseongFetched(p.id)}
            className="text-xl font-bold text-gray-800 bg-green-50 border border-green-200 rounded-lg px-2.5 py-0.5 shrink-0"
          >
            ×{p.quantity}
          </button>
        </div>
        <div className="text-sm font-medium text-gray-800">{p.product_name}</div>
        <div className="mt-1.5">
          <span className="text-xs text-gray-500 font-mono">{p.product_code}</span>
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
          {isMiseongView ? '🚚 미성 (임시 보관)' : `${activeBatch?.batch_no}번 ${activeBatch?.name}`}
        </h2>
        {isMiseongView ? (
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setShowAddMiseong(true)} className="text-xs font-medium text-amber-700">+ 추가</button>
            <button onClick={downloadMiseongExcel} className="text-xs font-medium text-amber-700">엑셀</button>
          </div>
        ) : (
          <span className="w-14 shrink-0" />
        )}
      </div>

      {isMiseongView && miseongPickupsToday.some(p => !!p.fetched_at) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
          <p className="text-xs font-medium text-amber-700 mb-2">
            오늘 미성 이동 기록 {miseongPickupsToday.filter(p => !!p.fetched_at).length}건
          </p>
          <div className="space-y-1">
            {miseongPickupsToday.filter(p => !!p.fetched_at).map(p => (
              <div key={p.id} className="flex items-center justify-between text-xs text-amber-900">
                <span className="truncate">{p.product_name} <span className="font-mono text-amber-500">{p.product_code}</span></span>
                <span className="flex items-center gap-2 shrink-0 ml-2">
                  ×{p.quantity}
                  <button onClick={() => removeMiseongPickup(p.id)} className="text-amber-400 hover:text-red-500">✕</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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
      ) : pickingList.length === 0 && doneItems.length === 0 && pendingManual.length === 0 ? (
        <p className="text-center text-gray-400 py-12">피킹할 상품이 없습니다.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-xs text-gray-400">총 {pickingList.length}종 / {pickingList.reduce((sum, r) => sum + r.quantity, 0)}EA</p>
            {doneItems.length > 0 && (
              <button onClick={() => setShowDone(v => !v)} className="text-xs text-gray-500 underline">
                확인완료 {doneList.length}종 / {doneList.reduce((sum, r) => sum + r.quantity, 0)}EA {showDone ? '숨기기' : '보기'}
              </button>
            )}
          </div>
          {pendingManual.map(p => renderPendingMiseong(p))}
          {pickingList.length === 0 && pendingManual.length === 0 ? (
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

      {showAddMiseong && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => { setShowAddMiseong(false); setProductQuery(''); setProductResults([]) }}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-bold text-gray-800">미성 상품 추가</span>
              <button onClick={() => { setShowAddMiseong(false); setProductQuery(''); setProductResults([]) }} className="text-gray-400 text-xl leading-none px-1">×</button>
            </div>
            <div className="space-y-2">
              <div className="relative">
                <input
                  autoFocus
                  value={productQuery}
                  onChange={e => {
                    const v = e.target.value
                    setProductQuery(v)
                    if (searchTimeout.current) clearTimeout(searchTimeout.current)
                    searchTimeout.current = setTimeout(() => searchProducts(v), 300)
                  }}
                  placeholder="상품명 또는 바코드로 검색"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
                {productResults.length > 0 && (
                  <div className="absolute z-10 left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg divide-y max-h-40 overflow-y-auto">
                    {productResults.map(p => (
                      <button
                        key={p.product_code}
                        onClick={() => {
                          setAddForm(f => ({ ...f, product_code: p.product_code, product_name: p.product_name }))
                          setProductQuery('')
                          setProductResults([])
                        }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-amber-50"
                      >
                        <div className="font-medium text-gray-800">{p.product_name}</div>
                        <div className="text-gray-400 font-mono">{p.product_code}{p.barcode ? ` · ${p.barcode}` : ''}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {addForm.product_code && (
                <p className="text-[11px] text-gray-400 font-mono px-0.5">코드 자동입력됨: {addForm.product_code}</p>
              )}
              <input
                value={addForm.product_name}
                onChange={e => setAddForm(f => ({ ...f, product_name: e.target.value }))}
                placeholder="상품명"
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <input
                type="number"
                min={1}
                value={addForm.quantity}
                onChange={e => setAddForm(f => ({ ...f, quantity: e.target.value }))}
                placeholder="수량"
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <button
              onClick={addMiseongManual}
              className="w-full mt-3 py-2 rounded-lg text-sm font-medium text-white bg-amber-600 hover:bg-amber-700"
            >
              추가
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
