import { useParams } from 'react-router-dom'
import { ReaderShell } from '@/features/reader/ReaderShell'

export default function ReaderPage() {
  const { resourceId } = useParams()
  if (!resourceId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-3">
        缺少 resourceId
      </div>
    )
  }
  return <ReaderShell resourceId={resourceId} />
}
