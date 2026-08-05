import { useState } from 'react'
import BarcodeDB from './BarcodeDB'
import BarcodeAssign from './BarcodeAssign'

export default function AdminProducts() {
  const [tab, setTab] = useState<'list' | 'assign'>('list')
  // 채번 탭에서 채번이 끝나면 이 값을 올려서 목록 탭이(숨겨져 있어도) 새로 불러오게 함
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-gray-800 mb-1">상품 관리</h2>
      <p className="text-sm text-gray-400 mb-4">바코드 DB 조회/수정과 신규 채번을 한 곳에서 처리해요.</p>

      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab('list')}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            tab === 'list' ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-300 hover:border-indigo-400'
          }`}
        >
          바코드 목록
        </button>
        <button
          onClick={() => setTab('assign')}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            tab === 'assign' ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-300 hover:border-indigo-400'
          }`}
        >
          바코드 채번
        </button>
      </div>

      {/* 둘 다 마운트 상태로 두고 CSS로만 감춤 — 탭을 오가도 검색/업로드 상태가 안 날아가고,
          채번 완료 시 목록 탭이 화면에 없어도 refreshKey로 바로 새로고침됨 */}
      <div className={tab === 'list' ? '' : 'hidden'}>
        <BarcodeDB refreshKey={refreshKey} />
      </div>
      <div className={tab === 'assign' ? '' : 'hidden'}>
        <BarcodeAssign onAssigned={() => setRefreshKey(k => k + 1)} />
      </div>
    </div>
  )
}
