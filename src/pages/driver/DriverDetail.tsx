import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

interface OrderItem {
  product_name: string
  option_info: string | null
  quantity: number
}

interface OrderStop {
  id: string
  customer_name: string
  address: string
  delivered_at: string | null
  delivery_memo: string | null
  items: OrderItem[]
}

function compressImage(file: File): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const maxW = 800
      const scale = Math.min(1, maxW / img.width)
      canvas.width = img.width * scale
      canvas.height = img.height * scale
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(blob => resolve(blob!), 'image/jpeg', 0.7)
      URL.revokeObjectURL(url)
    }
    img.src = url
  })
}

function mapDeeplink(address: string) {
  const encoded = encodeURIComponent(address)
  return {
    tmap: `tmap://search?name=${encoded}`,
    naver: `nmap://search?query=${encoded}&appname=com.rooming.delivery`,
  }
}

export default function DriverDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [order, setOrder] = useState<OrderStop | null>(null)
  const [memo, setMemo] = useState('')
  const [processing, setProcessing] = useState(false)
  const [showFailForm, setShowFailForm] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!id) return
    async function load() {
      const { data: o } = await supabase
        .from('orders')
        .select('id, customer_name, receiver_name, address, delivered_at, delivery_memo')
        .eq('id', id)
        .single()
      if (!o) return
      const { data: items } = await supabase
        .from('order_items')
        .select('product_name, option_info, quantity')
        .eq('order_id', id)
      setOrder({
        id: o.id,
        customer_name: o.receiver_name || o.customer_name,
        address: o.address,
        delivered_at: o.delivered_at,
        delivery_memo: o.delivery_memo,
        items: items ?? [],
      })
    }
    load()
  }, [id])

  async function handleDone() {
    if (!order) return
    setProcessing(true)

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const invoiceNo = `직배${today}`

    const file = fileRef.current?.files?.[0]
    if (file) {
      const compressed = await compressImage(file)
      const path = `${order.id}/${Date.now()}.jpg`
      await supabase.storage.from('delivery-photos').upload(path, compressed)
      await supabase.from('delivery_photos').insert({ order_id: order.id, storage_path: path })
    }

    await supabase.from('orders').update({
      delivered_at: new Date().toISOString(),
      tracking_number: invoiceNo,
    }).eq('id', order.id)

    setProcessing(false)
    navigate('/')
  }

  async function handleFail() {
    if (!order || !memo.trim()) return
    setProcessing(true)
    await supabase.from('orders').update({ delivery_memo: memo }).eq('id', order.id)
    setProcessing(false)
    navigate('/')
  }

  if (!order) return <div className="py-12 text-center text-gray-400">불러오는 중...</div>

  const links = mapDeeplink(order.address)
  const pending = !order.delivered_at && !order.delivery_memo

  return (
    <div>
      <button onClick={() => navigate('/')} className="text-sm text-blue-600 mb-4">← 목록으로</button>

      <div className="bg-white rounded-xl border p-5 mb-4">
        <h2 className="font-bold text-lg mb-3">{order.customer_name}</h2>
        <p className="text-gray-600 text-sm mb-4">{order.address}</p>
        <div className="flex gap-2 mb-4">
          <a href={links.tmap} className="flex-1 text-center bg-blue-50 text-blue-700 py-2 rounded-lg text-sm font-medium">
            티맵으로 열기
          </a>
          <a href={links.naver} className="flex-1 text-center bg-green-50 text-green-700 py-2 rounded-lg text-sm font-medium">
            네이버지도
          </a>
        </div>

        <div className="border-t pt-4">
          <p className="text-sm font-medium text-gray-700 mb-2">상품 목록</p>
          <ul className="space-y-1">
            {order.items.map((item, i) => (
              <li key={i} className="text-sm text-gray-600">
                {item.product_name} {item.option_info && <span className="text-gray-400">({item.option_info})</span>} x{item.quantity}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {pending && (
        <div className="space-y-3">
          <div className="bg-white rounded-xl border p-4">
            <p className="text-sm font-medium text-gray-700 mb-2">완료 사진 (선택)</p>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="text-sm" />
          </div>
          <button
            onClick={handleDone}
            disabled={processing}
            className="w-full bg-green-600 text-white py-3 rounded-xl font-medium text-lg hover:bg-green-700 disabled:opacity-50"
          >
            {processing ? '처리 중...' : '배송 완료'}
          </button>

          {!showFailForm ? (
            <button
              onClick={() => setShowFailForm(true)}
              className="w-full bg-gray-100 text-gray-600 py-3 rounded-xl font-medium"
            >
              배송 불가
            </button>
          ) : (
            <div className="bg-white rounded-xl border p-4 space-y-3">
              <textarea
                value={memo}
                onChange={e => setMemo(e.target.value)}
                placeholder="불가 사유를 입력하세요"
                rows={3}
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
              <button
                onClick={handleFail}
                disabled={processing || !memo.trim()}
                className="w-full bg-red-500 text-white py-2 rounded-lg font-medium disabled:opacity-50"
              >
                불가 처리
              </button>
            </div>
          )}
        </div>
      )}

      {!pending && (
        <div className={`rounded-xl p-4 text-center font-medium ${order.delivered_at ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {order.delivered_at ? '배송 완료' : `배송 불가: ${order.delivery_memo}`}
        </div>
      )}
    </div>
  )
}
