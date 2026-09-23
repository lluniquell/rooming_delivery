import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? '').trim()
const ACCESS_KEY = (process.env.CHANNEL_TALK_ACCESS_KEY ?? '').trim()
const ACCESS_SECRET = (process.env.CHANNEL_TALK_ACCESS_SECRET ?? '').trim()
const GROUP_NAME = (process.env.CHANNEL_TALK_GROUP_NAME ?? '').trim()
// 배송불가는 완료 알림과 다른 채널(물류팀-이슈사항)로 보냄 — 없으면 기존 채널로 폴백
const ISSUE_GROUP_NAME = (process.env.CHANNEL_TALK_ISSUE_GROUP_NAME ?? '').trim() || GROUP_NAME

const supabase = createClient(SUPABASE_URL, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim())

// 채널톡 오픈 API는 blocks 타입이 text/code 뿐이라 이미지 첨부나 링크 미리보기 블록이
// 아예 없음(2026-09-22 실제 API 테스트로 확인) — 사진은 plainText에 URL을 그대로 넣어
// 채널톡 자동 링크 미리보기에 기대는 방법뿐. 대신 Supabase 스토리지 원본 URL이 너무 길어서
// (주문id/사진id/타임스탬프.jpg) ?photo=id 리다이렉트로 줄인 짧은 링크를 사용함 — 별도
// 파일로 만들면 Vercel Hobby 플랜 서버리스 함수 12개 제한에 걸려 배포가 실패해서
// (2026-09-23 실제로 겪음) 이 파일 안에 GET 분기로 합쳐둠
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const { photo } = req.query
    if (!photo || typeof photo !== 'string') return res.status(400).send('photo id 필요')
    const { data } = await supabase.from('delivery_photos').select('storage_path').eq('id', photo).maybeSingle()
    if (!data) return res.status(404).send('사진을 찾을 수 없습니다.')
    return res.redirect(302, `${SUPABASE_URL}/storage/v1/object/public/delivery-photos/${data.storage_path}`)
  }

  if (req.method !== 'POST') return res.status(405).end()
  if (!ACCESS_KEY || !ACCESS_SECRET || !GROUP_NAME) {
    return res.status(500).json({ error: 'CHANNEL_TALK_ACCESS_KEY / CHANNEL_TALK_ACCESS_SECRET / CHANNEL_TALK_GROUP_NAME 환경변수가 설정되지 않았습니다.' })
  }

  const origin = `https://${req.headers.host}`
  const { kind, id, driver_name, memo } = req.body ?? {}
  if (!kind || !id) return res.status(400).json({ error: 'kind, id 필요' })
  if (kind !== 'order' && kind !== 'adhoc' && kind !== 'fail') return res.status(400).json({ error: "kind는 'order', 'adhoc' 또는 'fail'" })

  async function sendMessage(plainText: string, groupName: string) {
    const chRes = await fetch(`https://api.channel.io/open/groups/@${encodeURIComponent(groupName)}/messages`, {
      method: 'POST',
      headers: {
        'x-access-key': ACCESS_KEY,
        'x-access-secret': ACCESS_SECRET,
        'Channel-Version': '2026-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plainText }),
    })
    const chData = await chRes.json()
    if (!chRes.ok) throw new Error(JSON.stringify(chData))
  }

  // 배송불가 — 완료 알림과 양식은 같되(담당자/수령인/주문번호/주소) 사유를 덧붙여서
  // 물류팀-이슈사항 채널로 따로 보냄(2026-09-23)
  if (kind === 'fail') {
    const { data: order } = await supabase
      .from('orders')
      .select('cafe24_order_no, customer_name, receiver_name, address')
      .eq('id', id)
      .maybeSingle()
    if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' })
    const text = [
      `배송불가(${driver_name ?? '알 수 없음'}) ${order.receiver_name || order.customer_name} (${order.cafe24_order_no})`,
      order.address ?? '',
      memo ? `사유: ${memo}` : '',
    ].filter(Boolean).join('\n')
    try {
      await sendMessage(text, ISSUE_GROUP_NAME)
      return res.status(200).json({ ok: true })
    } catch (e: any) {
      return res.status(500).json({ error: e.message })
    }
  }

  let headerName: string
  let orderNoSuffix = ''
  let address: string | null = null
  // 사진마다 어떤 상품 사진인지 같이 보여주기 위해 상품명을 같이 들고 다님(2026-09-22)
  let photoEntries: { url: string; productName: string | null }[] = []

  if (kind === 'order') {
    const { data: order } = await supabase
      .from('orders')
      .select('cafe24_order_no, customer_name, receiver_name, address')
      .eq('id', id)
      .maybeSingle()
    if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' })
    headerName = order.receiver_name || order.customer_name
    orderNoSuffix = ` (${order.cafe24_order_no})`
    address = order.address

    const { data: photos } = await supabase.from('delivery_photos').select('id, order_item_id').eq('order_id', id)
    const itemIds = [...new Set((photos ?? []).map(p => p.order_item_id).filter((v): v is string => !!v))]
    let productNameById: Record<string, string> = {}
    if (itemIds.length) {
      const { data: itemRows } = await supabase.from('order_items').select('id, product_name').in('id', itemIds)
      productNameById = Object.fromEntries((itemRows ?? []).map(i => [i.id, i.product_name]))
    }
    photoEntries = (photos ?? []).map(p => ({
      url: `${origin}/api/channeltalk/notify?photo=${p.id}`,
      productName: p.order_item_id ? productNameById[p.order_item_id] ?? null : null,
    }))
  } else {
    const { data: adhoc } = await supabase
      .from('schedule_adhoc_stops')
      .select('name, address')
      .eq('id', id)
      .maybeSingle()
    if (!adhoc) return res.status(404).json({ error: '기타 배송지를 찾을 수 없습니다.' })
    headerName = adhoc.name
    address = adhoc.address

    const { data: photos } = await supabase.from('delivery_photos').select('id').eq('adhoc_stop_id', id)
    photoEntries = (photos ?? []).map(p => ({
      url: `${origin}/api/channeltalk/notify?photo=${p.id}`,
      productName: null,
    }))
  }

  const label = kind === 'order' ? '배송완료' : '처리완료'
  const headerText = [
    `${label}(${driver_name ?? '알 수 없음'}) ${headerName}${orderNoSuffix}`,
    address ?? '',
  ].filter(Boolean).join('\n')

  try {
    // 상품 1개짜리 배송이 훨씬 많아서, 그 흔한 경우엔 메시지가 안내문+사진 2개로
    // 안 쪼개지게 첫 번째 사진은 안내문에 같이 담아 보냄. 둘째 장부터만 따로 보냄
    // — 채널톡은 한 메시지에 링크가 여러 개 있으면 첫 번째 것만 미리보기가 뜨기 때문(2026-09-22)
    const [first, ...rest] = photoEntries
    await sendMessage(first ? [headerText, '', first.productName, first.url].filter(Boolean).join('\n') : headerText, GROUP_NAME)
    for (const { url, productName } of rest) {
      await sendMessage([productName, url].filter(Boolean).join('\n'), GROUP_NAME)
    }
    res.status(200).json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
