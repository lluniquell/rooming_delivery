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
  status: string
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
  // 배송완료를 상품 단위로 선택해서 처리할 수 있게 — 사진 촬영 여부와 무관(2026-09-29)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [sendingPhotos, setSendingPhotos] = useState(false)
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
        .select('id, product_name, option_info, quantity, cafe24_item_code, tracking_number, item_note, status')
        .eq('order_id', id)
        .eq('delivery_method', '직배')
        .in('status', ['confirmed', 'in_transit'])
      // 아직 완료 안 된 상품은 기본으로 전부 선택해둬서, 평소(상품 1~2개)엔 그냥 바로
      // "배송 완료"만 누르면 되고, 일부만 배송된 경우에만 체크 해제하면 됨(2026-09-29)
      setSelectedItemIds(new Set((items ?? []).filter(i => i.status !== 'in_transit').map(i => i.id)))

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

  // 품목이 많으면 사진을 다 못 찍거나(고객이 못 찍게 하는 경우 포함) 일부 상품만
  // 먼저 배송되는 경우가 있어서, 사진 촬영 여부와 무관하게 체크한 상품만 배송완료
  // 처리할 수 있게 함. 선택 안 된(아직 배송 안 된) 상품이 남아있으면 주문 자체는
  // delivered_at을 세우지 않고 계속 진행중으로 남겨서, 나중에 다시 들어와 나머지를
  // 마저 처리할 수 있게 함(2026-09-29)
  async function handleCompleteSelected() {
    if (!order) return
    const targets = order.items.filter(i => selectedItemIds.has(i.id) && i.status !== 'in_transit')
    if (!targets.length) { alert('완료 처리할 상품을 선택해주세요.'); return }
    setProcessing(true)
    setMessage('')

    // 운송장번호는 스케줄러 "마감" 때 이미 order_items.tracking_number로 등록해둔 값을
    // 그대로 써야 함 — 여기서 새로 만들면 마감 시점(스케줄 날짜 기준)과 완료 시점(오늘
    // 날짜 기준)이 달라질 때(예: 하루 밀려서 처리) 카페24에 등록된 운송장번호와
    // 어긋나버림. 마감을 거치지 않은 예외적인 경우를 대비해 없으면만 폴백으로 새로 만듦
    const invoiceNo = order.items.find(i => i.tracking_number)?.tracking_number
      ?? `직배${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`

    // 카페24 배송완료 전환 — 선택된 상품만. 실패해도 로컬 완료 처리는 유지(나중에 수동 확인 필요)
    try {
      const itemCodes = targets.map(i => i.cafe24_item_code).filter(Boolean) as string[]
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

    const targetIds = targets.map(i => i.id)
    // order_items.status를 안 바꾸면 배송완료 후에도 계속 'confirmed'로 남아서
    // 주문/배치 화면(SoumOrders/SoumBatch)의 직배 배치에 영원히 남아있게 됨(2026-09-22 발견)
    await supabase.from('order_items')
      .update({ status: 'in_transit', shipped_at: new Date().toISOString() })
      .in('id', targetIds)

    // 카페24 어드민 메모에 담당 배송원/처리 현황 남김 — 실패해도 완료 처리엔 영향 없음
    const remainingAfter = order.items.filter(i => i.status !== 'in_transit' && !targetIds.includes(i.id)).length
    try {
      await fetch('/api/cafe24/shipments?action=memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_no: order.cafe24_order_no,
          content: `배송 담당자 : ${driverName}${remainingAfter ? ` (${targets.length}개 완료, ${remainingAfter}개 남음)` : ''}`,
        }),
      })
    } catch { /* 메모 등록 실패는 배송 완료 처리에 영향 없음 */ }

    // 채널톡 완료 알림 — 사진이 없어도 텍스트는 보내고, 아직 안 보낸 사진이 있으면 같이 보냄.
    // 실패해도 배송 완료 처리 자체는 이미 끝난 상태라 조용히 넘어감
    try {
      await fetch('/api/channeltalk/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'complete',
          id: order.id,
          driver_name: driverName,
          product_names: targets.map(i => i.product_name),
          remaining: remainingAfter,
        }),
      })
    } catch { /* 알림 실패는 배송 완료 처리에 영향 없음 */ }

    const updatedItems = order.items.map(i => targetIds.includes(i.id) ? { ...i, status: 'in_transit' } : i)
    if (remainingAfter === 0) {
      // 선택 안 한 나머지가 없거나 이번에 다 같이 끝남 — 주문 전체 완료 처리
      await supabase.from('orders').update({ delivered_at: new Date().toISOString() }).eq('id', order.id)
      setProcessing(false)
      navigate('/')
      return
    }

    // 아직 남은 상품이 있음 — 주문은 계속 진행중으로 두고 화면에 남아서 이어서 처리 가능
    setOrder({ ...order, items: updatedItems })
    setSelectedItemIds(new Set())
    setMessage(`${targets.length}개 상품을 배송완료 처리했습니다. 남은 상품: ${remainingAfter}개`)
    setProcessing(false)
  }

  // 배송완료 처리와 완전히 별개 — 지금까지 찍은(아직 안 보낸) 사진만 채널톡으로 전송.
  // 다시 눌러도 이미 보낸 사진은 서버가 알아서 제외하고 새로 찍은 것만 보냄(2026-09-29)
  async function handleSendPhotos() {
    if (!order) return
    setSendingPhotos(true)
    try {
      const res = await fetch('/api/channeltalk/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'photos', id: order.id, driver_name: driverName }),
      })
      const data = await res.json()
      if (!res.ok) { alert(`전송 실패: ${data.error}`); return }
      alert(data.sent ? `사진 ${data.sent}장을 전송했습니다.` : '새로 보낼 사진이 없습니다.')
    } catch {
      alert('전송 중 네트워크 오류가 발생했습니다.')
    } finally {
      setSendingPhotos(false)
    }
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
  const pendingItemCount = order.items.filter(i => i.status !== 'in_transit').length

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
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-gray-700">
              상품 목록 <span className="text-gray-400 font-normal">(사진 {photographedCount}/{order.items.length})</span>
            </p>
            {pending && (
              <button
                onClick={handleSendPhotos}
                disabled={sendingPhotos}
                className="text-xs px-2.5 py-1 rounded-lg border border-indigo-300 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 shrink-0"
              >
                {sendingPhotos ? '전송 중...' : '📷 채널톡 사진 전송'}
              </button>
            )}
          </div>
          <ul className="space-y-2">
            {order.items.map(item => {
              const photos = photosByItem[item.id] ?? []
              const itemDone = item.status === 'in_transit'
              const editable = pending && !itemDone
              const uploading = uploadingItemId === item.id
              return (
                <li
                  key={item.id}
                  className={`p-2.5 rounded-lg border ${itemDone ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {pending && !itemDone && (
                        <input
                          type="checkbox"
                          checked={selectedItemIds.has(item.id)}
                          onChange={e => setSelectedItemIds(prev => {
                            const next = new Set(prev)
                            e.target.checked ? next.add(item.id) : next.delete(item.id)
                            return next
                          })}
                          className="w-[18px] h-[18px] shrink-0"
                        />
                      )}
                      <div className="text-sm min-w-0">
                        <div className={itemDone ? 'text-green-700 font-medium' : 'text-gray-800'}>
                          {item.product_name}
                          {item.option_info && <span className="text-gray-400 ml-1">({item.option_info})</span>}
                        </div>
                        <div className="text-xs text-gray-400">x{item.quantity}</div>
                        {item.item_note && (
                          <div className="text-xs font-bold text-red-600 mt-0.5">{item.item_note}</div>
                        )}
                      </div>
                    </div>
                    {itemDone && <span className="text-green-600 text-xl shrink-0">✓</span>}
                  </div>
                  {/* 상품 1개에 여러 장 촬영 가능 — 잘못 찍은 사진은 눌러서 지우고 다시 찍음.
                      사진은 배송완료 조건이 아니라 참고용 — 고객이 촬영을 막는 경우 등
                      사진 없이도 완료 처리 가능(2026-09-29) */}
                  {(photos.length > 0 || editable) && (
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {photos.map(photo => (
                        <div key={photo.id} className="relative shrink-0">
                          <img
                            src={supabase.storage.from('delivery-photos').getPublicUrl(photo.storage_path).data.publicUrl}
                            alt=""
                            className="w-16 h-16 object-cover rounded-lg border"
                          />
                          {editable && (
                            <button
                              onClick={() => handleDeletePhoto(item, photo)}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none flex items-center justify-center shadow"
                            >×</button>
                          )}
                        </div>
                      ))}
                      {editable && (
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

      {message && <p className="text-sm text-amber-600 mb-3">{message}</p>}

      {pending && (
        <div className="space-y-3">
          <button
            onClick={handleCompleteSelected}
            disabled={processing || selectedItemIds.size === 0}
            className="w-full bg-green-600 text-white py-3 rounded-xl font-medium text-lg hover:bg-green-700 disabled:opacity-50"
          >
            {processing ? '처리 중...' : selectedItemIds.size === 0
              ? '완료할 상품을 선택해주세요'
              : selectedItemIds.size === pendingItemCount
                ? '배송 완료'
                : `선택한 상품 배송완료 (${selectedItemIds.size}/${pendingItemCount})`}
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
