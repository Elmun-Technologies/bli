import { AppShell } from '@/components/app/app-shell';
import { resolveDataSourceMode } from '@/lib/spatial/data-source';

export default function HomePage() {
  const dataSource = resolveDataSourceMode();

  return <AppShell dataSource={dataSource} />;
}
