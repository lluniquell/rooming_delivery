import { useState, useEffect, useRef } from 'react'
// 셀 서식(자동 줄바꿈 등) 쓰기가 필요해서 일반 xlsx 대신 씀 — 일반 xlsx는 스타일 쓰기를 지원 안 함
import * as XLSX from 'xlsx-js-style'
import { supabase } from '../../lib/supabase'

interface Batch {
  id: string
  batch_no: string
  name: string
  type: string
  item_count: number
  order_count: number
}

interface Item {
  id: string
  product_code: string
  product_name: string
  option_info: string | null
  brand: string | null
  supplier_name: string | null
  location: string | null
  quantity: number
  inspected_qty: number
  delivery_method: string | null
  status: string
  cafe24_item_code: string | null
  tracking_number: string | null
  cafe24_order_no: string
  customer_name: string
  receiver_name: string | null
  receiver_phone: string | null
  zipcode: string | null
  address: string | null
  shipping_message: string | null
  visit_time: string | null
  order_date: string | null
  tm_barcode: string | null
  tm_external_order_no: string | null
}

const STATUS_LABEL: Record<string, string> = {
  confirmed: '확정',
  in_transit: '배송중',
  delivered: '배송완료',
}

const STATUS_COLOR: Record<string, string> = {
  confirmed: 'bg-gray-100 text-gray-600',
  in_transit: 'bg-blue-100 text-blue-700',
  delivered: 'bg-green-100 text-green-700',
}

// 각 자리는 숫자/문자 상관없이 올 수 있음 (예: NK-01-02-03, NK-A1-B2-C3)
const LOC_REGEX = /[A-Z]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}/

// 엑셀 열 너비 자동 계산용 — 한글은 2칸으로 계산
function strWidth(s: string) {
  let w = 0
  for (const ch of s) w += /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch) ? 2 : 1
  return w
}

function autoColWidths(header: string[], dataRows: string[][], colMax: Record<number, number> = {}) {
  return header.map((h, colIdx) => {
    let max = strWidth(h)
    for (const row of dataRows) {
      for (const line of String(row[colIdx] ?? '').split('\n')) {
        max = Math.max(max, strWidth(line))
      }
    }
    const width = max + 2
    return { wch: colMax[colIdx] ? Math.min(width, colMax[colIdx]) : width }
  })
}

// 도로명주소 뒤에 오는 "OOO동 OOO호" 같은 상세주소를 찾아 별도 줄로 분리 (100% 정확하진 않음)
function splitAddressDetail(address: string | null): string {
  if (!address) return ''
  const m = address.match(/\s(\d+동\s*\d+호.*|\d+호.*)/)
  if (!m || m.index === undefined) return address.trim()
  const road = address.slice(0, m.index).trim()
  const detail = m[0].trim()
  return `${road}\n${detail}`
}

// 출력 시점 표시용 — YYYYMMDD HH:MM:SS
function printTimestamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return `${date} ${time}`
}

export default function SoumBatch() {
  const [batches, setBatches] = useState<Batch[]>([])
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [showPicking, setShowPicking] = useState(false)
  const [pickingSort, setPickingSort] = useState<'location' | 'brand'>('location')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null)

  useEffect(() => { loadBatches() }, [])

  async function loadBatches() {
    // 미성 배치는 소품팀 피킹 화면 전용 임시 보관소라 여기(배치현황)엔 안 보이게 함
    const { data: batchData } = await supabase.from('batches').select('*').neq('type', 'miseong').order('batch_no')
    if (!batchData) return

    const { data: itemData } = await supabase
      .from('order_items')
      .select('batch_id, orders(cafe24_order_no)')
      .eq('status', 'confirmed')

    const countMap: Record<string, number> = {}
    const orderSetMap: Record<string, Set<string>> = {}
    for (const it of (itemData ?? []) as any[]) {
      if (!it.batch_id) continue
      countMap[it.batch_id] = (countMap[it.batch_id] ?? 0) + 1
      const orderNo = it.orders?.cafe24_order_no
      if (orderNo) {
        if (!orderSetMap[it.batch_id]) orderSetMap[it.batch_id] = new Set()
        orderSetMap[it.batch_id].add(orderNo)
      }
    }

    setBatches(batchData.map(b => ({
      ...b,
      item_count: countMap[b.id] ?? 0,
      order_count: orderSetMap[b.id]?.size ?? 0,
    })))
  }

  async function selectBatch(batchId: string) {
    setActiveBatchId(batchId)
    setShowPicking(false)
    setLoading(true)
    const { data } = await supabase
      .from('order_items')
      .select('id, product_code, product_name, option_info, brand, supplier_name, location, quantity, inspected_qty, delivery_method, status, cafe24_item_code, tracking_number, tm_barcode, orders!inner(cafe24_order_no, customer_name, order_date, receiver_name, receiver_phone, zipcode, address, shipping_message, visit_time, tm_external_order_no)')
      .eq('batch_id', batchId)
      .eq('status', 'confirmed')
    const rows = ((data ?? []) as any[])
      .map(row => ({
        id: row.id,
        product_code: row.product_code,
        product_name: row.product_name,
        option_info: row.option_info,
        brand: row.brand,
        supplier_name: row.supplier_name,
        location: row.location,
        quantity: row.quantity,
        inspected_qty: row.inspected_qty,
        delivery_method: row.delivery_method,
        status: row.status,
        cafe24_item_code: row.cafe24_item_code,
        tracking_number: row.tracking_number,
        cafe24_order_no: row.orders.cafe24_order_no,
        customer_name: row.orders.customer_name,
        receiver_name: row.orders.receiver_name,
        receiver_phone: row.orders.receiver_phone,
        zipcode: row.orders.zipcode,
        address: row.orders.address,
        shipping_message: row.orders.shipping_message,
        visit_time: row.orders.visit_time,
        order_date: row.orders.order_date ?? null,
        tm_barcode: row.tm_barcode ?? null,
        tm_external_order_no: row.orders.tm_external_order_no ?? null,
      }))
      .sort((a, b) => (a.order_date ?? '').localeCompare(b.order_date ?? '') || a.cafe24_order_no.localeCompare(b.cafe24_order_no))
    setItems(rows)
    setLoading(false)
  }

  async function moveToHold(itemId: string) {
    const holdBatch = batches.find(b => b.type === 'hold')
    if (!holdBatch) return
    await supabase.from('order_items').update({ batch_id: holdBatch.id }).eq('id', itemId)
    // 서버 재조회 없이 로컬에서 바로 반영 (매번 전체 배치를 다시 불러오면 느림)
    setItems(prev => prev.filter(i => i.id !== itemId))
    setBatches(prev => prev.map(b => {
      if (b.id === activeBatchId) return { ...b, item_count: Math.max(0, b.item_count - 1) }
      if (b.id === holdBatch.id) return { ...b, item_count: b.item_count + 1 }
      return b
    }))
  }

  // 배정을 취소하고 "주문 수집" 화면의 미배정 목록으로 되돌림
  async function moveToUnassigned(itemId: string) {
    if (!confirm('이 상품을 배정 취소하고 주문 수집(미배정) 목록으로 되돌릴까요?')) return
    const item = items.find(i => i.id === itemId)

    // 카페24에 이미 운송장이 등록돼 있으면(운송장 업로드를 거쳤으면) 거기도 같이 정리
    if (item?.tracking_number && item.cafe24_item_code) {
      try {
        const res = await fetch('/api/cafe24/shipments?action=unregister', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_no: item.cafe24_order_no, item_code: item.cafe24_item_code }),
        })
        const result = await res.json()
        if (result.error) {
          alert(`카페24 운송장 정리 실패: ${result.error}\n로컬 미배정은 계속 진행됩니다.`)
        }
      } catch {
        alert('카페24 운송장 정리 중 네트워크 오류가 발생했습니다.\n로컬 미배정은 계속 진행됩니다.')
      }
    }

    await supabase.from('order_items')
      .update({ status: 'collected', batch_id: null, delivery_method: null, tracking_number: null })
      .eq('id', itemId)
    // 서버 재조회 없이 로컬에서 바로 반영
    setItems(prev => prev.filter(i => i.id !== itemId))
    setBatches(prev => prev.map(b =>
      b.id === activeBatchId ? { ...b, item_count: Math.max(0, b.item_count - 1) } : b
    ))
  }

  function buildPickingList() {
    const merged: Record<string, {
      location: string; brand: string; product_name: string
      option_info: string; supplier_note: string; quantity: number
    }> = {}

    for (const item of items) {
      // 이미 바코드 검수 끝난(출고검수1에서 스캔 완료된) 수량은 다시 픽킹할 필요 없음 —
      // 아직 안 채워진 나머지 수량만 픽킹리스트에 반영 (예: 보류 배치에서 B만 남은 경우)
      const remaining = item.quantity - item.inspected_qty
      if (remaining <= 0) continue

      const supplier = item.supplier_name ?? ''
      const codeMatch = supplier.match(LOC_REGEX)?.[0]
      const hasMiseong = supplier.includes('미성')

      // 주문수집 시 이미 파싱해서 저장해둔 값을 우선 사용 — 아직 재수집 전이라 저장된 값이
      // 없는 옛 데이터만 화면에서 그때그때 다시 계산 (하위호환)
      let location = item.location ?? ''
      let stripPattern: RegExp | string = ''
      if (!item.location && codeMatch) {
        location = codeMatch
        stripPattern = LOC_REGEX
      } else if (!item.location && hasMiseong) {
        location = '미성'
        stripPattern = '미성'
      } else if (codeMatch) {
        stripPattern = LOC_REGEX
      } else if (hasMiseong) {
        stripPattern = '미성'
      }

      const supplier_note = (stripPattern ? supplier.replace(stripPattern, '') : supplier)
        .replace(/^\s*[|｜]\s*|\s*[|｜]\s*$/g, '').trim()
      const key = `${item.product_code}__${item.option_info ?? ''}`
      if (merged[key]) {
        merged[key].quantity += remaining
      } else {
        merged[key] = {
          location,
          brand: item.brand ?? '',
          product_name: item.product_name,
          option_info: item.option_info ?? '',
          supplier_note,
          quantity: remaining,
        }
      }
    }
    const rows = Object.values(merged)
    return pickingSort === 'brand'
      ? rows.sort((a, b) => a.brand.localeCompare(b.brand) || a.product_name.localeCompare(b.product_name))
      : rows.sort((a, b) => a.location.localeCompare(b.location) || a.product_name.localeCompare(b.product_name))
  }

  const activeBatch = batches.find(b => b.id === activeBatchId)
  const pickingList = buildPickingList()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // CJ "루밍" 지정형 레이아웃용 (내품수량 필드가 있는 커스텀 양식) — 박스수량은 항상 1,
  // 실제 수량은 내품수량 컬럼에 넣음
  function downloadCJUpload1() {
    // 이미 운송장이 등록된 상품(재출력 아니고 새로 뽑는 용도)은 제외
    const cjItems = items.filter(i => i.delivery_method === 'CJ' && !i.tracking_number)
    if (!cjItems.length) {
      alert('이 배치에 운송장 미등록 CJ 상품이 없습니다.')
      return
    }

    const orderInfo: Record<string, {
      orderNo: string; name: string; phone: string; zipcode: string
      address: string; message: string
    }> = {}
    for (const item of cjItems) {
      const key = item.cafe24_order_no
      if (!orderInfo[key]) {
        orderInfo[key] = {
          orderNo: key,
          name: item.receiver_name || item.customer_name,
          phone: item.receiver_phone ?? '',
          zipcode: item.zipcode ?? '',
          address: item.address ?? '',
          message: item.shipping_message ?? '',
        }
      }
    }

    const header = [
      '받는분성명', '받는분전화번호', '받는분우편번호', '받는분주소(전체, 분할)',
      '고객주문번호', '품목명', '내품수량', '배송메세지1', '품목명', '박스수량',
      '보내는분성명', '보내는분주소(전체, 분할)', '보내는분전화번호', '운임구분',
    ]
    const SENDER_NAME = '루밍'
    const SENDER_ADDRESS = '서울 서초구 사평대로26길 48 미성빌딩'
    const SENDER_PHONE = '02-599-0804'
    const FREIGHT_TYPE = '신용'
    const d = new Date()
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    const dataRows = cjItems.map(item => {
      const o = orderInfo[item.cafe24_order_no]
      return [
        o.name, o.phone, o.zipcode, o.address,
        o.orderNo, item.product_name, item.quantity, o.message, '', 1,
        SENDER_NAME, SENDER_ADDRESS, SENDER_PHONE, FREIGHT_TYPE,
      ]
    })

    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'CJ업로드1')
    XLSX.writeFile(wb, `CJ업로드1_${activeBatch?.name ?? '배치'}_${dateStr}.xlsx`)
  }

  // 직배(수기 배차) 용 — 배송담당자는 현장에서 손으로 채워 넣는 칸이라 빈 칸으로 둠.
  // 번호는 "같은 주문(고객) 안에서 몇 번째 상품인지" — 단건 주문은 구분 필요 없어 빈 칸
  function downloadDirectManual() {
    if (!items.length) {
      alert('이 배치에 상품이 없습니다.')
      return
    }

    const countByOrder: Record<string, number> = {}
    for (const item of items) {
      countByOrder[item.cafe24_order_no] = (countByOrder[item.cafe24_order_no] ?? 0) + 1
    }
    const seenIndex: Record<string, number> = {}

    const header = ['배송 담당자', '판매담당자', '고객명', '번호', '제품명', '도착시간', '연락처', '주소']
    const dataRows = items.map(item => {
      const total = countByOrder[item.cafe24_order_no]
      seenIndex[item.cafe24_order_no] = (seenIndex[item.cafe24_order_no] ?? 0) + 1
      return [
        '',
        item.customer_name,
        item.receiver_name || item.customer_name,
        total > 1 ? `${seenIndex[item.cafe24_order_no]}-${total}` : '',
        item.supplier_name ? `${item.product_name} x ${item.quantity}ea\n${item.supplier_name}` : `${item.product_name} x ${item.quantity}ea`,
        item.visit_time ?? '',
        item.receiver_phone ?? '',
        item.address ?? '',
      ]
    })

    const d = new Date()
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows])

    // 제품명 셀에 상품명\n공급사명 처럼 줄바꿈이 들어가므로 자동 줄바꿈 서식 적용
    for (let i = 0; i < items.length; i++) {
      const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: 4 })
      if (ws[cellRef]) ws[cellRef].s = { alignment: { wrapText: true, vertical: 'top' } }
    }

    // 같은 주문(고객)의 여러 상품 행은 판매담당자/고객명/연락처/주소가 다 똑같으니 셀 병합
    // — items가 이미 cafe24_order_no 기준으로 정렬돼 있어서 연속된 행끼리만 묶으면 됨
    const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = []
    const mergeCols = [1, 2, 6, 7] // 판매담당자, 고객명, 연락처, 주소
    let runStart = 0
    for (let i = 1; i <= items.length; i++) {
      const sameAsPrev = i < items.length && items[i].cafe24_order_no === items[runStart].cafe24_order_no
      if (!sameAsPrev) {
        if (i - runStart > 1) {
          for (const c of mergeCols) {
            merges.push({ s: { r: runStart + 1, c }, e: { r: i, c } }) // +1: 헤더 행 보정
          }
        }
        runStart = i
      }
    }
    ws['!merges'] = merges

    // 내용 길이에 맞춰 열 너비 자동 지정 — 제품명·주소는 줄바꿈으로 처리하니 너무 넓어지지 않게 제한
    ws['!cols'] = autoColWidths(header, dataRows, { 4: 40, 7: 45 })

    // 병합된 행은 엑셀이 줄바꿈에 맞춰 행 높이를 자동으로 못 맞추므로, 줄 수에 맞춰 직접 지정
    const ROW_HEIGHT_PT = 15 // 엑셀 기본 한 줄 높이
    ws['!rows'] = [{}, ...dataRows.map(row => {
      const lines = (String(row[4]).match(/\n/g)?.length ?? 0) + 1
      return { hpt: ROW_HEIGHT_PT * lines }
    })]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '수기엑셀')
    XLSX.writeFile(wb, `수기엑셀_${activeBatch?.name ?? '배치'}_${dateStr}.xlsx`)
  }

  // 팀무버 배치용 내부 확인용 엑셀 — 조립 여부/배송 희망일/배송 예정일은 아직 관리하는 데이터가
  // 없어서 빈 칸으로 두고 현장에서 수기로 채움
  function downloadTeamMoverExcel() {
    if (!items.length) { alert('이 배치에 상품이 없습니다.'); return }

    const header = ['담당자', '고객명', '제품명', '제품', '조립 여부', '배송 희망일', '배송 예정일', '', '연락처', '주소', '', '', '']
    const dataRows = items.map(item => [
      item.customer_name,
      item.receiver_name || item.customer_name,
      item.product_name,
      item.supplier_name ?? '',
      '',
      '',
      '',
      '',
      item.receiver_phone ?? '',
      item.address ?? '',
      '',
      '',
      '',
    ])

    const d = new Date()
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows])
    ws['!cols'] = autoColWidths(header, dataRows, { 2: 35, 9: 45 })

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '팀무버')
    XLSX.writeFile(wb, `팀무버_${activeBatch?.name ?? '배치'}_${dateStr}.xlsx`)
  }

  // 팀무버 주문 등록(외부 업로드용) 엑셀 — 외부주문번호/외부송장번호/바코드는 한번 발급되면
  // 재다운로드해도 같은 값을 계속 써야 해서(중복 등록 방지) orders/order_items에 영구 저장해 재사용
  async function downloadTeamMoverRegisterExcel() {
    if (!items.length) { alert('이 배치에 상품이 없습니다.'); return }

    // 1) 외부주문번호 — 주문 단위로 부여 (같은 주문의 상품 행들은 값을 공유)
    const orderInfoByNo = new Map<string, { order_date: string | null; tm_external_order_no: string | null }>()
    for (const item of items) {
      if (!orderInfoByNo.has(item.cafe24_order_no)) {
        orderInfoByNo.set(item.cafe24_order_no, { order_date: item.order_date, tm_external_order_no: item.tm_external_order_no })
      }
    }
    const fmtYmd = (d: string | null) => (d ? d.slice(0, 10).replace(/-/g, '') : `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`)

    const needAssignment = [...orderInfoByNo.entries()].filter(([, o]) => !o.tm_external_order_no)
    const datesNeeded = [...new Set(needAssignment.map(([, o]) => fmtYmd(o.order_date)))]
    const maxSeqByDate: Record<string, number> = {}
    await Promise.all(datesNeeded.map(async datePart => {
      const { data: usedRows } = await supabase
        .from('orders')
        .select('tm_external_order_no')
        .like('tm_external_order_no', `${datePart}%`)
      let max = 0
      for (const row of usedRows ?? []) {
        const seqPart = parseInt(String(row.tm_external_order_no).slice(8), 10)
        if (!isNaN(seqPart)) max = Math.max(max, seqPart)
      }
      maxSeqByDate[datePart] = max
    }))
    const newExternalNoByOrderNo = new Map<string, string>()
    for (const [orderNo, o] of needAssignment) {
      const datePart = fmtYmd(o.order_date)
      const next = (maxSeqByDate[datePart] ?? 0) + 1
      maxSeqByDate[datePart] = next
      newExternalNoByOrderNo.set(orderNo, `${datePart}${String(next).padStart(2, '0')}`)
    }
    if (newExternalNoByOrderNo.size) {
      await Promise.all([...newExternalNoByOrderNo.entries()].map(([orderNo, no]) =>
        supabase.from('orders').update({ tm_external_order_no: no }).eq('cafe24_order_no', orderNo)
      ))
    }
    const externalNoByOrderNo = new Map<string, string>()
    for (const [orderNo, o] of orderInfoByNo) {
      externalNoByOrderNo.set(orderNo, o.tm_external_order_no ?? newExternalNoByOrderNo.get(orderNo) ?? '')
    }

    // 2) 바코드 — 상품(order_item) 단위로 부여, 고정 접두어 ROOMING + 전역 순번
    const itemsNeedingBarcode = items.filter(i => !i.tm_barcode)
    const newBarcodeById = new Map<string, string>()
    if (itemsNeedingBarcode.length) {
      const { data: maxRow } = await supabase
        .from('order_items')
        .select('tm_barcode')
        .not('tm_barcode', 'is', null)
        .order('tm_barcode', { ascending: false })
        .limit(1)
        .maybeSingle()
      let seq = maxRow?.tm_barcode ? parseInt(String(maxRow.tm_barcode).replace('ROOMING', ''), 10) : 0
      for (const item of itemsNeedingBarcode) {
        seq += 1
        newBarcodeById.set(item.id, `ROOMING${String(seq).padStart(6, '0')}`)
      }
      await Promise.all([...newBarcodeById.entries()].map(([id, code]) =>
        supabase.from('order_items').update({ tm_barcode: code }).eq('id', id)
      ))
    }

    const header = [
      '판매사(필)', '외부주문번호(필)', '외부송장번호(필)', '묶음주문번호', '운송장번호', '주문유형(필)', '송장유형(필)',
      '주문인(필)', '주문인전화번호1(필)', '주문인전화번호2', '주문인주소(필)', '주문인우편번호',
      '수령인(필)', '수령인전화번호1(필)', '수령인전화번호2', '수령인주소(필)', '수령인우편번호',
      '주문일(필)', '희망일', '고객요청사항', '인프라', '창고', '전시장',
      '바코드(필)', '제품', '제품구분(필)', '제품수량(필)', '판매가', '할인율', '결제수단', '상품명',
      '추천인고유번호', '추천인이름', '취소비용 고객부담 여부', '택배사', '택배사(직접입력)', '운임구분', '운임비',
      '판매채널', '판매처', '등록유형', '도선료', '기타',
    ]
    const dataRows = items.map(item => {
      const externalNo = externalNoByOrderNo.get(item.cafe24_order_no) ?? ''
      const personName = `${item.receiver_name || item.customer_name}님`
      const addr = splitAddressDetail(item.address)
      const barcode = item.tm_barcode ?? newBarcodeById.get(item.id) ?? ''
      return [
        '(주)루밍', externalNo, externalNo, '', '', '배송', '단순배송',
        personName, item.receiver_phone ?? '', '', addr, item.zipcode ?? '',
        personName, item.receiver_phone ?? '', '', addr, item.zipcode ?? '',
        item.order_date ? item.order_date.slice(0, 10) : '', '', item.shipping_message ?? '', '', '', '',
        barcode, '', '구성품', String(item.quantity), '', '', '', item.product_name,
        '', '', '', '', '', '', '',
        '', '', '', '', '',
      ]
    })

    const d = new Date()
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows])
    ws['!cols'] = autoColWidths(header, dataRows, { 10: 40, 15: 40, 19: 35 })

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '주문등록')
    XLSX.writeFile(wb, `팀무버_주문등록_${activeBatch?.name ?? '배치'}_${dateStr}.xlsx`)

    // 방금 새로 발급한 값들은 다음 화면 새로고침 없이도 바로 반영
    if (newExternalNoByOrderNo.size || newBarcodeById.size) {
      setItems(prev => prev.map(i => ({
        ...i,
        tm_external_order_no: i.tm_external_order_no ?? newExternalNoByOrderNo.get(i.cafe24_order_no) ?? null,
        tm_barcode: i.tm_barcode ?? newBarcodeById.get(i.id) ?? null,
      })))
    }
  }

  async function uploadTracking(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 })

      // 헤더 행에서 주문번호/운송장 컬럼 찾기
      // (findIndex는 완전히 빈 셀로 생긴 배열 홀(hole)도 콜백을 호출하므로, 매번 String(c ?? '')로 안전하게 변환)
      let headerIdx = -1, orderCol = -1, trackCol = -1
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const r = rows[i] ?? []
        const oc = r.findIndex(c => String(c ?? '').includes('주문번호'))
        const tc = r.findIndex(c => /운송장|송장번호/.test(String(c ?? '')))
        if (oc >= 0 && tc >= 0) { headerIdx = i; orderCol = oc; trackCol = tc; break }
      }
      if (headerIdx < 0) {
        alert('주문번호 / 운송장번호 컬럼을 찾을 수 없습니다.')
        return
      }

      const parsed: { order_no: string; tracking_no: string }[] = []
      for (const r of rows.slice(headerIdx + 1)) {
        const orderNo = String(r?.[orderCol] ?? '').trim()
        const tracking = String(r?.[trackCol] ?? '').trim().replace(/[-\s]/g, '')
        if (!orderNo || !tracking) continue
        parsed.push({ order_no: orderNo, tracking_no: tracking })
      }

      // 운송장번호 등록 + 카페24 배송대기 처리 모두 서버에서 처리 — 서버가 주문별로
      // CJ 배정 상품만 찾아 그 상품의 shipping_code에만 반영함 (타임아웃 방지 위해 50건씩 분할)
      let cafe24Updated = 0
      const cafe24Errors: string[] = []
      setUploadProgress({ current: 0, total: parsed.length })
      for (let i = 0; i < parsed.length; i += 50) {
        const chunk = parsed.slice(i, i + 50)
        try {
          const res = await fetch('/api/cafe24/shipments?action=standby', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orders: chunk }),
          })
          const result = await res.json()
          cafe24Updated += result.updated ?? 0
          if (result.errors?.length) cafe24Errors.push(...result.errors)
        } catch {
          cafe24Errors.push(`${chunk[0].order_no} 외 ${chunk.length - 1}건: 네트워크 오류`)
        }
        setUploadProgress({ current: Math.min(i + 50, parsed.length), total: parsed.length })
      }

      let msg = `카페24 배송대기 처리 ${cafe24Updated}건 / 전체 ${parsed.length}건`
      if (cafe24Errors.length) {
        msg += `\n실패 ${cafe24Errors.length}건\n${cafe24Errors.slice(0, 5).join('\n')}${cafe24Errors.length > 5 ? '\n...' : ''}`
      }
      alert(msg)
      if (activeBatchId) selectBatch(activeBatchId)
    } catch (err: any) {
      alert(`파일 처리 실패: ${err.message}`)
    } finally {
      setUploadProgress(null)
      e.target.value = ''
    }
  }

  async function refresh() {
    setRefreshing(true)
    await loadBatches()
    if (activeBatchId) await selectBatch(activeBatchId)
    setRefreshing(false)
  }

  return (
    <div className="max-w-5xl">
      {/* 인쇄 시 이 페이지 본문은 전부 숨김(display:none) — visibility:hidden은 자리를 그대로
          차지해서 뒤에 가려진 콘텐츠 높이만큼 빈 페이지가 같이 인쇄되는 문제가 있었음 */}
      <div className="print:hidden">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800">배치 현황</h2>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-500 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          {refreshing ? '새로고침 중...' : '↻ 새로고침'}
        </button>
      </div>

      {/* 운송장 업로드 진행 상태 (50건씩 분할 호출) */}
      {uploadProgress && (
        <div className="bg-white rounded-xl border p-3 mb-4">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
            <span className="font-medium text-gray-700">운송장 등록 중...</span>
            <span>{uploadProgress.current} / {uploadProgress.total}건</span>
          </div>
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-300"
              style={{ width: `${uploadProgress.total ? (uploadProgress.current / uploadProgress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* 배치 카드 */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-6">
        {batches.map(batch => (
          <button
            key={batch.id}
            onClick={() => selectBatch(batch.id)}
            className={`p-3 rounded-xl border text-left transition-colors ${
              activeBatchId === batch.id
                ? 'bg-indigo-50 border-indigo-300'
                : 'bg-white hover:bg-gray-50 border-gray-200'
            }`}
          >
            <div className="text-xs text-gray-400 mb-1">{batch.batch_no}번</div>
            <div className="font-medium text-gray-800 text-sm leading-tight">{batch.name}</div>
            <div className={`text-2xl font-bold mt-2 ${
              batch.item_count > 0 ? 'text-indigo-600' : 'text-gray-200'
            }`}>
              {batch.order_count}건
            </div>
            <div className="text-xs text-gray-400">SKU {batch.item_count}개</div>
          </button>
        ))}
      </div>

      {/* 선택된 배치 상세 */}
      {activeBatchId && (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <span className="font-medium text-gray-800">
              {activeBatch?.batch_no}번 {activeBatch?.name}
              <span className="text-gray-400 font-normal ml-2 text-sm">
                주문 {new Set(items.map(i => i.cafe24_order_no)).size}건 / SKU {items.length}개
              </span>
            </span>
            {items.length > 0 && (
              <div className="flex gap-2">
                {activeBatch?.type === 'direct' ? (
                  <button
                    onClick={downloadDirectManual}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
                  >
                    수기 엑셀 다운로드
                  </button>
                ) : activeBatch?.name?.includes('팀무버') ? (
                  <>
                    <button
                      onClick={downloadTeamMoverExcel}
                      className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
                    >
                      팀무버 엑셀 다운로드
                    </button>
                    <button
                      onClick={downloadTeamMoverRegisterExcel}
                      className="px-3 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700"
                    >
                      팀무버 주문 등록 엑셀 다운로드
                    </button>
                  </>
                ) : (
                  <button
                    onClick={downloadCJUpload1}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
                  >
                    CJ 송장 출력용 엑셀 다운로드
                  </button>
                )}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium bg-orange-500 text-white hover:bg-orange-600"
                >
                  운송장 업로드
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={uploadTracking}
                  className="hidden"
                />
                <button
                  onClick={() => setShowPicking(true)}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700"
                >
                  픽킹리스트
                </button>
              </div>
            )}
          </div>

          {loading ? (
            <div className="p-12 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : items.length === 0 ? (
            <div className="p-12 text-center text-gray-400 text-sm">이 배치에 상품이 없습니다</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">주문번호</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">주문자명</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">수령인명</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">상품</th>
                  <th className="text-center px-4 py-2 font-medium text-gray-500 text-xs w-12">수량</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">배송방법</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">상태</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 whitespace-nowrap">{item.cafe24_order_no}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{item.customer_name}</td>
                    <td className="px-4 py-3 font-medium text-gray-800 whitespace-nowrap">{item.receiver_name || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {item.brand && <span className="text-gray-400 text-xs mr-1.5">[{item.brand}]</span>}
                      {item.product_name}
                      {item.option_info && <span className="text-gray-400 text-xs ml-1.5">{item.option_info}</span>}
                    </td>
                    <td className="px-4 py-3 text-center font-semibold text-gray-800">{item.quantity}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{item.delivery_method ?? '-'}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLOR[item.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABEL[item.status] ?? item.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => moveToUnassigned(item.id)}
                        className="text-xs text-gray-300 hover:text-indigo-400 transition-colors mr-3"
                      >
                        미배정으로
                      </button>
                      <button
                        onClick={() => moveToHold(item.id)}
                        className="text-xs text-gray-300 hover:text-orange-400 transition-colors"
                      >
                        보류로
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      </div>

      {showPicking && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 print:static print:bg-white print:p-0 print:block">
          <div className="picking-print-area bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col print:rounded-none print:shadow-none print:max-h-none print:max-w-none print:block">
            <div className="px-5 py-3 border-b flex items-center justify-between shrink-0 print:hidden">
              <h3 className="font-bold text-gray-800">
                픽킹리스트 <span className="text-gray-400 font-normal text-sm ml-1">{activeBatch?.name}</span>
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 mr-1">정렬</span>
                <button
                  onClick={() => setPickingSort('location')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    pickingSort === 'location'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'text-gray-600 border-gray-300 hover:border-indigo-400'
                  }`}
                >
                  로케이션 오름차순
                </button>
                <button
                  onClick={() => setPickingSort('brand')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    pickingSort === 'brand'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'text-gray-600 border-gray-300 hover:border-indigo-400'
                  }`}
                >
                  브랜드명 오름차순
                </button>
                <button
                  onClick={() => window.print()}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-300 text-gray-600 hover:border-indigo-400 ml-2"
                >
                  인쇄
                </button>
                <button
                  onClick={() => setShowPicking(false)}
                  className="ml-2 text-gray-400 hover:text-gray-600 text-xl leading-none px-1"
                >
                  ×
                </button>
              </div>
            </div>
            <p className="hidden print:block px-5 pt-4 text-sm font-bold text-gray-800">
              픽킹리스트 — {activeBatch?.name} <span className="font-normal text-gray-400">{printTimestamp()}</span>
            </p>
            <div className="overflow-y-auto print:overflow-visible">
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50 sticky top-0 print:static">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">로케이션</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">브랜드</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">상품명</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">옵션</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">공급사</th>
                    <th className="text-center px-3 py-2 font-medium text-gray-500 text-xs w-12">수량</th>
                  </tr>
                </thead>
                <tbody>
                  {pickingList.map((item, i) => (
                    <tr key={i} className="border-b last:border-0 print:break-inside-avoid">
                      <td className="px-3 py-2.5 font-mono text-xs text-indigo-600 whitespace-nowrap">{item.location || '-'}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-500">{item.brand || '-'}</td>
                      <td className="px-3 py-2.5 text-sm text-gray-800">{item.product_name}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-500">{item.option_info || '-'}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-400">{item.supplier_note || '-'}</td>
                      <td className="px-3 py-2.5 text-center font-bold text-gray-800">{item.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
