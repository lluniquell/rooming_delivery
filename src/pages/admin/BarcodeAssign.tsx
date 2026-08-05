import { useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'

interface Item {
  product_code: string
  product_name: string
  existingBarcode: string | null // 기존 파일에 있던 바코드값
}

interface Result {
  product_code: string
  product_name: string
  barcode: string
}

function getWeekOfMonth(date: Date): number {
  return Math.ceil(date.getDate() / 7)
}

function buildPrefix(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const w = String(getWeekOfMonth(date))
  return `200${yy}${mm}${w}`
}

interface Props {
  // 채번 실행이 끝나면(barcodes 테이블 반영 완료) 부모(바코드 목록 탭)에 알려서 새로고침시킴
  onAssigned?: () => void
}

export default function BarcodeAssign({ onAssigned }: Props) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<Item[]>([])
  const [confirmItems, setConfirmItems] = useState<Item[]>([]) // 기존 바코드 있어서 확인 필요
  const [results, setResults] = useState<Result[]>([])
  const [message, setMessage] = useState('')
  const [processing, setProcessing] = useState(false)
  const [fileName, setFileName] = useState('')

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setItems([])
    setConfirmItems([])
    setResults([])
    setMessage('')

    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf)
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as string[][]

    // 바코드 열 인덱스 찾기
    const header = rows[0] ?? []
    const barcodeColIdx = header.findIndex(h =>
      String(h).toLowerCase().includes('바코드') || String(h).toUpperCase() === 'BARCODE'
    )

    const parsed: Item[] = []
    const needConfirm: Item[] = []

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      const product_code = String(row[0] ?? '').trim()
      const product_name = String(row[4] ?? '').trim()
      if (!product_code || !product_name) continue

      const existingBarcode = barcodeColIdx >= 0 ? String(row[barcodeColIdx] ?? '').trim() : ''

      const item: Item = { product_code, product_name, existingBarcode: existingBarcode || null }

      if (existingBarcode && !existingBarcode.startsWith('P000') && existingBarcode !== '') {
        needConfirm.push(item)
      } else {
        parsed.push(item)
      }
    }

    setItems(parsed)
    setConfirmItems(needConfirm)
    e.target.value = ''
  }

  function confirmAll() {
    setItems(prev => [...prev, ...confirmItems])
    setConfirmItems([])
  }

  async function assign() {
    if (!items.length) return
    setProcessing(true)
    setMessage('')

    const now = new Date()
    const prefix = buildPrefix(now)

    // 현재 주차 마지막 일련번호 조회
    const { data: existing } = await supabase
      .from('barcodes')
      .select('barcode')
      .like('barcode', `${prefix}%`)
      .order('barcode', { ascending: false })
      .limit(1)

    let serial = 1
    if (existing?.length) {
      serial = parseInt(existing[0].barcode.slice(-5), 10) + 1
    }

    // product_code 기존 행 확인
    const codes = items.map(i => i.product_code)
    const { data: existingRows } = await supabase
      .from('barcodes')
      .select('id, product_code, barcode')
      .in('product_code', codes)

    // 바코드가 실제로 있는 행만 중복 경고 대상
    const withBarcode = (existingRows ?? []).filter(r => r.barcode)
    if (withBarcode.length) {
      const dupeList = [...new Set(withBarcode.map(d => d.product_code))].join(', ')
      if (!confirm(`이미 바코드가 있는 품목코드:\n${dupeList}\n\n추가 채번할까요?`)) {
        setProcessing(false)
        return
      }
    }

    // 바코드 없는 행(로케이션 전용)은 그 행에 채움
    const emptyByCode = new Map<string, string>()
    for (const r of existingRows ?? []) {
      if (!r.barcode && !emptyByCode.has(r.product_code)) emptyByCode.set(r.product_code, r.id)
    }

    const newRows = items.map(item => ({
      product_code: item.product_code,
      product_name: item.product_name,
      barcode: `${prefix}${String(serial++).padStart(5, '0')}`,
    }))

    const insertRows: typeof newRows = []
    for (const row of newRows) {
      const emptyId = emptyByCode.get(row.product_code)
      if (emptyId) {
        const { error } = await supabase.from('barcodes')
          .update({ barcode: row.barcode, product_name: row.product_name })
          .eq('id', emptyId)
        if (error) {
          setMessage(`오류: ${error.message}`)
          setProcessing(false)
          return
        }
        emptyByCode.delete(row.product_code)
      } else {
        insertRows.push(row)
      }
    }

    if (insertRows.length) {
      const { error } = await supabase.from('barcodes').insert(insertRows)
      if (error) {
        setMessage(`오류: ${error.message}`)
        setProcessing(false)
        return
      }
    }

    setResults(newRows)
    setItems([])
    setMessage(`✅ ${newRows.length}건 채번 완료`)
    setProcessing(false)
    onAssigned?.()
  }

  function downloadResult() {
    const ws = XLSX.utils.aoa_to_sheet([
      ['품목코드', '바코드', '품목명'],
      ...results.map(r => [r.product_code, r.barcode, r.product_name]),
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '채번결과')
    XLSX.writeFile(wb, `바코드채번_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800">바코드 채번</h2>
        <div className="flex items-center gap-2">
          {message && <span className="text-sm text-gray-500">{message}</span>}
          <input ref={uploadRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFile} />
          <button
            onClick={() => uploadRef.current?.click()}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700"
          >
            이카운트 엑셀 업로드
          </button>
        </div>
      </div>

      {/* 기존 바코드 확인 팝업 */}
      {confirmItems.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-4">
          <p className="font-medium text-yellow-800 mb-2">기존 바코드가 있는 품목이 있습니다. 재채번할까요?</p>
          <div className="space-y-1 mb-3 max-h-40 overflow-y-auto">
            {confirmItems.map(i => (
              <div key={i.product_code} className="text-sm text-yellow-700 flex gap-3">
                <span className="font-mono">{i.product_code}</span>
                <span>{i.product_name}</span>
                <span className="font-mono text-yellow-500">{i.existingBarcode}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={confirmAll} className="bg-yellow-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-yellow-600">
              포함해서 채번
            </button>
            <button onClick={() => setConfirmItems([])} className="text-yellow-700 px-4 py-1.5 rounded-lg text-sm hover:bg-yellow-100">
              제외
            </button>
          </div>
        </div>
      )}

      {/* 채번 대기 목록 */}
      {items.length > 0 && (
        <div className="bg-white rounded-xl border mb-4 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">채번 대기 <span className="text-blue-600 font-bold">{items.length}</span>건</span>
            <button
              onClick={assign}
              disabled={processing}
              className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {processing ? '채번 중...' : '채번 실행'}
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs w-36">품목코드</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">품목명</th>
                </tr>
              </thead>
              <tbody>
                {items.map(i => (
                  <tr key={i.product_code} className="border-b last:border-0">
                    <td className="px-4 py-2 font-mono text-gray-500 text-xs">{i.product_code}</td>
                    <td className="px-4 py-2 text-gray-800">{i.product_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 채번 결과 */}
      {results.length > 0 && (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">채번 결과 {results.length}건</span>
            <button
              onClick={downloadResult}
              className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700"
            >
              결과 엑셀 다운로드
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs w-36">품목코드</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs w-36">바코드</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">품목명</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.product_code} className="border-b last:border-0">
                    <td className="px-4 py-2 font-mono text-gray-500 text-xs">{r.product_code}</td>
                    <td className="px-4 py-2 font-mono text-blue-600 text-xs">{r.barcode}</td>
                    <td className="px-4 py-2 text-gray-800">{r.product_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {fileName && !items.length && !results.length && !confirmItems.length && (
        <p className="text-sm text-gray-400 text-center py-8">채번할 항목이 없습니다.</p>
      )}
    </div>
  )
}
