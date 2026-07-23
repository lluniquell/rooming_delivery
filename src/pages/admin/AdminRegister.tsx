import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { DeliveryItem } from '../../types'

interface Cafe24Item {
  product_no: string
  product_name: string
  quantity: number
  option_info?: string
  selected: boolean
}

interface OrderResult {
  orderNo: string
  customerName: string
  address: string
  items: Cafe24Item[]
}

export default function AdminRegister() {
  const [orderNos, setOrderNos] = useState('')
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().slice(0, 10))
  const [results, setResults] = useState<OrderResult[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  async function fetchOrders() {
    setLoading(true)
    setMessage('')
    const nos = orderNos.split('\n').map(s => s.trim()).filter(Boolean)

    const fetched: OrderResult[] = await Promise.all(
      nos.map(async (no) => {
        const res = await fetch(`/api/cafe24/collect?order_no=${no}`)
        if (!res.ok) return { orderNo: no, customerName: '조회 실패', address: '', items: [] }
        const data = await res.json()
        return {
          orderNo: no,
          customerName: data.customer_name,
          address: data.address,
          items: (data.items ?? []).map((item: DeliveryItem) => ({ ...item, selected: false })),
        }
      })
    )
    setResults(fetched)
    setLoading(false)
  }

  function toggleItem(orderNo: string, productNo: string) {
    setResults(prev => prev.map(r =>
      r.orderNo !== orderNo ? r : {
        ...r,
        items: r.items.map(i => i.product_no === productNo ? { ...i, selected: !i.selected } : i),
      }
    ))
  }

  async function saveSelected() {
    setSaving(true)
    setMessage('')
    const rows = results.flatMap(r => {
      const selected = r.items.filter(i => i.selected)
      if (!selected.length) return []
      return [{
        cafe24_order_no: r.orderNo,
        customer_name: r.customerName,
        address: r.address,
        items: selected.map(({ selected: _, ...rest }) => rest),
        scheduled_date: scheduledDate,
        status: 'pending',
      }]
    })

    if (!rows.length) { setMessage('선택된 상품이 없습니다.'); setSaving(false); return }

    const { error } = await supabase.from('deliveries').insert(rows)
    if (error) setMessage(`저장 실패: ${error.message}`)
    else {
      setMessage(`${rows.length}건 등록 완료!`)
      setResults([])
      setOrderNos('')
    }
    setSaving(false)
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-gray-800 mb-6">주문 등록</h2>

      <div className="bg-white rounded-xl border p-6 mb-6">
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">카페24 주문번호 (줄바꿈으로 여러 건 입력)</label>
          <textarea
            value={orderNos}
            onChange={e => setOrderNos(e.target.value)}
            rows={4}
            placeholder="20240001&#10;20240002"
            className="w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex items-center gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">배송 예정일</label>
            <input
              type="date"
              value={scheduledDate}
              onChange={e => setScheduledDate(e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm"
            />
          </div>
          <button
            onClick={fetchOrders}
            disabled={loading || !orderNos.trim()}
            className="mt-5 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? '조회 중...' : '주문 조회'}
          </button>
        </div>
      </div>

      {results.map(r => (
        <div key={r.orderNo} className="bg-white rounded-xl border p-6 mb-4">
          <div className="mb-3">
            <span className="font-mono text-sm text-gray-500">{r.orderNo}</span>
            <span className="ml-3 font-medium">{r.customerName}</span>
            <span className="ml-2 text-sm text-gray-500">{r.address}</span>
          </div>
          <div className="space-y-2">
            {r.items.map(item => (
              <label key={item.product_no} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={item.selected}
                  onChange={() => toggleItem(r.orderNo, item.product_no)}
                  className="w-4 h-4"
                />
                <span className="text-sm">{item.product_name}</span>
                {item.option_info && <span className="text-xs text-gray-400">{item.option_info}</span>}
                <span className="text-sm text-gray-500">x{item.quantity}</span>
              </label>
            ))}
          </div>
        </div>
      ))}

      {results.length > 0 && (
        <div className="flex items-center gap-4">
          <button
            onClick={saveSelected}
            disabled={saving}
            className="bg-green-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? '저장 중...' : '선택 항목 등록'}
          </button>
          {message && <span className="text-sm text-gray-600">{message}</span>}
        </div>
      )}
    </div>
  )
}
