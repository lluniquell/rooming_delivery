import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'

interface Batch {
  id: string
  batch_no: string
  name: string
  type: string
  item_count: number
}

interface Item {
  id: string
  product_code: string
  product_name: string
  option_info: string | null
  brand: string | null
  supplier_name: string | null
  quantity: number
  delivery_method: string | null
  status: string
  cafe24_item_code: string | null
  tracking_number: string | null
  cafe24_order_no: string
  customer_name: string
  receiver_name: string | null
  receiver_phone: string | null
  zipcode: string | null
  address: string | null
  shipping_message: string | null
}

const STATUS_LABEL: Record<string, string> = {
  confirmed: '확정',
  in_transit: '배송중',
  delivered: '배송완료',
}

const STATUS_COLOR: Record<string, string> = {
  confirmed: 'bg-gray-100 text-gray-600',
  in_transit: 'bg-blue-100 text-blue-700',
  delivered: 'bg-green-100 text-green-700',
}

const LOC_REGEX = /[A-Z]{2}-\d{2}-\d{2}-\d{2}/

export default function SoumBatch() {
  const [batches, setBatches] = useState<Batch[]>([])
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [showPicking, setShowPicking] = useState(false)
  const [pickingSort, setPickingSort] = useState<'location' | 'brand'>('location')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => { loadBatches() }, [])

  async function loadBatches() {
    const { data: batchData } = await supabase.from('batches').select('*').order('batch_no')
    if (!batchData) return

    const { data: itemData } = await supabase
      .from('order_items')
      .select('batch_id')
      .eq('status', 'confirmed')

    const countMap: Record<string, number> = {}
    for (const it of itemData ?? []) {
      if (it.batch_id) countMap[it.batch_id] = (countMap[it.batch_id] ?? 0) + 1
    }

    setBatches(batchData.map(b => ({ ...b, item_count: countMap[b.id] ?? 0 })))
  }

  async function selectBatch(batchId: string) {
    setActiveBatchId(batchId)
    setShowPicking(false)
    setLoading(true)
    const { data } = await supabase
      .from('order_items')
      .select('id, product_code, product_name, option_info, brand, supplier_name, quantity, delivery_method, status, cafe24_item_code, tracking_number, orders!inner(cafe24_order_no, customer_name, order_date, receiver_name, receiver_phone, zipcode, address, shipping_message)')
      .eq('batch_id', batchId)
      .eq('status', 'confirmed')
    const rows = ((data ?? []) as any[])
      .map(row => ({
        id: row.id,
        product_code: row.product_code,
        product_name: row.product_name,
        option_info: row.option_info,
        brand: row.brand,
        supplier_name: row.supplier_name,
        quantity: row.quantity,
        delivery_method: row.delivery_method,
        status: row.status,
        cafe24_item_code: row.cafe24_item_code,
        tracking_number: row.tracking_number,
        cafe24_order_no: row.orders.cafe24_order_no,
        customer_name: row.orders.customer_name,
        receiver_name: row.orders.receiver_name,
        receiver_phone: row.orders.receiver_phone,
        zipcode: row.orders.zipcode,
        address: row.orders.address,
        shipping_message: row.orders.shipping_message,
        _date: row.orders.order_date ?? '',
      }))
      .sort((a, b) => a._date.localeCompare(b._date) || a.cafe24_order_no.localeCompare(b.cafe24_order_no))
    setItems(rows)
    setLoading(false)
  }

  async function moveToHold(itemId: string) {
    const holdBatch = batches.find(b => b.type === 'hold')
    if (!holdBatch) return
    await supabase.from('order_items').update({ batch_id: holdBatch.id }).eq('id', itemId)
    // 서버 재조회 없이 로컬에서 바로 반영 (매번 전체 배치를 다시 불러오면 느림)
    setItems(prev => prev.filter(i => i.id !== itemId))
    setBatches(prev => prev.map(b => {
      if (b.id === activeBatchId) return { ...b, item_count: Math.max(0, b.item_count - 1) }
      if (b.id === holdBatch.id) return { ...b, item_count: b.item_count + 1 }
      return b
    }))
  }

  function buildPickingList() {
    const merged: Record<string, {
      location: string; brand: string; product_name: string
      option_info: string; supplier_note: string; quantity: number
    }> = {}

    for (const item of items) {
      const supplier = item.supplier_name ?? ''
      const location = supplier.match(LOC_REGEX)?.[0] ?? ''
      const supplier_note = supplier.replace(LOC_REGEX, '').replace(/^\s*[|｜]\s*|\s*[|｜]\s*$/g, '').trim()
      const key = `${item.product_code}__${item.option_info ?? ''}`
      if (merged[key]) {
        merged[key].quantity += item.quantity
      } else {
        merged[key] = {
          location,
          brand: item.brand ?? '',
          product_name: item.product_name,
          option_info: item.option_info ?? '',
          supplier_note,
          quantity: item.quantity,
        }
      }
    }
    const rows = Object.values(merged)
    return pickingSort === 'brand'
      ? rows.sort((a, b) => a.brand.localeCompare(b.brand))
      : rows.sort((a, b) => a.location.localeCompare(b.location))
  }

  const activeBatch = batches.find(b => b.id === activeBatchId)
  const pickingList = buildPickingList()
  const fileInputRef = useRef<HTMLInputElement>(null)

  function downloadCJ() {
    // 이 배치에 경동/직배 상품이 섞여 있어도 CJ로 배정된 상품만 CJ 송장 엑셀에 실림
    const cjItems = items.filter(i => i.delivery_method === 'CJ')
    if (!cjItems.length) {
      alert('이 배치에 CJ 배정 상품이 없습니다.')
      return
    }

    // 택배 프로그램의 '합포장' 설정으로 같은 고객주문번호 여러 줄이 하나로 묶여 출력됨을 확인 —
    // 상품마다 한 줄씩 나누고, 품목명은 각 줄의 실제 상품명, 박스수량은 항상 1
    const orderInfo: Record<string, {
      orderNo: string; name: string; phone: string; zipcode: string
      address: string; message: string
    }> = {}
    for (const item of cjItems) {
      const key = item.cafe24_order_no
      if (!orderInfo[key]) {
        orderInfo[key] = {
          orderNo: key,
          name: item.receiver_name || item.customer_name,
          phone: item.receiver_phone ?? '',
          zipcode: item.zipcode ?? '',
          address: item.address ?? '',
          message: item.shipping_message ?? '',
        }
      }
    }

    // CJ 표준 양식 (컬럼 순서 고정). 값이 없는 필드(예약구분/받는분기타연락처/운송장번호/
    // 박스타입/기본운임/배송메세지2)는 CJ 시스템이 채우거나 우리가 안 쓰는 항목이라 공란.
    const header = [
      '예약구분', '집하예정일', '받는분성명', '받는분전화번호', '받는분기타연락처',
      '받는분우편번호', '받는분주소(전체, 분할)', '운송장번호', '고객주문번호',
      '품목명', '박스수량', '박스타입', '기본운임', '배송메세지1', '배송메세지2',
      '품목명', '운임구분',
    ]
    const d = new Date()
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    // 상품마다 한 줄씩 — 같은 주문번호가 여러 줄에 반복됨, 박스수량은 항상 1
    const dataRows = cjItems.map(item => {
      const o = orderInfo[item.cafe24_order_no]
      return [
        '', dateStr, o.name, o.phone, '',
        o.zipcode, o.address, '', o.orderNo,
        item.product_name, 1, '', '', o.message, '',
        '', '',
      ]
    })

    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'CJ송장')
    XLSX.writeFile(wb, `CJ송장_${activeBatch?.name ?? '배치'}_${dateStr}.xlsx`)
  }

  async function uploadTracking(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 })

      // 헤더 행에서 주문번호/운송장 컬럼 찾기
      // (findIndex는 완전히 빈 셀로 생긴 배열 홀(hole)도 콜백을 호출하므로, 매번 String(c ?? '')로 안전하게 변환)
      let headerIdx = -1, orderCol = -1, trackCol = -1
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const r = rows[i] ?? []
        const oc = r.findIndex(c => String(c ?? '').includes('주문번호'))
        const tc = r.findIndex(c => /운송장|송장번호/.test(String(c ?? '')))
        if (oc >= 0 && tc >= 0) { headerIdx = i; orderCol = oc; trackCol = tc; break }
      }
      if (headerIdx < 0) {
        alert('주문번호 / 운송장번호 컬럼을 찾을 수 없습니다.')
        return
      }

      const parsed: { order_no: string; tracking_no: string }[] = []
      for (const r of rows.slice(headerIdx + 1)) {
        const orderNo = String(r?.[orderCol] ?? '').trim()
        const tracking = String(r?.[trackCol] ?? '').trim().replace(/[-\s]/g, '')
        if (!orderNo || !tracking) continue
        parsed.push({ order_no: orderNo, tracking_no: tracking })
      }

      // 운송장번호 등록 + 카페24 배송대기 처리 모두 서버에서 처리 — 서버가 주문별로
      // CJ 배정 상품만 찾아 그 상품의 shipping_code에만 반영함 (타임아웃 방지 위해 50건씩 분할)
      let cafe24Updated = 0
      const cafe24Errors: string[] = []
      for (let i = 0; i < parsed.length; i += 50) {
        const chunk = parsed.slice(i, i + 50)
        try {
          const res = await fetch('/api/cafe24/shipments?action=standby', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orders: chunk }),
          })
          const result = await res.json()
          cafe24Updated += result.updated ?? 0
          if (result.errors?.length) cafe24Errors.push(...result.errors)
        } catch {
          cafe24Errors.push(`${chunk[0].order_no} 외 ${chunk.length - 1}건: 네트워크 오류`)
        }
      }

      let msg = `카페24 배송대기 처리 ${cafe24Updated}건 / 전체 ${parsed.length}건`
      if (cafe24Errors.length) {
        msg += `\n실패 ${cafe24Errors.length}건\n${cafe24Errors.slice(0, 5).join('\n')}${cafe24Errors.length > 5 ? '\n...' : ''}`
      }
      alert(msg)
      if (activeBatchId) selectBatch(activeBatchId)
    } catch (err: any) {
      alert(`파일 처리 실패: ${err.message}`)
    } finally {
      e.target.value = ''
    }
  }

  async function refresh() {
    setRefreshing(true)
    await loadBatches()
    if (activeBatchId) await selectBatch(activeBatchId)
    setRefreshing(false)
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800">배치 현황</h2>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-500 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          {refreshing ? '새로고침 중...' : '↻ 새로고침'}
        </button>
      </div>

      {/* 배치 카드 */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-6">
        {batches.map(batch => (
          <button
            key={batch.id}
            onClick={() => selectBatch(batch.id)}
            className={`p-3 rounded-xl border text-left transition-colors ${
              activeBatchId === batch.id
                ? 'bg-indigo-50 border-indigo-300'
                : 'bg-white hover:bg-gray-50 border-gray-200'
            }`}
          >
            <div className="text-xs text-gray-400 mb-1">{batch.batch_no}번</div>
            <div className="font-medium text-gray-800 text-sm leading-tight">{batch.name}</div>
            <div className={`text-2xl font-bold mt-2 ${
              batch.item_count > 0 ? 'text-indigo-600' : 'text-gray-200'
            }`}>
              {batch.item_count}
            </div>
          </button>
        ))}
      </div>

      {/* 선택된 배치 상세 */}
      {activeBatchId && (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <span className="font-medium text-gray-800">
              {activeBatch?.batch_no}번 {activeBatch?.name}
              <span className="text-gray-400 font-normal ml-2 text-sm">상품 {items.length}개</span>
            </span>
            {items.length > 0 && (
              <div className="flex gap-2">
                <button
                  onClick={downloadCJ}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
                >
                  CJ 송장 출력용 엑셀 다운로드
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium bg-orange-500 text-white hover:bg-orange-600"
                >
                  운송장 업로드
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={uploadTracking}
                  className="hidden"
                />
                <button
                  onClick={() => setShowPicking(true)}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700"
                >
                  픽킹리스트
                </button>
              </div>
            )}
          </div>

          {loading ? (
            <div className="p-12 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : items.length === 0 ? (
            <div className="p-12 text-center text-gray-400 text-sm">이 배치에 상품이 없습니다</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">주문번호</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">주문자명</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">수령인명</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">상품</th>
                  <th className="text-center px-4 py-2 font-medium text-gray-500 text-xs w-12">수량</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">배송방법</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">상태</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 whitespace-nowrap">{item.cafe24_order_no}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{item.customer_name}</td>
                    <td className="px-4 py-3 font-medium text-gray-800 whitespace-nowrap">{item.receiver_name || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {item.brand && <span className="text-gray-400 text-xs mr-1.5">[{item.brand}]</span>}
                      {item.product_name}
                      {item.option_info && <span className="text-gray-400 text-xs ml-1.5">{item.option_info}</span>}
                    </td>
                    <td className="px-4 py-3 text-center font-semibold text-gray-800">{item.quantity}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{item.delivery_method ?? '-'}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLOR[item.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABEL[item.status] ?? item.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => moveToHold(item.id)}
                        className="text-xs text-gray-300 hover:text-orange-400 transition-colors"
                      >
                        보류로
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showPicking && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col">
            <div className="px-5 py-3 border-b flex items-center justify-between shrink-0">
              <h3 className="font-bold text-gray-800">
                픽킹리스트 <span className="text-gray-400 font-normal text-sm ml-1">{activeBatch?.name}</span>
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 mr-1">정렬</span>
                <button
                  onClick={() => setPickingSort('location')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    pickingSort === 'location'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'text-gray-600 border-gray-300 hover:border-indigo-400'
                  }`}
                >
                  로케이션 오름차순
                </button>
                <button
                  onClick={() => setPickingSort('brand')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    pickingSort === 'brand'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'text-gray-600 border-gray-300 hover:border-indigo-400'
                  }`}
                >
                  브랜드명 오름차순
                </button>
                <button
                  onClick={() => setShowPicking(false)}
                  className="ml-2 text-gray-400 hover:text-gray-600 text-xl leading-none px-1"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">로케이션</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">브랜드</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">상품명</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">옵션</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">공급사</th>
                    <th className="text-center px-3 py-2 font-medium text-gray-500 text-xs w-12">수량</th>
                  </tr>
                </thead>
                <tbody>
                  {pickingList.map((item, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-3 py-2.5 font-mono text-xs text-indigo-600 whitespace-nowrap">{item.location || '-'}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-500">{item.brand || '-'}</td>
                      <td className="px-3 py-2.5 text-sm text-gray-800">{item.product_name}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-500">{item.option_info || '-'}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-400">{item.supplier_note || '-'}</td>
                      <td className="px-3 py-2.5 text-center font-bold text-gray-800">{item.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
