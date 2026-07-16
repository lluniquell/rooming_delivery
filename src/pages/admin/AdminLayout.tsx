import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import type { Driver } from '../../types'
import { signOut } from '../../lib/auth'

interface Props {
  driver: Driver
}

const deliveryItems = [
  { to: '/admin/dashboard', label: '배송 현황' },
  { to: '/admin/register', label: '주문 등록' },
  { to: '/admin/assign', label: '배송원 배정' },
  { to: '/admin/drivers', label: '배송원 관리' },
  { to: '/admin/storage', label: '스토리지' },
]

const propItems = [
  { to: '/admin/inspection', label: '바코드 검수' },
  { to: '/admin/barcodes', label: '바코드 DB' },
  { to: '/admin/barcode-assign', label: '바코드 채번' },
]

const devItems = [
  { to: '/admin/test', label: '카페24 테스트' },
]

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
      {open && (
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
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="font-bold text-gray-800">루밍 관리</span>
          <nav className="flex gap-1">
            <NavGroup label="배송팀" items={deliveryItems} />
            <NavGroup label="소품팀" items={propItems} />
            <NavGroup label="테스트" items={devItems} />
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-gray-500">
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
