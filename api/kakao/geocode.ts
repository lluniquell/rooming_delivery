import type { VercelRequest, VercelResponse } from '@vercel/node'

const REST_KEY = (process.env.KAKAO_REST_API_KEY ?? '').trim()

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  const { address } = req.body ?? {}
  if (!address) return res.status(400).json({ error: 'address 필요' })

  try {
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`
    const apiRes = await fetch(url, {
      headers: { Authorization: `KakaoAK ${REST_KEY}` },
    })
    const data = await apiRes.json()
    const doc = data.documents?.[0]
    if (!doc) return res.status(200).json({ lat: null, lng: null, message: '검색 결과 없음' })

    res.status(200).json({ lat: Number(doc.y), lng: Number(doc.x) })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
