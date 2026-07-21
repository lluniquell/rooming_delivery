import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import type { Driver } from './types'
import { getCurrentDriver } from './lib/auth'

import LoginPage from './pages/LoginPage'
import AdminLayout from './pages/admin/AdminLayout'
import AdminDashboard from './pages/admin/AdminDashboard'
import AdminRegister from './pages/admin/AdminRegister'
import AdminAssign from './pages/admin/AdminAssign'
import AdminDrivers from './pages/admin/AdminDrivers'
import AdminStorage from './pages/admin/AdminStorage'
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

        {/* 관리자 */}
        <Route
          path="/admin"
          element={driver?.role === 'admin' ? <AdminLayout driver={driver} /> : <Navigate to="/login" />}
        >
          <Route index element={<Navigate to="/admin/dashboard" />} />
          <Route path="dashboard" element={<AdminDashboard />} />
          <Route path="register" element={<AdminRegister />} />
          <Route path="assign" element={<AdminAssign />} />
          <Route path="drivers" element={<AdminDrivers />} />
          <Route path="storage" element={<AdminStorage />} />
          <Route path="soum/orders" element={<SoumOrders />} />
          <Route path="soum/batches" element={<SoumBatch />} />
          <Route path="soum/outgoing" element={<SoumOutgoing />} />
          <Route path="schedule" element={<ScheduleBoard />} />
          <Route path="schedule/day/:date" element={<ScheduleDay />} />
          <Route path="inspection" element={<InspectionMain />} />
          <Route path="barcodes" element={<BarcodeDB />} />
          <Route path="barcode-assign" element={<BarcodeAssign />} />
          <Route path="test" element={<AdminTest />} />
        </Route>

        {/* 배송원 */}
        <Route
          path="/"
          element={driver?.role === 'driver' ? <DriverLayout driver={driver} /> : driver?.role === 'admin' ? <Navigate to="/admin/dashboard" /> : <Navigate to="/login" />}
        >
          <Route index element={<DriverList />} />
          <Route path="delivery/:id" element={<DriverDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
