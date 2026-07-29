import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { compressImage } from '../../lib/photo'

interface OrderItem {
  id: string
  product_name: string
  option_info: string | null
  quantity: number
  cafe24_item_code: string | null
}

interface OrderStop {
  id: string
  cafe24_order_no: string
  customer_name: string
  address: string
  receiver_phone: string | null
  delivered_at: string | null
  delivery_memo: string | null
  items: OrderItem[]
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
  const [photoTaken, setPhotoTaken] = useState<Set<string>>(new Set())
  const [uploadingItemId, setUploadingItemId] = useState<string | null>(null)
  const [memo, setMemo] = useState('')
  const [processing, setProcessing] = useState(false)
  const [showFailForm, setShowFailForm] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!id) return
    async function load() {
      const { data: o } = await supabase
        .from('orders')
        .select('id, cafe24_order_no, customer_name, receiver_name, receiver_phone, address, delivered_at, delivery_memo')
        .eq('id', id)
        .single()
      if (!o) return
      const { data: items } = await supabase
        .from('order_items')
        .select('id, product_name, option_info, quantity, cafe24_item_code')
        .eq('order_id', id)
      setOrder({
        id: o.id,
        cafe24_order_no: o.cafe24_order_no,
        customer_name: o.receiver_name || o.customer_name,
        address: o.address,
        receiver_phone: o.receiver_phone,
        delivered_at: o.delivered_at,
        delivery_memo: o.delivery_memo,
        items: items ?? [],
      })

      // 앱을 도중에 나갔다 다시 들어온 경우를 대비해 이미 찍은 사진은 미리 체크 표시
      const { data: photos } = await supabase
        .from('delivery_photos')
        .select('order_item_id')
        .eq('order_id', id)
        .not('order_item_id', 'is', null)
      setPhotoTaken(new Set((photos ?? []).map((p: any) => p.order_item_id)))
    }
    load()
  }, [id])

  async function handleItemPhoto(item: OrderItem, file: File) {
    if (!order) return
    setUploadingItemId(item.id)
    try {
      const compressed = await compressImage(file)
      const path = `${order.id}/${item.id}/${Date.now()}.jpg`
      const { error: uploadError } = await supabase.storage.from('delivery-photos').upload(path, compressed)
      if (uploadError) { alert(`사진 업로드 실패: ${uploadError.message}`); return }
      const { error: insertError } = await supabase.from('delivery_photos').insert({ order_id: order.id, order_item_id: item.id, storage_path: path })
      if (insertError) { alert(`사진 저장 실패: ${insertError.message}`); return }
      setPhotoTaken(prev => new Set([...prev, item.id]))
    } finally {
      setUploadingItemId(null)
    }
  }

  async function handleDone() {
    if (!order) return
    setProcessing(true)
    setMessage('')

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const invoiceNo = `직배${today}`

    await supabase.from('orders').update({
      delivered_at: new Date().toISOString(),
      tracking_number: invoiceNo,
    }).eq('id', order.id)

    // 카페24 배송중 전환 — 실패해도 로컬 완료 처리는 유지 (나중에 수동 확인 필요)
    try {
      const itemCodes = order.items.map(i => i.cafe24_item_code).filter(Boolean) as string[]
      if (itemCodes.length) {
        const res = await fetch('/api/cafe24/shipments?action=transit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orders: [{ order_no: order.cafe24_order_no, item_codes: itemCodes, tracking_no: invoiceNo }] }),
        })
        const result = await res.json()
        if (result.errors?.length) {
          setMessage(`카페24 배송중 전환 실패: ${result.errors[0]}`)
        }
      }
    } catch {
      setMessage('카페24 배송중 전환 중 네트워크 오류가 발생했습니다.')
    }

    // 채널톡 알림 — 실패해도 배송 완료 처리 자체는 이미 끝난 상태라 조용히 넘어감
    try {
      await fetch('/api/channeltalk/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: order.id }),
      })
    } catch { /* 알림 실패는 배송 완료 처리에 영향 없음 */ }

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
  const allPhotographed = order.items.length > 0 && order.items.every(i => photoTaken.has(i.id))

  return (
    <div>
      <button onClick={() => navigate('/')} className="text-sm text-blue-600 mb-4">← 목록으로</button>

      <div className="bg-white rounded-xl border p-5 mb-4">
        <h2 className="font-bold text-lg mb-3">{order.customer_name}</h2>
        <p className="text-gray-600 text-sm mb-4">{order.address}</p>
        <div className="flex gap-2 mb-2">
          <a href={links.tmap} className="flex-1 text-center bg-blue-50 text-blue-700 py-2 rounded-lg text-sm font-medium">
            티맵으로 열기
          </a>
          <a href={links.naver} className="flex-1 text-center bg-green-50 text-green-700 py-2 rounded-lg text-sm font-medium">
            네이버지도
          </a>
        </div>
        {order.receiver_phone && (
          <div className="flex gap-2 mb-4">
            <a href={`tel:${order.receiver_phone}`} className="flex-1 text-center bg-gray-100 text-gray-700 py-2 rounded-lg text-sm font-medium">
              📞 전화
            </a>
            <a href={`sms:${order.receiver_phone}`} className="flex-1 text-center bg-gray-100 text-gray-700 py-2 rounded-lg text-sm font-medium">
              💬 문자
            </a>
          </div>
        )}

        <div className="border-t pt-4">
          <p className="text-sm font-medium text-gray-700 mb-2">
            상품별 완료 사진 {pending && <span className="text-gray-400 font-normal">({photoTaken.size}/{order.items.length})</span>}
          </p>
          <ul className="space-y-2">
            {order.items.map(item => {
              const done = photoTaken.has(item.id)
              const uploading = uploadingItemId === item.id
              return (
                <li
                  key={item.id}
                  className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border ${done ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}
                >
                  <div className="text-sm min-w-0">
                    <div className={done ? 'text-green-700 font-medium' : 'text-gray-800'}>
                      {item.product_name}
                      {item.option_info && <span className="text-gray-400 ml-1">({item.option_info})</span>}
                    </div>
                    <div className="text-xs text-gray-400">x{item.quantity}</div>
                  </div>
                  {done ? (
                    <span className="text-green-600 text-xl shrink-0">✓</span>
                  ) : pending ? (
                    <label className="shrink-0 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium cursor-pointer">
                      {uploading ? '업로드 중...' : '사진 촬영'}
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        disabled={uploading}
                        onChange={e => {
                          const file = e.target.files?.[0]
                          if (file) handleItemPhoto(item, file)
                        }}
                      />
                    </label>
                  ) : (
                    <span className="text-gray-300 text-xs shrink-0">미촬영</span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>

      {message && <p className="text-sm text-red-500 mb-3">{message}</p>}

      {pending && (
        <div className="space-y-3">
          <button
            onClick={handleDone}
            disabled={processing || !allPhotographed}
            className="w-full bg-green-600 text-white py-3 rounded-xl font-medium text-lg hover:bg-green-700 disabled:opacity-50"
          >
            {processing ? '처리 중...' : allPhotographed ? '배송 완료' : `상품 사진을 모두 찍어주세요 (${photoTaken.size}/${order.items.length})`}
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
