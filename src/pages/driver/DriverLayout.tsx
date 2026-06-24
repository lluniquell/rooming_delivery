import { Outlet } from 'react-router-dom'
import type { Driver } from '../../types'
import { signOut } from '../../lib/auth'

interface Props {
  driver: Driver
}

export default function DriverLayout({ driver }: Props) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <span className="font-bold text-gray-800">루밍 배송</span>
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span>{driver.name}</span>
          <button onClick={() => signOut()} className="text-gray-400 hover:text-gray-600">로그아웃</button>
        </div>
      </header>
      <main className="p-4 max-w-lg mx-auto">
        <Outlet />
      </main>
    </div>
  )
}
