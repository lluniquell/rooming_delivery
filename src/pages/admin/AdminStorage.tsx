import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

const STORAGE_LIMIT_GB = 1

export default function AdminStorage() {
  const [usageBytes, setUsageBytes] = useState(0)
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    async function fetchUsage() {
      const { data } = await supabase.storage.from('delivery-photos').list('', { limit: 10000 })
      const total = (data ?? []).reduce((sum, f) => sum + (f.metadata?.size ?? 0), 0)
      setUsageBytes(total)
      setLoading(false)
    }
    fetchUsage()
  }, [])

  const usageGB = usageBytes / 1024 / 1024 / 1024
  const pct = Math.min((usageGB / STORAGE_LIMIT_GB) * 100, 100)

  async function downloadZip() {
    setDownloading(true)
    const res = await fetch(`/api/admin/storage/download?from=${from}&to=${to}`)
    if (res.ok) {
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `photos_${from}_${to}.zip`
      a.click()
    }
    setDownloading(false)
  }

  return (
    <div className="max-w-xl">
      <h2 className="text-xl font-bold text-gray-800 mb-6">스토리지 관리</h2>

      <div className="bg-white rounded-xl border p-6 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">스토리지 사용량</span>
          <span className="text-sm text-gray-500">{loading ? '...' : `${(usageGB * 1024).toFixed(0)} MB / 1 GB`}</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-3">
          <div
            className="bg-blue-500 h-3 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-gray-400 mt-1">{pct.toFixed(1)}% 사용 중</p>
      </div>

      <div className="bg-white rounded-xl border p-6">
        <h3 className="font-medium text-gray-800 mb-4">사진 ZIP 다운로드</h3>
        <div className="flex gap-3 mb-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">시작일</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">종료일</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm" />
          </div>
        </div>
        <button
          onClick={downloadZip}
          disabled={downloading || !from || !to}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {downloading ? '다운로드 중...' : 'ZIP 다운로드'}
        </button>
      </div>
    </div>
  )
}
