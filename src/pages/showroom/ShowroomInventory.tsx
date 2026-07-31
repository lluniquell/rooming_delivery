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

interface ThumbnailState {
  product_name: string
  loading: boolean
  image: string | null
  title: string | null
  error: string | null
}

export default function ShowroomInventory() {
  const [barcodeInput, setBarcodeInput] = useState('')
  const [scan, setScan] = useState<Scan | null>(null)
  const [nameQuery, setNameQuery] = useState('')
  const [nameResults, setNameResults] = useState<SearchResult[]>([])
  const [thumbnail, setThumbnail] = useState<ThumbnailState | null>(null)

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

  // 바코드DB엔 이미지 정보가 없어서, 같은 상품코드의 수집된 주문(order_items)에 남아있는
  // product_no(카페24 상품번호)로 온라인몰 공개 페이지의 썸네일을 가져옴 — SoumPicking.tsx와 동일한 방식
  async function showThumbnail(product_code: string, product_name: string) {
    setThumbnail({ product_name, loading: true, image: null, title: null, error: null })
    const { data } = await supabase
      .from('order_items')
      .select('product_no')
      .eq('product_code', product_code)
      .not('product_no', 'is', null)
      .limit(1)
      .maybeSingle()
    if (!data?.product_no) {
      setThumbnail({ product_name, loading: false, image: null, title: null, error: '이미지를 불러올 수 없습니다.' })
      return
    }
    try {
      const res = await fetch(`/api/product-thumbnail?product_no=${data.product_no}`)
      const result = await res.json()
      if (!res.ok) throw new Error(result.error ?? '조회 실패')
      setThumbnail({ product_name, loading: false, image: result.image, title: result.title, error: null })
    } catch (e: any) {
      setThumbnail({ product_name, loading: false, image: null, title: null, error: e.message })
    }
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
          <button
            onClick={() => showThumbnail(scan.row.product_code, scan.row.product_name)}
            className="text-sm font-medium text-gray-800 text-left underline decoration-dotted underline-offset-2"
          >
            {scan.row.product_name}
          </button>
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
                    <button
                      onClick={() => showThumbnail(r.product_code, r.product_name)}
                      className="text-sm text-gray-800 text-left truncate underline decoration-dotted underline-offset-2"
                    >
                      {r.product_name}
                    </button>
                    <div className="text-[11px] text-gray-400 font-mono">{r.product_code}{r.barcode ? ` · ${r.barcode}` : ''}</div>
                  </div>
                  <div className="text-sm font-bold text-indigo-600 font-mono shrink-0">{r.location || '미등록'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {thumbnail && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setThumbnail(null)}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-2 gap-2">
              <span className="text-sm font-medium text-gray-800">{thumbnail.title ?? thumbnail.product_name}</span>
              <button onClick={() => setThumbnail(null)} className="text-gray-400 text-xl leading-none px-1 shrink-0">×</button>
            </div>
            {thumbnail.loading ? (
              <p className="text-center text-gray-400 py-16 text-sm">불러오는 중...</p>
            ) : thumbnail.image ? (
              <img src={thumbnail.image} alt={thumbnail.title ?? ''} className="w-full rounded-lg" />
            ) : (
              <p className="text-center text-gray-400 py-16 text-sm">{thumbnail.error ?? '이미지를 찾을 수 없습니다.'}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
