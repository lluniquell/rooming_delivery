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

interface UploadConflict {
  product_code: string
  product_name: string
  csv_barcode: string
  existing_barcodes: string
}

const PAGE_SIZE = 100

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export default function BarcodeDB() {
  const [barcodes, setBarcodes] = useState<Barcode[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const [conflicts, setConflicts] = useState<UploadConflict[]>([])
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

  // 이카운트 전체상품 CSV 업로드 — 단계별 처리:
  // 1) CSV에 바코드가 있고 그 바코드가 DB에 이미 있으면 → 같은 물건으로 보고 상품코드/상품명/
  //    로케이션(값 있을 때만)을 CSV 기준으로 갱신 (바코드는 상품코드보다 더 믿을 수 있는 키)
  // 2) 그 외엔 상품코드로 매칭: 상품코드가 DB에 아예 없으면 새로 등록
  // 3) 상품코드는 있는데 CSV 바코드가 기존 바코드와 다르고, 채울 빈 바코드 칸도 없으면
  //    → 건드리지 않고 충돌 목록에만 남김
  // 4) CSV에 바코드가 없으면(상품코드만 매칭) 상품명/로케이션만 갱신
  // 5) CSV에 값이 없는 칸(바코드/로케이션)은 항상 패스 — 기존 값을 빈 값으로 덮어쓰지 않음
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadMsg('처리 중...')
    setConflicts([])

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
        barcode: clean(cols[2]) || null,
        location: clean(cols[3]) || null,
      }
    }).filter(r => r.product_code)

    if (!rows.length) {
      setUploadMsg('파싱된 데이터가 없습니다.')
      setUploading(false)
      return
    }

    // 같은 상품코드가 CSV에 여러 번 나오면 마지막 값 기준
    const byCode = new Map<string, typeof rows[number]>()
    for (const r of rows) byCode.set(r.product_code, r)
    const csvRows = [...byCode.values()]

    type ExistingRow = { id: number; product_code: string; product_name: string; barcode: string | null; location: string | null }

    const existingByCode = new Map<string, ExistingRow[]>()
    for (const codes of chunk(csvRows.map(r => r.product_code), 200)) {
      const { data } = await supabase.from('barcodes').select('id, product_code, product_name, barcode, location').in('product_code', codes)
      for (const row of (data ?? []) as ExistingRow[]) {
        const list = existingByCode.get(row.product_code) ?? []
        list.push(row)
        existingByCode.set(row.product_code, list)
      }
    }

    // 바코드는 상품코드보다 신뢰할 수 있는 물리적 식별자라, 상품코드가 바뀌었어도
    // 바코드가 같으면 같은 물건으로 보고 상품코드/상품명을 최신화함
    const csvBarcodes = [...new Set(csvRows.map(r => r.barcode).filter((b): b is string => !!b))]
    const existingByBarcode = new Map<string, ExistingRow>()
    for (const codes of chunk(csvBarcodes, 200)) {
      const { data } = await supabase.from('barcodes').select('id, product_code, product_name, barcode, location').in('barcode', codes)
      for (const row of (data ?? []) as ExistingRow[]) existingByBarcode.set(row.barcode as string, row)
    }

    const toInsert: { product_code: string; product_name: string; barcode: string | null; location: string | null }[] = []
    const toUpdate: { id: number; product_code: string; product_name: string; barcode: string | null; location: string | null }[] = []
    const conflictList: UploadConflict[] = []

    for (const r of csvRows) {
      if (r.barcode) {
        const byBarcode = existingByBarcode.get(r.barcode)
        if (byBarcode) {
          const newLocation = r.location ?? byBarcode.location
          if (byBarcode.product_code !== r.product_code || byBarcode.product_name !== r.product_name || newLocation !== byBarcode.location) {
            toUpdate.push({ id: byBarcode.id, product_code: r.product_code, product_name: r.product_name, barcode: r.barcode, location: newLocation })
          }
          continue
        }
      }

      const existingRows = existingByCode.get(r.product_code) ?? []

      if (existingRows.length === 0) {
        toInsert.push({ product_code: r.product_code, product_name: r.product_name, barcode: r.barcode, location: r.location })
        continue
      }

      if (r.barcode) {
        // 위에서 이미 바코드로 전역 매칭을 시도했는데 못 찾은 경우 — 같은 상품코드의
        // 빈 바코드 칸을 채우거나, 없으면 충돌로 남김
        const emptySlot = existingRows.find(x => !x.barcode)
        if (emptySlot) {
          const newLocation = r.location ?? emptySlot.location
          toUpdate.push({ id: emptySlot.id, product_code: r.product_code, product_name: r.product_name, barcode: r.barcode, location: newLocation })
          continue
        }
        conflictList.push({
          product_code: r.product_code,
          product_name: r.product_name,
          csv_barcode: r.barcode,
          existing_barcodes: existingRows.map(x => x.barcode).filter(Boolean).join(', '),
        })
        continue
      }

      // CSV에 바코드 없음 — 상품코드만으로 매칭된 행들의 상품명/로케이션만 갱신
      for (const row of existingRows) {
        const newLocation = r.location ?? row.location
        if (row.product_name !== r.product_name || newLocation !== row.location) {
          toUpdate.push({ id: row.id, product_code: row.product_code, product_name: r.product_name, barcode: row.barcode, location: newLocation })
        }
      }
    }

    // 같은 기존 행(id)이 두 번 이상 업데이트 대상으로 잡히면(예: CSV 안에 같은 바코드가
    // 중복 기재된 경우) 마지막 값만 반영 — 한 upsert 배치 안에 같은 id가 중복되면 오류가 남
    const dedupedUpdates = [...new Map(toUpdate.map(u => [u.id, u])).values()]

    let errorMsg: string | null = null
    for (const batch of chunk(toInsert, 500)) {
      const { error } = await supabase.from('barcodes').insert(batch)
      if (error) { errorMsg = error.message; break }
    }
    if (!errorMsg) {
      for (const batch of chunk(dedupedUpdates, 500)) {
        const { error } = await supabase.from('barcodes').upsert(batch, { onConflict: 'id' })
        if (error) { errorMsg = error.message; break }
      }
    }

    if (errorMsg) {
      setUploadMsg(`오류: ${errorMsg}`)
    } else {
      setConflicts(conflictList)
      setUploadMsg(
        `✅ 신규 ${toInsert.length}건, 업데이트 ${dedupedUpdates.length}건${conflictList.length ? `, 충돌 ${conflictList.length}건(아래에서 다운로드)` : ''}`
      )
      fetchBarcodes(0, search)
      setPage(0)
    }
    setUploading(false)
    e.target.value = ''
  }

  function downloadConflicts() {
    const rows = [
      ['상품코드', '상품명', 'CSV 바코드', '기존 등록된 바코드'],
      ...conflicts.map(c => [c.product_code, c.product_name, c.csv_barcode, c.existing_barcodes]),
    ]
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `바코드_충돌목록_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
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
          {conflicts.length > 0 && (
            <button
              onClick={downloadConflicts}
              className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-600"
            >
              충돌 목록 다운로드 ({conflicts.length})
            </button>
          )}
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
                  <td className="px-2 py-2">
                    <input
                      defaultValue={b.location ?? ''}
                      onBlur={async e => {
                        const val = e.target.value.trim() || null
                        if (val === (b.location ?? null)) return
                        await supabase.from('barcodes').update({ location: val }).eq('id', b.id)
                        setBarcodes(prev => prev.map(x => x.id === b.id ? { ...x, location: val } : x))
                      }}
                      className="w-full font-mono text-blue-500 text-xs border-0 bg-transparent focus:bg-white focus:border focus:border-blue-300 rounded px-1 py-0.5 focus:outline-none"
                      placeholder="-"
                    />
                  </td>
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
