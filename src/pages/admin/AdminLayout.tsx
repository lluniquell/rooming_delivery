import { Outlet, NavLink } from 'react-router-dom'
import type { Driver } from '../../types'
import { signOut } from '../../lib/auth'

interface Props {
  driver: Driver
}

const navItems = [
  { to: '/admin/dashboard', label: '배송 현황' },
  { to: '/admin/register', label: '주문 등록' },
  { to: '/admin/assign', label: '배송원 배정' },
  { to: '/admin/drivers', label: '배송원 관리' },
  { to: '/admin/storage', label: '스토리지' },
]

export default function AdminLayout({ driver }: Props) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="font-bold text-gray-800">루밍 배송 관리</span>
          <nav className="flex gap-1">
            {navItems.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded text-sm font-medium ${isActive ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'}`
                }
              >
                {item.label}
              </NavLink>
            ))}
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
