import { useState } from 'react'

export default function AdminTest() {
  const [orderNo, setOrderNo] = useState('')
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tokenStatus, setTokenStatus] = useState<any>(null)

  async function checkToken() {
    const res = await fetch('/api/cafe24/status')
    const data = await res.json()
    setTokenStatus(data)
  }

  async function checkShop() {
    const res = await fetch('/api/cafe24/shop')
    const text = await res.text()
    let data: any
    try { data = JSON.parse(text) } catch { data = text }
    setTokenStatus(data)
  }

  async function checkShopBrowser() {
    // 브라우저에서 직접 Cafe24 API 호출 (Cloudflare 우회 테스트)
    const statusRes = await fetch('/api/cafe24/status')
    const status = await statusRes.json()
    if (!status.access_token_prefix) { setTokenStatus({ error: '토큰 없음' }); return }

    // 실제 토큰을 가져오는 엔드포인트 필요
    const tokenRes = await fetch('/api/cafe24/token-for-client')
    const { access_token, mall_id } = await tokenRes.json()

    const apiRes = await fetch(`https://${mall_id}.cafe24api.com/api/v2/admin/shops/1`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': '2023-08-01',
      },
    })
    const text = await apiRes.text()
    let data: any
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 500), status: apiRes.status } }
    setTokenStatus({ source: '브라우저 직접 호출', ...data })
  }

  async function search(e: React.FormEvent) {
    e.preventDefault()
    if (!orderNo.trim()) return
    setLoading(true)
    setError('')
    setResult(null)

    const res = await fetch(`/api/cafe24/orders/${orderNo.trim()}`)
    const text = await res.text()
    let data: any
    try { data = JSON.parse(text) } catch { data = text }

    if (!res.ok) {
      setError(text)
    } else {
      setResult(data ?? '(빈 응답)')
    }
    setLoading(false)
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold text-gray-800 mb-4">카페24 주문 조회 테스트</h2>

      <div className="mb-6">
        <button onClick={checkToken} className="bg-gray-100 text-gray-700 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-200 mr-2">
          토큰 상태 확인
        </button>
        <button onClick={checkShop} className="bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg text-sm hover:bg-blue-200 mr-2">
          쇼핑몰 정보 조회 (서버)
        </button>
        <button onClick={checkShopBrowser} className="bg-green-100 text-green-700 px-3 py-1.5 rounded-lg text-sm hover:bg-green-200">
          쇼핑몰 정보 조회 (브라우저 직접)
        </button>
        {tokenStatus && (
          <pre className="mt-2 text-xs bg-gray-50 border rounded p-3 overflow-auto">
            {JSON.stringify(tokenStatus, null, 2)}
          </pre>
        )}
      </div>

      <form onSubmit={search} className="flex gap-2 mb-6">
        <input
          value={orderNo}
          onChange={e => setOrderNo(e.target.value)}
          placeholder="주문번호 입력"
          className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? '조회 중...' : '조회'}
        </button>
      </form>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
          <p className="text-red-600 text-sm font-medium mb-2">오류</p>
          <pre className="text-xs text-red-500 overflow-auto">{error}</pre>
        </div>
      )}

      {result !== null && (
        <div className="bg-white rounded-xl border p-4">
          <p className="text-sm font-medium text-gray-700 mb-3">응답 데이터</p>
          <pre className="text-xs text-gray-600 overflow-auto max-h-96 bg-gray-50 rounded p-3">
            {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
