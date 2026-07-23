import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = (process.env.VITE_CAFE24_MALL_ID ?? '').trim()
// 카페24 배송사 코드 — 0006 "CJ대한통운" (일반). 1040 "CJ대한통운(연동)"은
// 카페24가 API로 직접 수정하는 걸 막아둔 코드라("연동된 배송사로 수정 불가" 422 에러) 사용 불가.
const CJ_CARRIER_CODE = (process.env.CAFE24_CJ_CARRIER_CODE ?? '0006').trim()

const supabase = createClient(
  (process.env.VITE_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
)

async function getToken(): Promise<string> {
  const { data } = await supabase.from('cafe24_tokens').select('access_token').eq('id', 1).single()
  if (!data) throw new Error('토큰 없음')
  return data.access_token
}

async function cafe24Get(path: string, token: string) {
  const res = await fetch(`https://${MALL_ID}.cafe24api.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch {
    throw new Error(`파싱 실패 (${res.status}): ${text.slice(0, 200)}`)
  }
}

// CJ 운송장 등록 — 이 주문에서 CJ로 배정된 상품에만 정확히 등록 (POST ?action=standby)
async function handleStandby(req: VercelRequest, res: VercelResponse) {
  const { orders, carrier_code } = req.body ?? {}
  if (!Array.isArray(orders) || !orders.length) {
    return res.status(400).json({ error: 'orders 배열이 필요합니다. [{ order_no, tracking_no }]' })
  }

  try {
    const token = await getToken()
    const code = (carrier_code ?? CJ_CARRIER_CODE).trim()

    let updated = 0
    const errors: string[] = []

    for (const { order_no, tracking_no } of orders) {
      if (!order_no || !tracking_no) continue
      try {
        const { data: orderRow } = await supabase
          .from('orders')
          .select('id')
          .eq('cafe24_order_no', order_no)
          .maybeSingle()
        if (!orderRow) { errors.push(`${order_no}: 주문을 찾을 수 없음`); continue }

        // 이 주문에서 CJ로 배정된 상품 행만 대상으로 함 — 같은 주문에 경동/직배 상품이
        // 섞여 있어도 그쪽 상품은 절대 건드리지 않기 위함
        const { data: cjItems } = await supabase
          .from('order_items')
          .select('id, cafe24_item_code')
          .eq('order_id', orderRow.id)
          .eq('delivery_method', 'CJ')
          .eq('status', 'confirmed')
        if (!cjItems?.length) { errors.push(`${order_no}: CJ 배정 상품 없음`); continue }

        const itemCodes = cjItems.map(i => i.cafe24_item_code).filter(Boolean) as string[]
        if (!itemCodes.length) { errors.push(`${order_no}: cafe24_item_code 없음 (재수집 필요)`); continue }

        // POST(등록) API는 order_item_code를 배열로 받아 "이 운송장을 이 상품들에만 등록"
        // 하도록 정확히 지정할 수 있음 — 다른 배송방법 상품에는 전혀 영향 없음.
        // (PUT/수정 API는 status와 tracking_no를 동시에 못 쓰는 제약이 있어 이 용도엔 안 맞음)
        const apiRes = await fetch(
          `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders/${order_no}/shipments`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              shop_no: 1,
              request: {
                tracking_no: String(tracking_no),
                shipping_company_code: code,
                status: 'standby', // 배송대기
                order_item_code: itemCodes,
              },
            }),
          }
        )
        const text = await apiRes.text()
        let data: any
        try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }

        if (!apiRes.ok || data.error) {
          errors.push(`${order_no}: ${data.error?.message ?? JSON.stringify(data).slice(0, 150)}`)
        } else {
          updated++
          await supabase.from('order_items')
            .update({ tracking_number: String(tracking_no) })
            .in('id', cjItems.map(i => i.id))
          await supabase.from('orders')
            .update({ cafe24_synced_at: new Date().toISOString() })
            .eq('id', orderRow.id)
        }
      } catch (e: any) {
        errors.push(`${order_no}: ${e.message}`)
      }
      await new Promise(r => setTimeout(r, 150))
    }

    res.status(200).json({ updated, total: orders.length, ...(errors.length && { errors }) })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}

// 출고검수1 완료 시 배송중 전환 (POST ?action=transit)
async function handleTransit(req: VercelRequest, res: VercelResponse) {
  // orders: [{ order_no, item_codes }] — item_codes가 있으면 그 상품(order_item_code)들의
  // shipping_code만 전환, 없으면(구버전 호출 호환) 주문의 모든 shipping_code를 전환
  const { order_nos, orders } = req.body ?? {}
  const targets: { order_no: string; item_codes?: string[] }[] =
    Array.isArray(orders) ? orders
    : Array.isArray(order_nos) ? order_nos.map((o: string) => ({ order_no: o }))
    : []
  if (!targets.length) {
    return res.status(400).json({ error: 'order_nos 또는 orders 배열이 필요합니다.' })
  }

  try {
    const token = await getToken()
    let updated = 0
    const errors: string[] = []

    for (const { order_no: orderNo, item_codes } of targets) {
      if (!orderNo) continue
      try {
        // shipping_code는 D-{주문번호}-00으로 고정이 아님 — 상품(라인)이 서로 다른
        // 배송 그룹으로 나뉘면 -01, -02 등 별도 코드를 갖는 경우가 실제로 있어서,
        // 주문의 실제 아이템을 조회해 존재하는 shipping_code를 전부 처리해야 함
        const itemsData = await cafe24Get(`/api/v2/admin/orders/${orderNo}/items?shop_no=1`, token)
        const allItems: any[] = itemsData.items ?? []

        // item_codes가 지정된 경우, 그 상품(order_item_code)에 해당하는 shipping_code만 대상으로 함
        // — 같은 주문에 다른 배송방법 상품이 섞여 있어도 그쪽 그룹은 건드리지 않기 위함
        const scoped = item_codes?.length
          ? allItems.filter(i => item_codes.includes(i.order_item_code))
          : allItems
        const shippingCodes = [...new Set(scoped.map((i: any) => i.shipping_code).filter(Boolean))]

        if (!shippingCodes.length) {
          errors.push(`${orderNo}: shipping_code를 찾을 수 없음`)
          continue
        }

        for (const shippingCode of shippingCodes) {
          const apiRes = await fetch(
            `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders/${orderNo}/shipments/${shippingCode}`,
            {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ shop_no: 1, request: { status: 'shipping' } }),
            }
          )
          const text = await apiRes.text()
          let data: any
          try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }

          if (!apiRes.ok || data.error) {
            errors.push(`${orderNo} (${shippingCode}): ${data.error?.message ?? JSON.stringify(data).slice(0, 150)}`)
          }
          await new Promise(r => setTimeout(r, 150))
        }
        updated++
      } catch (e: any) {
        errors.push(`${orderNo}: ${e.message}`)
      }
    }

    res.status(200).json({ updated, total: targets.length, ...(errors.length && { errors }) })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}

// 90026: 주문 취소상태 변경(단건), 90072: 주문 취소상태 변경(일괄) — event_code는 둘 다 cancel_order
const CANCEL_EVENTS = new Set([90026, 90072])

// 카페24 웹훅 수신 (action 파라미터 없이 기본 호출 — 카페24 개발자센터에 등록할 콜백 URL)
async function handleWebhook(req: VercelRequest, res: VercelResponse) {
  try {
    const { event_no, resource } = req.body ?? {}

    if (CANCEL_EVENTS.has(event_no) && resource?.order_id) {
      // 일괄취소(90072)는 order_id가 콤마로 여러 건 — 항상 배열로 통일해서 처리
      const orderNos: string[] = String(resource.order_id).split(',').map((s: string) => s.trim()).filter(Boolean)
      if (orderNos.length) {
        await supabase
          .from('orders')
          .update({ cancelled_at: new Date().toISOString() })
          .in('cafe24_order_no', orderNos)
      }
    }

    // 처리 대상이 아닌 이벤트도 200으로 응답 — 그래야 카페24가 실패로 보고 재발송을 반복하지 않음
    res.status(200).json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const action = req.query.action
  if (action === 'standby') return handleStandby(req, res)
  if (action === 'transit') return handleTransit(req, res)
  return handleWebhook(req, res)
}
