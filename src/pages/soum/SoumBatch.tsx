import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

interface Batch {
  id: string
  batch_no: string
  name: string
  type: string
  order_count: number
}

interface OrderItem {
  product_code: string
  product_name: string
  option_info: string | null
  brand: string | null
  supplier_name: string | null
  quantity: number
}

interface Order {
  id: string
  cafe24_order_no: string
  customer_name: string
  delivery_method: string | null
  tracking_number: string | null
  status: string
  order_items: OrderItem[]
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
  const [orders, setOrders] = useState<Order[]>([])
  const [showPicking, setShowPicking] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadBatches() }, [])

  async function loadBatches() {
    const { data: batchData } = await supabase.from('batches').select('*').order('batch_no')
    if (!batchData) return

    const { data: orderData } = await supabase
      .from('orders')
      .select('batch_id')
      .in('status', ['confirmed', 'in_transit'])

    const countMap: Record<string, number> = {}
    for (const o of orderData ?? []) {
      if (o.batch_id) countMap[o.batch_id] = (countMap[o.batch_id] ?? 0) + 1
    }

    setBatches(batchData.map(b => ({ ...b, order_count: countMap[b.id] ?? 0 })))
  }

  async function selectBatch(batchId: string) {
    setActiveBatchId(batchId)
    setShowPicking(false)
    setLoading(true)
    const { data } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('batch_id', batchId)
      .in('status', ['confirmed', 'in_transit'])
      .order('order_date', { ascending: true })
    setOrders(data ?? [])
    setLoading(false)
  }

  async function moveToHold(orderId: string) {
    const { data: holdBatch } = await supabase.from('batches').select('id').eq('type', 'hold').single()
    if (!holdBatch) return
    await supabase.from('orders').update({ batch_id: holdBatch.id }).eq('id', orderId)
    if (activeBatchId) selectBatch(activeBatchId)
    loadBatches()
  }

  function buildPickingList() {
    const merged: Record<string, {
      location: string; brand: string; product_name: string
      option_info: string; supplier_note: string; quantity: number
    }> = {}

    for (const order of orders) {
      for (const item of order.order_items) {
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
    }
    return Object.values(merged).sort((a, b) => a.location.localeCompare(b.location))
  }

  const activeBatch = batches.find(b => b.id === activeBatchId)
  const pickingList = buildPickingList()

  return (
    <div className="max-w-5xl">
      <h2 className="text-xl font-bold text-gray-800 mb-6">배치 현황</h2>

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
              batch.order_count > 0 ? 'text-indigo-600' : 'text-gray-200'
            }`}>
              {batch.order_count}
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
              <span className="text-gray-400 font-normal ml-2 text-sm">{orders.length}건</span>
            </span>
            {orders.length > 0 && (
              <button
                onClick={() => setShowPicking(v => !v)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                  showPicking
                    ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    : 'bg-green-600 text-white hover:bg-green-700'
                }`}
              >
                {showPicking ? '주문 목록' : '픽킹리스트'}
              </button>
            )}
          </div>

          {loading ? (
            <div className="p-12 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : orders.length === 0 ? (
            <div className="p-12 text-center text-gray-400 text-sm">이 배치에 주문이 없습니다</div>
          ) : showPicking ? (
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
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
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">주문번호</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">수령인</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">배송방법</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">운송장</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">상태</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <tr key={order.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{order.cafe24_order_no}</td>
                    <td className="px-4 py-3 font-medium text-gray-800">{order.customer_name}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{order.delivery_method ?? '-'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">{order.tracking_number ?? '-'}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLOR[order.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABEL[order.status] ?? order.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => moveToHold(order.id)}
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
    </div>
  )
}
