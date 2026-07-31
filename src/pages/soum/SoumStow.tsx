import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

interface BarcodeRow {
  id: number
  product_code: string
  product_name: string
  location: string | null
}

interface ProductCandidate {
  product_code: string
  product_name: string
  barcode: string | null
}

interface FindCandidate {
  id: number
  product_code: string
  product_name: string
  barcode: string | null
  location: string | null
}

type Scan =
  | { mode: 'found'; barcode: string; row: BarcodeRow }
  | { mode: 'not_found'; barcode: string }

export default function SoumStow() {
  const [staffName, setStaffName] = useState('')
  const [barcodeInput, setBarcodeInput] = useState('')
  const [scan, setScan] = useState<Scan | null>(null)
  const [locationValue, setLocationValue] = useState('')
  const [quantityValue, setQuantityValue] = useState('1')
  const [barcodeValue, setBarcodeValue] = useState('')
  const [manualForm, setManualForm] = useState({ product_code: '', product_name: '' })
  const [productQuery, setProductQuery] = useState('')
  const [productResults, setProductResults] = useState<ProductCandidate[]>([])
  const [message, setMessage] = useState('')
  const [todayCount, setTodayCount] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findResults, setFindResults] = useState<FindCandidate[]>([])

  const barcodeRef = useRef<HTMLInputElement>(null)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const findSearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    barcodeRef.current?.focus()
    loadTodayCount()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('drivers').select('name').eq('id', user.id).maybeSingle()
        .then(({ data }) => { if (data) setStaffName(data.name) })
    })
  }, [])

  async function loadTodayCount() {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
    const { count } = await supabase
      .from('stow_events')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', dayStart.toISOString())
    setTodayCount(count ?? 0)
  }

  function reset() {
    setScan(null)
    setBarcodeInput('')
    setLocationValue('')
    setQuantityValue('1')
    setBarcodeValue('')
    setManualForm({ product_code: '', product_name: '' })
    setProductQuery('')
    setProductResults([])
    setFindOpen(false)
    setFindQuery('')
    setFindResults([])
    setTimeout(() => barcodeRef.current?.focus(), 50)
  }

  // 상품 찾기 — 바코드 없이 상품명/코드로 먼저 찾아서 진열하는 경로. 골라진 상품은
  // barcodes에 이미 있는 행이라 '찾음' 상태와 동일하게 취급해 바코드/위치/수량 폼을 그대로 재사용
  async function searchFind(q: string) {
    const query = q.trim()
    if (!query) { setFindResults([]); return }
    const { data } = await supabase
      .from('barcodes')
      .select('id, product_code, product_name, barcode, location')
      .or(`barcode.ilike.%${query}%,product_name.ilike.%${query}%,product_code.ilike.%${query}%`)
      .limit(8)
    setFindResults((data ?? []) as FindCandidate[])
  }

  function selectFindCandidate(p: FindCandidate) {
    setMessage('')
    setScan({ mode: 'found', barcode: p.barcode ?? '', row: { id: p.id, product_code: p.product_code, product_name: p.product_name, location: p.location } })
    setBarcodeValue(p.barcode ?? '')
    setLocationValue(p.location ?? '')
    setQuantityValue('1')
    setFindOpen(false)
    setFindQuery('')
    setFindResults([])
  }

  async function lookupBarcode(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = barcodeInput.trim()
    if (!trimmed) return
    setMessage('')
    const { data } = await supabase.from('barcodes').select('id, product_code, product_name, location').eq('barcode', trimmed).maybeSingle()
    if (data) {
      setScan({ mode: 'found', barcode: trimmed, row: data })
      setLocationValue(data.location ?? '')
      setQuantityValue('1')
      setBarcodeValue(trimmed)
    } else {
      setScan({ mode: 'not_found', barcode: trimmed })
      setLocationValue('')
      setQuantityValue('1')
      setManualForm({ product_code: '', product_name: '' })
    }
  }

  async function searchProducts(q: string) {
    const query = q.trim()
    if (!query) { setProductResults([]); return }
    const { data } = await supabase
      .from('barcodes')
      .select('product_code, product_name, barcode')
      .or(`barcode.ilike.%${query}%,product_name.ilike.%${query}%,product_code.ilike.%${query}%`)
      .limit(8)
    const seen = new Set<string>()
    const deduped: ProductCandidate[] = []
    for (const row of (data ?? []) as ProductCandidate[]) {
      if (seen.has(row.product_code)) continue
      seen.add(row.product_code)
      deduped.push(row)
    }
    setProductResults(deduped)
  }

  async function confirmStow() {
    if (scan?.mode !== 'found') return
    const location = locationValue.trim()
    const quantity = Number(quantityValue)
    const barcode = barcodeValue.trim()
    if (!barcode) { alert('바코드를 입력해주세요.'); return }
    if (!location) { alert('위치를 입력해주세요.'); return }
    if (!quantity || quantity <= 0) { alert('수량을 입력해주세요.'); return }

    if (location !== (scan.row.location ?? '') || barcode !== scan.barcode) {
      const { error: updateError } = await supabase.from('barcodes').update({ location, barcode }).eq('id', scan.row.id)
      if (updateError) { alert(`바코드/위치 수정 실패: ${updateError.message}`); return }
    }
    const { error } = await supabase.from('stow_events').insert({
      barcode,
      product_code: scan.row.product_code,
      product_name: scan.row.product_name,
      location,
      quantity,
      staff_name: staffName,
    })
    if (error) { alert(`진열 기록 실패: ${error.message}`); return }

    setMessage(`✅ ${scan.row.product_name} → ${location} 진열 완료`)
    setTodayCount(c => c + 1)
    reset()
  }

  async function registerAndStow() {
    if (scan?.mode !== 'not_found') return
    const product_code = manualForm.product_code.trim()
    const product_name = manualForm.product_name.trim()
    const location = locationValue.trim()
    const quantity = Number(quantityValue)
    if (!product_code || !product_name) { alert('검색해서 상품을 고르거나, 상품코드/상품명을 입력해주세요.'); return }
    if (!location) { alert('위치를 입력해주세요.'); return }
    if (!quantity || quantity <= 0) { alert('수량을 입력해주세요.'); return }

    const { error: insertBarcodeError } = await supabase.from('barcodes').insert({
      barcode: scan.barcode,
      product_code,
      product_name,
      location,
    })
    if (insertBarcodeError) { alert(`바코드 등록 실패: ${insertBarcodeError.message}`); return }

    const { error } = await supabase.from('stow_events').insert({
      barcode: scan.barcode,
      product_code,
      product_name,
      location,
      quantity,
      staff_name: staffName,
    })
    if (error) { alert(`진열 기록 실패: ${error.message}`); return }

    setMessage(`✅ ${product_name} → ${location} 신규 등록 + 진열 완료`)
    setTodayCount(c => c + 1)
    reset()
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">입고 진열</h2>
        <span className="text-xs text-gray-400">오늘 {todayCount}건</span>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          type="button"
          onClick={() => setFindOpen(v => !v)}
          className="px-3 py-2.5 rounded-lg text-sm font-medium border border-gray-300 text-gray-600 shrink-0"
        >
          상품 찾기
        </button>
        <form onSubmit={lookupBarcode} className="flex gap-2 flex-1">
          <input
            ref={barcodeRef}
            value={barcodeInput}
            onChange={e => setBarcodeInput(e.target.value)}
            placeholder="바코드 스캔 또는 입력"
            inputMode="numeric"
            pattern="[0-9]*"
            className="flex-1 min-w-0 border rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button type="submit" className="px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700">
            조회
          </button>
        </form>
      </div>

      {findOpen && (
        <div className="relative mb-4">
          <input
            autoFocus
            value={findQuery}
            onChange={e => {
              const v = e.target.value
              setFindQuery(v)
              if (findSearchTimeout.current) clearTimeout(findSearchTimeout.current)
              findSearchTimeout.current = setTimeout(() => searchFind(v), 300)
            }}
            placeholder="상품명 또는 상품코드로 검색"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          {findResults.length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg divide-y max-h-52 overflow-y-auto">
              {findResults.map(p => (
                <button
                  key={p.id}
                  onClick={() => selectFindCandidate(p)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-indigo-50"
                >
                  <div className="font-medium text-gray-800">{p.product_name}</div>
                  <div className="text-gray-400 font-mono">
                    {p.product_code}{p.barcode ? ` · ${p.barcode}` : ''}{p.location ? ` · ${p.location}` : ''}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {message && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 mb-4 text-sm text-green-700">
          {message}
        </div>
      )}

      {scan?.mode === 'found' && (
        <div className="bg-white rounded-xl border p-4 space-y-3">
          <div>
            <div className="text-sm font-medium text-gray-800">{scan.row.product_name}</div>
            <div className="text-xs text-gray-400 font-mono">{scan.row.product_code}</div>
            {scan.row.location && (
              <div className="text-xs text-gray-400 mt-0.5">현재 위치: <span className="font-mono">{scan.row.location}</span></div>
            )}
          </div>
          <input
            value={barcodeValue}
            onChange={e => setBarcodeValue(e.target.value)}
            placeholder="바코드"
            inputMode="numeric"
            pattern="[0-9]*"
            className="w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <input
            autoFocus
            value={locationValue}
            onChange={e => setLocationValue(e.target.value)}
            placeholder="위치 (예: NK-A-01)"
            className="w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <input
            type="number"
            min={1}
            value={quantityValue}
            onChange={e => setQuantityValue(e.target.value)}
            placeholder="수량"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <div className="flex gap-2">
            <button onClick={reset} className="flex-1 py-2 rounded-lg text-sm text-gray-500 border border-gray-300">취소</button>
            <button onClick={confirmStow} className="flex-1 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700">진열 완료</button>
          </div>
        </div>
      )}

      {scan?.mode === 'not_found' && (
        <div className="bg-white rounded-xl border p-4 space-y-3">
          <p className="text-xs text-gray-500">등록되지 않은 바코드입니다 (<span className="font-mono">{scan.barcode}</span>). 상품을 찾아서 새로 등록해주세요.</p>
          <div className="relative">
            <input
              autoFocus
              value={productQuery}
              onChange={e => {
                const v = e.target.value
                setProductQuery(v)
                if (searchTimeout.current) clearTimeout(searchTimeout.current)
                searchTimeout.current = setTimeout(() => searchProducts(v), 300)
              }}
              placeholder="상품명 또는 상품코드로 검색"
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            {productResults.length > 0 && (
              <div className="absolute z-10 left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg divide-y max-h-40 overflow-y-auto">
                {productResults.map(p => (
                  <button
                    key={p.product_code}
                    onClick={() => {
                      setManualForm({ product_code: p.product_code, product_name: p.product_name })
                      setProductQuery('')
                      setProductResults([])
                    }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-indigo-50"
                  >
                    <div className="font-medium text-gray-800">{p.product_name}</div>
                    <div className="text-gray-400 font-mono">{p.product_code}{p.barcode ? ` · ${p.barcode}` : ''}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {manualForm.product_code && (
            <p className="text-[11px] text-gray-400 font-mono px-0.5">선택됨: {manualForm.product_name} ({manualForm.product_code})</p>
          )}
          <input
            value={locationValue}
            onChange={e => setLocationValue(e.target.value)}
            placeholder="위치 (예: NK-A-01)"
            className="w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <input
            type="number"
            min={1}
            value={quantityValue}
            onChange={e => setQuantityValue(e.target.value)}
            placeholder="수량"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <div className="flex gap-2">
            <button onClick={reset} className="flex-1 py-2 rounded-lg text-sm text-gray-500 border border-gray-300">취소</button>
            <button onClick={registerAndStow} className="flex-1 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700">등록 + 진열 완료</button>
          </div>
        </div>
      )}
    </div>
  )
}
