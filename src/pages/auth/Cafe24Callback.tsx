import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { exchangeCodeForTokens } from '../../lib/cafe24'

export default function Cafe24Callback() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const error = params.get('error')
    const errorDesc = params.get('error_description')

    if (error || !code) {
      setError(errorDesc?.replace(/\+/g, ' ') || '인증이 거부됐습니다. 운영자 계정으로 다시 시도해주세요.')
      setStatus('error')
      return
    }

    exchangeCodeForTokens(code)
      .then(() => {
        setStatus('success')
        setTimeout(() => navigate('/admin/dashboard'), 2000)
      })
      .catch(e => {
        setError(e.message)
        setStatus('error')
      })
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        {status === 'loading' && <p className="text-gray-500">카페24 인증 처리 중...</p>}
        {status === 'success' && (
          <>
            <p className="text-green-600 font-bold text-lg">✅ 카페24 연동 완료</p>
            <p className="text-gray-400 text-sm mt-1">잠시 후 이동합니다</p>
          </>
        )}
        {status === 'error' && (
          <>
            <p className="text-red-600 font-bold">인증 실패</p>
            <p className="text-gray-500 text-sm mt-2">{error}</p>
            <button
              onClick={() => navigate('/admin/dashboard')}
              className="mt-4 text-sm text-blue-500 hover:underline"
            >
              대시보드로 돌아가기
            </button>
          </>
        )}
      </div>
    </div>
  )
}
