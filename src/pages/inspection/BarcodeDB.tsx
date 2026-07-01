import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

interface Barcode {
  id: string
  barcode: string
  product_code: string
  product_name: string
  created_at: string
}

export default function BarcodeDB() {
  const [barcodes, setBarcodes] = useState<Barcode[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadMsg('')

    const text = await file.text()
    const lines = text.split(/\r?\n/).filter(l => l.trim())
    if (lines.length < 2) {
      setUploadMsg('데이터가 없습니다.')
      setUploading(false)
      return
    }

    // 이카운트 형식: 상품코드, 상품명, 바코드
    const rows = lines.slice(1).map(line => {
      const cols = line.split(',')
      return {
        product_code: cols[0]?.trim() || '',
        product_name: cols[1]?.trim() || '',
        barcode: cols[2]?.trim() || '',
      }
    }).filter(r => r.barcode && r.product_code)

    // 같은 파일 내 중복 바코드 제거 (마지막 행 기준)
    const deduped = Object.values(
      Object.fromEntries(rows.map(r => [r.barcode, r]))
    )

    if (!deduped.length) {
      setUploadMsg('파싱된 데이터가 없습니다.')
      setUploading(false)
      return
    }

    const { error } = await supabase
      .from('barcodes')
      .upsert(deduped, { onConflict: 'barcode' })

    if (error) {
      setUploadMsg(`오류: ${error.message}`)
    } else {
      setUploadMsg(`✅ ${deduped.length}건 업로드 완료`)
      // 목록 새로고침
      const { data } = await supabase.from('barcodes').select('*').order('created_at', { ascending: false })
      setBarcodes(data ?? [])
    }
    setUploading(false)
    e.target.value = ''
  }

  useEffect(() => {
    supabase
      .from('barcodes')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setBarcodes(data ?? [])
        setLoading(false)
      })
  }, [])

  function downloadExcel() {
    const rows = [
      ['상품코드', '상품명', '바코드'],
      ...barcodes.map(b => [b.product_code, b.product_name, b.barcode]),
    ]
    const csv = rows.map(r => r.join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `barcodes_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const filtered = barcodes.filter(b =>
    b.product_name.includes(search) ||
    b.product_code.includes(search) ||
    b.barcode.includes(search)
  )

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800">바코드 DB</h2>
        <div className="flex items-center gap-2">
          {uploadMsg && <span className="text-sm text-gray-500">{uploadMsg}</span>}
          <input ref={uploadRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} />
          <button
            onClick={() => uploadRef.current?.click()}
            disabled={uploading}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {uploading ? '업로드 중...' : '이카운트 CSV 업로드'}
          </button>
          <button
            onClick={downloadExcel}
            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700"
          >
            CSV 다운로드
          </button>
        </div>
      </div>

      <div className="mb-4">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="상품명 / 상품코드 / 바코드 검색"
          className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-gray-400 text-sm">불러오는 중...</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">상품명</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 w-36">상품코드</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 w-36">바코드</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={3} className="text-center py-12 text-gray-400">데이터가 없습니다.</td></tr>
              )}
              {filtered.map(b => (
                <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-800">{b.product_name}</td>
                  <td className="px-4 py-3 font-mono text-gray-500 text-xs">{b.product_code}</td>
                  <td className="px-4 py-3 font-mono text-gray-500 text-xs">{b.barcode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="mt-2 text-xs text-gray-400 text-right">총 {filtered.length}개</p>
    </div>
  )
}
