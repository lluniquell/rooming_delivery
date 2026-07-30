import type { VercelRequest, VercelResponse } from '@vercel/node'

// 루밍 온라인몰(고객용) 상품 상세 페이지를 그대로 가져와 og:image/og:title만 추출 —
// 카페24 관리자 API(mall.read_product) 권한 없이도 되는 방식
const STORE_DOMAIN = 'rooming.co.kr'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { product_no } = req.query
  if (!product_no) return res.status(400).json({ error: 'product_no 필요' })

  try {
    const pageRes = await fetch(`https://${STORE_DOMAIN}/product/detail.html?product_no=${product_no}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    if (!pageRes.ok) return res.status(502).json({ error: `상품 페이지 조회 실패 (${pageRes.status})` })
    const html = await pageRes.text()
    const image = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? null
    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? null
    if (!image) return res.status(404).json({ error: '이미지를 찾을 수 없습니다.' })
    res.status(200).json({ image, title })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
