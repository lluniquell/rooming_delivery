import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

interface BarcodeRow {
  product_code: string
  product_name: string
  location: string | null
}

interface SearchResult {
  product_code: string
  product_name: string
  barcode: string | null
  location: string | null
}

type Scan =
  | { mode: 'found'; barcode: string; row: BarcodeRow }
  | { mode: 'not_found'; barcode: string }

export default function ShowroomInventory() {
  const [barcodeInput, setBarcodeInput] = useState('')
  const [scan, setScan] = useState<Scan | null>(null)
  const [nameQuery, setNameQuery] = useState('')
  const [nameResults, setNameResults] = useState<SearchResult[]>([])

  const barcodeRef = useRef<HTMLInputElement>(null)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    barcodeRef.current?.focus()
  }, [])

  async function lookupBarcode(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = barcodeInput.trim()
    if (!trimmed) return
    const { data } = await supabase.from('barcodes').select('product_code, product_name, location').eq('barcode', trimmed).maybeSingle()
    setScan(data ? { mode: 'found', barcode: trimmed, row: data } : { mode: 'not_found', barcode: trimmed })
    setBarcodeInput('')
    setNameQuery('')
    setNameResults([])
    barcodeRef.current?.focus()
  }

  async function searchByName(q: string) {
    const query = q.trim()
    if (!query) { setNameResults([]); return }
    const { data } = await supabase
      .from('barcodes')
      .select('product_code, product_name, barcode, location')
      .or(`product_name.ilike.%${query}%,product_code.ilike.%${query}%`)
      .limit(10)
    const seen = new Set<string>()
    const deduped: SearchResult[] = []
    for (const row of (data ?? []) as SearchResult[]) {
      if (seen.has(row.product_code)) continue
      seen.add(row.product_code)
      deduped.push(row)
    }
    setNameResults(deduped)
  }

  return (
    <div className="max-w-md mx-auto">
      <h2 className="text-lg font-bold text-gray-800 mb-4">재고 위치</h2>

      <form onSubmit={lookupBarcode} className="flex gap-2 mb-4">
        <input
          ref={barcodeRef}
          value={barcodeInput}
          onChange={e => setBarcodeInput(e.target.value)}
          placeholder="바코드 스캔 또는 입력"
          inputMode="numeric"
          pattern="[0-9]*"
          className="flex-1 border rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
        <button type="submit" className="px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700">
          조회
        </button>
      </form>

      {scan?.mode === 'found' && (
        <div className="bg-white rounded-xl border p-4">
          <div className="text-sm font-medium text-gray-800">{scan.row.product_name}</div>
          <div className="text-xs text-gray-400 font-mono mt-0.5">{scan.row.product_code} · {scan.barcode}</div>
          <div className="mt-3 text-2xl font-bold text-indigo-600 font-mono">
            {scan.row.location || '위치 미등록'}
          </div>
        </div>
      )}

      {scan?.mode === 'not_found' && (
        <div className="bg-white rounded-xl border p-4 space-y-3">
          <p className="text-sm text-gray-500">
            등록되지 않은 바코드입니다 (<span className="font-mono">{scan.barcode}</span>). 상품명으로 찾아보세요.
          </p>
          <input
            autoFocus
            value={nameQuery}
            onChange={e => {
              const v = e.target.value
              setNameQuery(v)
              if (searchTimeout.current) clearTimeout(searchTimeout.current)
              searchTimeout.current = setTimeout(() => searchByName(v), 300)
            }}
            placeholder="상품명 또는 상품코드로 검색"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          {nameResults.length > 0 && (
            <div className="divide-y border rounded-lg overflow-hidden">
              {nameResults.map(r => (
                <div key={r.product_code} className="px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-gray-800 truncate">{r.product_name}</div>
                    <div className="text-[11px] text-gray-400 font-mono">{r.product_code}{r.barcode ? ` · ${r.barcode}` : ''}</div>
                  </div>
                  <div className="text-sm font-bold text-indigo-600 font-mono shrink-0">{r.location || '미등록'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
