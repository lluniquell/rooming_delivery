import { useEffect, useState } from 'react'
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
        <button
          onClick={downloadExcel}
          className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700"
        >
          이카운트용 CSV 다운로드
        </button>
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
