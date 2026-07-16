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
        <button onClick={checkToken} className="bg-gray-100 text-gray-700 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-200">
          토큰 상태 확인
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
