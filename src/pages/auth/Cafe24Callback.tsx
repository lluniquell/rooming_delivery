import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { exchangeCodeForTokens } from '../../lib/cafe24'

export default function Cafe24Callback() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code')
    if (!code) {
      setError('인증 코드가 없습니다.')
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
            <p className="text-gray-500 text-sm mt-1">{error}</p>
          </>
        )}
      </div>
    </div>
  )
}
