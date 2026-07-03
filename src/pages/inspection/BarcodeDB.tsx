import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

interface Barcode {
  id: string
  barcode: string
  product_code: string
  product_name: string
  location: string | null
  created_at: string
}

const PAGE_SIZE = 100

export default function BarcodeDB() {
  const [barcodes, setBarcodes] = useState<Barcode[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)

  async function fetchBarcodes(p: number, q: string) {
    setLoading(true)
    let query = supabase
      .from('barcodes')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)

    if (q) {
      query = query.or(`product_name.ilike.%${q}%,product_code.ilike.%${q}%,barcode.ilike.%${q}%`)
    }

    const { data, count } = await query
    setBarcodes(data ?? [])
    setTotal(count ?? 0)
    setLoading(false)
  }

  useEffect(() => { fetchBarcodes(page, search) }, [page, search])

  function doSearch() {
    setPage(0)
    setSearch(searchInput)
  }

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

    const clean = (v?: string) => (v ?? '').replace(/[\t"]/g, '').trim()

    const rows = lines.slice(1).map(line => {
      const cols = line.split('","')
      return {
        product_code: clean(cols[0]),
        product_name: clean(cols[1]),
        barcode: clean(cols[2]),
      }
    }).filter(r => r.barcode && r.product_code)

    const deduped = Object.values(Object.fromEntries(rows.map(r => [r.barcode, r])))

    if (!deduped.length) {
      setUploadMsg('파싱된 데이터가 없습니다.')
      setUploading(false)
      return
    }

    const { error } = await supabase.from('barcodes').upsert(deduped, { onConflict: 'barcode' })

    if (error) {
      setUploadMsg(`오류: ${error.message}`)
    } else {
      setUploadMsg(`✅ ${deduped.length}건 업로드 완료`)
      fetchBarcodes(0, search)
      setPage(0)
    }
    setUploading(false)
    e.target.value = ''
  }

  async function downloadExcel() {
    // 전체 다운로드 - 페이지 순회
    let all: Barcode[] = []
    let from = 0
    while (true) {
      const { data } = await supabase.from('barcodes').select('*').order('created_at', { ascending: false }).range(from, from + 999)
      if (!data?.length) break
      all = all.concat(data)
      if (data.length < 1000) break
      from += 1000
    }
    const rows = [
      ['상품코드', '상품명', '바코드', '로케이션'],
      ...all.map(b => [b.product_code, b.product_name, b.barcode ?? '', b.location ?? '']),
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

  const totalPages = Math.ceil(total / PAGE_SIZE)

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
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doSearch()}
          placeholder="상품명 / 상품코드 / 바코드 검색 후 Enter"
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
                <th className="text-left px-4 py-3 font-medium text-gray-600 w-28">로케이션</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {barcodes.length === 0 && (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400">데이터가 없습니다.</td></tr>
              )}
              {barcodes.map(b => (
                <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50 group">
                  <td className="px-4 py-3 text-gray-800">{b.product_name}</td>
                  <td className="px-4 py-3 font-mono text-gray-500 text-xs">{b.product_code}</td>
                  <td className="px-4 py-3 font-mono text-gray-500 text-xs">{b.barcode}</td>
                  <td className="px-4 py-3 font-mono text-blue-500 text-xs">{b.location ?? ''}</td>
                  <td className="px-2 py-3">
                    <button
                      onClick={async () => {
                        if (!confirm(`삭제할까요?\n${b.product_name} / ${b.barcode}`)) return
                        await supabase.from('barcodes').delete().eq('id', b.id)
                        fetchBarcodes(page, search)
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-opacity text-xs px-1"
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <span>총 {total.toLocaleString()}개</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(0)} disabled={page === 0} className="px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-30">«</button>
            <button onClick={() => setPage(p => p - 1)} disabled={page === 0} className="px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-30">‹</button>
            <span className="px-2">{page + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1} className="px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-30">›</button>
            <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1} className="px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-30">»</button>
          </div>
        )}
      </div>
    </div>
  )
}
