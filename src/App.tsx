import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import type { Driver, Permission } from './types'
import { getCurrentDriver } from './lib/auth'

import LoginPage from './pages/LoginPage'
import AdminLayout, { PERMISSION_GROUPS, hasPermission, canManageAccounts, isDriverAccount } from './pages/admin/AdminLayout'
import AdminAccounts from './pages/admin/AdminAccounts'
import InspectionMain from './pages/inspection/InspectionMain'
import BarcodeDB from './pages/inspection/BarcodeDB'
import BarcodeAssign from './pages/inspection/BarcodeAssign'
import Cafe24Callback from './pages/auth/Cafe24Callback'
import AdminTest from './pages/admin/AdminTest'
import SoumOrders from './pages/soum/SoumOrders'
import SoumBatch from './pages/soum/SoumBatch'
import SoumOutgoing from './pages/soum/SoumOutgoing'
import ScheduleBoard from './pages/schedule/ScheduleBoard'
import ScheduleDay from './pages/schedule/ScheduleDay'
import DriverLayout from './pages/driver/DriverLayout'
import DriverList from './pages/driver/DriverList'
import DriverDetail from './pages/driver/DriverDetail'

function RequirePermission({ perm, driver, children }: { perm: Permission; driver: Driver; children: React.ReactNode }) {
  if (hasPermission(driver, perm)) return <>{children}</>
  return <Navigate to="/admin" replace />
}

function RequireSuperadmin({ driver, children }: { driver: Driver; children: React.ReactNode }) {
  if (driver.is_superadmin) return <>{children}</>
  return <Navigate to="/admin" replace />
}

function RequireAccountManage({ driver, children }: { driver: Driver; children: React.ReactNode }) {
  if (canManageAccounts(driver)) return <>{children}</>
  return <Navigate to="/admin" replace />
}

function defaultAdminPath(driver: Driver) {
  if (driver.is_superadmin || driver.permissions?.includes('admin')) return '/admin/soum/orders'
  // 메뉴 항목이 있는(아직 빈 메뉴가 아닌) 첫 권한 그룹으로 이동
  const firstGroup = PERMISSION_GROUPS.find(g => driver.permissions?.includes(g.key) && g.items.length > 0)
  // 권한이 하나도 없으면 /login으로 보내면 안 됨 — 이미 로그인된 상태라 / <-> /login 무한 리다이렉트 루프에 빠짐
  return firstGroup ? firstGroup.items[0].to : '/admin/no-access'
}

function NoAccess({ driver }: { driver: Driver }) {
  return (
    <div className="max-w-md mx-auto mt-20 text-center">
      <h2 className="text-lg font-bold text-gray-800 mb-2">부여된 권한이 없습니다</h2>
      <p className="text-sm text-gray-500">
        {driver.name}님 계정에 아직 메뉴 권한이 설정되지 않았어요.<br />
        관리자에게 계정 관리에서 권한을 부여해달라고 요청해주세요.
      </p>
    </div>
  )
}

function App() {
  const [driver, setDriver] = useState<Driver | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getCurrentDriver().then((d) => {
      setDriver(d)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      getCurrentDriver().then(setDriver)
    })

    return () => subscription.unsubscribe()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">로딩 중...</div>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={!driver ? <LoginPage /> : <Navigate to="/" />} />
        <Route path="/auth/cafe24/callback" element={<Cafe24Callback />} />

        {/* 관리자 — role이 아니라 'driver' 권한 유무로 판단 */}
        <Route
          path="/admin"
          element={driver && !isDriverAccount(driver) ? <AdminLayout driver={driver} /> : <Navigate to="/login" />}
        >
          <Route index element={driver && <Navigate to={defaultAdminPath(driver)} replace />} />
          <Route path="no-access" element={driver && <NoAccess driver={driver} />} />
          <Route path="soum/orders" element={driver && <RequirePermission perm="orders" driver={driver}><SoumOrders /></RequirePermission>} />
          <Route path="soum/batches" element={driver && <RequirePermission perm="orders" driver={driver}><SoumBatch /></RequirePermission>} />
          <Route path="soum/outgoing" element={driver && <RequirePermission perm="soum" driver={driver}><SoumOutgoing /></RequirePermission>} />
          <Route path="schedule" element={driver && <RequirePermission perm="schedule" driver={driver}><ScheduleBoard /></RequirePermission>} />
          <Route path="schedule/day/:date" element={driver && <RequirePermission perm="schedule" driver={driver}><ScheduleDay /></RequirePermission>} />
          <Route path="inspection" element={driver && <RequirePermission perm="soum" driver={driver}><InspectionMain /></RequirePermission>} />
          <Route path="barcodes" element={driver && <RequirePermission perm="soum" driver={driver}><BarcodeDB /></RequirePermission>} />
          <Route path="barcode-assign" element={driver && <RequirePermission perm="soum" driver={driver}><BarcodeAssign /></RequirePermission>} />
          <Route path="test" element={driver && <RequireSuperadmin driver={driver}><AdminTest /></RequireSuperadmin>} />
          <Route path="accounts" element={driver && <RequireAccountManage driver={driver}><AdminAccounts /></RequireAccountManage>} />
        </Route>

        {/* 배송원 */}
        <Route
          path="/"
          element={driver && isDriverAccount(driver) ? <DriverLayout driver={driver} /> : driver ? <Navigate to={defaultAdminPath(driver)} /> : <Navigate to="/login" />}
        >
          <Route index element={<DriverList />} />
          <Route path="delivery/:id" element={<DriverDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
