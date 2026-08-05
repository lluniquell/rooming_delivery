// Vercel/Supabase 둘 다 사용량(대역폭/함수 호출수/DB 용량 등)을 가져올 수 있는 공식 공개
// API가 없어서(로그인 세션 뒤에 있는 대시보드 페이지라 스크래핑도 계정정보 없인 불가능),
// 직접 조회하는 대시보드 대신 실제 사용량 페이지로 바로 가는 링크만 모아둠
const LINKS = [
  {
    name: 'Vercel',
    desc: '배포 현황, 대역폭, 서버리스 함수 호출수 등',
    url: 'https://vercel.com/dashboard',
    color: 'bg-black',
  },
  {
    name: 'Supabase',
    desc: 'DB 용량, API 요청수, 스토리지 등',
    url: 'https://supabase.com/dashboard/project/ivahnozcmltdzaodmbzb/settings/billing/usage',
    color: 'bg-emerald-600',
  },
]

export default function AdminUsage() {
  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold text-gray-800 mb-2">사용량 관리</h2>
      <p className="text-sm text-gray-400 mb-6">
        Vercel/Supabase는 로그인 세션 뒤의 대시보드라 여기서 직접 값을 가져올 방법이 없어요 — 아래 버튼으로 바로 이동해서 확인해주세요.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {LINKS.map(l => (
          <a
            key={l.name}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-white rounded-xl border p-5 hover:border-indigo-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2.5 h-2.5 rounded-full ${l.color}`} />
              <span className="font-bold text-gray-800">{l.name} 사용량 →</span>
            </div>
            <p className="text-xs text-gray-400">{l.desc}</p>
          </a>
        ))}
      </div>
    </div>
  )
}
