import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

interface Order {
  id: string
  cafe24_order_no: string
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

const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

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
  const [orders, setOrders] = useState<Order[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collecting, setCollecting] = useState(false)
  const [collectMsg, setCollectMsg] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [assignBatchId, setAssignBatchId] = useState('')
  const [assignMethod, setAssignMethod] = useState('CJ')
  const [startDate, setStartDate] = useState(daysAgo(180))
  const [endDate, setEndDate] = useState(today())
  const [activePreset, setActivePreset] = useState('6개월')

  function applyPreset(preset: typeof PRESETS[0]) {
    setStartDate(preset.start())
    setEndDate(preset.end ? preset.end() : today())
    setActivePreset(preset.label)
  }

  useEffect(() => {
    loadOrders()
    loadBatches()
  }, [])

  async function loadOrders() {
    const { data } = await supabase
      .from('orders')
      .select('id, cafe24_order_no, customer_name, order_date, order_items(count)')
      .eq('status', 'collected')
      .is('batch_id', null)
      .order('order_date', { ascending: false })
    setOrders(
      (data ?? []).map((o: any) => ({
        id: o.id,
        cafe24_order_no: o.cafe24_order_no,
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
      const res = await fetch('/api/cafe24/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      })
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
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{order.cafe24_order_no}</td>
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
