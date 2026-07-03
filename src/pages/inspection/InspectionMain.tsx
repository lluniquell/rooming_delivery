import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

function parseInvoiceNo(raw: string): string {
  const trimmed = raw.trim()
  const n = Number(trimmed)
  if (!isNaN(n) && (trimmed.includes('E') || trimmed.includes('e'))) {
    return Math.round(n).toString()
  }
  return trimmed
}

interface InspectionItem {
  id: string
  invoice_no: string
  customer_name: string
  brand: string | null
  product_code: string
  product_name: string
  option_info: string | null
  supplier_name: string | null
  quantity: number
  inspected_qty: number
}

interface UnregisteredModal {
  barcode: string
  candidates: InspectionItem[]
}

interface PendingInvoice {
  invoice_no: string
  customer_name: string
  item_count: number
}

export default function InspectionMain() {
  const [invoiceNo, setInvoiceNo] = useState('')
  const [items, setItems] = useState<InspectionItem[]>([])
  const [barcode, setBarcode] = useState('')
  const [modal, setModal] = useState<UnregisteredModal | null>(null)
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(false)
  const [pendingList, setPendingList] = useState<PendingInvoice[]>([])
  const [showPending, setShowPending] = useState(false)

  const invoiceRef = useRef<HTMLInputElement>(null)
  const barcodeRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const [hasUploaded, setHasUploaded] = useState(false)

  async function downloadPickingList() {
    const { data: items } = await supabase.from('inspection_items').select('product_code, brand, product_name, option_info, supplier_name, quantity')
    if (!items) return

    const locationRegex = /[A-Z]{2}-\d{2}-\d{2}-\d{2}/
    const rows = items
      .map(i => {
        const supplier = i.supplier_name ?? ''
        const location = supplier.match(locationRegex)?.[0] ?? ''
        const supplier_note = supplier.replace(locationRegex, '').replace(/^\s*[|｜]\s*|\s*[|｜]\s*$/g, '').trim()
        return { location, brand: i.brand ?? '', product_name: i.product_name, option_info: i.option_info ?? '', supplier_note, quantity: i.quantity }
      })
      .sort((a, b) => a.location.localeCompare(b.location))

    const csv = [
      ['로케이션', '브랜드', '상품명', '옵션', '공급사 상품명', '주문수량'],
      ...rows.map(r => [r.location, r.brand, r.product_name, r.option_info, r.supplier_note, r.quantity]),
    ].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `픽킹리스트_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function loadPending() {
    const { data } = await supabase
      .from('inspection_items')
      .select('invoice_no, customer_name')
    if (!data) return
    const map: Record<string, PendingInvoice> = {}
    for (const row of data) {
      if (!map[row.invoice_no]) {
        map[row.invoice_no] = { invoice_no: row.invoice_no, customer_name: row.customer_name, item_count: 0 }
      }
      map[row.invoice_no].item_count++
    }
    setPendingList(Object.values(map))
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

    // 헤더: 브랜드,상품명,상품옵션,상품품목코드,수량,수령인,운송장번호,공급사 상품명
    // 포맷: "값","값","값" — 구분자는 ","
    const clean = (v?: string) => (v ?? '').replace(/^["'\s]+|["'\s]+$/g, '').trim()

    const rows = lines.slice(1).map(line => {
      const cols = line.split('","')
      return {
        brand: clean(cols[0]) || null,
        product_name: clean(cols[1]),
        option_info: clean(cols[2]) || null,
        product_code: clean(cols[3]),
        quantity: parseInt(clean(cols[4]) || '1', 10) || 1,
        customer_name: clean(cols[5]),
        invoice_no: parseInvoiceNo(clean(cols[6])),
        supplier_name: clean(cols[7]) || null,
        inspected_qty: 0,
      }
    }).filter(r => r.invoice_no && r.product_code)

    if (!rows.length) {
      setUploadMsg('파싱된 데이터가 없습니다. 컬럼 순서를 확인하세요.')
      setUploading(false)
      return
    }

    const { error } = await supabase.from('inspection_items').insert(rows)
    if (error) {
      setUploadMsg(`오류: ${error.message}`)
    } else {
      // 공급사 상품명에서 로케이션 추출 → barcodes 업데이트
      const locationRegex = /[A-Z]{2}-\d{2}-\d{2}-\d{2}/
      const locationUpdates = rows
        .map(r => ({ product_code: r.product_code, location: (r.supplier_name ?? '').match(locationRegex)?.[0] ?? null }))
        .filter(r => r.location)
      for (const u of locationUpdates) {
        await supabase.from('barcodes').update({ location: u.location }).eq('product_code', u.product_code)
      }
      setUploadMsg(`✅ ${rows.length}건 업로드 완료`)
      setHasUploaded(true)
      loadPending()
    }
    setUploading(false)
    e.target.value = ''
  }

  useEffect(() => {
    invoiceRef.current?.focus()
    loadPending()
  }, [])

  useEffect(() => {
    if (done) {
      // A: 검수 완료 시 자동 삭제 (카페24 API 연동 예정)
      deleteInvoice(items[0]?.invoice_no).then(() => {
        setTimeout(() => {
          setDone(false)
          setItems([])
          setInvoiceNo('')
          setMessage('')
          invoiceRef.current?.focus()
        }, 2000)
      })
    }
  }, [done])

  async function deleteInvoice(invoice: string) {
    if (!invoice) return
    await supabase.from('inspection_items').delete().eq('invoice_no', invoice)
    // TODO: 카페24 API - 해당 운송장 배송완료 처리
    loadPending()
  }

  async function loadInvoice(e: React.FormEvent) {
    e.preventDefault()
    if (!invoiceNo.trim()) return

    const { data, error } = await supabase
      .from('inspection_items')
      .select('*')
      .eq('invoice_no', invoiceNo.trim())

    if (error || !data?.length) {
      setMessage('해당 운송장번호의 주문이 없습니다.')
      setItems([])
      return
    }

    setItems(data)
    setMessage('')
    setTimeout(() => barcodeRef.current?.focus(), 100)
  }

  async function handleBarcodeScan(e: React.FormEvent) {
    e.preventDefault()
    if (!barcode.trim() || !items.length) return

    const scanned = barcode.trim()
    setBarcode('')

    // barcodes 테이블에서 조회
    const { data: bcData } = await supabase
      .from('barcodes')
      .select('product_code')
      .eq('barcode', scanned)
      .single()

    if (bcData) {
      const matched = items.find(i => i.product_code === bcData.product_code)
      if (!matched) {
        setMessage(`중복 바코드 또는 잘못 등록된 바코드입니다. (DB: ${bcData.product_code})`)
      } else {
        await countUp(bcData.product_code)
      }
    } else {
      // 미등록 바코드 → 모달
      setModal({ barcode: scanned, candidates: items })
    }

    barcodeRef.current?.focus()
  }

  async function countUp(productCode: string) {
    const target = items.find(i => i.product_code === productCode)
    if (!target) {
      setMessage(`현재 주문에 없는 상품입니다. (${productCode})`)
      return
    }
    if (target.inspected_qty >= target.quantity) {
      setMessage(`이미 수량이 완료된 상품입니다. (${target.product_name})`)
      return
    }

    const newQty = target.inspected_qty + 1
    await supabase
      .from('inspection_items')
      .update({ inspected_qty: newQty })
      .eq('id', target.id)

    const updated = items.map(i =>
      i.id === target.id ? { ...i, inspected_qty: newQty } : i
    )
    setItems(updated)
    setMessage('')

    if (updated.every(i => i.inspected_qty >= i.quantity)) {
      setDone(true)
    }
  }

  async function registerBarcode(item: InspectionItem) {
    if (!modal) return

    await supabase.from('barcodes').upsert({
      barcode: modal.barcode,
      product_code: item.product_code,
      product_name: item.product_name,
    }, { onConflict: 'barcode' })

    setModal(null)
    await countUp(item.product_code)
  }

  const allDone = items.length > 0 && items.every(i => i.inspected_qty >= i.quantity)

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">바코드 검수</h2>
        <div className="flex items-center gap-2">
          {hasUploaded && (
            <button
              onClick={downloadPickingList}
              className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700"
            >
              픽킹 리스트 다운로드
            </button>
          )}
          {uploadMsg && <span className="text-sm text-gray-500">{uploadMsg}</span>}
          {pendingList.length > 0 && (
            <button
              onClick={() => setShowPending(v => !v)}
              className="text-sm text-gray-500 hover:text-gray-800 px-3 py-1.5 rounded-lg border hover:bg-gray-50"
            >
              잔여 <span className="font-bold text-blue-600">{pendingList.length}</span>건
            </button>
          )}
          <input ref={uploadRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleUpload} />
          <button
            onClick={() => uploadRef.current?.click()}
            disabled={uploading}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {uploading ? '업로드 중...' : '주문 엑셀 업로드'}
          </button>
        </div>
      </div>

      {/* 잔여 주문 목록 */}
      {showPending && (
        <div className="bg-white rounded-xl border mb-4 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">잔여 주문 목록</span>
            <button onClick={() => setShowPending(false)} className="text-gray-400 hover:text-gray-600 text-xs">닫기</button>
          </div>
          <div className="divide-y max-h-64 overflow-y-auto">
            {pendingList.map(p => (
              <button
                key={p.invoice_no}
                onClick={() => {
                  setInvoiceNo(p.invoice_no)
                  setShowPending(false)
                  // 자동 조회
                  supabase.from('inspection_items').select('*').eq('invoice_no', p.invoice_no).then(({ data }) => {
                    if (data?.length) { setItems(data); setMessage(''); setTimeout(() => barcodeRef.current?.focus(), 100) }
                  })
                }}
                className="w-full text-left px-4 py-3 hover:bg-blue-50 flex items-center justify-between"
              >
                <div>
                  <span className="text-sm font-medium text-gray-800">{p.customer_name}</span>
                  <span className="text-xs font-mono text-gray-400 ml-2">{p.invoice_no}</span>
                </div>
                <span className="text-xs text-gray-400">{p.item_count}종</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 운송장 입력 */}
      <form onSubmit={loadInvoice} className="bg-white rounded-xl border p-4 mb-4 flex gap-2">
        <input
          ref={invoiceRef}
          value={invoiceNo}
          onChange={e => setInvoiceNo(e.target.value)}
          placeholder="운송장번호 스캔 또는 입력"
          className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          조회
        </button>
      </form>

      {/* 완료 배너 */}
      {(allDone || done) && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-center">
          <p className="text-green-700 font-bold text-lg">✅ 검수 완료!</p>
          <p className="text-green-600 text-sm mt-1">다음 운송장을 스캔하세요</p>
        </div>
      )}

      {/* 주문 목록 */}
      {items.length > 0 && (
        <div className="bg-white rounded-xl border mb-4 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <div>
              <span className="font-medium text-gray-800">{items[0].customer_name}</span>
              <span className="text-sm font-mono text-gray-400 ml-3">{items[0].invoice_no}</span>
            </div>
            <button
              onClick={async () => {
                if (!confirm('이 운송장 주문을 DB에서 삭제할까요?')) return
                await deleteInvoice(items[0].invoice_no)
                setItems([])
                setInvoiceNo('')
                setMessage('삭제됐습니다.')
                invoiceRef.current?.focus()
              }}
              className="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
            >
              삭제
            </button>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs w-24">브랜드</th>
                <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">상품명 / 옵션</th>
                <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs w-36">공급사 상품명</th>
                <th className="text-center px-3 py-2 font-medium text-gray-500 text-xs w-14">수량</th>
                <th className="text-center px-3 py-2 font-medium text-gray-500 text-xs w-14">검수</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => {
                const complete = item.inspected_qty >= item.quantity
                return (
                  <tr key={item.id} className={`border-b last:border-0 ${complete ? 'bg-green-50' : ''}`}>
                    <td className={`px-3 py-3 text-xs ${complete ? 'text-green-600' : 'text-gray-500'}`}>
                      {item.brand ?? '-'}
                    </td>
                    <td className="px-3 py-3">
                      <div className={`text-sm ${complete ? 'text-green-700 font-medium' : 'text-gray-800'}`}>
                        {item.product_name}
                      </div>
                      {item.option_info && (
                        <div className="text-xs text-gray-400 mt-0.5">{item.option_info}</div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-xs text-gray-400 leading-tight">{item.supplier_name ?? '-'}</div>
                    </td>
                    <td className="text-center px-3 py-3 text-gray-600 text-sm">{item.quantity}</td>
                    <td className="text-center px-3 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <span className={`text-sm font-bold ${complete ? 'text-green-600' : item.inspected_qty > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
                          {item.inspected_qty}
                        </span>
                        {!complete && (
                          <button
                            onClick={() => countUp(item.product_code)}
                            className="w-5 h-5 rounded-full bg-gray-200 hover:bg-blue-500 hover:text-white text-gray-500 text-xs font-bold flex items-center justify-center leading-none"
                          >+</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 바코드 입력 */}
      {items.length > 0 && !allDone && (
        <form onSubmit={handleBarcodeScan} className="bg-white rounded-xl border p-4 flex gap-2">
          <input
            ref={barcodeRef}
            value={barcode}
            onChange={e => setBarcode(e.target.value)}
            placeholder="바코드 스캔"
            className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800"
          >
            입력
          </button>
        </form>
      )}

      {message && (
        <p className="mt-3 text-sm text-red-500">{message}</p>
      )}

      {/* 미등록 바코드 모달 */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h3 className="font-bold text-gray-800 mb-1">미등록 바코드</h3>
            <p className="text-sm font-mono text-gray-500 mb-4">{modal.barcode}</p>
            <p className="text-sm text-gray-600 mb-3">어떤 상품인가요?</p>
            <div className="space-y-2 mb-4">
              {modal.candidates.map(item => (
                <button
                  key={item.id}
                  onClick={() => registerBarcode(item)}
                  className="w-full text-left px-4 py-3 rounded-xl border hover:bg-blue-50 hover:border-blue-300 transition-colors"
                >
                  <p className="font-medium text-gray-800 text-sm">{item.product_name}</p>
                  {item.option_info && <p className="text-xs text-blue-500 mt-0.5">{item.option_info}</p>}
                  <p className="text-xs text-gray-400 font-mono mt-0.5">{item.product_code}</p>
                </button>
              ))}
            </div>
            <button
              onClick={() => setModal(null)}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
