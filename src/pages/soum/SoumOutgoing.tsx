import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

function parseInvoiceNo(raw: string): string {
  const trimmed = raw.trim()
  const n = Number(trimmed)
  if (!isNaN(n) && (trimmed.includes('E') || trimmed.includes('e'))) {
    return Math.round(n).toString()
  }
  return trimmed.replace(/[-\s]/g, '')
}

interface InspectItem {
  id: string
  product_code: string
  product_name: string
  option_info: string | null
  brand: string | null
  supplier_name: string | null
  quantity: number
  inspected_qty: number
  delivery_method: string | null
  cafe24_item_code: string | null
  product_no: number | null
}

interface UnregisteredModal {
  barcode: string
  candidates: InspectItem[]
}

interface PendingOrder {
  tracking_number: string
  customer_name: string
  item_count: number
  ea_count: number
}

export default function SoumOutgoing() {
  const [invoiceNo, setInvoiceNo] = useState('')
  const [orderInfo, setOrderInfo] = useState<{ id: string; cafe24_order_no: string; customer_name: string; tracking_number: string } | null>(null)
  const [items, setItems] = useState<InspectItem[]>([])
  const [barcode, setBarcode] = useState('')
  const [modal, setModal] = useState<UnregisteredModal | null>(null)
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(false)
  const [pendingList, setPendingList] = useState<PendingOrder[]>([])
  const [showPending, setShowPending] = useState(false)
  const [holdBatchId, setHoldBatchId] = useState<string | null>(null)
  const [staffName, setStaffName] = useState('')

  const invoiceRef = useRef<HTMLInputElement>(null)
  const barcodeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    invoiceRef.current?.focus()
    loadPending()
    supabase.from('batches').select('id').eq('type', 'hold').maybeSingle()
      .then(({ data }) => setHoldBatchId(data?.id ?? null))
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('drivers').select('name').eq('id', user.id).maybeSingle()
        .then(({ data }) => { if (data) setStaffName(data.name) })
    })
  }, [])

  // 카페24 주문 메모에 직접 기록 — orders.admin_memo는 카페24 메모를 그대로 캐시해오는
  // 것뿐이라(주문수집할 때마다 통째로 덮어씀) 로컬 DB에만 써두면 다음 수집 때 사라짐
  async function postMemoToCafe24(orderNo: string, text: string) {
    try {
      await fetch('/api/cafe24/shipments?action=memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_no: orderNo, content: text }),
      })
    } catch { /* 메모 등록 실패해도 출고 처리 자체엔 영향 없음 */ }
  }

  async function loadPending() {
    // 운송장 등록됐고 아직 출고 안 된 상품이 있는 주문 — 운송장번호는 상품(order_item) 자신의
    // 값이라, 같은 주문에 다른 배송방법 상품이 섞여 있어도 그건 여기 잡히지 않음.
    // 이 화면은 CJ 전용이라 직배(스케줄러/배송원 앱에서 완료 처리)는 제외
    const { data } = await supabase
      .from('order_items')
      .select('tracking_number, quantity, orders!inner(customer_name)')
      .eq('status', 'confirmed')
      .eq('delivery_method', 'CJ')
      .not('tracking_number', 'is', null)
    const map: Record<string, PendingOrder> = {}
    for (const row of (data ?? []) as any[]) {
      const t = row.tracking_number
      if (!map[t]) map[t] = { tracking_number: t, customer_name: row.orders.customer_name, item_count: 0, ea_count: 0 }
      map[t].item_count++
      map[t].ea_count += row.quantity
    }
    setPendingList(Object.values(map))
  }

  async function loadByTracking(tracking: string) {
    // 주문 단위가 아니라, 이 운송장번호를 실제로 가진 상품(order_item) 행만 조회 —
    // 같은 주문의 다른 배송방법(경동/직배) 상품은 tracking_number가 다르므로 절대 섞이지 않음.
    // 이 화면은 CJ 전용이라 직배는 제외
    const { data: itemData } = await supabase
      .from('order_items')
      .select('id, product_code, product_name, option_info, brand, supplier_name, quantity, inspected_qty, delivery_method, cafe24_item_code, product_no, order_id, orders!inner(id, cafe24_order_no, customer_name, cancelled_at)')
      .eq('tracking_number', tracking)
      .eq('status', 'confirmed')
      .eq('delivery_method', 'CJ')

    if (!itemData?.length) {
      setMessage('해당 운송장번호의 검수 대기 상품이 없습니다. (이미 출고됐거나 배정 전)')
      setItems([])
      setOrderInfo(null)
      return
    }

    // 출고 전 취소된 주문 — 검수/출고 진행 자체를 막고 경고만 표시
    if ((itemData[0] as any).orders.cancelled_at) {
      setMessage('⚠️ 취소 주문입니다. 출고하지 마세요.')
      setItems([])
      setOrderInfo(null)
      return
    }

    const order = (itemData[0] as any).orders
    setOrderInfo({ id: order.id, cafe24_order_no: order.cafe24_order_no, customer_name: order.customer_name, tracking_number: tracking })
    setItems(itemData.map(({ orders, ...rest }: any) => rest))
    setMessage('')
    setTimeout(() => barcodeRef.current?.focus(), 100)
  }

  async function loadInvoice(e: React.FormEvent) {
    e.preventDefault()
    if (!invoiceNo.trim()) return
    await loadByTracking(parseInvoiceNo(invoiceNo))
  }

  // 상품별 배송방법 카운트 + 상태를 배송중으로 바꾸고 카페24에 배송중 전환 요청
  async function shipItems(targetItems: InspectItem[], orderNo: string, trackingNo: string) {
    for (const i of targetItems) {
      supabase.rpc('increment_ship_count', {
        p_code: i.product_code,
        p_method: i.delivery_method ?? 'CJ',
        p_qty: i.quantity,
      }).then(() => {})
    }
    await supabase.from('order_items')
      .update({ status: 'in_transit', shipped_at: new Date().toISOString(), shipped_by: staffName || null })
      .in('id', targetItems.map(i => i.id))
    try {
      const itemCodes = targetItems.map(i => i.cafe24_item_code).filter(Boolean) as string[]
      const res = await fetch('/api/cafe24/shipments?action=transit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: [{ order_no: orderNo, item_codes: itemCodes, tracking_no: trackingNo }] }),
      })
      const result = await res.json()
      if (result.errors?.length) {
        setMessage(`카페24 배송중 전환 실패: ${result.errors[0]}`)
      }
    } catch {
      setMessage('카페24 배송중 전환 실패: 네트워크 오류')
    }
    if (staffName) {
      postMemoToCafe24(orderNo, `출고 검수 담당자 : ${staffName}`)
    }
    loadPending()
  }

  useEffect(() => {
    if (done && orderInfo) {
      shipItems(items, orderInfo.cafe24_order_no, orderInfo.tracking_number).then(() => {
        setTimeout(() => {
          setDone(false)
          setItems([])
          setOrderInfo(null)
          setInvoiceNo('')
          setMessage('')
          invoiceRef.current?.focus()
        }, 2000)
      })
    }
  }, [done])

  // 매장 재고 부족 등으로 일부만 검수됐을 때, 그 완료분만 먼저 배송중 처리
  async function shipCompletedOnly() {
    if (!orderInfo) return
    const completed = items.filter(i => i.inspected_qty >= i.quantity)
    if (!completed.length) return
    const remaining = items.length - completed.length
    if (!confirm(`검수 완료된 ${completed.length}건만 배송중으로 처리합니다. 나머지 ${remaining}건은 검수 대기로 남습니다. 진행할까요?`)) return

    await shipItems(completed, orderInfo.cafe24_order_no, orderInfo.tracking_number)
    const completedIds = new Set(completed.map(i => i.id))
    setItems(prev => prev.filter(i => !completedIds.has(i.id)))
    setMessage('')
  }

  // 일부 상품이 품절 등으로 준비가 안 될 때, 이 운송장 전체(검수 진행분 포함)를 보류로 이동
  // — 배치 현황에서 상품마다 따로 누를 필요 없이 여기서 한 번에 처리
  async function moveAllToHold() {
    if (!orderInfo || !holdBatchId) return
    if (!confirm(`이 운송장의 상품 ${items.length}건을 전부 보류로 이동할까요? (검수 진행 상황은 그대로 유지됩니다)`)) return

    await supabase.from('order_items')
      .update({ batch_id: holdBatchId })
      .in('id', items.map(i => i.id))

    loadPending()
    setItems([])
    setOrderInfo(null)
    setInvoiceNo('')
    setMessage('')
    invoiceRef.current?.focus()
  }

  async function handleBarcodeScan(e: React.FormEvent) {
    e.preventDefault()
    if (!barcode.trim() || !items.length) return

    const scanned = barcode.trim()
    setBarcode('')

    const { data: bcData } = await supabase
      .from('barcodes')
      .select('product_code')
      .eq('barcode', scanned)
      .single()

    if (bcData) {
      const matched = items.find(i => i.product_code === bcData.product_code)
      if (!matched) {
        setMessage(`중복 바코드 또는 잘못 등록된 바코드입니다. (DB: ${bcData.product_code})`)
      } else {
        await countUp(bcData.product_code)
      }
    } else {
      setModal({ barcode: scanned, candidates: items.filter(i => i.inspected_qty < i.quantity) })
    }

    barcodeRef.current?.focus()
  }

  // 검수 수량을 직접 지정 — 바코드 스캔(countUp)과 텍스트박스 수동 입력이 둘 다 이걸 씀
  async function setInspectedQty(itemId: string, rawQty: number) {
    const target = items.find(i => i.id === itemId)
    if (!target) return
    const newQty = Math.max(0, Math.min(rawQty, target.quantity))
    if (newQty === target.inspected_qty) return

    await supabase.from('order_items').update({ inspected_qty: newQty }).eq('id', itemId)

    const updated = items.map(i => i.id === itemId ? { ...i, inspected_qty: newQty } : i)
    setItems(updated)
    setMessage('')

    if (updated.every(i => i.inspected_qty >= i.quantity)) {
      setDone(true)
    }
  }

  async function countUp(productCode: string) {
    const target = items.find(i => i.product_code === productCode)
    if (!target) {
      setMessage(`현재 주문에 없는 상품입니다. (${productCode})`)
      return
    }
    if (target.inspected_qty >= target.quantity) {
      setMessage(`이미 수량이 완료된 상품입니다. (${target.product_name})`)
      return
    }
    await setInspectedQty(target.id, target.inspected_qty + 1)
  }

  async function registerBarcode(item: InspectItem) {
    if (!modal) return

    // 같은 상품의 바코드 없는 행(로케이션 전용)이 있으면 그 행에 채움
    const { data: existingRows } = await supabase
      .from('barcodes')
      .select('id, barcode')
      .eq('product_code', item.product_code)
    const emptyRow = existingRows?.find(r => !r.barcode)

    if (emptyRow) {
      await supabase.from('barcodes')
        .update({ barcode: modal.barcode, product_name: item.product_name })
        .eq('id', emptyRow.id)
    } else {
      await supabase.from('barcodes').upsert({
        barcode: modal.barcode,
        product_code: item.product_code,
        product_name: item.product_name,
      }, { onConflict: 'barcode' })
    }

    setModal(null)
    await countUp(item.product_code)
  }

  const allDone = items.length > 0 && items.every(i => i.inspected_qty >= i.quantity)

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">출고 검수</h2>
        <div className="flex items-center gap-2">
          {pendingList.length > 0 && (
            <button
              onClick={() => setShowPending(v => !v)}
              className="text-sm text-gray-500 hover:text-gray-800 px-3 py-1.5 rounded-lg border hover:bg-gray-50"
            >
              잔여 <span className="font-bold text-blue-600">{pendingList.length}</span>건
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-400 mb-4">
        배치 현황에서 운송장 업로드 후, 운송장번호를 스캔해 상품을 검수합니다.
      </p>

      {/* 잔여 주문 목록 */}
      {showPending && (
        <div className="bg-white rounded-xl border mb-4 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">잔여 주문 목록</span>
            <button onClick={() => setShowPending(false)} className="text-gray-400 hover:text-gray-600 text-xs">닫기</button>
          </div>
          <div className="divide-y max-h-64 overflow-y-auto">
            {pendingList.map(p => (
              <button
                key={p.tracking_number}
                onClick={() => {
                  setInvoiceNo(p.tracking_number)
                  setShowPending(false)
                  loadByTracking(p.tracking_number)
                }}
                className="w-full text-left px-4 py-3 hover:bg-blue-50 flex items-center justify-between"
              >
                <div>
                  <span className="text-sm font-medium text-gray-800">{p.customer_name}</span>
                  <span className="text-xs font-mono text-gray-400 ml-2">{p.tracking_number}</span>
                </div>
                <span className="text-xs text-gray-400">{p.item_count}종 / {p.ea_count}EA</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 운송장 입력 */}
      <form onSubmit={loadInvoice} className="bg-white rounded-xl border p-4 mb-4 flex gap-2">
        <input
          ref={invoiceRef}
          value={invoiceNo}
          onChange={e => setInvoiceNo(e.target.value)}
          placeholder="운송장번호 스캔 또는 입력"
          className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          조회
        </button>
      </form>

      {/* 완료 배너 */}
      {(allDone || done) && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-center">
          <p className="text-green-700 font-bold text-lg">✅ 검수 완료!</p>
          <p className="text-green-600 text-sm mt-1">다음 운송장을 스캔하세요</p>
        </div>
      )}

      {/* 상품 목록 */}
      {items.length > 0 && orderInfo && (
        <div className="bg-white rounded-xl border mb-4 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50">
            <span className="font-medium text-gray-800">{orderInfo.customer_name}</span>
            <span className="text-sm font-mono text-gray-400 ml-3">{orderInfo.tracking_number}</span>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs w-24">브랜드</th>
                <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">상품명 / 옵션</th>
                <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs w-36">공급사 상품명</th>
                <th className="text-center px-3 py-2 font-medium text-gray-500 text-xs w-14">수량</th>
                <th className="text-center px-3 py-2 font-medium text-gray-500 text-xs w-14">검수</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => {
                const complete = item.inspected_qty >= item.quantity
                return (
                  <tr key={item.id} className={`border-b last:border-0 ${complete ? 'bg-green-50' : ''}`}>
                    <td className={`px-3 py-3 text-xs ${complete ? 'text-green-600' : 'text-gray-500'}`}>
                      {item.brand ?? '-'}
                    </td>
                    <td className="px-3 py-3">
                      <div className={`text-sm ${complete ? 'text-green-700 font-medium' : 'text-gray-800'}`}>
                        {item.product_no ? (
                          <a
                            href={`https://rooming.co.kr/product/detail.html?product_no=${item.product_no}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="underline decoration-dotted underline-offset-2"
                          >
                            {item.product_name}
                          </a>
                        ) : (
                          item.product_name
                        )}
                      </div>
                      {item.option_info && (
                        <div className="text-xs text-gray-400 mt-0.5">{item.option_info}</div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-xs text-gray-400 leading-tight">{item.supplier_name ?? '-'}</div>
                    </td>
                    <td className="text-center px-3 py-3 text-gray-600 text-sm">{item.quantity}</td>
                    <td className="text-center px-3 py-3">
                      {/* 바코드 스캔하면 이 값이 자동으로 올라가고, 대량 수량은 직접 타이핑해서
                          입력해도 됨 — 수량 맞으면 자동으로 초록색(완료) 처리 */}
                      <input
                        type="number"
                        min={0}
                        max={item.quantity}
                        value={item.inspected_qty}
                        onChange={e => setInspectedQty(item.id, Number(e.target.value))}
                        className={`w-14 text-center text-sm font-bold rounded border py-1 focus:outline-none focus:ring-2 focus:ring-blue-400 ${
                          complete
                            ? 'text-green-600 border-green-300 bg-green-50'
                            : item.inspected_qty > 0
                              ? 'text-blue-600 border-blue-300'
                              : 'text-gray-400 border-gray-200'
                        }`}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 바코드 입력 */}
      {items.length > 0 && !allDone && (
        <form onSubmit={handleBarcodeScan} className="bg-white rounded-xl border p-4 flex gap-2">
          <input
            ref={barcodeRef}
            value={barcode}
            onChange={e => setBarcode(e.target.value)}
            placeholder="바코드 스캔"
            inputMode="numeric"
            pattern="[0-9]*"
            className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800"
          >
            입력
          </button>
        </form>
      )}

      {/* 매장 재고 부족 등으로 일부만 검수됐을 때, 완료분만 먼저 출고 */}
      {items.length > 0 && !allDone && items.some(i => i.inspected_qty >= i.quantity) && (
        <button
          onClick={shipCompletedOnly}
          className="w-full mt-3 py-2.5 rounded-lg text-sm font-medium border border-blue-200 text-blue-600 bg-blue-50 hover:bg-blue-100"
        >
          검수 완료분만 배송중 처리 ({items.filter(i => i.inspected_qty >= i.quantity).length}건)
        </button>
      )}

      {/* 일부 상품 품절 등으로 준비가 안 될 때, 이 운송장 전체를 보류로 이동 */}
      {items.length > 0 && !allDone && (
        <button
          onClick={moveAllToHold}
          disabled={!holdBatchId}
          className="w-full mt-2 py-2.5 rounded-lg text-sm font-medium border border-amber-200 text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-50"
        >
          이 운송장 전체 보류로 이동
        </button>
      )}

      {message && (
        <p className="mt-3 text-sm text-red-500">{message}</p>
      )}

      {/* 미등록 바코드 모달 */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h3 className="font-bold text-gray-800 mb-1">미등록 바코드</h3>
            <p className="text-sm font-mono text-gray-500 mb-4">{modal.barcode}</p>
            <p className="text-sm text-gray-600 mb-3">어떤 상품인가요?</p>
            <div className="space-y-2 mb-4 max-h-72 overflow-y-auto">
              {modal.candidates.map(item => (
                <button
                  key={item.id}
                  onClick={() => registerBarcode(item)}
                  className="w-full text-left px-4 py-3 rounded-xl border hover:bg-blue-50 hover:border-blue-300 transition-colors"
                >
                  <p className="font-medium text-gray-800 text-sm">{item.product_name}</p>
                  {item.option_info && <p className="text-xs text-blue-500 mt-0.5">{item.option_info}</p>}
                  <p className="text-xs text-gray-400 font-mono mt-0.5">{item.product_code}</p>
                </button>
              ))}
            </div>
            <button
              onClick={() => setModal(null)}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
