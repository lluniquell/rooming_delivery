import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

interface Order {
  id: string
  cafe24_order_id: string
  customer_name: string
  order_date: string | null
  item_count: number
}

interface Batch {
  id: string
  batch_no: string
  name: string
  type: string
}

const DELIVERY_METHODS = ['CJ', '배송팀', '문종철', '경동', '팀무버']

export default function SoumOrders() {
  const [orders, setOrders] = useState<Order[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collecting, setCollecting] = useState(false)
  const [collectMsg, setCollectMsg] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [assignBatchId, setAssignBatchId] = useState('')
  const [assignMethod, setAssignMethod] = useState('CJ')

  useEffect(() => {
    loadOrders()
    loadBatches()
  }, [])

  async function loadOrders() {
    const { data } = await supabase
      .from('orders')
      .select('id, cafe24_order_id, customer_name, order_date, order_items(count)')
      .eq('status', 'collected')
      .is('batch_id', null)
      .order('order_date', { ascending: false })
    setOrders(
      (data ?? []).map((o: any) => ({
        id: o.id,
        cafe24_order_id: o.cafe24_order_id,
        customer_name: o.customer_name,
        order_date: o.order_date,
        item_count: o.order_items?.[0]?.count ?? 0,
      }))
    )
  }

  async function loadBatches() {
    const { data } = await supabase
      .from('batches')
      .select('*')
      .neq('type', 'hold')
      .order('batch_no')
    setBatches(data ?? [])
    if (data?.length) setAssignBatchId(data[0].id)
  }

  async function collect() {
    setCollecting(true)
    setCollectMsg('')
    try {
      const res = await fetch('/api/cafe24/collect', { method: 'POST' })
      const data = await res.json()
      if (data.error) {
        setCollectMsg(`오류: ${data.error}`)
      } else if (data.collected === 0) {
        setCollectMsg(data.message ?? '새 주문이 없습니다.')
      } else {
        setCollectMsg(`✅ ${data.collected}건 수집 (기존 ${data.skipped}건 제외)`)
        loadOrders()
      }
    } catch {
      setCollectMsg('네트워크 오류')
    }
    setCollecting(false)
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(selected.size === orders.length ? new Set() : new Set(orders.map(o => o.id)))
  }

  async function confirmAssign() {
    await supabase.from('orders').update({
      batch_id: assignBatchId,
      delivery_method: assignMethod,
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
    }).in('id', [...selected])
    setSelected(new Set())
    setShowModal(false)
    loadOrders()
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800">주문 수집</h2>
        <div className="flex items-center gap-3">
          {collectMsg && <span className="text-sm text-gray-500">{collectMsg}</span>}
          <button
            onClick={collect}
            disabled={collecting}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {collecting ? '수집 중...' : '카페24 주문 수집'}
          </button>
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="bg-white rounded-xl border p-16 text-center text-gray-400 text-sm">
          미배정 주문이 없습니다
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selected.size === orders.length && orders.length > 0}
                onChange={toggleAll}
                className="rounded"
              />
              전체 선택 ({orders.length}건)
            </label>
            {selected.size > 0 && (
              <button
                onClick={() => setShowModal(true)}
                className="bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-700"
              >
                {selected.size}건 배치 배정
              </button>
            )}
          </div>

          <table className="w-full text-sm">
            <thead className="border-b">
              <tr className="bg-gray-50">
                <th className="w-10 px-4 py-2" />
                <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">주문번호</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">수령인</th>
                <th className="text-center px-4 py-2 font-medium text-gray-500 text-xs">품목</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">주문일</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(order => (
                <tr
                  key={order.id}
                  onClick={() => toggle(order.id)}
                  className={`border-b last:border-0 cursor-pointer transition-colors ${
                    selected.has(order.id) ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(order.id)}
                      onChange={() => toggle(order.id)}
                      onClick={e => e.stopPropagation()}
                      className="rounded"
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{order.cafe24_order_id}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{order.customer_name}</td>
                  <td className="px-4 py-3 text-center text-gray-500">{order.item_count}종</td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {order.order_date ? new Date(order.order_date).toLocaleDateString('ko-KR') : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h3 className="font-bold text-gray-800 mb-5">배치 배정 ({selected.size}건)</h3>

            <div className="mb-4">
              <p className="text-xs font-medium text-gray-500 mb-2">배치</p>
              <div className="flex flex-wrap gap-2">
                {batches.map(b => (
                  <button
                    key={b.id}
                    onClick={() => setAssignBatchId(b.id)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      assignBatchId === b.id
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'text-gray-600 border-gray-300 hover:border-indigo-400'
                    }`}
                  >
                    {b.batch_no}번 {b.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-6">
              <p className="text-xs font-medium text-gray-500 mb-2">배송 방법</p>
              <div className="flex flex-wrap gap-2">
                {DELIVERY_METHODS.map(m => (
                  <button
                    key={m}
                    onClick={() => setAssignMethod(m)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      assignMethod === m
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'text-gray-600 border-gray-300 hover:border-blue-400'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 py-2 text-sm text-gray-500 border rounded-lg hover:bg-gray-50"
              >
                취소
              </button>
              <button
                onClick={confirmAssign}
                className="flex-1 py-2 text-sm text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 font-medium"
              >
                확정
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
