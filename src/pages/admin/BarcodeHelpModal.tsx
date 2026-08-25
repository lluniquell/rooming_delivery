interface Props {
  onClose: () => void
}

function Section({ title, badge, children }: { title: string; badge: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 last:mb-0">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">{badge}</span>
        <h3 className="text-sm font-bold text-gray-800">{title}</h3>
      </div>
      <div className="text-sm text-gray-600 space-y-2 pl-1">{children}</div>
    </div>
  )
}

function ColTable({ cols }: { cols: { name: string; desc: string }[] }) {
  return (
    <table className="w-full text-xs border rounded-lg overflow-hidden">
      <tbody>
        {cols.map((c, i) => (
          <tr key={c.name} className={i !== cols.length - 1 ? 'border-b' : ''}>
            <td className="px-3 py-1.5 bg-gray-50 font-mono text-gray-500 w-24">{c.name}</td>
            <td className="px-3 py-1.5 text-gray-700">{c.desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function BarcodeHelpModal({ onClose }: Props) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b px-5 py-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-800">바코드 관리 도움말</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1">✕</button>
        </div>

        <div className="p-5">
          <Section title="이카운트 CSV 업로드" badge="바코드 목록">
            <p>이카운트에서 뽑은 전체상품 CSV로 상품코드/상품명/바코드/로케이션을 한 번에 갱신합니다.</p>
            <p className="text-gray-500">파일 형식: <span className="font-mono">.csv</span> (콤마 구분, 따옴표로 감싸도/안 감싸도 됩니다. 첫 줄은 헤더로 보고 건너뜁니다.)</p>
            <p className="font-medium text-gray-700 mt-2">열 순서 (헤더 이름과 무관하게 1~4번째 열 위치로 인식)</p>
            <ColTable cols={[
              { name: '1열', desc: '상품코드 (필수, 없으면 그 줄은 무시)' },
              { name: '2열', desc: '상품명' },
              { name: '3열', desc: '바코드 (비어있어도 됨)' },
              { name: '4열', desc: '로케이션 (비어있어도 됨)' },
            ]} />
            <p className="font-medium text-gray-700 mt-2">처리 규칙</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>CSV의 바코드가 이미 DB에 있으면 → 같은 물건으로 보고 상품코드·상품명·로케이션을 CSV 값으로 갱신</li>
              <li>상품코드가 DB에 아예 없으면 → 신규 등록</li>
              <li>상품코드는 있는데 CSV 바코드가 기존 바코드와 다르고 채울 빈 칸도 없으면 → 자동 반영하지 않고 <span className="font-medium">충돌 목록</span>에 남김</li>
              <li>CSV에 값이 비어있는 칸(바코드·로케이션)은 기존 값을 그대로 유지 (빈 값으로 덮어쓰지 않음)</li>
            </ul>
            <p className="text-gray-500">업로드 후 충돌이 있으면 화면에 "충돌 목록 다운로드" 버튼이 나타나고, 해당 건은 직접 확인 후 처리해야 합니다.</p>
          </Section>

          <Section title="CSV 다운로드" badge="바코드 목록">
            <p>현재 바코드 DB 전체를 CSV 파일로 내보냅니다. 이카운트 업로드용 원본을 만들거나 백업할 때 사용하세요.</p>
            <p className="font-medium text-gray-700 mt-2">내려받는 열 순서</p>
            <ColTable cols={[
              { name: '1열', desc: '상품코드' },
              { name: '2열', desc: '상품명' },
              { name: '3열', desc: '바코드' },
              { name: '4열', desc: '로케이션' },
            ]} />
            <p className="text-gray-500">파일명: <span className="font-mono">barcodes_YYYY-MM-DD.csv</span></p>
          </Section>

          <Section title="이카운트 엑셀 업로드" badge="바코드 채번">
            <p>아직 바코드가 없는 신상품을 이카운트 엑셀에서 불러와 채번 대기 목록에 올립니다.</p>
            <p className="text-gray-500">파일 형식: <span className="font-mono">.xlsx</span> / <span className="font-mono">.xls</span></p>
            <p className="font-medium text-gray-700 mt-2">필요한 열 (헤더 텍스트와 무관하게 열 위치로 인식)</p>
            <ColTable cols={[
              { name: 'A열', desc: '품목코드 (필수)' },
              { name: 'E열', desc: '품목명 (필수)' },
              { name: '"바코드" 열', desc: '헤더에 "바코드" 또는 "BARCODE"가 포함된 열이 있으면 기존 바코드로 인식' },
            ]} />
            <p className="text-gray-500">품목코드·품목명이 없는 줄은 건너뜁니다. 기존 바코드가 있고 그 값이 "P000"으로 시작하지 않으면 재채번 여부를 묻는 확인창이 뜹니다.</p>
          </Section>

          <Section title="바코드 채번" badge="바코드 채번">
            <p>업로드된 채번 대기 목록에 새 바코드 번호를 발급해 DB에 반영합니다.</p>
            <p className="font-medium text-gray-700 mt-2">채번 규칙</p>
            <p className="font-mono text-xs bg-gray-50 border rounded px-3 py-2">200 + 연도(2자리) + 월(2자리) + 그달의 몇째 주(1자리) + 일련번호(5자리)</p>
            <p className="text-gray-500">예: 2026년 8월 25일(4째 주)에 채번 → <span className="font-mono">20026084</span> + <span className="font-mono">00001</span>부터 순서대로. 같은 주차 안에서는 이미 발급된 마지막 일련번호 다음부터 이어서 채번합니다.</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>이미 바코드가 있는 품목코드는 채번 실행 전 확인창으로 다시 물어봅니다.</li>
              <li>같은 상품코드에 로케이션만 등록되고 바코드가 비어있던 행이 있으면, 새로 만들지 않고 그 행에 바코드를 채웁니다.</li>
              <li>채번 완료 후 결과를 엑셀(품목코드·바코드·품목명)로 다운로드할 수 있습니다.</li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  )
}
