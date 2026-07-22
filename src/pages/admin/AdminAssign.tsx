import { useEffect, useState } from 'react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '../../lib/supabase'
import type { Delivery, Driver } from '../../types'

function SortableRow({ delivery, drivers, onAssign }: {
  delivery: Delivery
  drivers: Driver[]
  onAssign: (id: string, driverId: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: delivery.id })
  const style = { transform: CSS.Transform.toString(transform), transition }

  return (
    <tr ref={setNodeRef} style={style} className="border-b hover:bg-gray-50">
      <td className="px-4 py-3 cursor-grab text-gray-400" {...attributes} {...listeners}>⠿</td>
      <td className="px-4 py-3 font-mono text-sm">{delivery.cafe24_order_no}</td>
      <td className="px-4 py-3">{delivery.customer_name}</td>
      <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">{delivery.address}</td>
      <td className="px-4 py-3">
        <select
          value={delivery.driver_id ?? ''}
          onChange={e => onAssign(delivery.id, e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="">미배정</option>
          {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </td>
    </tr>
  )
}

export default function AdminAssign() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [saving, setSaving] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor))

  useEffect(() => {
    supabase.from('drivers').select('*').eq('is_active', true).eq('role', 'driver').then(({ data }) => setDrivers(data ?? []))
  }, [])

  useEffect(() => {
    supabase
      .from('deliveries')
      .select('*')
      .eq('scheduled_date', date)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .then(({ data }) => setDeliveries(data ?? []))
  }, [date])

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setDeliveries(items => {
        const oldIndex = items.findIndex(i => i.id === active.id)
        const newIndex = items.findIndex(i => i.id === over.id)
        return arrayMove(items, oldIndex, newIndex)
      })
    }
  }

  function handleAssign(id: string, driverId: string) {
    setDeliveries(prev => prev.map(d => d.id === id ? { ...d, driver_id: driverId || null } : d))
  }

  async function save() {
    setSaving(true)
    await Promise.all(
      deliveries.map((d, i) =>
        supabase.from('deliveries').update({ driver_id: d.driver_id, sort_order: i + 1 }).eq('id', d.id)
      )
    )
    setSaving(false)
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <h2 className="text-xl font-bold text-gray-800">배송원 배정</h2>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm"
        />
        <button
          onClick={save}
          disabled={saving}
          className="ml-auto bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? '저장 중...' : '저장'}
        </button>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="w-10 px-4 py-3"></th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">주문번호</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">고객명</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">주소</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">배송원</th>
              </tr>
            </thead>
            <tbody>
              <SortableContext items={deliveries.map(d => d.id)} strategy={verticalListSortingStrategy}>
                {deliveries.length === 0 && (
                  <tr><td colSpan={5} className="text-center py-12 text-gray-400">배송 건이 없습니다.</td></tr>
                )}
                {deliveries.map(d => (
                  <SortableRow key={d.id} delivery={d} drivers={drivers} onAssign={handleAssign} />
                ))}
              </SortableContext>
            </tbody>
          </table>
        </DndContext>
      </div>
    </div>
  )
}
