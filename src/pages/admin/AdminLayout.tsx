import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import type { Driver, Permission } from '../../types'
import { signOut } from '../../lib/auth'

interface Props {
  driver: Driver
}

const orderItems = [
  { to: '/admin/soum/orders', label: '주문 수집' },
  { to: '/admin/soum/batches', label: '배치 현황' },
  { to: '/admin/soum/shipping-status', label: '배송 현황' },
]

const scheduleItems = [
  { to: '/admin/schedule', label: '배송 스케줄' },
]

const logisticsItems = [
  { to: '/admin/logistics/picking', label: '피킹' },
]

const propItems = [
  { to: '/admin/soum/outgoing', label: '출고 검수 (CJ 운송장)' },
  { to: '/admin/soum/picking', label: '피킹' },
  { to: '/admin/soum/stow', label: '입고 진열' },
]

const devItems = [
  { to: '/admin/test', label: '카페24 테스트' },
  { to: '/admin/soum/dashboard', label: '소품팀 대시보드' },
]

const showroomItems = [
  { to: '/admin/showroom/inventory', label: '재고 위치' },
]

const adminItems = [
  { to: '/admin/products', label: '상품 관리' },
  { to: '/admin/accounts', label: '계정 관리' },
  { to: '/admin/usage', label: '사용량 관리' },
]

export const PERMISSION_GROUPS: { key: Permission; label: string; items: { to: string; label: string }[] }[] = [
  { key: 'orders', label: '주문', items: orderItems },
  { key: 'schedule', label: '스케줄러', items: scheduleItems },
  { key: 'logistics', label: '물류팀', items: logisticsItems },
  { key: 'soum', label: '소품팀', items: propItems },
  { key: 'showroom', label: '공용', items: showroomItems },
]

// 계정 관리 화면에서 고를 수 있는 권한 목록 — '관리자'는 실제 메뉴가 아니라
// PERMISSION_GROUPS 전체를 한 번에 부여하는 상위 권한. '배송팀'(driver)은 관리자 패널의
// 메뉴 권한이 아니라 모바일 배송원 앱 접근(role 대체) — 서로 배타적으로 다룸
export const ASSIGNABLE_PERMISSIONS: { key: Permission; label: string }[] = [
  { key: 'admin', label: '관리자 (전체 메뉴)' },
  { key: 'orders', label: '주문' },
  { key: 'schedule', label: '스케줄러' },
  { key: 'logistics', label: '물류팀' },
  { key: 'soum', label: '소품팀' },
  { key: 'showroom', label: '공용' },
  { key: 'driver', label: '배송팀' },
]

export function hasPermission(driver: Driver, key: Permission) {
  return driver.is_superadmin || driver.permissions?.includes('admin') || driver.permissions?.includes(key)
}

// '관리자' 권한 보유자는 슈퍼관리자와 마찬가지로 계정 관리 접근 가능 (테스트 메뉴는 제외)
export function canManageAccounts(driver: Driver) {
  return driver.is_superadmin || driver.permissions?.includes('admin')
}

// 배송팀 권한과 다른 관리자 메뉴 권한을 같이 가질 수 있어서, 관리자 패널 쪽 메뉴가 하나라도
// 있는지 별도로 판단 — 순수 배송팀 계정(모바일 전용)은 여기 해당 안 됨
export function hasAnyAdminAccess(driver: Driver) {
  return driver.is_superadmin || canManageAccounts(driver) || PERMISSION_GROUPS.some(g => hasPermission(driver, g.key))
}

// 모바일 배송원 앱으로 갈지(관리자 패널 대신) — role 컬럼 대신 permissions만으로 판단
export function isDriverAccount(driver: Driver) {
  return driver.permissions?.includes('driver') ?? false
}

// 지금 브라우저가 로드하고 있는 번들이 실제 배포된 최신 번들인지 주기적으로 확인.
// index.html을 캐시 없이 다시 받아와서 그 안의 script 파일명(해시 포함)을 지금 로드된
// 것과 비교 — 다르면 새 배포가 있었는데 새로고침을 안 한 것
function useVersionCheck() {
  const [outdated, setOutdated] = useState(false)

  useEffect(() => {
    async function check() {
      try {
        const currentScript = document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src')
        if (!currentScript) return // 로컬 개발 서버 등 해시 번들이 없는 환경
        const res = await fetch('/', { cache: 'no-store' })
        const html = await res.text()
        const liveScript = html.match(/\/assets\/index-[^"]+\.js/)?.[0]
        if (liveScript && liveScript !== currentScript) setOutdated(true)
      } catch {
        // 네트워크 오류는 무시 — 다음 주기에 재시도
      }
    }
    check()
    const interval = setInterval(check, 5 * 60 * 1000)
    const onFocus = () => check()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return outdated
}

function NavGroup({ label, items }: { label: string; items: { to: string; label: string }[] }) {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const isActive = items.some(i => location.pathname.startsWith(i.to))
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className={`px-3 py-1.5 rounded text-sm font-semibold flex items-center gap-1 ${isActive ? 'bg-blue-100 text-blue-700' : 'text-gray-700 hover:bg-gray-100'}`}
      >
        {label}
        <svg className={`w-3 h-3 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && items.length === 0 && (
        <div className="absolute left-0 top-full mt-1 bg-white border rounded-xl shadow-lg py-1 min-w-32 z-50 px-4 py-2 text-xs text-gray-400">
          준비 중입니다
        </div>
      )}
      {open && items.length > 0 && (
        <div className="absolute left-0 top-full mt-1 bg-white border rounded-xl shadow-lg py-1 min-w-32 z-50">
          {items.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `block px-4 py-2 text-sm ${isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AdminLayout({ driver }: Props) {
  const canSee = (key: Permission) => hasPermission(driver, key)
  const outdated = useVersionCheck()

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between print:hidden">
        <div className="flex items-center gap-6">
          <span className="font-bold text-gray-800">루밍 관리</span>
          <nav className="flex gap-1">
            {PERMISSION_GROUPS.filter(g => canSee(g.key)).map(g => (
              <NavGroup key={g.key} label={g.label} items={g.items} />
            ))}
            {driver.is_superadmin && <NavGroup label="테스트" items={devItems} />}
            {canManageAccounts(driver) && <NavGroup label="관리자" items={adminItems} />}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-gray-500">
          {isDriverAccount(driver) && (
            <NavLink to="/" className="text-teal-600 hover:text-teal-700 font-medium">
              배송 목록
            </NavLink>
          )}
          {outdated ? (
            <button
              onClick={() => window.location.reload()}
              className="px-2 py-1 rounded-lg text-xs font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 animate-pulse"
            >
              ⚠️ 새 버전 있음 · 새로고침
            </button>
          ) : (
            <span className="text-[10px] text-gray-300 font-mono" title="배포 버전">{__BUILD_ID__}</span>
          )}
          <span>{driver.name}</span>
          <button onClick={() => signOut()} className="text-gray-400 hover:text-gray-600">로그아웃</button>
        </div>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  )
}
