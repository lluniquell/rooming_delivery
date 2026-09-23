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
  tracking_number: string | null
  item_note: string | null
}

interface Photo {
  id: string
  storage_path: string
}

interface OrderStop {
  id: string
  cafe24_order_no: string
  customer_name: string
  address: string
  receiver_phone: string | null
  delivered_at: string | null
  delivery_memo: string | null
  schedule_note: string | null
  companionName: string | null
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
  const [driverName, setDriverName] = useState('')
  const [photosByItem, setPhotosByItem] = useState<Record<string, Photo[]>>({})
  const [uploadingItemId, setUploadingItemId] = useState<string | null>(null)
  const [memo, setMemo] = useState('')
  const [processing, setProcessing] = useState(false)
  const [showFailForm, setShowFailForm] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!id) return
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: driverRow } = await supabase.from('drivers').select('name').eq('id', user.id).maybeSingle()
        if (driverRow) setDriverName(driverRow.name)
      }

      const { data: o } = await supabase
        .from('orders')
        .select('id, cafe24_order_no, customer_name, receiver_name, receiver_phone, address, delivered_at, delivery_memo, schedule_note, scheduled_date')
        .eq('id', id)
        .single()
      if (!o) return
      // 카페24 주문 하나에는 이 주문의 전체 이력(예전 교환/취소/CJ로 이미 나간 상품 등)이
      // 다 order_items로 남아있어서, 이번 직배 배송분(delivery_method='직배', 아직
      // 확정~진행중 단계)만 걸러야 함 — 안 그러면 몇 달 전에 이미 끝난 무관한 상품까지
      // 다 같이 나와서 "상품 사진을 모두 찍어주세요"에 안 찍힌 걸로 잡힘(20260227-0000613
      // 발견, 2026-09-23)
      const { data: items } = await supabase
        .from('order_items')
        .select('id, product_name, option_info, quantity, cafe24_item_code, tracking_number, item_note')
        .eq('order_id', id)
        .eq('delivery_method', '직배')
        .in('status', ['confirmed', 'in_transit'])

      // 이 주문이 다른 배송원 루트에 "동행 (주문번호)" 기타 배송지로 붙어있는지 확인 —
      // 원래 담당자도 2인 배송인 걸 상세 화면에서 바로 알 수 있어야 함(2026-09-22)
      let companionName: string | null = null
      if (o.scheduled_date && o.cafe24_order_no) {
        const { data: adhocStops } = await supabase
          .from('schedule_adhoc_stops')
          .select('route_id, reason')
          .eq('date', o.scheduled_date)
          .ilike('reason', `%${o.cafe24_order_no}%`)
        const companionRouteIds = [...new Set((adhocStops ?? []).map(a => a.route_id))]
        if (companionRouteIds.length) {
          const { data: companionRoutes } = await supabase.from('schedule_routes').select('id, driver_ids').in('id', companionRouteIds)
          const companionDriverIds = [...new Set((companionRoutes ?? []).flatMap(r => r.driver_ids as string[]))]
          if (companionDriverIds.length) {
            const { data: driverRows } = await supabase.from('drivers').select('id, name').in('id', companionDriverIds)
            companionName = (driverRows ?? []).map(d => d.name).join('/') || null
          }
        }
      }

      setOrder({
        id: o.id,
        cafe24_order_no: o.cafe24_order_no,
        customer_name: o.receiver_name || o.customer_name,
        address: o.address,
        receiver_phone: o.receiver_phone,
        delivered_at: o.delivered_at,
        delivery_memo: o.delivery_memo,
        schedule_note: o.schedule_note,
        companionName,
        items: items ?? [],
      })

      // 앱을 도중에 나갔다 다시 들어온 경우를 대비해 이미 찍은 사진들을 미리 불러와둠
      const { data: photos } = await supabase
        .from('delivery_photos')
        .select('id, order_item_id, storage_path')
        .eq('order_id', id)
        .not('order_item_id', 'is', null)
      const grouped: Record<string, Photo[]> = {}
      for (const p of photos ?? []) {
        (grouped[p.order_item_id] ??= []).push({ id: p.id, storage_path: p.storage_path })
      }
      setPhotosByItem(grouped)
    }
    load()
  }, [id])

  // 상품 1개에 사진 여러 장 촬영 가능 — 매번 새 파일로 추가만 하고 기존 사진은 안 건드림
  async function handleItemPhoto(item: OrderItem, file: File) {
    if (!order) return
    setUploadingItemId(item.id)
    try {
      const compressed = await compressImage(file)
      const path = `${order.id}/${item.id}/${Date.now()}.jpg`
      const { error: uploadError } = await supabase.storage.from('delivery-photos').upload(path, compressed)
      if (uploadError) { alert(`사진 업로드 실패: ${uploadError.message}`); return }
      const { data: inserted, error: insertError } = await supabase
        .from('delivery_photos')
        .insert({ order_id: order.id, order_item_id: item.id, storage_path: path })
        .select('id')
        .single()
      if (insertError || !inserted) { alert(`사진 저장 실패: ${insertError?.message}`); return }
      setPhotosByItem(prev => ({ ...prev, [item.id]: [...(prev[item.id] ?? []), { id: inserted.id, storage_path: path }] }))
    } finally {
      setUploadingItemId(null)
    }
  }

  // 잘못 찍은 사진 삭제 — 배송원이 직접 다시 찍기 전에 지울 수 있게
  async function handleDeletePhoto(item: OrderItem, photo: Photo) {
    if (!confirm('이 사진을 삭제할까요?')) return
    const { error: dbError } = await supabase.from('delivery_photos').delete().eq('id', photo.id)
    if (dbError) { alert(`사진 삭제 실패: ${dbError.message}`); return }
    await supabase.storage.from('delivery-photos').remove([photo.storage_path])
    setPhotosByItem(prev => ({ ...prev, [item.id]: (prev[item.id] ?? []).filter(p => p.id !== photo.id) }))
  }

  async function handleDone() {
    if (!order) return
    setProcessing(true)
    setMessage('')

    // 운송장번호는 스케줄러 "마감" 때 이미 order_items.tracking_number로 등록해둔 값을
    // 그대로 써야 함 — 여기서 새로 만들면 마감 시점(스케줄 날짜 기준)과 완료 시점(오늘
    // 날짜 기준)이 달라질 때(예: 하루 밀려서 처리) 카페24에 등록된 운송장번호와
    // 어긋나버림. 마감을 거치지 않은 예외적인 경우를 대비해 없으면만 폴백으로 새로 만듦
    const invoiceNo = order.items.find(i => i.tracking_number)?.tracking_number
      ?? `직배${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`

    await supabase.from('orders').update({
      delivered_at: new Date().toISOString(),
    }).eq('id', order.id)

    // order_items.status를 안 바꾸면 배송완료 후에도 계속 'confirmed'로 남아서
    // 주문/배치 화면(SoumOrders/SoumBatch)의 직배 배치에 영원히 남아있게 됨(2026-09-22
    // 발견) — CJ 출고검수(SoumOutgoing)/팀무버 완료 처리와 동일하게 in_transit으로 전환.
    // delivery_method='직배' + status='confirmed'로 좁혀야 이 주문의 예전 이력(이미
    // 다른 방법으로 나갔거나 취소/교환된 상품)까지 같이 안 건드림(2026-09-23)
    await supabase.from('order_items')
      .update({ status: 'in_transit', shipped_at: new Date().toISOString() })
      .eq('order_id', order.id)
      .eq('delivery_method', '직배')
      .eq('status', 'confirmed')

    // 카페24 배송완료 전환 — 실패해도 로컬 완료 처리는 유지 (나중에 수동 확인 필요)
    try {
      const itemCodes = order.items.map(i => i.cafe24_item_code).filter(Boolean) as string[]
      if (itemCodes.length) {
        const res = await fetch('/api/cafe24/shipments?action=transit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orders: [{ order_no: order.cafe24_order_no, item_codes: itemCodes, tracking_no: invoiceNo, status: 'shipped', carrier_code: '0001' }] }),
        })
        const result = await res.json()
        if (result.errors?.length) {
          setMessage(`카페24 배송완료 전환 실패: ${result.errors[0]}`)
        }
      }
    } catch {
      setMessage('카페24 배송완료 전환 중 네트워크 오류가 발생했습니다.')
    }

    // 카페24 어드민 메모에 담당 배송원 이름 남김 — 실패해도 완료 처리엔 영향 없음
    try {
      await fetch('/api/cafe24/shipments?action=memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_no: order.cafe24_order_no, content: `배송 담당자 : ${driverName}` }),
      })
    } catch { /* 메모 등록 실패는 배송 완료 처리에 영향 없음 */ }

    // 채널톡 알림 — 실패해도 배송 완료 처리 자체는 이미 끝난 상태라 조용히 넘어감
    try {
      await fetch('/api/channeltalk/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'order', id: order.id, driver_name: driverName }),
      })
    } catch { /* 알림 실패는 배송 완료 처리에 영향 없음 */ }

    setProcessing(false)
    navigate('/')
  }

  async function handleFail() {
    if (!order || !memo.trim()) return
    setProcessing(true)
    await supabase.from('orders').update({ delivery_memo: memo }).eq('id', order.id)

    // 채널톡 물류팀-이슈사항 알림 — 실패해도 배송 불가 처리 자체는 이미 끝난 상태라 조용히 넘어감
    try {
      await fetch('/api/channeltalk/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'fail', id: order.id, driver_name: driverName, memo }),
      })
    } catch { /* 알림 실패는 배송 불가 처리에 영향 없음 */ }

    setProcessing(false)
    navigate('/')
  }

  if (!order) return <div className="py-12 text-center text-gray-400">불러오는 중...</div>

  const links = mapDeeplink(order.address)
  const pending = !order.delivered_at && !order.delivery_memo
  const photographedCount = order.items.filter(i => (photosByItem[i.id]?.length ?? 0) > 0).length
  const allPhotographed = order.items.length > 0 && photographedCount === order.items.length

  return (
    <div>
      <button onClick={() => navigate('/')} className="text-sm text-blue-600 mb-4">← 목록으로</button>

      <div className="bg-white rounded-xl border p-5 mb-4">
        <h2 className="font-bold text-lg mb-3">{order.customer_name}</h2>
        <p className="text-gray-600 text-sm mb-4">{order.address}</p>
        {order.schedule_note && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4 text-sm text-amber-800">
            {order.schedule_note}
          </div>
        )}
        {order.companionName && (
          <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 mb-4 text-sm text-purple-700">
            동행: {order.companionName}
          </div>
        )}
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
            상품별 완료 사진 {pending && <span className="text-gray-400 font-normal">({photographedCount}/{order.items.length})</span>}
          </p>
          <ul className="space-y-2">
            {order.items.map(item => {
              const photos = photosByItem[item.id] ?? []
              const done = photos.length > 0
              const uploading = uploadingItemId === item.id
              return (
                <li
                  key={item.id}
                  className={`p-2.5 rounded-lg border ${done ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm min-w-0">
                      <div className={done ? 'text-green-700 font-medium' : 'text-gray-800'}>
                        {item.product_name}
                        {item.option_info && <span className="text-gray-400 ml-1">({item.option_info})</span>}
                      </div>
                      <div className="text-xs text-gray-400">x{item.quantity}</div>
                      {item.item_note && (
                        <div className="text-xs font-bold text-red-600 mt-0.5">{item.item_note}</div>
                      )}
                    </div>
                    {!done && !pending && (
                      <span className="text-gray-300 text-xs shrink-0">미촬영</span>
                    )}
                  </div>
                  {/* 상품 1개에 여러 장 촬영 가능 — 잘못 찍은 사진은 눌러서 지우고 다시 찍음.
                      완료 처리 전(pending)에만 촬영/삭제 가능(2026-09-23) */}
                  {(done || pending) && (
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {photos.map(photo => (
                        <div key={photo.id} className="relative shrink-0">
                          <img
                            src={supabase.storage.from('delivery-photos').getPublicUrl(photo.storage_path).data.publicUrl}
                            alt=""
                            className="w-16 h-16 object-cover rounded-lg border"
                          />
                          {pending && (
                            <button
                              onClick={() => handleDeletePhoto(item, photo)}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none flex items-center justify-center shadow"
                            >×</button>
                          )}
                        </div>
                      ))}
                      {pending && (
                        <label className="w-16 h-16 shrink-0 rounded-lg border-2 border-dashed border-gray-300 text-gray-400 text-xs flex flex-col items-center justify-center cursor-pointer hover:border-blue-400 hover:text-blue-500">
                          {uploading ? '업로드 중' : (
                            <>
                              <span className="text-xl leading-none">＋</span>
                              사진
                            </>
                          )}
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
                      )}
                    </div>
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
            {processing ? '처리 중...' : allPhotographed ? '배송 완료' : `상품 사진을 모두 찍어주세요 (${photographedCount}/${order.items.length})`}
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
