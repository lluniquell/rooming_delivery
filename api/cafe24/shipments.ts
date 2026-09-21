import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MALL_ID = (process.env.VITE_CAFE24_MALL_ID ?? '').trim()
// 카페24 배송사 코드 — 0006 "CJ대한통운" (일반). 1040 "CJ대한통운(연동)"은
// 카페24가 API로 직접 수정하는 걸 막아둔 코드라("연동된 배송사로 수정 불가" 422 에러) 사용 불가.
const CJ_CARRIER_CODE = (process.env.CAFE24_CJ_CARRIER_CODE ?? '0006').trim()
// 이 주문자(카페24 로그인 아이디)의 주문은 스케줄러/배송 작업은 평소대로 진행하되
// 카페24 배송상태(배송대기/배송중) 전환만 걸러서 건드리지 않음(2026-09-22)
const EXCLUDED_MEMBER_IDS = new Set(['ajpk'])

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

async function cafe24Req(method: string, path: string, token: string, body?: any) {
  const res = await fetch(`https://${MALL_ID}.cafe24api.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }
  return { ok: res.ok, data }
}

// 운송장 등록 — 이 주문에서 해당 배송방법으로 배정된 상품에만 정확히 등록 (POST ?action=standby)
// CJ 운송장 업로드뿐 아니라 직배 루트 마감 시 등록에도 재사용됨(delivery_method로 구분)
async function handleStandby(req: VercelRequest, res: VercelResponse) {
  const { orders, carrier_code, delivery_method } = req.body ?? {}
  if (!Array.isArray(orders) || !orders.length) {
    return res.status(400).json({ error: 'orders 배열이 필요합니다. [{ order_no, tracking_no }]' })
  }

  try {
    const token = await getToken()
    const code = (carrier_code ?? CJ_CARRIER_CODE).trim()
    const method = delivery_method ?? 'CJ'

    let updated = 0
    const errors: string[] = []

    for (const { order_no, tracking_no } of orders) {
      if (!order_no || !tracking_no) continue
      try {
        const { data: orderRow } = await supabase
          .from('orders')
          .select('id, member_id')
          .eq('cafe24_order_no', order_no)
          .maybeSingle()
        if (!orderRow) { errors.push(`${order_no}: 주문을 찾을 수 없음`); continue }
        if (orderRow.member_id && EXCLUDED_MEMBER_IDS.has(orderRow.member_id)) continue

        // 이 주문에서 해당 배송방법으로 배정된 상품 행만 대상으로 함 — 같은 주문에 다른
        // 배송방법 상품이 섞여 있어도 그쪽 상품은 절대 건드리지 않기 위함
        const { data: cjItems } = await supabase
          .from('order_items')
          .select('id, cafe24_item_code')
          .eq('order_id', orderRow.id)
          .eq('delivery_method', method)
          .eq('status', 'confirmed')
        if (!cjItems?.length) { errors.push(`${order_no}: ${method} 배정 상품 없음`); continue }

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
  // orders: [{ order_no, item_codes, tracking_no }] — item_codes가 있으면 그 상품들만 배송중 전환 대상.
  // 카페24는 배송상태를 상품 단위가 아니라 shipping_code(운송장 그룹) 단위로만 바꿀 수 있어서,
  // item_codes가 그 그룹의 일부만 가리키면(예: 매장 재고 부족으로 일부만 먼저 출고) 그룹 전체를
  // 지우고 item_codes만 같은 tracking_no로 새 그룹을 만들어 그 그룹만 배송중 전환한다.
  // (실제로 이 필터를 무시하고 그룹 전체를 전환해버려 정상 출고분까지 상태가 꼬인 적 있음 — 2026-07-26)
  const { order_nos, orders } = req.body ?? {}
  const targets: { order_no: string; item_codes?: string[]; tracking_no?: string; carrier_code?: string }[] =
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

    for (const { order_no: orderNo, item_codes, tracking_no, carrier_code } of targets) {
      if (!orderNo) continue
      try {
        const { data: orderRow } = await supabase
          .from('orders')
          .select('member_id')
          .eq('cafe24_order_no', orderNo)
          .maybeSingle()
        if (orderRow?.member_id && EXCLUDED_MEMBER_IDS.has(orderRow.member_id)) continue

        // shipping_code는 D-{주문번호}-00으로 고정이 아님 — 상품(라인)이 서로 다른
        // 배송 그룹으로 나뉘면 -01, -02 등 별도 코드를 갖는 경우가 실제로 있어서,
        // 주문의 실제 아이템을 조회해 존재하는 shipping_code를 전부 처리해야 함
        const itemsData = await cafe24Get(`/api/v2/admin/orders/${orderNo}/items?shop_no=1`, token)
        const allItems: any[] = itemsData.items ?? []

        const targetSet = new Set<string>(
          item_codes?.length ? item_codes : allItems.map((i: any) => i.order_item_code)
        )
        const groupOf: Record<string, string[]> = {}
        for (const it of allItems) {
          if (!it.shipping_code) continue
          ;(groupOf[it.shipping_code] ??= []).push(it.order_item_code)
        }
        const touchedGroups = [...new Set(
          allItems.filter((i: any) => targetSet.has(i.order_item_code)).map((i: any) => i.shipping_code).filter(Boolean)
        )]

        if (!touchedGroups.length) {
          errors.push(`${orderNo}: shipping_code를 찾을 수 없음`)
          continue
        }

        for (const shippingCode of touchedGroups) {
          const groupItems = groupOf[shippingCode] ?? []
          const isFullGroup = groupItems.every(code => targetSet.has(code))
          // shipping_code는 등록 안 된 상품에도 기본값이 항상 붙어있어서, 실제 등록 여부는
          // 그 그룹 상품의 tracking_no 존재 여부로 판단해야 함 (2026-07-29 실제로 이 체크가
          // 없어서 미등록 그룹에 DELETE를 시도하다 실패해 등록/전환 자체가 통째로 스킵된 적 있음)
          const groupTrackingNo = allItems.find((i: any) => i.shipping_code === shippingCode)?.tracking_no as string | undefined

          if (isFullGroup && groupTrackingNo) {
            // 이미 등록된 그룹 전체가 대상 — 그대로 배송중 전환
            const r = await cafe24Req('PUT', `/api/v2/admin/orders/${orderNo}/shipments/${shippingCode}`, token,
              { shop_no: 1, request: { status: 'shipping' } })
            if (!r.ok || r.data.error) {
              errors.push(`${orderNo} (${shippingCode}): ${r.data.error?.message ?? JSON.stringify(r.data).slice(0, 150)}`)
            }
          } else if (!tracking_no) {
            errors.push(`${orderNo} (${shippingCode}): 미등록 그룹이거나 그룹 일부만 전환하려면 tracking_no가 필요합니다`)
          } else {
            // 그룹 일부만 대상이거나, 아직 등록 자체가 안 된 그룹 — 등록돼 있었으면 지우고
            // 대상 상품만 같은 운송장번호로 새로 등록한 뒤 전환 (등록 자체가 없었으면 삭제는 생략)
            const targetCodes = groupItems.filter(code => targetSet.has(code))
            if (groupTrackingNo) {
              const delRes = await cafe24Req('DELETE', `/api/v2/admin/orders/${orderNo}/shipments/${shippingCode}?shop_no=1`, token)
              if (!delRes.ok) {
                errors.push(`${orderNo} (${shippingCode}): 기존 운송장 등록 삭제 실패`)
                continue
              }
            }
            const postRes = await cafe24Req('POST', `/api/v2/admin/orders/${orderNo}/shipments`, token, {
              shop_no: 1,
              request: {
                status: 'standby',
                tracking_no,
                shipping_company_code: carrier_code ?? CJ_CARRIER_CODE,
                order_item_code: targetCodes,
              },
            })
            const newCode = postRes.data?.shipments?.[0]?.shipping_code
            if (!postRes.ok || !newCode) {
              errors.push(`${orderNo}: 운송장 등록 실패 — ${JSON.stringify(postRes.data).slice(0, 150)}`)
              continue
            }
            const putRes = await cafe24Req('PUT', `/api/v2/admin/orders/${orderNo}/shipments/${newCode}`, token,
              { shop_no: 1, request: { status: 'shipping' } })
            if (!putRes.ok || putRes.data.error) {
              errors.push(`${orderNo} (${newCode}): ${putRes.data.error?.message ?? JSON.stringify(putRes.data).slice(0, 150)}`)
            }
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

// 미배정으로 되돌릴 때 기존 운송장 등록을 카페24에서도 정리 (POST ?action=unregister)
// 이 상품이 속한 shipping_code 그룹에 다른 상품이 더 있으면(같은 운송장으로 같이 등록된 경우)
// 그룹 전체를 지우고 나머지 상품만 같은 운송장번호로 재등록 — 이 상품만 쏙 빠지고
// 상태는 자동으로 배송준비중(N20)으로 돌아감 (등록 삭제의 부수 효과)
async function handleUnregister(req: VercelRequest, res: VercelResponse) {
  const { order_no, item_code } = req.body ?? {}
  if (!order_no || !item_code) {
    return res.status(400).json({ error: 'order_no, item_code가 필요합니다.' })
  }

  try {
    const token = await getToken()
    const itemsData = await cafe24Get(`/api/v2/admin/orders/${order_no}/items?shop_no=1`, token)
    const allItems: any[] = itemsData.items ?? []
    const target = allItems.find((i: any) => i.order_item_code === item_code)

    // shipping_code는 등록 안 된 상품에도 기본값(-00)이 항상 붙어있어서 등록 여부 판단에
    // 쓸 수 없음 — 실제 운송장 등록 여부는 tracking_no 유무로 판단해야 함
    if (!target?.tracking_no || !target?.shipping_code) {
      return res.status(200).json({ ok: true, message: '등록된 운송장이 없습니다.' })
    }

    const shippingCode = target.shipping_code
    const groupItems = allItems.filter((i: any) => i.shipping_code === shippingCode)
    const remaining = groupItems.filter((i: any) => i.order_item_code !== item_code)

    const delRes = await cafe24Req('DELETE', `/api/v2/admin/orders/${order_no}/shipments/${shippingCode}?shop_no=1`, token)
    if (!delRes.ok) {
      return res.status(500).json({ error: '기존 운송장 등록 삭제 실패', detail: delRes.data })
    }

    if (remaining.length) {
      const postRes = await cafe24Req('POST', `/api/v2/admin/orders/${order_no}/shipments`, token, {
        shop_no: 1,
        request: {
          status: 'standby',
          tracking_no: target.tracking_no,
          shipping_company_code: target.shipping_company_code || CJ_CARRIER_CODE,
          order_item_code: remaining.map((i: any) => i.order_item_code),
        },
      })
      if (!postRes.ok) {
        return res.status(500).json({ error: '나머지 상품 재등록 실패', detail: postRes.data })
      }
    }

    res.status(200).json({ ok: true })
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

// 카페24 주문 메모 등록 (POST ?action=memo) — shop_no는 쿼리스트링이 아니라 바디에만 넣어야 함
// ("Query String is not available for POST, PUT Method." 에러 남)
async function handleMemo(req: VercelRequest, res: VercelResponse) {
  const { order_no, content } = req.body ?? {}
  if (!order_no || !content) return res.status(400).json({ error: 'order_no, content 필요' })

  try {
    const token = await getToken()
    const { ok, data } = await cafe24Req('POST', `/api/v2/admin/orders/${order_no}/memos`, token, {
      shop_no: 1,
      request: { content },
    })
    if (!ok) return res.status(502).json({ error: data })
    res.status(200).json({ ok: true, memo: data })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const action = req.query.action
  if (action === 'standby') return handleStandby(req, res)
  if (action === 'transit') return handleTransit(req, res)
  if (action === 'unregister') return handleUnregister(req, res)
  if (action === 'memo') return handleMemo(req, res)
  return handleWebhook(req, res)
}
